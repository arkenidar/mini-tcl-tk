// tcl.js — a small Tcl interpreter in JavaScript.
//
// A faithful port of mini-tcl.lua (the portable-Lua Tcl subset): same open
// command-registry architecture, same parser/expr semantics, same result codes.
// The core knows nothing about the DOM or Tk — every capability is a plain entry
// in `Tcl.commands`, so tk.js layers a widget toolkit on top without touching this.
//
// Public surface (mirrors mini-tcl.lua's embed table):
//   Tcl.globals                       global variable frame (name -> string)
//   Tcl.commands[name] = (words, frame) => [code, value]
//   Tcl.codes = { OK, ERROR, RETURN, BREAK, CONTINUE }
//   Tcl.evalScript(code, frame) -> [code, value]
//   Tcl.stdout = (s) => ...           puts sink (override to capture output)
//   Tcl.onVarWrite = (frame, name, value) => ...   variable write trace hook
//
// Loads as a classic script (assigns window.Tcl) so wish.html works over file://.
// Also usable under Node via the CommonJS / ESM shim at the bottom.

(function (root) {
    "use strict";

    // ===== Result codes (TCL-style) =========================================
    var OK = 0, ERROR = 1, RETURN = 2, BREAK = 3, CONTINUE = 4;

    var Tcl = {
        globals: {},
        commands: {},
        codes: { OK: OK, ERROR: ERROR, RETURN: RETURN, BREAK: BREAK, CONTINUE: CONTINUE },
        // Overridable hooks.
        stdout: function (s) { if (typeof console !== "undefined") console.log(s); },
        onVarWrite: null, // (frame, name, value) => void
    };

    // Internal: signal an error from deep in the parser/expr (≈ Lua error(msg,0)).
    function fail(msg) { throw new Error(msg); }

    // ===== Frame helpers ====================================================
    // A frame is a plain object name->string. Proc-local frames are Proxy-wrapped
    // so the `global` command can forward linked names to Tcl.globals (the Lua
    // metatable __index/__newindex trick). getVar/setVar centralise access so the
    // onVarWrite trace fires no matter which frame is written.

    function hasVar(frame, name) {
        return Object.prototype.hasOwnProperty.call(frame, name) || frame[name] !== undefined;
    }
    function getVar(frame, name) {
        var v = frame[name];
        return v === undefined ? null : v;
    }
    function setVar(frame, name, value) {
        frame[name] = value;
        if (Tcl.onVarWrite) Tcl.onVarWrite(frame, name, value);
    }
    function unsetVar(frame, name) {
        delete frame[name];
        if (Tcl.onVarWrite) Tcl.onVarWrite(frame, name, undefined);
    }

    // ===== Number / boolean helpers =========================================

    function toNumber(s) {
        if (typeof s === "number") return s;
        var str = String(s).trim();
        var n;
        if (/^[-+]?0[xX][0-9a-fA-F]+$/.test(str)) n = parseInt(str, 16);
        else if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(str)) n = Number(str);
        else n = NaN;
        if (isNaN(n)) fail('expected number but got "' + s + '"');
        return n;
    }

    function numToStr(n) {
        if (typeof n !== "number") return String(n);
        if (Number.isFinite(n) && Math.floor(n) === n) {
            // match Lua's "%d": integer formatting, no decimal point
            return String(n);
        }
        return String(n);
    }

    function isTrue(v) {
        if (typeof v === "number") return v !== 0;
        var str = String(v).trim();
        if (str !== "" && !isNaN(Number(str))) return Number(str) !== 0;
        var s = str.toLowerCase();
        if (s === "true" || s === "yes" || s === "on") return true;
        if (s === "false" || s === "no" || s === "off") return false;
        fail('expected boolean value but got "' + v + '"');
    }

    // ===== List helpers =====================================================
    // TCL lists are strings; elements with spaces/braces are brace-quoted.

    function isSpace(c) { return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v"; }

    function listToTable(s) {
        s = String(s);
        var items = [], i = 0, len = s.length;
        while (i < len) {
            var c = s[i];
            if (isSpace(c)) {
                i++;
            } else if (c === "{") {
                var depth = 1, j = i + 1;
                while (j < len && depth > 0) {
                    var cj = s[j];
                    if (cj === "{") depth++;
                    else if (cj === "}") depth--;
                    j++;
                }
                if (depth !== 0) fail("unmatched open brace in list");
                items.push(s.slice(i + 1, j - 1));
                i = j;
            } else if (c === '"') {
                var k = i + 1, buf = "";
                while (k < len) {
                    var ck = s[k];
                    if (ck === "\\" && k < len - 1) { buf += s[k + 1]; k += 2; }
                    else if (ck === '"') { k++; break; }
                    else { buf += ck; k++; }
                }
                items.push(buf);
                i = k;
            } else {
                var m = i;
                while (m < len && !isSpace(s[m])) m++;
                items.push(s.slice(i, m));
                i = m;
            }
        }
        return items;
    }

    function listElement(s) {
        s = String(s);
        if (s === "") return "{}";
        if (/[\s{}"\[\]$\\;]/.test(s)) {
            var depth = 0;
            for (var k = 0; k < s.length; k++) {
                var c = s[k];
                if (c === "{") depth++;
                else if (c === "}") depth--;
                if (depth < 0) break;
            }
            if (depth === 0) return "{" + s + "}";
            return s.replace(/[\s{}"\[\]$\\;]/g, "\\$&");
        }
        return s;
    }

    function tableToList(t) {
        var out = [];
        for (var i = 0; i < t.length; i++) out.push(listElement(t[i]));
        return out.join(" ");
    }

    // ===== Parser ===========================================================
    // Words: bare, "double quoted" (with subst), {braced} (verbatim).
    // Substitutions: $name, ${name}, [script]. Commands end at newline or ';'.
    // '#' at command position starts a comment to end of line.

    var BACKSLASH_MAP = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

    function isWordChar(c) { return c !== undefined && /[A-Za-z0-9_]/.test(c); }

    // Read $var or ${var} starting after '$'. Returns [value, nextIndex].
    function substVar(s, i, frame) {
        var len = s.length;
        if (i < len && s[i] === "{") {
            var j = s.indexOf("}", i + 1);
            if (j < 0) fail("missing close-brace for variable name");
            var name = s.slice(i + 1, j);
            if (!hasVar(frame, name)) fail('can\'t read "' + name + '": no such variable');
            return [getVar(frame, name), j + 1];
        }
        var k = i;
        while (k < len && isWordChar(s[k])) k++;
        if (k === i) return ["$", i]; // lone '$' is literal
        var nm = s.slice(i, k);
        if (!hasVar(frame, nm)) fail('can\'t read "' + nm + '": no such variable');
        return [getVar(frame, nm), k];
    }

    // Read a [command] substitution starting after '['. Returns [value, nextIndex].
    function substBracket(s, i, frame) {
        var depth = 1, start = i, len = s.length;
        while (i < len) {
            var c = s[i];
            if (c === "[") depth++;
            else if (c === "]") { depth--; if (depth === 0) break; }
            i++;
        }
        if (depth !== 0) fail("missing close-bracket");
        var r = evalScript(s.slice(start, i), frame);
        var code = r[0], val = r[1];
        if (code === ERROR) fail(val);
        if (code !== OK && code !== RETURN) fail("invalid command result code in bracket substitution");
        return [val, i + 1];
    }

    // Read one word starting at non-space position i. Returns [word, nextIndex].
    function readWord(s, i, frame) {
        var len = s.length;
        var c = s[i];

        if (c === "{") {
            var depth = 1, j = i + 1;
            while (j < len) {
                var cj = s[j];
                if (cj === "\\") { j += 2; }
                else if (cj === "{") { depth++; j++; }
                else if (cj === "}") {
                    depth--;
                    if (depth === 0) {
                        var body = s.slice(i + 1, j);
                        body = body.replace(/\\\n\s*/g, " ");
                        return [body, j + 1];
                    }
                    j++;
                } else j++;
            }
            fail("missing close-brace");
        }

        var buf = "", quoted = false;
        if (c === '"') { quoted = true; i++; }

        while (i < len) {
            c = s[i];
            if (quoted && c === '"') {
                return [buf, i + 1];
            } else if (!quoted && (c === " " || c === "\t" || c === "\n" || c === ";")) {
                return [buf, i];
            } else if (c === "\\") {
                i++;
                if (i >= len) { buf += "\\"; break; }
                var ec = s[i];
                if (ec === "\n") {
                    buf += " ";
                    i++;
                    while (i < len && (s[i] === " " || s[i] === "\t")) i++;
                } else {
                    buf += BACKSLASH_MAP[ec] || ec;
                    i++;
                }
            } else if (c === "$") {
                var rv = substVar(s, i + 1, frame);
                buf += rv[0]; i = rv[1];
            } else if (c === "[") {
                var rb = substBracket(s, i + 1, frame);
                buf += rb[0]; i = rb[1];
            } else {
                buf += c; i++;
            }
        }
        if (quoted) fail("missing close-quote");
        return [buf, i];
    }

    // Parse and run one command starting at i. Returns [code, value, nextIndex].
    function evalCommand(s, i, frame) {
        var len = s.length;
        var words = [];
        while (true) {
            while (i < len && (s[i] === " " || s[i] === "\t")) i++;
            if (i >= len) break;
            var c = s[i];
            if (c === "\n" || c === ";") { i++; break; }
            if (c === "\\" && s[i + 1] === "\n") {
                i += 2;
            } else if (c === "#" && words.length === 0) {
                while (i < len && s[i] !== "\n") i++;
            } else {
                var rw = readWord(s, i, frame);
                words.push(rw[0]);
                i = rw[1];
            }
        }

        if (words.length === 0) return [OK, "", i];

        var cmd = Tcl.commands[words[0]];
        if (!cmd) return [ERROR, 'invalid command name "' + words[0] + '"', i];
        var res = cmd(words, frame);
        var code = res[0], val = res[1];
        return [code, val === undefined || val === null ? "" : val, i];
    }

    // Evaluate a script (sequence of commands). Returns [code, value].
    function evalScript(s, frame) {
        s = String(s);
        var i = 0, len = s.length;
        var code = OK, val = "";
        while (i < len) {
            try {
                var r = evalCommand(s, i, frame);
                code = r[0]; val = r[1]; i = r[2];
            } catch (e) {
                return [ERROR, String(e && e.message !== undefined ? e.message : e)];
            }
            if (code !== OK) return [code, val];
        }
        return [code, val];
    }

    Tcl.evalScript = function (code, frame) { return evalScript(code, frame || Tcl.globals); };

    // ===== expr evaluator ===================================================
    // Operates on the assembled expression string; does its own $var/[cmd] subst
    // so `expr {$x < 10}` works.

    function tokenize(s, frame) {
        var t = [], i = 0, len = s.length;
        function push(kind, v) { t.push({ kind: kind, v: v }); }
        while (i < len) {
            var c = s[i];
            var two = s.slice(i, i + 2);
            if (/\s/.test(c)) {
                i++;
            } else if (/\d/.test(c) || (c === "." && /\d/.test(s[i + 1] || ""))) {
                var j = i;
                while (j < len && /[0-9.xXa-fA-F]/.test(s[j])) j++;
                var raw = s.slice(i, j);
                var n = /^0[xX]/.test(raw) ? parseInt(raw, 16) : Number(raw);
                if (isNaN(n)) fail("invalid number in expression");
                push("num", n);
                i = j;
            } else if (c === "$") {
                var rv = substVar(s, i + 1, frame);
                var nv = Number(rv[0]);
                if (rv[0] !== "" && !isNaN(nv)) push("num", nv); else push("str", rv[0]);
                i = rv[1];
            } else if (c === "[") {
                var rb = substBracket(s, i + 1, frame);
                var nb = Number(rb[0]);
                if (rb[0] !== "" && !isNaN(nb)) push("num", nb); else push("str", rb[0]);
                i = rb[1];
            } else if (c === '"' || c === "{") {
                var rw = readWord(s, i, frame);
                var nw = Number(rw[0]);
                if (rw[0] !== "" && !isNaN(nw)) push("num", nw); else push("str", rw[0]);
                i = rw[1];
            } else if (/[A-Za-z_]/.test(c)) {
                var k = i;
                while (k < len && /[A-Za-z0-9_]/.test(s[k])) k++;
                push("name", s.slice(i, k));
                i = k;
            } else if (two === "==" || two === "!=" || two === "<=" || two === ">=" ||
                       two === "&&" || two === "||" || two === "**") {
                push("op", two);
                i += 2;
            } else if (/[+\-*/%<>!(),?:]/.test(c)) {
                push("op", c);
                i++;
            } else {
                fail("unexpected character '" + c + "' in expression");
            }
        }
        return t;
    }

    var MATH_FUNCS = {
        abs: Math.abs, sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        exp: Math.exp, log: Math.log, floor: Math.floor, ceil: Math.ceil,
        atan: Math.atan, asin: Math.asin, acos: Math.acos,
        round: function (x) { return Math.floor(x + 0.5); },
        min: Math.min, max: Math.max,
        pow: function (a, b) { return Math.pow(a, b); },
        fmod: function (a, b) { return a % b; },
        int: function (x) { return x >= 0 ? Math.floor(x) : Math.ceil(x); },
        double: function (x) { return x; },
        rand: function () { return Math.random(); },
        srand: function (seed) { return seed; },
    };

    function exprEval(s, frame) {
        var toks = tokenize(String(s), frame);
        var pos = 0;

        function peek() { return toks[pos]; }
        function isOp(op) { var t = toks[pos]; return t && t.kind === "op" && t.v === op; }
        function expectOp(op) { if (!isOp(op)) fail("expected '" + op + "' in expression"); pos++; }

        var parseTernary;

        function parsePrimary() {
            var t = peek();
            if (!t) fail("premature end of expression");
            if (t.kind === "num" || t.kind === "str") { pos++; return t.v; }
            if (t.kind === "name") {
                var name = t.v; pos++;
                if (name === "eq" || name === "ne" || name === "in") fail("operator '" + name + "' out of place");
                var fn = MATH_FUNCS[name];
                if (!fn) fail('unknown function "' + name + '"');
                expectOp("(");
                var args = [];
                if (!isOp(")")) {
                    args.push(parseTernary());
                    while (isOp(",")) { pos++; args.push(parseTernary()); }
                }
                expectOp(")");
                return fn.apply(null, args.map(toNumber));
            }
            if (isOp("(")) { pos++; var v = parseTernary(); expectOp(")"); return v; }
            if (isOp("-")) { pos++; return -toNumber(parsePrimary()); }
            if (isOp("+")) { pos++; return toNumber(parsePrimary()); }
            if (isOp("!")) { pos++; return isTrue(parsePrimary()) ? 0 : 1; }
            fail("syntax error in expression");
        }

        function parsePower() {
            var left = parsePrimary();
            if (isOp("**")) { pos++; return Math.pow(toNumber(left), toNumber(parsePower())); }
            return left;
        }

        function parseMul() {
            var left = parsePower();
            while (isOp("*") || isOp("/") || isOp("%")) {
                var op = peek().v; pos++;
                var right = parsePower();
                var a = toNumber(left), b = toNumber(right);
                if (op === "*") left = a * b;
                else if (op === "/") left = a / b;
                else left = a % b;
            }
            return left;
        }

        function parseAdd() {
            var left = parseMul();
            while (isOp("+") || isOp("-")) {
                var op = peek().v; pos++;
                var right = parseMul();
                var a = toNumber(left), b = toNumber(right);
                left = op === "+" ? a + b : a - b;
            }
            return left;
        }

        function parseComp() {
            var left = parseAdd();
            while (true) {
                var t = peek(), op;
                if (t && t.kind === "op" && (t.v === "<" || t.v === ">" || t.v === "<=" || t.v === ">=")) op = t.v;
                else if (t && t.kind === "name" && (t.v === "eq" || t.v === "ne")) op = t.v;
                else break;
                pos++;
                var right = parseAdd();
                if (op === "eq") left = (String(left) === String(right)) ? 1 : 0;
                else if (op === "ne") left = (String(left) !== String(right)) ? 1 : 0;
                else {
                    var a = toNumber(left), b = toNumber(right);
                    if (op === "<") left = a < b ? 1 : 0;
                    else if (op === ">") left = a > b ? 1 : 0;
                    else if (op === "<=") left = a <= b ? 1 : 0;
                    else left = a >= b ? 1 : 0;
                }
            }
            return left;
        }

        function parseEq() {
            var left = parseComp();
            while (isOp("==") || isOp("!=")) {
                var op = peek().v; pos++;
                var right = parseComp();
                var a = Number(left), b = Number(right);
                var equal;
                if (left !== "" && right !== "" && !isNaN(a) && !isNaN(b)) equal = (a === b);
                else equal = (String(left) === String(right));
                left = op === "==" ? (equal ? 1 : 0) : (equal ? 0 : 1);
            }
            return left;
        }

        function parseAnd() {
            var left = parseEq();
            while (isOp("&&")) { pos++; var right = parseEq(); left = (isTrue(left) && isTrue(right)) ? 1 : 0; }
            return left;
        }

        function parseOr() {
            var left = parseAnd();
            while (isOp("||")) { pos++; var right = parseAnd(); left = (isTrue(left) || isTrue(right)) ? 1 : 0; }
            return left;
        }

        parseTernary = function () {
            var cond = parseOr();
            if (isOp("?")) {
                pos++;
                var a = parseTernary();
                expectOp(":");
                var b = parseTernary();
                return isTrue(cond) ? a : b;
            }
            return cond;
        };

        var v = parseTernary();
        if (pos < toks.length) fail("extra tokens at end of expression");
        if (typeof v === "number") return numToStr(v);
        return String(v);
    }

    function evalExprWords(words, frame, first) {
        var parts = [];
        for (var k = first; k < words.length; k++) parts.push(words[k]);
        return exprEval(parts.join(" "), frame);
    }

    // ===== Commands =========================================================

    var cmds = Tcl.commands;

    function wrongArgs(usage) { return [ERROR, 'wrong # args: should be "' + usage + '"']; }

    cmds["puts"] = function (words) {
        var i = 1, nonewline = false;
        if (words[i] === "-nonewline") { nonewline = true; i++; }
        if (words.length !== i + 1) return wrongArgs("puts ?-nonewline? string");
        Tcl.stdout(words[i] + (nonewline ? "" : "\n"));
        return [OK, ""];
    };

    cmds["set"] = function (words, frame) {
        if (words.length === 2) {
            if (!hasVar(frame, words[1])) return [ERROR, 'can\'t read "' + words[1] + '": no such variable'];
            return [OK, getVar(frame, words[1])];
        } else if (words.length === 3) {
            setVar(frame, words[1], words[2]);
            return [OK, words[2]];
        }
        return wrongArgs("set varName ?newValue?");
    };

    cmds["unset"] = function (words, frame) {
        for (var k = 1; k < words.length; k++) unsetVar(frame, words[k]);
        return [OK, ""];
    };

    cmds["append"] = function (words, frame) {
        if (words.length < 2) return wrongArgs("append varName ?value value ...?");
        var name = words[1];
        var v = hasVar(frame, name) ? getVar(frame, name) : "";
        for (var k = 2; k < words.length; k++) v += words[k];
        setVar(frame, name, v);
        return [OK, v];
    };

    cmds["incr"] = function (words, frame) {
        if (words.length !== 2 && words.length !== 3) return wrongArgs("incr varName ?increment?");
        var name = words[1];
        var cur = hasVar(frame, name) ? getVar(frame, name) : "0";
        var n, delta = 1;
        try { n = toNumber(cur); } catch (e) { return [ERROR, e.message]; }
        if (words.length === 3) { try { delta = toNumber(words[2]); } catch (e2) { return [ERROR, e2.message]; } }
        var v = numToStr(n + delta);
        setVar(frame, name, v);
        return [OK, v];
    };

    cmds["expr"] = function (words, frame) {
        if (words.length < 2) return wrongArgs("expr arg ?arg ...?");
        try { return [OK, evalExprWords(words, frame, 1)]; }
        catch (e) { return [ERROR, String(e.message)]; }
    };

    cmds["if"] = function (words, frame) {
        var i = 1;
        while (i < words.length) {
            var cond = words[i]; i++;
            if (words[i] === "then") i++;
            var body = words[i];
            if (body === undefined) return [ERROR, 'wrong # args: no script following "if" condition'];
            i++;
            var condVal;
            try { condVal = exprEval(cond, frame); } catch (e) { return [ERROR, String(e.message)]; }
            if (isTrue(condVal)) return evalScript(body, frame);
            var kw = words[i];
            if (kw === undefined) return [OK, ""];
            if (kw === "elseif") { i++; }
            else if (kw === "else") {
                var elseBody = words[i + 1];
                if (elseBody === undefined) return [ERROR, 'wrong # args: no script following "else"'];
                return evalScript(elseBody, frame);
            } else {
                return [ERROR, 'invalid "if" syntax: expected "elseif" or "else" but got "' + kw + '"'];
            }
        }
        return [OK, ""];
    };

    cmds["while"] = function (words, frame) {
        if (words.length !== 3) return wrongArgs("while test command");
        var cond = words[1], body = words[2];
        while (true) {
            var condVal;
            try { condVal = exprEval(cond, frame); } catch (e) { return [ERROR, String(e.message)]; }
            if (!isTrue(condVal)) break;
            var r = evalScript(body, frame);
            if (r[0] === BREAK) break;
            if (r[0] !== OK && r[0] !== CONTINUE) return r;
        }
        return [OK, ""];
    };

    cmds["for"] = function (words, frame) {
        if (words.length !== 5) return wrongArgs("for start test next command");
        var start = words[1], test = words[2], nextS = words[3], body = words[4];
        var r = evalScript(start, frame);
        if (r[0] !== OK) return r;
        while (true) {
            var condVal;
            try { condVal = exprEval(test, frame); } catch (e) { return [ERROR, String(e.message)]; }
            if (!isTrue(condVal)) break;
            r = evalScript(body, frame);
            if (r[0] === BREAK) break;
            if (r[0] !== OK && r[0] !== CONTINUE) return r;
            r = evalScript(nextS, frame);
            if (r[0] !== OK) return r;
        }
        return [OK, ""];
    };

    cmds["foreach"] = function (words, frame) {
        if (words.length !== 4) return wrongArgs("foreach varList list command");
        var varNames, items;
        try { varNames = listToTable(words[1]); } catch (e) { return [ERROR, e.message]; }
        try { items = listToTable(words[2]); } catch (e2) { return [ERROR, e2.message]; }
        if (varNames.length === 0) return [ERROR, "foreach varlist is empty"];
        var body = words[3], i = 0;
        while (i < items.length) {
            for (var k = 0; k < varNames.length; k++) setVar(frame, varNames[k], items[i + k] !== undefined ? items[i + k] : "");
            i += varNames.length;
            var r = evalScript(body, frame);
            if (r[0] === BREAK) break;
            if (r[0] !== OK && r[0] !== CONTINUE) return r;
        }
        return [OK, ""];
    };

    cmds["break"] = function (words) { if (words.length !== 1) return wrongArgs("break"); return [BREAK, ""]; };
    cmds["continue"] = function (words) { if (words.length !== 1) return wrongArgs("continue"); return [CONTINUE, ""]; };
    cmds["return"] = function (words) { if (words.length > 2) return wrongArgs("return ?value?"); return [RETURN, words[1] || ""]; };

    cmds["proc"] = function (words) {
        if (words.length !== 4) return wrongArgs("proc name args body");
        var name = words[1], argSpec = words[2], body = words[3];
        var params;
        try { params = listToTable(argSpec); } catch (e) { return [ERROR, e.message]; }
        Tcl.commands[name] = function (callWords) {
            var localFrame = {};
            var nParams = params.length;
            for (var idx = 0; idx < nParams; idx++) {
                var spec = listToTable(params[idx]);
                var pname = spec[0], def = spec[1];
                if (pname === "args" && idx === nParams - 1) {
                    var rest = [];
                    for (var k = idx + 1; k < callWords.length; k++) rest.push(callWords[k]);
                    localFrame["args"] = tableToList(rest);
                } else {
                    var v = callWords[idx + 1];
                    if (v === undefined) v = def;
                    if (v === undefined) return [ERROR, 'wrong # args: should be "' + name + " " + params.join(" ") + '"'];
                    localFrame[pname] = v;
                }
            }
            if (params[nParams - 1] !== "args" && callWords.length - 1 > nParams) {
                return [ERROR, 'wrong # args: should be "' + name + " " + params.join(" ") + '"'];
            }
            var r = evalScript(body, localFrame);
            if (r[0] === RETURN || r[0] === OK) return [OK, r[1]];
            if (r[0] === ERROR) return [ERROR, r[1]];
            return [ERROR, 'invoked "' + (r[0] === BREAK ? "break" : "continue") + '" outside of a loop'];
        };
        return [OK, ""];
    };

    cmds["global"] = function (words, frame) {
        if (frame === Tcl.globals) return [OK, ""];
        // Proc-local frames need a Proxy to forward linked names to globals. If the
        // frame isn't already proxied, we can't retrofit it (it's referenced by
        // closure); instead we record linked names on a side table the proxy reads.
        var linked = frame.__tcl_linked__;
        if (!linked) {
            // Best-effort: define accessor properties forwarding to globals.
            linked = {};
            Object.defineProperty(frame, "__tcl_linked__", { value: linked, enumerable: false, writable: true });
        }
        for (var k = 1; k < words.length; k++) {
            var name = words[k];
            linked[name] = true;
            (function (nm) {
                Object.defineProperty(frame, nm, {
                    configurable: true,
                    enumerable: true,
                    get: function () { return Tcl.globals[nm]; },
                    set: function (v) { Tcl.globals[nm] = v; },
                });
            })(name);
        }
        return [OK, ""];
    };

    cmds["eval"] = function (words, frame) {
        if (words.length < 2) return wrongArgs("eval arg ?arg ...?");
        var parts = [];
        for (var k = 1; k < words.length; k++) parts.push(words[k]);
        return evalScript(parts.join(" "), frame);
    };

    cmds["catch"] = function (words, frame) {
        if (words.length !== 2 && words.length !== 3) return wrongArgs("catch script ?varName?");
        var r = evalScript(words[1], frame);
        if (words.length === 3) setVar(frame, words[2], r[1]);
        return [OK, numToStr(r[0])];
    };

    cmds["error"] = function (words) {
        if (words.length !== 2) return wrongArgs("error message");
        return [ERROR, words[1]];
    };

    // ----- string -----------------------------------------------------------

    function endIndex(x, n) {
        // n = length of the sequence; returns a 0-based index per Tcl end/end-N
        if (x === "end") return n - 1;
        var m = /^end-(\d+)$/.exec(x);
        if (m) return n - 1 - Number(m[1]);
        return toNumber(x);
    }

    var stringSub = {
        length: function (a) { return numToStr(a[0].length); },
        toupper: function (a) { return a[0].toUpperCase(); },
        tolower: function (a) { return a[0].toLowerCase(); },
        trim: function (a) { return a[0].replace(/^\s+/, "").replace(/\s+$/, ""); },
        trimleft: function (a) { return a[0].replace(/^\s+/, ""); },
        trimright: function (a) { return a[0].replace(/\s+$/, ""); },
        reverse: function (a) { return a[0].split("").reverse().join(""); },
        index: function (a) {
            var s = a[0], i = a[1];
            if (i === undefined) fail('wrong # args: should be "string index string charIndex"');
            var n = endIndex(i, s.length);
            if (n < 0 || n >= s.length) return "";
            return s[n];
        },
        range: function (a) {
            var s = a[0], first = a[1], last = a[2];
            if (last === undefined) fail('wrong # args: should be "string range string first last"');
            var f = Math.max(0, endIndex(first, s.length));
            var l = Math.min(s.length - 1, endIndex(last, s.length));
            if (f > l) return "";
            return s.slice(f, l + 1);
        },
        "repeat": function (a) {
            var s = a[0], count = a[1];
            if (count === undefined) fail('wrong # args: should be "string repeat string count"');
            return s.repeat(Math.max(0, toNumber(count)));
        },
        equal: function (a) {
            if (a[1] === undefined) fail('wrong # args: should be "string equal string1 string2"');
            return a[0] === a[1] ? "1" : "0";
        },
        compare: function (a) {
            if (a[1] === undefined) fail('wrong # args: should be "string compare string1 string2"');
            if (a[0] < a[1]) return "-1"; if (a[0] > a[1]) return "1"; return "0";
        },
        first: function (a) {
            var needle = a[0], hay = a[1];
            if (hay === undefined) fail('wrong # args: should be "string first needleString haystackString"');
            return numToStr(hay.indexOf(needle));
        },
        last: function (a) {
            var needle = a[0], hay = a[1];
            if (hay === undefined) fail('wrong # args: should be "string last needleString haystackString"');
            return numToStr(hay.lastIndexOf(needle));
        },
        match: function (a) {
            var pattern = a[0], s = a[1];
            if (s === undefined) fail('wrong # args: should be "string match pattern string"');
            var lp = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
            return new RegExp("^" + lp + "$").test(s) ? "1" : "0";
        },
    };

    cmds["string"] = function (words) {
        if (words.length < 3) return wrongArgs("string subcommand string ?arg ...?");
        var sub = stringSub[words[1]];
        if (!sub) return [ERROR, 'unknown or unsupported "string" subcommand "' + words[1] + '"'];
        var args = [];
        for (var k = 2; k < words.length; k++) args.push(words[k]);
        try { return [OK, sub(args)]; } catch (e) { return [ERROR, String(e.message)]; }
    };

    // ----- lists ------------------------------------------------------------

    cmds["list"] = function (words) {
        var t = [];
        for (var k = 1; k < words.length; k++) t.push(words[k]);
        return [OK, tableToList(t)];
    };

    cmds["llength"] = function (words) {
        if (words.length !== 2) return wrongArgs("llength list");
        var t;
        try { t = listToTable(words[1]); } catch (e) { return [ERROR, e.message]; }
        return [OK, numToStr(t.length)];
    };

    cmds["lindex"] = function (words) {
        if (words.length !== 3) return wrongArgs("lindex list index");
        var t;
        try { t = listToTable(words[1]); } catch (e) { return [ERROR, e.message]; }
        var n;
        try { n = endIndex(words[2], t.length); } catch (e2) { return [ERROR, e2.message]; }
        return [OK, t[n] !== undefined ? t[n] : ""];
    };

    cmds["lappend"] = function (words, frame) {
        if (words.length < 2) return wrongArgs("lappend varName ?value value ...?");
        var name = words[1];
        var cur = hasVar(frame, name) ? getVar(frame, name) : "";
        var parts = [];
        if (cur !== "") parts.push(cur);
        for (var k = 2; k < words.length; k++) parts.push(listElement(words[k]));
        var v = parts.join(" ");
        setVar(frame, name, v);
        return [OK, v];
    };

    cmds["lrange"] = function (words) {
        if (words.length !== 4) return wrongArgs("lrange list first last");
        var t;
        try { t = listToTable(words[1]); } catch (e) { return [ERROR, e.message]; }
        var f, l;
        try { f = endIndex(words[2], t.length); l = endIndex(words[3], t.length); }
        catch (e2) { return [ERROR, e2.message]; }
        f = Math.max(0, f); l = Math.min(t.length - 1, l);
        var out = [];
        for (var k = f; k <= l; k++) out.push(t[k]);
        return [OK, tableToList(out)];
    };

    cmds["split"] = function (words) {
        if (words.length !== 2 && words.length !== 3) return wrongArgs("split string ?splitChars?");
        var s = words[1];
        var seps = words.length === 3 ? words[2] : " \t\n\r";
        var out = [];
        if (seps === "") {
            for (var k = 0; k < s.length; k++) out.push(s[k]);
        } else {
            var cls = "[" + seps.replace(/[\^\]\\\-]/g, "\\$&") + "]";
            var re = new RegExp(cls);
            var start = 0;
            while (true) {
                re.lastIndex = 0;
                var rest = s.slice(start);
                var m = rest.search(re);
                if (m < 0) { out.push(rest); break; }
                out.push(rest.slice(0, m));
                start = start + m + 1;
            }
        }
        return [OK, tableToList(out)];
    };

    cmds["join"] = function (words) {
        if (words.length !== 2 && words.length !== 3) return wrongArgs("join list ?joinString?");
        var t;
        try { t = listToTable(words[1]); } catch (e) { return [ERROR, e.message]; }
        return [OK, t.join(words.length === 3 ? words[2] : " ")];
    };

    // ----- info -------------------------------------------------------------

    cmds["info"] = function (words, frame) {
        var sub = words[1];
        if (sub === "exists") {
            if (words.length !== 3) return wrongArgs("info exists varName");
            return [OK, hasVar(frame, words[2]) ? "1" : "0"];
        } else if (sub === "commands") {
            var names = Object.keys(Tcl.commands).sort();
            return [OK, tableToList(names)];
        }
        return [ERROR, 'unknown or unsupported "info" subcommand "' + String(sub) + '"'];
    };

    // exit/source are filesystem/host concerns — stub them so scripts don't crash.
    cmds["exit"] = function () { return [OK, ""]; };
    cmds["source"] = function () { return [ERROR, '"source" is not available in the browser']; };

    // Expose internals that tk.js / tests may reuse.
    Tcl.listToTable = listToTable;
    Tcl.tableToList = tableToList;
    Tcl.listElement = listElement;
    Tcl.isTrue = function (v) { try { return isTrue(v); } catch (e) { return false; } };
    Tcl.exprEval = exprEval;

    // ===== export ===========================================================
    root.Tcl = Tcl;
    if (typeof module !== "undefined" && module.exports) module.exports = Tcl;

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

// tk.js — a Tk essence for tcl.js, rendered with native HTML controls.
//
// Where mini-tcl's tk.lua draws every widget on a canvas and runs its own frame
// loop, this layer maps each Tk widget to a real DOM element (<button>, <input>,
// <input type=range>, …) and lets the browser own layout (CSS flex/grid) and the
// event loop. It is pure additions to tcl.js's open command registry — the
// interpreter core never learns about the DOM.
//
// Authentic Tk surface:
//   frame/label/button/entry/checkbutton/radiobutton/scale  (creation)
//   pack / grid                                              (geometry)
//   bind / focus / winfo / wm / update / destroy             (control)
// Each widget path (".b") also becomes a command: ".b configure -text X",
// ".b cget -text", ".b invoke", entry get/insert/delete, scale get/set.

(function (root) {
    "use strict";

    var Tcl = root.Tcl;
    if (!Tcl) throw new Error("tk.js requires tcl.js to be loaded first");
    var OK = Tcl.codes.OK, ERROR = Tcl.codes.ERROR;
    var cmds = Tcl.commands;
    var globals = Tcl.globals;

    // ---- widget store ------------------------------------------------------
    var W = {};                      // path -> widget record
    var byVar = {};                  // tcl var name -> [widget, ...] bound to it
    var rootEl = null;               // DOM container for "." (set via Tk.setRoot)

    var root_ = {
        cls: "toplevel", path: ".", opts: { title: "wish" },
        children: [], el: null, manager: null,
    };
    W["."] = root_;

    function num(x) { var n = Number(x); return isNaN(n) ? 0 : n; }
    function truthy(v) { return Tcl.isTrue(v); }

    function parentOf(path) {
        if (path === ".") return null;
        var dot = path.lastIndexOf(".");
        if (dot <= 0) return ".";
        return path.slice(0, dot);
    }

    // -opt val -opt val ... starting at index `start` of a words array.
    function parseOpts(words, start, opts) {
        for (var i = start; i < words.length; i += 2) {
            var k = String(words[i]).replace(/^-/, "");
            opts[k] = words[i + 1];
        }
    }

    // Caption to show: -textvariable (live) wins over a static -text, as in Tk.
    function shownText(w) {
        var v = w.opts.textvariable;
        if (v) return String(globals[v] !== undefined ? globals[v] : "");
        return String(w.opts.text || "");
    }

    // ---- variable binding --------------------------------------------------
    // Register/unregister a widget against the tcl var it mirrors.
    function bindVar(w, name) {
        if (!name) return;
        (byVar[name] = byVar[name] || []).push(w);
        if (globals[name] === undefined) {
            // seed the variable so reads don't error, mirroring Tk's behaviour of
            // creating the variable when a widget is linked to it.
            globals[name] = (w.cls === "scale") ? String(num(w.opts.from)) : "";
        }
    }

    // Push a tcl var's value into every widget bound to it (Tcl -> DOM).
    function syncVar(name) {
        var list = byVar[name];
        if (!list) return;
        for (var i = 0; i < list.length; i++) refresh(list[i]);
    }

    // Pull a control's current value into the tcl var (DOM -> Tcl), then sync any
    // siblings bound to the same variable and run reconcile hooks.
    function writeVar(name, value) {
        if (!name) return;
        globals[name] = value;
        if (Tcl.onVarWrite) Tcl.onVarWrite(globals, name, value);
        syncVar(name);
    }

    // The interpreter calls this whenever a variable is written from a script; we
    // refresh widgets so `set n 5` in the REPL moves the matching control live.
    Tcl.onVarWrite = function (frame, name) {
        if (byVar[name]) syncVar(name);
    };

    // ---- DOM creation per widget class ------------------------------------
    function makeEl(w) {
        var o = w.opts, el;
        switch (w.cls) {
            case "frame":
                el = document.createElement("div");
                el.className = "tk-frame";
                break;
            case "label":
                el = document.createElement("span");
                el.className = "tk-label";
                bindVar(w, o.textvariable);   // live updates when the var changes
                break;
            case "button":
                el = document.createElement("button");
                el.className = "tk-button";
                el.type = "button";
                el.addEventListener("click", function () { invokeCommand(w); });
                bindVar(w, o.textvariable);
                break;
            case "entry":
                el = document.createElement("input");
                el.className = "tk-entry";
                el.type = "text";
                if (o.width) el.size = num(o.width);
                el.addEventListener("input", function () {
                    if (o.textvariable) writeVar(o.textvariable, el.value);
                    else o.text = el.value;
                });
                bindVar(w, o.textvariable);
                break;
            case "checkbutton":
                el = document.createElement("label");
                el.className = "tk-checkbutton";
                var cb = document.createElement("input");
                cb.type = "checkbox";
                cb.addEventListener("change", function () {
                    if (o.variable) writeVar(o.variable, cb.checked ? "1" : "0");
                    invokeCommand(w);
                });
                el.appendChild(cb);
                el.appendChild(document.createTextNode(" "));
                el._input = cb;
                el._text = el.appendChild(document.createElement("span"));
                bindVar(w, o.variable);
                break;
            case "radiobutton":
                el = document.createElement("label");
                el.className = "tk-radiobutton";
                var rb = document.createElement("input");
                rb.type = "radio";
                rb.name = "tkvar-" + (o.variable || w.path);
                rb.value = o.value !== undefined ? o.value : "";
                rb.addEventListener("change", function () {
                    if (rb.checked) {
                        if (o.variable) writeVar(o.variable, rb.value);
                        invokeCommand(w);   // -command fires after the var is set
                    }
                });
                el.appendChild(rb);
                el.appendChild(document.createTextNode(" "));
                el._input = rb;
                el._text = el.appendChild(document.createElement("span"));
                bindVar(w, o.variable);
                break;
            case "scale":
                el = document.createElement("input");
                el.className = "tk-scale";
                el.type = "range";
                el.min = num(o.from); el.max = num(o.to);
                if (o.orient === "vertical") el.classList.add("vertical");
                el.addEventListener("input", function () {
                    if (o.variable) writeVar(o.variable, el.value);
                });
                bindVar(w, o.variable);
                break;
            case "canvas":
                el = document.createElement("canvas");
                el.className = "tk-canvas";
                el.width = num(o.width) || 200;
                el.height = num(o.height) || 120;
                w.ctx = el.getContext("2d");
                break;
            default:
                el = document.createElement("div");
        }
        el.dataset.tkPath = w.path;
        return el;
    }

    function invokeCommand(w) {
        var c = w.opts.command;
        if (c) {
            var r = Tcl.evalScript(c, globals);
            if (r[0] === ERROR && Tcl.stdout) Tcl.stdout("error: " + r[1] + "\n");
            Tk.reconcile();
        }
    }

    // ---- reflect option/state changes onto the DOM element ----------------
    function applyStyle(w) {
        var o = w.opts, el = w.el;
        if (!el) return;
        if (o.background) el.style.background = cssColor(o.background);
        if (o.foreground) el.style.color = cssColor(o.foreground);
        if (o.width && (w.cls === "frame" || w.cls === "canvas")) el.style.minWidth = num(o.width) + "px";
        if (o.height && (w.cls === "frame")) el.style.minHeight = num(o.height) + "px";
    }

    // Tk colours are mostly CSS names already; "r g b" triples (from tk.lua-style
    // scripts) become rgb(); leave everything else for the browser to interpret.
    function cssColor(spec) {
        spec = String(spec);
        var m = /^(-?\d+)\s+(-?\d+)\s+(-?\d+)$/.exec(spec);
        if (m) return "rgb(" + m[1] + "," + m[2] + "," + m[3] + ")";
        return spec;
    }

    // Re-render a widget from its options + bound variable (idempotent).
    function refresh(w) {
        var el = w.el, o = w.opts;
        if (!el) return;
        switch (w.cls) {
            case "label":
                el.textContent = shownText(w);
                break;
            case "button":
                el.textContent = shownText(w);
                break;
            case "entry":
                var ev = o.textvariable ? String(globals[o.textvariable] !== undefined ? globals[o.textvariable] : "")
                                        : String(o.text || "");
                if (document.activeElement !== el) el.value = ev;
                break;
            case "checkbutton":
                el._text.textContent = shownText(w);
                el._input.checked = o.variable ? truthy(globals[o.variable]) : truthy(o.text);
                break;
            case "radiobutton":
                el._text.textContent = shownText(w);
                el._input.checked = o.variable && String(globals[o.variable]) === String(o.value || "");
                break;
            case "scale":
                var sv = o.variable ? num(globals[o.variable]) : num(o.from);
                if (document.activeElement !== el) el.value = sv;
                break;
        }
        applyStyle(w);
    }

    // Refresh every widget (cheap; called after each top-level eval).
    var Tk = {
        widgets: W, byVar: byVar,
        setRoot: function (el) { rootEl = el; root_.el = el; el.className = (el.className + " tk-toplevel").trim(); },
        reconcile: function () { for (var p in W) if (p !== "." && W[p].el) refresh(W[p]); },
        reset: function () {
            for (var p in W) {
                if (p === ".") continue;
                if (W[p].el && W[p].el.parentNode) W[p].el.parentNode.removeChild(W[p].el);
                delete cmds[p];     // drop the widget's path command too
                delete W[p];
            }
            for (var v in byVar) delete byVar[v];
            root_.children = []; root_.manager = null;
            if (rootEl) rootEl.innerHTML = "";
        },
    };

    // ---- geometry: pack -> flexbox ----------------------------------------
    function packApply(parent) {
        var pel = parent.el;
        if (!pel) return;
        pel.style.display = "flex";
        // direction is set by the first packed child's side (Tk packs into a cavity;
        // a single flex axis is the honest browser-native approximation).
        var kids = parent.children.map(function (p) { return W[p]; }).filter(function (k) { return k && k.manager === "pack"; });
        var firstSide = kids.length ? (kids[0].packopts.side || "top") : "top";
        var vertical = (firstSide === "top" || firstSide === "bottom");
        pel.style.flexDirection = vertical
            ? (firstSide === "bottom" ? "column-reverse" : "column")
            : (firstSide === "right" ? "row-reverse" : "row");
        pel.style.alignItems = "center";

        kids.forEach(function (k) {
            var po = k.packopts, el = k.el;
            el.style.flexGrow = truthy(po.expand) ? "1" : "0";
            el.style.flexShrink = "0";
            var fill = po.fill || "none";
            if (vertical) {
                el.style.alignSelf = (fill === "x" || fill === "both") ? "stretch" : "";
                el.style.width = (fill === "x" || fill === "both") ? "auto" : "";
            } else {
                el.style.alignSelf = (fill === "y" || fill === "both") ? "stretch" : "";
            }
            el.style.margin = (num(po.pady)) + "px " + (num(po.padx)) + "px";
            if (k.children && k.children.length) layoutChildren(k);
        });
    }

    // ---- geometry: grid -> CSS grid ---------------------------------------
    function gridApply(parent) {
        var pel = parent.el;
        if (!pel) return;
        pel.style.display = "grid";
        pel.style.gap = "4px";
        var kids = parent.children.map(function (p) { return W[p]; }).filter(function (k) { return k && k.manager === "grid"; });
        kids.forEach(function (k) {
            var go = k.gridopts, el = k.el;
            var r = num(go.row), c = num(go.column);
            var cs = Math.max(1, num(go.columnspan));
            var rs = Math.max(1, num(go.rowspan));
            el.style.gridRow = (r + 1) + " / span " + rs;
            el.style.gridColumn = (c + 1) + " / span " + cs;
            var st = String(go.sticky || "");
            var ew = st.indexOf("e") >= 0 && st.indexOf("w") >= 0;
            var ns = st.indexOf("n") >= 0 && st.indexOf("s") >= 0;
            el.style.justifySelf = ew ? "stretch" : (st.indexOf("e") >= 0 ? "end" : (st.indexOf("w") >= 0 ? "start" : "center"));
            el.style.alignSelf = ns ? "stretch" : (st.indexOf("s") >= 0 ? "end" : (st.indexOf("n") >= 0 ? "start" : "center"));
            el.style.margin = num(go.pady) + "px " + num(go.padx) + "px";
            if (k.children && k.children.length) layoutChildren(k);
        });
    }

    function layoutChildren(parent) {
        var mgr = null;
        for (var i = 0; i < parent.children.length; i++) {
            var k = W[parent.children[i]];
            if (k && k.manager) { mgr = k.manager; break; }
        }
        if (mgr === "pack") packApply(parent);
        else if (mgr === "grid") gridApply(parent);
    }

    // Attach a managed child's DOM node under its parent and (re)apply layout.
    function placeInParent(w) {
        var parent = W[w.parent] || root_;
        if (!parent.el) return;       // parent not realised yet (rare)
        if (w.el.parentNode !== parent.el) parent.el.appendChild(w.el);
        layoutChildren(parent);
    }

    // ---- per-widget command -----------------------------------------------
    function canvasSub(w, words) {
        // words: [path, subcommand, ...] — 0-based.
        var sub = words[1];
        if (sub === "create") {
            var kind = words[2], ctx = w.ctx;
            if (!ctx) return [OK, ""];
            if (kind === "text") {
                var o = {}; parseOpts(words, 5, o);
                ctx.fillStyle = cssColor(o.fill || "black");
                ctx.fillText(String(o.text || ""), num(words[3]), num(words[4]));
            } else {
                var o2 = {}; parseOpts(words, 7, o2);
                ctx.fillStyle = cssColor(o2.fill || "gray");
                ctx.strokeStyle = ctx.fillStyle;
                var x1 = num(words[3]), y1 = num(words[4]), x2 = num(words[5]), y2 = num(words[6]);
                if (kind === "rectangle") ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                else if (kind === "line") { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
            }
            w.items = (w.items || 0) + 1;
            return [OK, String(w.items)];
        } else if (sub === "delete") {
            if (w.ctx) w.ctx.clearRect(0, 0, w.el.width, w.el.height);
            w.items = 0;
            return [OK, ""];
        }
        return [OK, ""];
    }

    function registerWidgetCommand(path) {
        cmds[path] = function (words) {
            var w = W[path];
            if (!w) return [ERROR, 'bad window path name "' + path + '"'];
            var sub = words[1];
            if (sub === "configure" || sub === "config" || sub === "conf") {
                parseOpts(words, 2, w.opts);
                // re-bind variables if -textvariable/-variable changed
                if (w.opts.textvariable) bindVar(w, w.opts.textvariable);
                if (w.opts.variable) bindVar(w, w.opts.variable);
                refresh(w);
                return [OK, ""];
            } else if (sub === "cget") {
                var key = String(words[2] || "").replace(/^-/, "");
                return [OK, String(w.opts[key] !== undefined ? w.opts[key] : "")];
            } else if (sub === "invoke") {
                invokeCommand(w);
                return [OK, ""];
            } else if (w.cls === "entry") {
                if (sub === "get") return [OK, w.el ? w.el.value : ""];
                if (sub === "delete") { if (w.el) w.el.value = ""; if (w.opts.textvariable) writeVar(w.opts.textvariable, ""); return [OK, ""]; }
                if (sub === "insert") { if (w.el) { w.el.value += String(words[3] || ""); if (w.opts.textvariable) writeVar(w.opts.textvariable, w.el.value); } return [OK, ""]; }
            } else if (w.cls === "scale") {
                if (sub === "get") return [OK, w.el ? String(w.el.value) : "0"];
                if (sub === "set") { if (w.opts.variable) writeVar(w.opts.variable, String(words[2])); else if (w.el) w.el.value = num(words[2]); return [OK, ""]; }
            } else if (w.cls === "canvas") {
                return canvasSub(w, words);
            }
            return [OK, ""];
        };
    }

    // ---- creation commands -------------------------------------------------
    function maker(cls, defaults) {
        return function (words) {
            var path = words[1];
            if (!path) return [ERROR, 'wrong # args: should be "' + cls + ' pathName ?-option value ...?"'];
            var w = { cls: cls, path: path, opts: {}, children: [], el: null,
                      parent: parentOf(path), manager: null };
            for (var k in defaults) w.opts[k] = defaults[k];
            parseOpts(words, 2, w.opts);
            W[path] = w;
            var parent = W[w.parent];
            if (parent) parent.children.push(path);
            w.el = makeEl(w);
            registerWidgetCommand(path);
            refresh(w);
            return [OK, path];
        };
    }

    cmds["frame"]       = maker("frame", {});
    cmds["label"]       = maker("label", { text: "" });
    cmds["button"]      = maker("button", { text: "", command: "" });
    cmds["entry"]       = maker("entry", { textvariable: "", text: "", width: 15 });
    cmds["checkbutton"] = maker("checkbutton", { text: "", variable: "", command: "" });
    cmds["radiobutton"] = maker("radiobutton", { text: "", variable: "", value: "", command: "" });
    cmds["scale"]       = maker("scale", { from: 0, to: 100, variable: "", orient: "horizontal" });
    cmds["canvas"]      = maker("canvas", { width: 200, height: 120 });

    // ---- geometry commands -------------------------------------------------
    cmds["pack"] = function (words) {
        var paths = [], i = 1;
        while (words[i] && String(words[i]).charAt(0) !== "-") { paths.push(words[i]); i++; }
        var po = { side: "top", fill: "none", expand: "0", padx: "0", pady: "0" };
        parseOpts(words, i, po);
        for (var p = 0; p < paths.length; p++) {
            var w = W[paths[p]];
            if (w) {
                w.manager = "pack";
                w.packopts = {};
                for (var k in po) w.packopts[k] = po[k];
                placeInParent(w);
            }
        }
        return [OK, ""];
    };

    cmds["grid"] = function (words) {
        var paths = [], i = 1;
        while (words[i] && String(words[i]).charAt(0) !== "-") { paths.push(words[i]); i++; }
        var go = { row: "0", column: "0", sticky: "", columnspan: "1", rowspan: "1", padx: "0", pady: "0" };
        parseOpts(words, i, go);
        for (var p = 0; p < paths.length; p++) {
            var w = W[paths[p]];
            if (w) { w.manager = "grid"; w.gridopts = {}; for (var k in go) w.gridopts[k] = go[k]; placeInParent(w); }
        }
        return [OK, ""];
    };

    // ---- control commands --------------------------------------------------
    // Tk virtual events -> DOM events, with a small %-substitution set.
    var EVENT_MAP = {
        "<Button-1>": "click", "<ButtonPress-1>": "mousedown", "<ButtonRelease-1>": "mouseup",
        "<Motion>": "mousemove", "<Enter>": "mouseenter", "<Leave>": "mouseleave",
        "<Key>": "keydown", "<KeyPress>": "keydown", "<KeyRelease>": "keyup",
        "<Return>": "keydown", "<FocusIn>": "focus", "<FocusOut>": "blur",
    };

    function substEvent(script, e, w) {
        return script.replace(/%([xyKAW])/g, function (_, ch) {
            if (ch === "x") return String(e.offsetX || 0);
            if (ch === "y") return String(e.offsetY || 0);
            if (ch === "K") return e.key || "";
            if (ch === "A") return (e.key && e.key.length === 1) ? e.key : "";
            if (ch === "W") return w.path;
            return "";
        });
    }

    cmds["bind"] = function (words) {
        var path = words[1], event = words[2], script = words[3];
        var w = W[path];
        if (!w || !w.el) return [OK, ""];
        if (script === undefined) return [OK, (w.bindings && w.bindings[event]) || ""];
        w.bindings = w.bindings || {};
        w.bindings[event] = script;
        var domEvent = EVENT_MAP[event] || event.replace(/[<>]/g, "").toLowerCase();
        var onlyReturn = (event === "<Return>");
        w.el.addEventListener(domEvent, function (e) {
            if (onlyReturn && e.key !== "Enter") return;
            var r = Tcl.evalScript(substEvent(script, e, w), globals);
            if (r[0] === ERROR && Tcl.stdout) Tcl.stdout("error: " + r[1] + "\n");
            Tk.reconcile();
        });
        return [OK, ""];
    };

    cmds["focus"] = function (words) {
        if (words[1]) { var w = W[words[1]]; if (w && w.el) w.el.focus(); return [OK, ""]; }
        var a = document.activeElement;
        return [OK, a && a.dataset ? (a.dataset.tkPath || "") : ""];
    };

    cmds["winfo"] = function (words) {
        var q = words[1], path = words[2], w = W[path];
        if (q === "exists") return [OK, w ? "1" : "0"];
        if (!w) return [ERROR, 'bad window path name "' + String(path) + '"'];
        var el = w.el;
        if (q === "width") return [OK, String(el ? Math.round(el.offsetWidth) : 0)];
        if (q === "height") return [OK, String(el ? Math.round(el.offsetHeight) : 0)];
        if (q === "x") return [OK, String(el ? Math.round(el.offsetLeft) : 0)];
        if (q === "y") return [OK, String(el ? Math.round(el.offsetTop) : 0)];
        if (q === "class") return [OK, w.cls];
        if (q === "children") return [OK, Tcl.tableToList(w.children)];
        return [OK, ""];
    };

    cmds["wm"] = function (words) {
        var sub = words[1];
        if (sub === "title") {
            if (words[3] !== undefined) { root_.opts.title = words[3]; if (typeof document !== "undefined") document.title = words[3]; return [OK, ""]; }
            return [OK, root_.opts.title || ""];
        } else if (sub === "geometry") {
            var geo = words[3];
            if (geo && rootEl) {
                var m = /^(\d+)x(\d+)/.exec(String(geo));
                if (m) { rootEl.style.width = m[1] + "px"; rootEl.style.height = m[2] + "px"; }
            }
            return [OK, ""];
        }
        return [OK, ""];
    };

    // DOM is retained-mode and event-driven: these just reconcile and return.
    cmds["update"] = function () { Tk.reconcile(); return [OK, ""]; };
    cmds["tkwait"] = function () { Tk.reconcile(); return [OK, ""]; };
    cmds["mainloop"] = function () { return [OK, ""]; };

    cmds["destroy"] = function (words) {
        var path = words[1], w = W[path];
        if (!w) return [OK, ""];
        if (w.el && w.el.parentNode) w.el.parentNode.removeChild(w.el);
        // detach from parent + drop bindings, var links, and the path command
        var parent = W[w.parent];
        if (parent) parent.children = parent.children.filter(function (p) { return p !== path; });
        for (var v in byVar) byVar[v] = byVar[v].filter(function (x) { return x !== w; });
        delete cmds[path];
        delete W[path];
        return [OK, ""];
    };

    root.Tk = Tk;
    if (typeof module !== "undefined" && module.exports) module.exports = Tk;

})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));

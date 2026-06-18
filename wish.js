// wish.js — bootstraps the browser wish shell.
//
// Wires tcl.js + tk.js to the page: routes `puts` output to the console pane,
// points Tk's root at #tk-root, and runs REPL lines / script blocks through
// Tcl.evalScript, reconciling the native widgets after each evaluation.
(function () {
    "use strict";

    var output = document.getElementById("repl-output");
    var form = document.getElementById("repl-form");
    var input = document.getElementById("repl-input");
    var scriptForm = document.getElementById("wish-script-form");
    var scriptBox = document.getElementById("wish-script");

    function append(text, cls) {
        var span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        output.appendChild(span);
        output.scrollTop = output.scrollHeight;
    }

    // Route Tcl `puts` into the console pane.
    Tcl.stdout = function (s) { append(s, "result"); };

    // Clear-console button in the Console card header.
    document.getElementById("clear-console-btn").addEventListener("click", function () { output.textContent = ""; });

    // The screen where native widgets live becomes the "." toplevel.
    Tk.setRoot(document.getElementById("tk-root"));

    // ---- generalized "what happens" action --------------------------------
    // Every reset-ish action is a choice over four consequences plus an optional
    // re-run. The named presets are just defaults the user can tweak (e.g. a
    // re-run that keeps variables: {widgets, run} without {vars}).
    var PRESETS = {
        clear:   { widgets: 1, vars: 0, procs: 0, consoleOut: 0, run: 0 },
        reset:   { widgets: 1, vars: 1, procs: 1, consoleOut: 1, run: 0 },
        replace: { widgets: 1, vars: 1, procs: 1, consoleOut: 1, run: 1 },
    };

    // Snapshot the pristine command set (tcl builtins + tk + the `wish` command,
    // before any user proc exists) so "clear procs" restores it exactly.
    var baseCommands = null;

    // Scriptable twin of the panel: `wish clear|reset|replace` runs a preset (and
    // loads it into the checkboxes so the consequences are visible); `wish apply`
    // runs whatever the checkboxes currently say.
    Tcl.commands["wish"] = function (words) {
        var sub = words[1];
        if (PRESETS[sub]) { loadPreset(sub); applyAction(PRESETS[sub]); return [Tcl.codes.OK, ""]; }
        if (sub === "apply") { applyAction(readChecks()); return [Tcl.codes.OK, ""]; }
        return [Tcl.codes.ERROR, 'bad wish action "' + String(sub) + '": want clear, reset, replace or apply'];
    };
    baseCommands = {};
    for (var c in Tcl.commands) baseCommands[c] = Tcl.commands[c];

    function applyAction(opts) {
        if (opts.consoleOut) output.textContent = "";
        if (opts.widgets) Tk.reset();
        if (opts.vars) for (var v in Tcl.globals) delete Tcl.globals[v];
        if (opts.procs) {
            // drop user-defined commands, but keep path commands of widgets still
            // on screen; then restore any builtin the user had overridden.
            for (var k in Tcl.commands) if (!baseCommands[k] && !Tk.widgets[k]) delete Tcl.commands[k];
            for (var b in baseCommands) Tcl.commands[b] = baseCommands[b];
        }
        if (opts.run) runScript();
        var did = [];
        if (opts.widgets) did.push("widgets");
        if (opts.vars) did.push("variables");
        if (opts.procs) did.push("procs");
        if (opts.consoleOut) did.push("console");
        var msg = did.length ? ("cleared " + did.join(", ")) : "kept all state";
        if (opts.run) msg += " — then ran script";
        append(msg + "\n", "banner");
    }

    // ---- the interactive Actions panel ------------------------------------
    var CHK = { widgets: "chk-widgets", vars: "chk-vars", procs: "chk-procs",
                consoleOut: "chk-console", run: "chk-run" };
    function readChecks() {
        var o = {};
        for (var key in CHK) o[key] = document.getElementById(CHK[key]).checked ? 1 : 0;
        return o;
    }
    var presetButtons = document.querySelectorAll("#actions .presets button[data-preset]");

    // Light up the preset whose consequence set exactly matches the current
    // checkboxes; none if the state is a custom tweak. Kept in sync from every
    // path that can change the state (presets, scripted `wish`, manual ticks).
    function highlightActivePreset() {
        var cur = readChecks();
        for (var b = 0; b < presetButtons.length; b++) {
            var p = PRESETS[presetButtons[b].getAttribute("data-preset")];
            var match = true;
            for (var key in CHK) if ((p[key] ? 1 : 0) !== cur[key]) { match = false; break; }
            presetButtons[b].classList.toggle("active", match);
        }
    }

    function loadPreset(name) {
        var p = PRESETS[name];
        for (var key in CHK) document.getElementById(CHK[key]).checked = !!p[key];
        highlightActivePreset();
    }
    for (var i = 0; i < presetButtons.length; i++) {
        presetButtons[i].addEventListener("click", function () { loadPreset(this.getAttribute("data-preset")); });
    }
    // tweaking any checkbox re-syncs the highlight (matches a preset, or none)
    for (var ck in CHK) document.getElementById(CHK[ck]).addEventListener("change", highlightActivePreset);
    function applyFromChecks() { applyAction(readChecks()); }
    document.getElementById("apply-btn").addEventListener("click", applyFromChecks);
    // a second Apply button sits next to "Run script" for convenience (same action)
    var applyBtn2 = document.getElementById("apply-btn-2");
    if (applyBtn2) applyBtn2.addEventListener("click", applyFromChecks);
    loadPreset("replace");   // default selection on load

    // Evaluate one chunk of Tcl, print its value/error, refresh widgets.
    function evalTcl(src) {
        var res = Tcl.evalScript(src, Tcl.globals);
        Tk.reconcile();
        var code = res[0], val = res[1];
        if (code === Tcl.codes.ERROR) append("error: " + val + "\n", "error");
        else if (code !== Tcl.codes.OK) append('error: invoked "break"/"continue" outside of a loop\n', "error");
        else if (val !== undefined && val !== "") append(val + "\n", "result");
    }

    append("wish — Tcl/Tk in JavaScript. Type commands below, one per line.\n", "banner");

    // ---- REPL line ----
    var history = [], histPos = 0;
    form.addEventListener("submit", function (e) {
        e.preventDefault();
        var line = input.value;
        if (!line.trim()) return;
        history.push(line); histPos = history.length;
        append("% " + line + "\n", "echo");
        evalTcl(line);
        input.value = "";
    });
    input.addEventListener("keydown", function (e) {
        if (e.key === "ArrowUp") {
            if (histPos > 0) { histPos--; input.value = history[histPos]; }
            e.preventDefault();
        } else if (e.key === "ArrowDown") {
            if (histPos < history.length - 1) { histPos++; input.value = history[histPos]; }
            else { histPos = history.length; input.value = ""; }
            e.preventDefault();
        }
    });

    // ---- whole-script box ----
    function runScript() {
        var src = scriptBox.value;
        if (!src.trim()) return;
        var n = src.trim().split("\n").length;
        append("% [script: " + n + " line" + (n === 1 ? "" : "s") + "]\n", "echo");
        evalTcl(src);
    }
    scriptForm.addEventListener("submit", function (e) { e.preventDefault(); runScript(); });
    scriptBox.addEventListener("keydown", function (e) {
        if (!e.shiftKey && (e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runScript(); }
    });

    // Shift+Ctrl/Cmd+Enter = the Replace preset (reset + run), so re-running starts
    // clean without stacking duplicate widgets.
    scriptBox.addEventListener("keydown", function (e) {
        if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault(); loadPreset("replace"); applyAction(PRESETS.replace);
        }
    });

    // ---- example picker ----------------------------------------------------
    // Loads examples/*.tcl into the script box. Uses fetch, which works when the
    // page is served over http; on file:// (where browsers block fetch of local
    // files) the picker disables itself and points the user at a static server.
    // The manifest is hand-maintained — fetch can't enumerate a directory; add a
    // line here when you drop a new file in examples/.
    var EXAMPLES = [
        { file: "examples/hello.tcl",       title: "Hello (label + button)" },
        { file: "examples/counter.tcl",     title: "Counter (button + label)" },
        { file: "examples/form.tcl",        title: "Form (grid settings)" },
        { file: "examples/temperature.tcl", title: "Temperature (slider + proc)" },
        { file: "examples/options.tcl",     title: "Options (radio + check)" },
        { file: "examples/events.tcl",      title: "Taps (bind + %subst)" },
        { file: "examples/paint.tcl",       title: "Paint (canvas)" },
        { file: "examples/palette.tcl",     title: "Palette (foreach + bind + live swatch)" },
    ];
    // Class-based so there can be one or several pickers; duplicates stay in sync.
    var exSelects = document.querySelectorAll(".example-select");
    var exLoads = document.querySelectorAll(".example-load");
    var exHints = document.querySelectorAll(".example-hint");
    exSelects.forEach(function (sel) {
        EXAMPLES.forEach(function (ex) {
            var opt = document.createElement("option");
            opt.value = ex.file; opt.textContent = ex.title;
            sel.appendChild(opt);
        });
    });
    function setAllSelects(file) { exSelects.forEach(function (s) { s.value = file; }); }

    if (location.protocol === "file:") {
        exSelects.forEach(function (s) { s.disabled = true; });
        exLoads.forEach(function (b) { b.disabled = true; });
        exHints.forEach(function (h) { h.textContent = "serve the folder to load examples (file:// blocks fetch) — or paste below"; });
    } else {
        // Fetch the example, mirror the choice to every picker, load it into the
        // script box, then apply cleanly (Replace = reset + run) so it renders fresh.
        function loadAndApply(file) {
            setAllSelects(file);
            fetch(file)
                .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
                .then(function (src) {
                    scriptBox.value = src;
                    append("loaded " + file + " — applying\n", "banner");
                    loadPreset("replace");
                    applyAction(PRESETS.replace);
                })
                .catch(function (e) { append("error: could not load " + file + ": " + e.message + "\n", "error"); });
        }
        exSelects.forEach(function (s) { s.addEventListener("change", function () { loadAndApply(this.value); }); });
        exLoads.forEach(function (b) { b.addEventListener("click", function () { loadAndApply(exSelects[0].value); }); });
    }
})();

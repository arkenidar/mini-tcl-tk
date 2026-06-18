// Headless test of tk.js against a minimal fake DOM (run: node test/tk.test.mjs).
// Exercises widget creation, the per-widget command, variable two-way binding,
// button/-command invocation, pack/grid managers, winfo, and destroy — without a
// real browser. The fake DOM implements only what tk.js touches.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ---- minimal fake DOM --------------------------------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = (tag || "div").toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this._text = "";
        this.classList = {
            _set: new Set(),
            add: (c) => this.classList._set.add(c),
            contains: (c) => this.classList._set.has(c),
        };
        this._listeners = {};
        this.value = "";
        this.checked = false;
        this.offsetWidth = 42; this.offsetHeight = 20; this.offsetLeft = 0; this.offsetTop = 0;
    }
    get className() { return this._className || ""; }
    set className(v) { this._className = v; }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children = []; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
    dispatch(ev, e) { (this._listeners[ev] || []).forEach((fn) => fn(e || {})); }
    focus() { fakeDocument.activeElement = this; }
    getContext() { return { fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, set fillStyle(v) {}, set strokeStyle(v) {} }; }
    set innerHTML(v) { if (v === "") this.children = []; }
}
const fakeDocument = {
    activeElement: null,
    title: "",
    createElement: (t) => new FakeEl(t),
    createTextNode: (t) => { const e = new FakeEl("#text"); e._text = t; return e; },
};
globalThis.window = globalThis;
globalThis.document = fakeDocument;

// ---- load core + toolkit -----------------------------------------------------
const Tcl = require("../tcl.js");
const Tk = require("../tk.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) pass++;
    else { fail++; console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
function ok(cond, label) { eq(!!cond, true, label); }

const out = [];
Tcl.stdout = (s) => out.push(s);
function run(src) { out.length = 0; const r = Tcl.evalScript(src, Tcl.globals); Tk.reconcile(); return { code: r[0], val: r[1], out: out.join("") }; }

const rootEl = new FakeEl("div");
Tk.setRoot(rootEl);

// ---- widget creation + path command -----------------------------------------
run("button .b -text Hi -command {incr n}");
ok(Tk.widgets[".b"], "button created in store");
eq(Tk.widgets[".b"].el.tagName, "BUTTON", "button is a <button>");
eq(Tk.widgets[".b"].el.textContent, "Hi", "button label rendered");
eq(run(".b cget -text").val, "Hi", "cget -text");
run(".b configure -text Bye");
eq(Tk.widgets[".b"].el.textContent, "Bye", "configure updates label");

// ---- button -command invocation (DOM click -> tcl) --------------------------
run("set n 0; label .out -textvariable n");
Tk.widgets[".b"].el.dispatch("click");
Tk.widgets[".b"].el.dispatch("click");
eq(Tcl.globals.n, "2", "two clicks ran {incr n} twice");
eq(Tk.widgets[".out"].el.textContent, "2", "label reflects -textvariable after clicks");

// ---- entry two-way binding ---------------------------------------------------
run("entry .e -textvariable who");
Tk.widgets[".e"].el.value = "ada";
Tk.widgets[".e"].el.dispatch("input");
eq(Tcl.globals.who, "ada", "DOM edit writes the tcl var (DOM->Tcl)");
run("set who lovelace");
eq(Tk.widgets[".e"].el.value, "lovelace", "set var updates the entry (Tcl->DOM)");

// ---- checkbutton -------------------------------------------------------------
run("checkbutton .c -text on -variable flag");
Tk.widgets[".c"].el._input.checked = true;
Tk.widgets[".c"].el._input.dispatch("change");
eq(Tcl.globals.flag, "1", "checkbutton toggles its -variable");
run("set flag 0");
eq(Tk.widgets[".c"].el._input.checked, false, "clearing the var unchecks the box");

// ---- radiobutton / checkbutton -command --------------------------------------
run('set log ""');
run('radiobutton .ra -text a -variable grp -value a -command {append log ra}');
Tk.widgets[".ra"].el._input.checked = true;
Tk.widgets[".ra"].el._input.dispatch("change");
eq(Tcl.globals.grp, "a", "radiobutton selects its -value");
eq(Tcl.globals.log, "ra", "radiobutton -command runs on select");
run('checkbutton .ck -text x -variable cv -command {append log ck}');
Tk.widgets[".ck"].el._input.checked = true;
Tk.widgets[".ck"].el._input.dispatch("change");
eq(Tcl.globals.log, "rack", "checkbutton -command runs on toggle");

// ---- scale -------------------------------------------------------------------
run("scale .s -from 0 -to 100 -variable v");
run(".s set 50");
eq(Tcl.globals.v, "50", "scale set writes the var");
eq(Tk.widgets[".s"].el.value, 50, "scale thumb reflects the var");
// a label bound to the same var must update live on a slider drag (no reconcile)
run("label .sv -textvariable v");
Tk.widgets[".s"].el.value = 63;
Tk.widgets[".s"].el.dispatch("input");
eq(Tk.widgets[".sv"].el.textContent, "63", "label follows scale drag live (no eval)");

// ---- canvas create/delete (0-based subcommand indexing) ----------------------
run("canvas .cv -width 100 -height 60");
eq(run(".cv create rectangle 0 0 20 20 -fill red").val, "1", "canvas create returns item id");
eq(run(".cv create text 10 10 -text hi -fill white").val, "2", "canvas create text increments id");
eq(run(".cv delete all").code, Tcl.codes.OK, "canvas delete ok");
eq(run(".cv create line 0 0 5 5").val, "1", "canvas item id resets after delete");

// ---- pack / grid managers ----------------------------------------------------
run("pack .b -side top");
eq(rootEl.style.display, "flex", "pack makes parent a flex container");
eq(Tk.widgets[".b"].manager, "pack", "widget records pack manager");
run("frame .f");
run("pack .f -side top");
run("grid [label .f.g -text cell] -row 1 -column 2");
// .f.g's parent is the grid-managed frame .f (a parent must not mix managers)
eq(Tk.widgets[".f"].el.style.display, "grid", "grid makes parent a grid container");
ok(Tk.widgets[".f.g"].el.style.gridRow.indexOf("2") >= 0, "grid row maps r+1");
ok(Tk.widgets[".f.g"].el.style.gridColumn.indexOf("3") >= 0, "grid column maps c+1");

// ---- winfo / wm --------------------------------------------------------------
eq(run("winfo exists .b").val, "1", "winfo exists yes");
eq(run("winfo exists .nope").val, "0", "winfo exists no");
eq(run("winfo class .e").val, "entry", "winfo class");
run("wm title . {Hello wish}");
eq(fakeDocument.title, "Hello wish", "wm title sets document.title");

// ---- destroy -----------------------------------------------------------------
run("destroy .b");
eq(run("winfo exists .b").val, "0", "destroy removes the widget");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

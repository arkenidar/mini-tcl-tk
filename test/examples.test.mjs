// Evaluates every examples/*.tcl through tcl.js + tk.js against a fake DOM and
// asserts each runs clean (run: node test/examples.test.mjs). New examples are
// picked up automatically — this guards the example set as it grows.

import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const base = fileURLToPath(new URL("../", import.meta.url));

// ---- minimal fake DOM (only what tk.js touches) ------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = (tag || "div").toUpperCase();
        this.children = []; this.parentNode = null; this.style = {}; this.dataset = {};
        this._text = ""; this._listeners = {}; this.value = ""; this.checked = false;
        this.width = 0; this.height = 0;
        this.offsetWidth = 10; this.offsetHeight = 10; this.offsetLeft = 0; this.offsetTop = 0;
        this.classList = { _s: new Set(), add: (c) => this.classList._s.add(c), contains: (c) => this.classList._s.has(c) };
    }
    get className() { return this._c || ""; } set className(v) { this._c = v; }
    get textContent() { return this._text; } set textContent(v) { this._text = String(v); this.children = []; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
    addEventListener() {} focus() {}
    getContext() { return { fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {}, set fillStyle(v) {}, set strokeStyle(v) {} }; }
    set innerHTML(v) { if (v === "") this.children = []; }
}
globalThis.window = globalThis;
globalThis.document = { activeElement: null, title: "",
    createElement: (t) => new FakeEl(t), createTextNode: (t) => { const e = new FakeEl("#text"); e._text = t; return e; } };

const Tcl = require(base + "tcl.js");
const Tk = require(base + "tk.js");
Tcl.stdout = () => {};
Tk.setRoot(new FakeEl("div"));

let fails = 0, n = 0;
for (const f of readdirSync(base + "examples").filter((x) => x.endsWith(".tcl")).sort()) {
    Tk.reset();
    for (const v in Tcl.globals) delete Tcl.globals[v];   // a fresh first-run for each
    const [code, val] = Tcl.evalScript(readFileSync(base + "examples/" + f, "utf8"), Tcl.globals);
    Tk.reconcile();
    n++;
    if (code === Tcl.codes.OK) console.log("OK  examples/" + f);
    else { console.error("ERR examples/" + f + ": " + val); fails++; }
}
console.log(`\n${n - fails}/${n} examples evaluate clean`);
process.exit(fails ? 1 : 0);

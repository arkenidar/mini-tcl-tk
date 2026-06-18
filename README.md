# wish — Tcl/Tk in JavaScript, with native HTML controls

An interactive **Tcl/Tk shell that runs entirely in the browser**: a Tcl interpreter
written in JavaScript (`tcl.js`) drives a Tk widget toolkit (`tk.js`) that renders
**real native HTML controls** — `<button>`, `<input>`, `<input type=range>`,
`<input type=checkbox>` — laid out with CSS flexbox / grid.

No Lua, no WebAssembly, no bundler, no dependencies, no build step. Open `wish.html`
and type Tk commands.

```
% button .b -text "Click me" -command {incr n}
% label .out -textvariable n
% set n 0
% pack .b -side top
% pack .out -side top
```

## Run it

- **Browser:** open `wish.html` directly (works over `file://` — everything is plain
  `<script src>`, no modules). Or serve the folder with any static server.
- **Interpreter tests (headless):** `node test/tcl.test.mjs`
- **Toolkit tests (fake-DOM, headless):** `node test/tk.test.mjs`
- **In VS Code:** press F5 → *Open wish (integrated browser)* (or *Debug wish (Chrome)*
  for breakpoints). Both start a `python3 -m http.server` task first. See `.vscode/`.

Type one command per line in the console, or paste a whole script into the script box
and press **Run** (Ctrl/Cmd+Enter also runs). See `examples/counter.tcl` and
`examples/form.tcl`.

### Loading examples

The **Example** picker above the script box loads an `examples/*.tcl` file into the
box **and applies it** (a clean Replace: reset + run, so it renders fresh). It uses
`fetch`, so it works when the page is **served over http** (e.g. `python3 -m http.server` then open `http://localhost:8000/wish.html`).
Over `file://`, browsers block `fetch` of local files, so the picker disables itself —
the inline default demo and everything else still works; just paste a script manually.

To add an example: drop a `.tcl` into `examples/` and add one line to the `EXAMPLES`
manifest near the bottom of `wish.js` (a directory can't be listed via `fetch`).

### Actions panel — choose the consequences

No page reload is needed and your script box is kept. Instead of fixed buttons, the
**Actions** panel exposes the *consequences* of a reset as checkboxes so you can see
and tweak them:

- `clear widgets` · `clear variables` · `clear procs` · `clear console` · `run script after`

The preset buttons just load defaults into those checkboxes, then you press **Apply**:

| Preset | widgets | variables | procs | console | run after |
|--------|:--:|:--:|:--:|:--:|:--:|
| **Clear screen** | ✓ | — | — | — | — |
| **Reset**        | ✓ | ✓ | ✓ | ✓ | — |
| **Replace**      | ✓ | ✓ | ✓ | ✓ | ✓ |

Tweak from a preset for in-between behaviours — e.g. uncheck *clear variables* and
check *run script after* for a **re-run that keeps state**. The same is scriptable
from the console or a script: `wish clear`, `wish reset`, `wish replace`, or
`wish apply` (runs the current checkbox selection). Shift+Ctrl/Cmd+Enter in the script
box applies the Replace preset.

## How it fits together

| File | Role |
|------|------|
| `tcl.js`   | The Tcl interpreter. An open command registry (`Tcl.commands[name] = (words, frame) => [code, value]`); the core knows nothing about the DOM. A faithful JS port of [`mini-tcl.lua`](../../service/mini-tcl.lua). |
| `tk.js`    | The Tk essence. Registers widget/geometry/control commands that create and manage **native DOM elements**. Pure additions to the registry. |
| `wish.html`/`wish.js`/`style.css` | The shell: a "screen" where widgets appear, plus a REPL and a script box. |

`tcl.js` is independent of `tk.js` — you can embed the interpreter on its own.

## Supported Tcl

`set unset append incr expr if while for foreach break continue return proc global
eval catch error string list llength lindex lappend lrange split join info puts`.
`expr` includes `**`, ternary `?:`, `eq`/`ne`, and the usual math functions.

## Supported Tk

- **Widgets:** `frame label button entry checkbutton radiobutton scale canvas`
- **Geometry:** `pack` (→ flexbox), `grid` (→ CSS grid)
- **Per-widget:** `.w configure -opt val`, `.w cget -opt`, `.w invoke`; entry
  `get/insert/delete`; scale `get/set`; canvas `create/delete`
- **Control:** `bind`, `focus`, `winfo`, `wm`, `update`, `destroy`
- **Variable binding:** `-textvariable` / `-variable` are two-way live links between a
  Tcl global and the control (edit the control → the var updates; `set v 50` in the
  REPL → the control moves).

## Design notes & limitations

- **DOM is retained-mode and event-driven**, so there is no render loop: `update` /
  `mainloop` are near no-ops, and `bind`/`-command` map straight to DOM listeners.
- **`pack` is a flexbox approximation** of Tk's cavity packer: the parent's flex axis
  follows the first packed child's `-side`. Don't mix `pack` and `grid` in one parent
  (Tk forbids this too).
- **Not yet implemented:** `listbox text menu spinbox`, `place` geometry, the full
  `bind` `%`-substitution set (only `%x %y %K %A %W`), `trace`, `after`.

## Lineage

This is the "best of js+tcl + best of html+tk" sibling of the canvas/Fengari `wish` in
[`mini-tcl.lua/docs`](../../service/mini-tcl.lua/docs). Same Tk vocabulary; here the
interpreter is native JS and the widgets are native HTML.

// Headless test of the tcl.js interpreter core (run: node test/tcl.test.mjs).
// Assertions are adapted from mini-tcl.lua's tests/smoke.tcl. No browser needed.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Tcl = require("../tcl.js");

let pass = 0, fail = 0;
const out = [];
Tcl.stdout = (s) => out.push(s);

// Run a snippet in a fresh global frame; return [code, value] and captured puts.
function run(src) {
    out.length = 0;
    const [code, val] = Tcl.evalScript(src, Tcl.globals);
    return { code, val, out: out.join("") };
}

function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}

// expr value via a bracket-substituted puts so we read the result string.
function expr(e) { return run(`puts [expr {${e}}]`).out.trimEnd(); }

// ---- expr ----
eq(expr("2 + 3 * 4"), "14", "expr precedence");
eq(expr("(2 + 3) * 4"), "20", "expr parens");
eq(expr("10 / 4.0"), "2.5", "expr float div");
eq(expr("7 % 3"), "1", "expr mod");
eq(expr("2 ** 10"), "1024", "expr power");
eq(expr("1 < 2 && 3 >= 3"), "1", "expr logic");
eq(expr("!0"), "1", "expr not");
eq(expr('"abc" eq "abc"'), "1", "expr eq");
eq(expr('"abc" ne "abd"'), "1", "expr ne");
eq(expr("1 ? 111 : 222"), "111", "expr ternary");
eq(expr("sqrt(16)"), "4", "expr sqrt");
eq(expr("max(3, min(9, 7))"), "7", "expr min/max");
eq(expr("1+2+3"), "6", "expr left-assoc chain");

// ---- set / append / incr / unset / info exists ----
eq(run("set x 5; puts $x").out.trimEnd(), "5", "set");
eq(run("set x 5; append x ab; puts $x").out.trimEnd(), "5ab", "append");
eq(run("set n 10; incr n; incr n 5; puts $n").out.trimEnd(), "16", "incr");
eq(run("set n 1; puts [info exists n]").out.trimEnd(), "1", "info exists true");
eq(run("set n 1; unset n; puts [info exists n]").out.trimEnd(), "0", "info exists false");

// ---- control flow ----
eq(run(`set v 15
if {$v < 10} { puts small } elseif {$v < 20} { puts medium } else { puts large }`).out.trimEnd(),
   "medium", "if/elseif/else");
eq(run(`set i 0; set out ""
while {$i < 10} { incr i; if {$i == 3} {continue}; if {$i == 6} {break}; append out "$i," }
puts $out`).out.trimEnd(), "1,2,4,5,", "while break/continue");
eq(run(`set out ""; for {set k 0} {$k < 5} {incr k} { append out $k }; puts $out`).out.trimEnd(),
   "01234", "for");
eq(run(`set out ""; foreach f {a b c} { append out "<$f>" }; puts $out`).out.trimEnd(),
   "<a><b><c>", "foreach single");
eq(run(`set out ""; foreach {p q} {1 one 2 two} { append out "$p=$q " }; puts $out`).out.trimEnd(),
   "1=one 2=two", "foreach pairs");

// ---- proc / return / global / defaults / varargs / recursion ----
eq(run(`proc square {a} { return [expr {$a * $a}] }; puts [square 9]`).out.trimEnd(), "81", "proc");
eq(run(`proc greet {name {greeting Hello}} { return "$greeting, $name" }; puts [greet World]`).out.trimEnd(),
   "Hello, World", "proc default arg");
eq(run(`proc greet {name {greeting Hello}} { return "$greeting, $name" }; puts [greet World Ciao]`).out.trimEnd(),
   "Ciao, World", "proc override default");
eq(run(`proc sum {args} { set total 0; foreach a $args { incr total $a }; return $total }; puts [sum 1 2 3 4]`).out.trimEnd(),
   "10", "proc varargs");
eq(run(`set counter 0; proc bump {} { global counter; incr counter }; bump; bump; puts $counter`).out.trimEnd(),
   "2", "global");
eq(run(`proc fact {n} { if {$n <= 1} { return 1 }; return [expr {$n * [fact [expr {$n - 1}]]}] }; puts [fact 5]`).out.trimEnd(),
   "120", "recursion");

// ---- string ----
eq(run(`puts [string length "hello world"]`).out.trimEnd(), "11", "string length");
eq(run(`puts [string toupper hello]`).out.trimEnd(), "HELLO", "string toupper");
eq(run(`puts [string index abcdef end]`).out.trimEnd(), "f", "string index end");
eq(run(`puts [string range abcdef 2 end]`).out.trimEnd(), "cdef", "string range end");
eq(run(`puts [string repeat ab 3]`).out.trimEnd(), "ababab", "string repeat");
eq(run(`puts [string match "h*o" hello]`).out.trimEnd(), "1", "string match glob");
eq(run(`puts [string first lo "hello world"]`).out.trimEnd(), "3", "string first");

// ---- lists ----
eq(run(`set l [list a b "c d" e]; puts $l`).out.trimEnd(), "a b {c d} e", "list quoting");
eq(run(`set l [list a b "c d" e]; puts [llength $l]`).out.trimEnd(), "4", "llength");
eq(run(`set l [list a b "c d" e]; puts [lindex $l 2]`).out.trimEnd(), "c d", "lindex");
eq(run(`set l [list a b "c d" e]; puts [lindex $l end]`).out.trimEnd(), "e", "lindex end");
eq(run(`set l [list a b c d]; puts [lrange $l 1 2]`).out.trimEnd(), "b c", "lrange");
eq(run(`set l2 {}; lappend l2 x; lappend l2 y z; puts $l2`).out.trimEnd(), "x y z", "lappend");
eq(run(`puts [split a,b,,c ,]`).out.trimEnd(), "a b {} c", "split");
eq(run(`puts [join {a b c} -]`).out.trimEnd(), "a-b-c", "join");

// ---- eval / catch / error ----
eq(run(`set rc [catch {error boom} msg]; puts "$rc $msg"`).out.trimEnd(), "1 boom", "catch error");
eq(run(`set rc [catch {expr {1 + 1}} msg]; puts "$rc $msg"`).out.trimEnd(), "0 2", "catch ok");
eq(run(`set rc [catch {nosuchcommand} msg]; puts $rc`).out.trimEnd(), "1", "catch bad cmd");

// ---- comments and ; separators ----
eq(run(`set a 1; set b 2  ;# trailing comment
puts "$a$b"`).out.trimEnd(), "12", "comment + semicolons");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

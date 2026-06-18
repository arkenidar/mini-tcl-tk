# hello.tcl
# The simplest counter: a label above a button.
# Click the button to count.

set n 0

label  .out -textvariable n
button .b   -text "Click me" -command {incr n}

pack .out -side top
pack .b   -side top -pady 8

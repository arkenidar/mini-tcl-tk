# temperature.tcl
# Celsius -> Fahrenheit with a slider + button,
# touch-only. Shows proc + expr + scale + grid.

if {![info exists celsius]} {
    set celsius 20
}
if {![info exists fahrenheit]} {
    set fahrenheit ""
}

proc c2f {c} {
    return [expr {round($c * 9.0 / 5 + 32)}]
}

label  .l1 -text "Celsius:"
scale  .c  -from -20 -to 100 -variable celsius
label  .cv -textvariable celsius

button .go -text "Convert" -command {set fahrenheit [c2f $celsius]}

label .l2  -text "Fahrenheit:"
label .out -textvariable fahrenheit

grid .l1  -row 0 -column 0 -sticky e -padx 4 -pady 4
grid .c   -row 0 -column 1 -sticky w -padx 4 -pady 4
grid .cv  -row 0 -column 2 -sticky w -padx 4 -pady 4
grid .go  -row 1 -column 0 -columnspan 3 -pady 6
grid .l2  -row 2 -column 0 -sticky e -padx 4 -pady 4
grid .out -row 2 -column 1 -sticky w -padx 4 -pady 4

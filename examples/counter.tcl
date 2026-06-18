# counter.tcl
# A two-button counter. Guarded init keeps the
# count across a keep-variables re-run; the
# Reset button zeroes it on purpose.

if {![info exists n]} {
    set n 0
}

button .inc -text "Count" -command {incr n}
button .dec -text "Reset" -command {set n 0}
label  .out -textvariable n

pack .inc -side left -padx 4
pack .dec -side left -padx 4
pack .out -side left -padx 12

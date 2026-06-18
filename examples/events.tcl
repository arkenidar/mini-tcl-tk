# events.tcl
# Tap the box to see where you tapped: bind +
# %-substitution, touch-only (no mouse-hover or
# keyboard). Guarded init keeps the readings.

if {![info exists where]} {
    set where "tap the box"
}
if {![info exists taps]} {
    set taps 0
}

frame .pad -width 260 -height 120 -background "30 50 80"
bind  .pad <Button-1> {set where "x=%x  y=%y"; incr taps}

label .w -textvariable where
label .n -text "taps:"
label .c -textvariable taps

pack .pad -side top -pady 6
pack .w   -side top
pack .n   -side top -pady 4
pack .c   -side top

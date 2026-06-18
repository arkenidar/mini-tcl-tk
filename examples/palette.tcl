# palette.tcl
# A colour palette: foreach builds a radio row,
# and selecting recolors a live swatch via the
# radiobutton's -command. Guarded init keeps the
# choice across re-runs.

if {![info exists choice]} {
    set choice green
}

label .title -text "Pick a colour:"
pack  .title -side top -pady 4

# the swatch shows the current colour
frame .sw -width 140 -height 56 -background $choice
pack  .sw -side top -pady 6

# a frame holds the radio row (packs left)
frame .row
foreach col {red green blue} {
    radiobutton .row.$col \
        -text $col -variable choice -value $col \
        -command {.sw configure -background $choice}
    pack .row.$col -side left -padx 4
}
pack .row -side top

label .sel -text "selected:"
label .val -textvariable choice

pack .sel -side top
pack .val -side top -pady 2

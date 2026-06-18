# paint.tcl
# The canvas widget: create rectangle / line /
# text, and delete. A proc redraws on demand.
# Colours accept names or "r g b" triples.

canvas .cv -width 300 -height 170 -background "12 18 28"

proc redraw {} {
    .cv delete all
    .cv create rectangle  30 30 130 110 -fill "60 140 220"
    .cv create rectangle 150 50 260 130 -fill "230 120 90"
    .cv create line 20 150 280 150 -fill "200 200 200"
    .cv create text 150 16 -text "mini canvas" -fill "230 210 60"
}

button .go -text "Redraw" -command redraw

pack .cv -side top -pady 6
pack .go -side top

redraw

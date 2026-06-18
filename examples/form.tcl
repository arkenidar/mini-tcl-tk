# form.tcl
# A settings form laid out with grid, touch-only
# (radios, a slider, a checkbox; no typing). The
# variables are made by the widgets, so a keep-
# variables re-run preserves your choices.

if {![info exists theme]} {
    set theme dark
}
if {![info exists volume]} {
    set volume 6
}
if {![info exists notify]} {
    set notify 1
}

label .lt -text "Theme:"
radiobutton .light -text light -variable theme -value light
radiobutton .dark  -text dark  -variable theme -value dark

label .lv  -text "Volume:"
scale .vol -from 0 -to 11 -variable volume
label .vv  -textvariable volume

checkbutton .notify -text "Notifications" -variable notify

button .ok -text "Submit" -command {
    puts "theme=$theme volume=$volume notify=$notify"
}

grid .lt     -row 0 -column 0 -sticky e -padx 4 -pady 4
grid .light  -row 0 -column 1 -sticky w -padx 4 -pady 4
grid .dark   -row 0 -column 2 -sticky w -padx 4 -pady 4
grid .lv     -row 1 -column 0 -sticky e -padx 4 -pady 4
grid .vol    -row 1 -column 1 -sticky w -padx 4 -pady 4
grid .vv     -row 1 -column 2 -sticky w -padx 4 -pady 4
grid .notify -row 2 -column 1 -columnspan 2 -sticky w -padx 4 -pady 4
grid .ok     -row 3 -column 1 -columnspan 2 -sticky w -padx 4 -pady 8

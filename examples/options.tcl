# options.tcl
# Radiobutton groups + checkbuttons, with a
# label that reflects the live selection.

if {![info exists color]} {
    set color blue
}
if {![info exists bold]} {
    set bold 0
}
if {![info exists italic]} {
    set italic 0
}

label .lc -text "Colour:"

radiobutton .rr -text red   -variable color -value red
radiobutton .rg -text green -variable color -value green
radiobutton .rb -text blue  -variable color -value blue

checkbutton .cb -text bold   -variable bold
checkbutton .ci -text italic -variable italic

label  .sel  -textvariable color
button .show -text "Show in console" -command {
    puts "color=$color bold=$bold italic=$italic"
}

pack .lc .rr .rg .rb .cb .ci .sel .show -side top -pady 2

package ui

import (
	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// Overlay is the window over a display that draws what the user points at.
// Clicks go through it and it never takes the keyboard. Its methods are
// safe from any goroutine.
type Overlay struct {
	u   *UI
	win *mygo.Window
}

// OpenOverlay covers bounds with an overlay, which shows once its page is
// ready.
func (u *UI) OpenOverlay(bounds mygo.Rectangle) *Overlay {
	o := &Overlay{u: u}
	mygo.RunOnMain(func() {
		o.win = u.open(kindOverlay, bounds)
		o.win.OnReadyToShow(func() { show(o.win, kindOverlay) })
	})
	return o
}

// Highlight draws the box, or clears it with nil.
func (o *Overlay) Highlight(h *contract.OverlayHighlight) {
	o.emit(func() { highlightEvent.Emit(o.win, h) })
}

// Note adds a line to the overlay's hint.
func (o *Overlay) Note(text string) { o.emit(func() { noteEvent.Emit(o.win, text) }) }

// Shift moves the drawn box as the window under it moves.
func (o *Overlay) Shift(dx, dy float64) {
	o.emit(func() { shiftEvent.Emit(o.win, contract.Shift{DX: dx, DY: dy}) })
}

// Hold keeps only the box, drawn right above owner, the window the user
// picked in, instead of above everything.
func (o *Overlay) Hold(owner desktop.WindowID) {
	mygo.RunOnMain(func() {
		if o.win.IsDestroyed() {
			return
		}
		holdEvent.Emit(o.win, struct{}{})
		d := o.u.deps.Desktop
		if owner == 0 || d.AttachToOwner(o.win, owner) != nil {
			o.u.check("window-level", d.SetLevel(o.win, desktop.LevelFloating))
		}
		o.win.ShowInactive()
	})
}

func (o *Overlay) Close() {
	mygo.RunOnMain(func() {
		if !o.win.IsDestroyed() {
			o.win.Destroy()
		}
	})
}

func (o *Overlay) emit(fn func()) {
	if !o.win.IsDestroyed() {
		fn()
	}
}

// CardFocused reports whether the current card has the keyboard.
func (u *UI) CardFocused() bool {
	focused := false
	mygo.RunOnMain(func() { focused = u.current != nil && !u.current.win.IsDestroyed() && u.current.win.IsFocused() })
	return focused
}

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/browser"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/pick"
)

const (
	pickPointing = 1500 * time.Millisecond
	pickCardWait = 10 * time.Second
	// markLeaks is how many mark-colored pixels a picture may hold before
	// the overlay counts as showing in it; the mark covers thousands.
	markLeaks = 50
)

// selfOverlay stands in for ui.Overlay: a window over the display, opened
// the way internal/ui opens an overlay, that draws a magenta mark over the
// target instead of the pick's box. The pick's picture must not show it.
type selfOverlay struct {
	d          desktop.Desktop
	win        *mygo.Window
	highlights atomic.Int32
	held       atomic.Bool
	closed     atomic.Bool
	attachErr  error
}

func openSelfOverlay(r *report, d desktop.Desktop, b mygo.Rectangle, mark desktop.Point) *selfOverlay {
	o := &selfOverlay{d: d}
	q := d.ToDIP(mark)
	page := fmt.Sprintf(`<!doctype html><html><body style="margin:0;background:transparent">`+
		`<div style="position:absolute;left:%dpx;top:%dpx;width:120px;height:60px;background:#ff00ff"></div></body></html>`,
		int(q.X)-b.X-60, int(q.Y)-b.Y-30)
	mygo.RunOnMain(func() {
		o.win = mygo.NewWindow(mygo.WindowOptions{
			X: b.X, Y: b.Y, Width: b.Width, Height: b.Height,
			Hidden: true, Frameless: true, Transparent: true, DisableShadow: true, DisableResize: true,
			DisableMinimize: true, DisableMaximize: true, DisableFullScreen: true, SkipTaskbar: true, AlwaysOnTop: true,
		})
		r.noErr("overlay PrepareWindow", d.PrepareWindow(o.win))
		r.noErr("overlay SetLevel screen saver", d.SetLevel(o.win, desktop.LevelScreenSaver))
		o.win.SetBounds(b)
		r.noErr("overlay SetFocusable false", d.SetFocusable(o.win, false))
		o.win.SetIgnoreMouseEvents(true)
		o.win.OnReadyToShow(o.win.ShowInactive)
		o.win.Page().LoadHTML(page, "")
	})
	return o
}

func (o *selfOverlay) Highlight(h *contract.OverlayHighlight) {
	if h != nil {
		o.highlights.Add(1)
	}
}

func (o *selfOverlay) Note(string)          {}
func (o *selfOverlay) Shift(dx, dy float64) {}

func (o *selfOverlay) Hold(owner desktop.WindowID) {
	mygo.RunOnMain(func() {
		o.attachErr = o.d.AttachToOwner(o.win, owner)
		o.win.ShowInactive()
	})
	o.held.Store(true)
}

func (o *selfOverlay) Close() {
	mygo.RunOnMain(func() {
		if !o.win.IsDestroyed() {
			o.win.Destroy()
		}
	})
	o.closed.Store(true)
}

// noBrowser has no extension connected, as on a machine without it.
type noBrowser struct{}

func (noBrowser) Count() int { return 0 }
func (noBrowser) PickInBrowser(context.Context, desktop.BrowserKind, desktop.Point, string) browser.BrowserPick {
	return browser.BrowserPick{Outcome: browser.PickUnavailable}
}

type pickedCard struct {
	grab contract.Grab
	card pick.Card
}

// checkPick runs one pick through internal/pick with the real Desktop, as
// a shake would start it: the target's text is pointed at under an
// overlay, a click confirms, and the grab a card would open comes back
// with the box held until the card lets it go.
func checkPick(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground, target desktop.Rect) {
	if drv == nil {
		r.skip("pick", "no driver posts input on this platform")
		return
	}
	home, err := os.MkdirTemp("", "pointy-selfcheck-home-")
	if !r.noErr("pick settings home", err) {
		return
	}
	defer os.RemoveAll(home)
	p := centerOf(target)
	if !r.noErr("pick moves to the target", drv.move(p)) {
		return
	}
	drv.setSelection(fg.ID, 0, 0)
	start, end, haveSel := drv.selection(fg.ID)
	arrow := drv.cursorFingerprint()

	opened := make(chan *selfOverlay, 1)
	cards := make(chan pickedCard, 1)
	picker := pick.New(pick.Deps{
		Desktop:    d,
		Settings:   config.LoadSettings(home),
		Fullscreen: func() bool { return false },
		Suppressed: func() bool { return false },
		Browser:    noBrowser{},
		OpenOverlay: func(b mygo.Rectangle) pick.Overlay {
			o := openSelfOverlay(r, d, b, p)
			opened <- o
			return o
		},
		DisplayAt:   displayAt(d),
		Keys:        globalKeys(func(kind string, err any) { r.check("pick "+kind, false, "%v", err) }),
		OpenGrab:    func(g contract.Grab, c pick.Card) { cards <- pickedCard{g, c} },
		ShowHint:    func(s string) { r.info("pick hint", "%s", s) },
		CardFocused: func() bool { return false },
		Log:         func(kind string, err any) { r.info("pick log", "%s: %v", kind, err) },
	})
	done := make(chan struct{})
	go func() {
		defer close(done)
		picker.Pick(p)
	}()
	stop := func() {
		picker.Cancel()
		<-done
	}

	var o *selfOverlay
	select {
	case o = <-opened:
	case <-done:
		r.check("pick starts pointing", false, "Pick returned before it opened an overlay")
		return
	case <-time.After(5 * time.Second):
		r.check("pick starts pointing", false, "no overlay within 5s")
		stop()
		return
	}
	r.check("pick starts pointing", true, "an overlay covers the display")
	time.Sleep(pickPointing)
	if shot, err := drv.screen(desktop.Rect{int(p.X) - 4, int(p.Y) - 4, 8, 8}); err == nil {
		r.check("the overlay shows above the target", markPixels(shot) > 0, "center %v", shot.At(4, 4))
	}
	r.check("pointing draws the control under the mouse", o.highlights.Load() > 0, "%d highlights", o.highlights.Load())

	if !r.noErr("pick confirms with a click", drv.click(p, false)) {
		stop()
		return
	}
	var got pickedCard
	select {
	case got = <-cards:
	case <-done:
		r.check("pick opens a card", false, "Pick returned without a grab")
		return
	case <-time.After(pickCardWait):
		r.check("pick opens a card", false, "no grab within %v", pickCardWait)
		stop()
		return
	}
	<-done
	g := got.grab
	r.check("pick opens a card", g.Method == contract.MethodUIAPick && g.Element != nil, "method %s, element %+v", g.Method, g.Element)
	if want := os.Getenv("POINTY_SELFCHECK_TEXT"); want != "" {
		r.check("the card holds the target's text", strings.Contains(g.Text, want), "%q", clipText(g.Text))
	}
	checkPickPicture(r, g)
	r.check("the held box attaches to the picked window", o.held.Load() && o.attachErr == nil, "held %v, %v", o.held.Load(), errText(o.attachErr))
	if haveSel {
		s, e, _ := drv.selection(fg.ID)
		r.check("the confirming click never reaches the target", s == start && e == end, "caret %d-%d, was %d-%d", s, e, start, end)
	}
	r.check("pointing puts the cursor back", drv.cursorFingerprint() == arrow, "arrow %s", arrow)
	got.card.Release()
	time.Sleep(300 * time.Millisecond)
	r.check("the card lets the held box go", o.closed.Load(), "closed %v", o.closed.Load())
}

// checkPickPicture decodes the picture a card would show and looks for the
// overlay's mark in it.
func checkPickPicture(r *report, g contract.Grab) {
	url := g.Image
	if url == "" {
		url = g.WideImage
	}
	data, ok := strings.CutPrefix(url, "data:image/jpeg;base64,")
	if !r.check("pick takes a picture", ok, "image %d bytes, wide %d bytes", len(g.Image), len(g.WideImage)) {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	var img image.Image
	if err == nil {
		img, err = jpeg.Decode(bytes.NewReader(raw))
	}
	if !r.noErr("the pick's picture decodes", err) {
		return
	}
	r.savePNG("pick-picture.png", img)
	r.check("the pick's picture leaves the overlay out", markPixels(img) < markLeaks, "%d magenta pixels in %s", markPixels(img), sizeOf(img))
}

func markPixels(img image.Image) int {
	n := 0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			cr, cg, cb, _ := img.At(x, y).RGBA()
			if cr>>8 > 200 && cg>>8 < 90 && cb>>8 > 200 {
				n++
			}
		}
	}
	return n
}

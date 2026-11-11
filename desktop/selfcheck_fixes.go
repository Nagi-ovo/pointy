package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/pick"
)

const (
	// taskbarAutoHide is ABS_AUTOHIDE in SHAppBarMessage's state mask.
	taskbarAutoHide = 0x1
	// tallOverflow is how far past its window a control's reported box
	// must reach to reproduce the unclipped-scroll-area bug.
	tallOverflow = 100
)

// checkMaximized maximizes the target window and turns on taskbar auto-hide
// to check that neither state makes FullscreenActive report full screen.
// Only the second reproduces issue #3: with the taskbar shown, a maximized
// window never covers the display.
func checkMaximized(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground) {
	if drv == nil {
		r.skip("maximized window", "no driver controls windows on this platform")
		return
	}
	if fg.ID == 0 {
		r.check("a maximized window is not full screen", false, "no foreground window")
		return
	}

	if !drv.canMaximize(fg.ID) {
		// Such as the taskbar or the desktop when no app is in front.
		r.skip("a maximized window is not full screen", fmt.Sprintf("the target %#x cannot be maximized", uint64(fg.ID)))
		return
	}
	wasMaximized := drv.isMaximized(fg.ID)
	if !wasMaximized {
		if err := drv.maximize(fg.ID); err != nil {
			r.check("a maximized window is not full screen", false, "maximize %#x: %v", uint64(fg.ID), err)
			return
		}
		defer func() {
			if err := drv.restore(fg.ID); err != nil {
				r.check("restore target window", false, "%v", err)
			} else {
				r.info("target window", "restored from maximized")
			}
		}()
		time.Sleep(400 * time.Millisecond)
	} else {
		r.info("target window", "already maximized; keeping state")
	}

	now, fgErr := ensureForeground(d, drv, fg.ID)
	zoomed := drv.isMaximized(fg.ID)
	full, err := d.FullscreenActive(nil)
	r.check("a maximized window is not full screen",
		fgErr == nil && now.ID == fg.ID && zoomed && err == nil && !full,
		"fullscreen=%v zoomed=%v fg=%#x (want %#x) %v", full, zoomed, uint64(now.ID), uint64(fg.ID), errText(err))

	origState, err := drv.taskbarState()
	if err != nil {
		r.skip("a maximized window over an auto-hidden taskbar is not full screen", err.Error())
		return
	}
	if origState&taskbarAutoHide == 0 {
		if err := drv.setTaskbarState(origState | taskbarAutoHide); err != nil {
			// Send the original state back in case Explorer acts on the message late.
			_ = drv.setTaskbarState(origState)
			r.skip("a maximized window over an auto-hidden taskbar is not full screen", err.Error())
			return
		}
		defer func() {
			if err := drv.setTaskbarState(origState); err != nil {
				r.check("restore taskbar", false, "%v", err)
			} else {
				time.Sleep(500 * time.Millisecond)
				r.info("taskbar", "restored state %#x", origState)
			}
		}()
		time.Sleep(time.Second)
	} else {
		r.info("taskbar", "already auto-hidden (%#x); keeping state", origState)
	}

	now, fgErr = ensureForeground(d, drv, fg.ID)
	winRect, okW := drv.windowRect(fg.ID)
	monRect, okM := drv.monitorRect(fg.ID)
	covers := okW && okM && coversDisplay(winRect, monRect)
	r.info("maximized over auto-hidden taskbar", "window %v monitor %v covers=%v", winRect, monRect, covers)
	if !covers {
		// Only a window covering the display reproduces issue #3.
		r.skip("a maximized window over an auto-hidden taskbar is not full screen", fmt.Sprintf("the window %v does not cover the display %v", winRect, monRect))
		return
	}
	zoomed = drv.isMaximized(fg.ID)
	full, err = d.FullscreenActive(nil)
	r.check("a maximized window over an auto-hidden taskbar is not full screen",
		fgErr == nil && now.ID == fg.ID && zoomed && err == nil && !full,
		"fullscreen=%v covers=%v zoomed=%v window=%v monitor=%v fg=%#x %v",
		full, covers, zoomed, winRect, monRect, uint64(now.ID), errText(err))
}

func ensureForeground(d desktop.Desktop, drv selfDriver, want desktop.WindowID) (desktop.Foreground, error) {
	now, err := d.Foreground()
	if err == nil && now.ID != want {
		drv.focus(want)
		time.Sleep(150 * time.Millisecond)
		now, err = d.Foreground()
	}
	return now, err
}

func coversDisplay(win, mon desktop.Rect) bool {
	return mon[2] > 0 && mon[3] > 0 &&
		win[0] <= mon[0] && win[1] <= mon[1] &&
		win[0]+win[2] >= mon[0]+mon[2] &&
		win[1]+win[3] >= mon[1]+mon[3]
}

// clipOverlay records the latest pointing highlight without opening an extra
// window on screen.
type clipOverlay struct {
	bounds mygo.Rectangle
	mu     sync.Mutex
	last   *contract.OverlayHighlight
	notify chan struct{}
}

func (o *clipOverlay) Highlight(h *contract.OverlayHighlight) {
	if h == nil {
		return
	}
	cp := *h
	o.mu.Lock()
	o.last = &cp
	o.mu.Unlock()
	select {
	case o.notify <- struct{}{}:
	default:
	}
}

func (o *clipOverlay) latest() *contract.OverlayHighlight {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.last
}

func (*clipOverlay) Note(contract.Message) {}
func (*clipOverlay) Shift(dx, dy float64)  {}
func (*clipOverlay) Hold(desktop.WindowID) {}
func (*clipOverlay) Close()                {}

// checkClippedHighlight opens a normal WebView2 window with a tall scrollable
// div, probes whether UI Automation reports an unclipped height past the
// window, and, when it does, runs a pick to check the drawn box is clipped.
func checkClippedHighlight(r *report, d desktop.Desktop, drv selfDriver) {
	if drv == nil {
		r.skip("highlight clipping", "no driver controls windows on this platform")
		return
	}
	prev, _ := d.Foreground()
	origCursor := d.Cursor()
	defer func() {
		if prev.ID != 0 {
			drv.focus(prev.ID)
			time.Sleep(150 * time.Millisecond)
		}
		_ = drv.move(origCursor)
	}()

	disp := mygo.Screen.PrimaryDisplay()
	area := disp.WorkArea
	if area.Width == 0 || area.Height == 0 {
		area = disp.Bounds
	}
	b := mygo.Rectangle{
		X:      area.X + max(0, (area.Width-600)/2),
		Y:      area.Y + max(0, (area.Height-400)/2),
		Width:  600,
		Height: 400,
	}

	var w *mygo.Window
	loaded := make(chan struct{})
	var once sync.Once
	mygo.RunOnMain(func() {
		w = mygo.NewWindow(mygo.WindowOptions{
			Title:  "Pointy scroll check",
			X:      b.X,
			Y:      b.Y,
			Width:  b.Width,
			Height: b.Height,
			Hidden: true,
		})
		w.Page().OnDidFinishLoad(func() { once.Do(func() { close(loaded) }) })
	})
	defer func() {
		mygo.RunOnMain(func() {
			if !w.IsDestroyed() {
				w.Destroy()
			}
		})
	}()

	w.Page().LoadHTML(scrollTestPage(), "")
	select {
	case <-loaded:
	case <-time.After(5 * time.Second):
		r.info("scroll page", "did not finish loading within 5s; showing anyway")
	}

	mygo.RunOnMain(func() {
		w.Show()
		w.Focus()
	})
	time.Sleep(300 * time.Millisecond)
	testID := d.WindowID(w)
	drv.focus(testID)
	time.Sleep(200 * time.Millisecond)

	winRect, ok := drv.windowRect(testID)
	if !ok || winRect[2] <= 0 || winRect[3] <= 0 {
		r.skip("highlight clipping", fmt.Sprintf("could not read test window %#x bounds", uint64(testID)))
		return
	}
	if now, err := d.Foreground(); err == nil && now.ID != testID {
		mygo.RunOnMain(func() {
			w.SetAlwaysOnTop(true)
			w.SetAlwaysOnTop(false)
		})
		_ = drv.click(centerOf(winRect), false)
		time.Sleep(300 * time.Millisecond)
		winRect, _ = drv.windowRect(testID)
	}

	mid := centerOf(winRect)
	if err := drv.move(mid); err != nil {
		r.skip("highlight clipping", fmt.Sprintf("moving cursor to test window: %v", err))
		return
	}

	// Chromium builds its UIA tree lazily after the first query, so poll
	// briefly before deciding whether any control overflows the window.
	var pt desktop.PointReply
	var ptErr error
	tallLevel := -1
	for attempt := range 8 {
		if attempt > 0 {
			time.Sleep(250 * time.Millisecond)
		}
		pt, _, ptErr = within(time.Second, func(ctx context.Context) (desktop.PointReply, error) {
			return d.PointAt(ctx, mid)
		})
		if ptErr != nil || !pt.OK {
			continue
		}
		tallLevel = findTallControl(pt, winRect)
		if tallLevel >= 0 {
			break
		}
	}

	r.info("scroll PointAt", "ok=%v win=%v window=%v %v", pt.OK, pt.Win, winRect, errText(ptErr))
	for i, c := range pt.Chain {
		r.info(fmt.Sprintf("scroll chain[%d]", i), "%s %q rect=%v", c.Control, c.Class, c.Rect)
	}
	if tallLevel < 0 {
		r.skip("highlight clipping", fmt.Sprintf("no control exceeded window %v (win=%v) by >%dpx: %s", winRect, pt.Win, tallOverflow, chainSummary(pt.Chain)))
		return
	}

	home, err := os.MkdirTemp("", "pointy-selfcheck-clip-")
	if !r.noErr("clip pick settings home", err) {
		return
	}
	defer os.RemoveAll(home)

	ensureForeground(d, drv, testID)
	if !r.noErr("clip pick moves to the scroll area", drv.move(mid)) {
		return
	}

	opened := make(chan *clipOverlay, 1)
	var keyMu sync.Mutex
	var keyFns map[string]func()
	picker := pick.New(pick.Deps{
		Desktop:    d,
		Settings:   config.LoadSettings(home),
		Fullscreen: func() bool { return false },
		Suppressed: func() bool { return false },
		Browser:    noBrowser{},
		OpenOverlay: func(bounds mygo.Rectangle) pick.Overlay {
			o := &clipOverlay{bounds: bounds, notify: make(chan struct{}, 1)}
			select {
			case opened <- o:
			default:
			}
			return o
		},
		DisplayAt: displayAt(d),
		Keys: func(k map[string]func()) func() {
			keyMu.Lock()
			keyFns = k
			keyMu.Unlock()
			return globalKeys(func(kind string, err any) { r.info("clip pick "+kind, "%v", err) })(k)
		},
		OpenGrab: func(_ contract.Grab, c pick.Card) {
			if c != nil {
				c.Release()
			}
		},
		ShowHint:    func(s string) { r.info("clip pick hint", "%s", s) },
		CardFocused: func() bool { return false },
		Log:         func(kind string, err any) { r.info("clip pick log", "%s: %v", kind, err) },
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		picker.Pick(mid)
	}()
	stop := func() {
		picker.Cancel()
		<-done
	}

	var o *clipOverlay
	select {
	case o = <-opened:
	case <-done:
		r.check("the highlight stays inside the window", false, "Pick returned before opening an overlay")
		return
	case <-time.After(5 * time.Second):
		r.check("the highlight stays inside the window", false, "no overlay within 5s")
		stop()
		return
	}

	select {
	case <-o.notify:
	case <-done:
		r.check("the highlight stays inside the window", false, "Pick returned before drawing a highlight")
		return
	case <-time.After(5 * time.Second):
		r.check("the highlight stays inside the window", false, "no highlight within 5s")
		stop()
		return
	}

	if tallLevel > 0 {
		keyMu.Lock()
		climb := keyFns["]"]
		keyMu.Unlock()
		if climb != nil {
			for range tallLevel {
				climb()
				select {
				case <-o.notify:
				case <-time.After(time.Second):
				}
			}
		}
	}

	stop()

	last := o.latest()
	if last == nil {
		r.check("the highlight stays inside the window", false, "no highlight recorded")
		return
	}
	hl := localToScreen(d, o.bounds, last.LocalRect)
	tol := max(8, int(math.Ceil(4*d.UnitsPerDIP(mid))))
	inside := hl[2] > 0 && hl[3] > 0 &&
		hl[0] >= winRect[0]-tol &&
		hl[1] >= winRect[1]-tol &&
		hl[0]+hl[2] <= winRect[0]+winRect[2]+tol &&
		hl[1]+hl[3] <= winRect[1]+winRect[3]+tol
	r.check("the highlight stays inside the window", inside, "highlight %v (local %+v) in window %v", hl, last.LocalRect, winRect)
}

func localToScreen(d desktop.Desktop, overlay mygo.Rectangle, local contract.LocalRect) desktop.Rect {
	tl := d.ToScreen(desktop.Point{X: float64(overlay.X) + local.X, Y: float64(overlay.Y) + local.Y})
	br := d.ToScreen(desktop.Point{X: float64(overlay.X) + local.X + local.Width, Y: float64(overlay.Y) + local.Y + local.Height})
	return desktop.Rect{
		int(math.Round(tl.X)),
		int(math.Round(tl.Y)),
		int(math.Round(br.X - tl.X)),
		int(math.Round(br.Y - tl.Y)),
	}
}

// findTallControl returns the index in session.setChain's filtered slice of
// the first control whose reported rectangle overflows its window by more
// than tallOverflow pixels, or -1 if none does.
func findTallControl(pt desktop.PointReply, winRect desktop.Rect) int {
	ref := winRect
	if pt.Win != nil {
		ref = *pt.Win
	}
	drawnIdx := 0
	for _, c := range pt.Chain {
		if c.Rect == nil || c.Rect[2] <= 4 || c.Rect[3] <= 4 {
			continue
		}
		if exceedsRect(*c.Rect, ref, tallOverflow) && exceedsRect(*c.Rect, winRect, tallOverflow) {
			return drawnIdx
		}
		drawnIdx++
	}
	return -1
}

func exceedsRect(r, bound desktop.Rect, margin int) bool {
	return r[3] > bound[3]+margin ||
		r[1] < bound[1]-margin ||
		r[1]+r[3] > bound[1]+bound[3]+margin ||
		r[2] > bound[2]+margin ||
		r[0] < bound[0]-margin ||
		r[0]+r[2] > bound[0]+bound[2]+margin
}

func chainSummary(chain []desktop.ChainItem) string {
	if len(chain) == 0 {
		return "empty chain"
	}
	parts := make([]string, len(chain))
	for i, c := range chain {
		parts[i] = fmt.Sprintf("%s=%v", c.Control, c.Rect)
	}
	return strings.Join(parts, ", ")
}

func scrollTestPage() string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8"><title>Pointy scroll check</title></head>`)
	b.WriteString(`<body style="margin:0;overflow:hidden">`)
	b.WriteString(`<div id="s" style="height:100vh;box-sizing:border-box;overflow:auto">`)
	b.WriteString(`<div style="font:16px/24px sans-serif;padding:16px;white-space:pre-line">`)
	for i := 1; i <= 300; i++ {
		fmt.Fprintf(&b, "Line %03d: scrollable text line to test highlight clipping.\n", i)
	}
	b.WriteString(`</div></div>`)
	b.WriteString(`<script>document.getElementById('s').scrollTop = 600;</script>`)
	b.WriteString(`</body></html>`)
	return b.String()
}

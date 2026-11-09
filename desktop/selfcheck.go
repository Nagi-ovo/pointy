package main

// POINTY_SELFCHECK=<file> starts Pointy in a mode that calls each Desktop
// method once against the foreground app and its own test window, judges
// what it can observe, writes one line per check to <file> and screenshots
// beside it, and exits 1 if any check failed. CI runs it on Windows with
// Notepad in front (.github/workflows/desktop-test.yml);
// POINTY_SELFCHECK_TEXT is the text Notepad shows, and
// POINTY_SELFCHECK_WAIT the seconds to wait first, for a person to bring
// an app to the front.

import (
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// selfDriver posts input and reads back system state the Desktop
// interface does not expose. Only Windows has one.
type selfDriver interface {
	info() []string
	windowRect(desktop.WindowID) (desktop.Rect, bool)
	rootOf(desktop.WindowID) desktop.WindowID
	ownerOf(*mygo.Window) desktop.WindowID
	windowAt(desktop.Point) desktop.WindowID
	style(*mygo.Window) string
	selection(target desktop.WindowID) (start, end int, ok bool)
	setSelection(target desktop.WindowID, start, end int) bool
	click(p desktop.Point, right bool) error
	wheel(p desktop.Point, delta int) error
	cursorFingerprint() string
	move(desktop.Point) error
	// screen copies r from the screen, Pointy's windows included.
	screen(desktop.Rect) (image.Image, error)
}

type report struct {
	mu    sync.Mutex
	dir   string
	lines []string
	fails int
}

func (r *report) add(kind, name, detail string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if kind == "FAIL" {
		r.fails++
	}
	r.lines = append(r.lines, fmt.Sprintf("%-4s %s: %s", kind, name, detail))
}

func (r *report) info(name, format string, a ...any) { r.add("INFO", name, fmt.Sprintf(format, a...)) }
func (r *report) skip(name, why string)              { r.add("SKIP", name, why) }

func (r *report) check(name string, ok bool, format string, a ...any) bool {
	kind := "PASS"
	if !ok {
		kind = "FAIL"
	}
	r.add(kind, name, fmt.Sprintf(format, a...))
	return ok
}

// noErr records a call that returns only an error.
func (r *report) noErr(name string, err error) bool {
	return r.check(name, err == nil, "%v", errText(err))
}

func errText(err error) string {
	if err == nil {
		return "ok"
	}
	return err.Error()
}

func (r *report) savePNG(name string, img image.Image) {
	f, err := os.Create(filepath.Join(r.dir, name))
	if err != nil {
		r.info("screenshot "+name, "%v", err)
		return
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		r.info("screenshot "+name, "%v", err)
	}
}

func selfCheck(out string) {
	mygo.App.SetName("Pointy")
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.WhenReady(func() {
		go func() {
			if wait, err := strconv.Atoi(os.Getenv("POINTY_SELFCHECK_WAIT")); err == nil {
				time.Sleep(time.Duration(wait) * time.Second)
			}
			r := &report{dir: filepath.Dir(out)}
			runChecks(r, newDesktop(resourceRoot()), newSelfDriver())
			text := strings.Join(r.lines, "\n") + fmt.Sprintf("\n\n%d failed\n", r.fails)
			if err := os.WriteFile(out, []byte(text), 0o644); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
			code := 0
			if r.fails > 0 {
				code = 1
			}
			mygo.App.Exit(code)
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// within calls an A11y method with a deadline and times it.
func within[T any](deadline time.Duration, call func(context.Context) (T, error)) (T, time.Duration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	defer cancel()
	start := time.Now()
	v, err := call(ctx)
	return v, time.Since(start), err
}

func runChecks(r *report, d desktop.Desktop, drv selfDriver) {
	r.info("build", "%s/%s %s", runtime.GOOS, runtime.GOARCH, runtime.Version())
	if drv != nil {
		for _, l := range drv.info() {
			r.info("system", "%s", l)
		}
	}
	for _, disp := range mygo.Screen.Displays() {
		r.info("display", "bounds %+v work %+v scale %.2f primary %v", disp.Bounds, disp.WorkArea, disp.ScaleFactor, disp.Primary)
	}

	fg, err := d.Foreground()
	r.check("Foreground", err == nil && fg.ID != 0, "%+v %v", fg, errText(err))
	full, err := d.FullscreenActive(nil)
	r.check("FullscreenActive", err == nil, "%v %v", full, errText(err))

	checkDIPs(r, d)

	r.info("CursorVisible", "%v", d.CursorVisible())
	r.info("ButtonDown", "%v", d.ButtonDown())
	r.info("ElevatedUnderCursor", "%v", d.ElevatedUnderCursor())
	r.info("HasAccess", "%v", d.HasAccess())
	kind, ok := d.Browser(map[string]string{"windows": "msedge.exe", "darwin": "microsoft edge"}[runtime.GOOS])
	r.check("Browser", ok && kind == desktop.BrowserEdge, "%q %v", kind, ok)
	r.check("Blocked", d.Blocked(map[string]string{"windows": "keepass.exe", "darwin": "keepassxc"}[runtime.GOOS]), "a password manager is blocked")

	target := targetArea(r, d, drv, fg)
	checkWindow(r, d, drv, fg, target)
	checkA11y(r, d, drv, fg, target)

	if img, _, err := within(3*time.Second, func(ctx context.Context) (image.Image, error) { return d.Capture(ctx, target, fg.PID) }); r.check("Capture", err == nil && img != nil && img.Bounds().Dx() == target[2], "%v of %v, %v", sizeOf(img), target, errText(err)) {
		r.savePNG("capture-target.png", img)
		r.check("Capture shows something", !uniform(img), "not one flat color")
	}

	checkCursor(r, d, drv)
	checkHook(r, d, drv, fg, target)

	d.AllowAnyForeground()
	r.info("AllowAnyForeground", "called")
	dir, err := os.MkdirTemp("", "pointy-selfcheck-cleanup-")
	if err == nil {
		err = os.WriteFile(filepath.Join(dir, "file"), []byte("x"), 0o644)
	}
	if err == nil {
		err = d.RemoveAfterExit([]string{dir})
	}
	r.check("RemoveAfterExit", err == nil, "%s; the workflow checks it is gone after exit: %v", dir, errText(err))
	r.info("cleanup dir", "%s", dir)
}

func sizeOf(img image.Image) string {
	if img == nil {
		return "nothing"
	}
	return fmt.Sprintf("%dx%d", img.Bounds().Dx(), img.Bounds().Dy())
}

// checkDIPs compares the conversion with mygo's own: both must put the
// cursor on the same DIP.
func checkDIPs(r *report, d desktop.Desktop) {
	c := d.Cursor()
	dip := d.ToDIP(c)
	m := mygo.Screen.CursorScreenPoint()
	r.check("ToDIP agrees with mygo", math.Abs(dip.X-float64(m.X)) <= 1 && math.Abs(dip.Y-float64(m.Y)) <= 1, "cursor %+v -> %+v, mygo %+v", c, dip, m)
	back := d.ToScreen(dip)
	r.check("ToScreen undoes ToDIP", math.Abs(back.X-c.X) <= 1 && math.Abs(back.Y-c.Y) <= 1, "%+v -> %+v", dip, back)
	scale := mygo.Screen.DisplayNearestPoint(m).ScaleFactor
	r.check("UnitsPerDIP agrees with mygo", math.Abs(d.UnitsPerDIP(c)-scale) < 0.01, "%v, mygo %v", d.UnitsPerDIP(c), scale)
	rect := desktop.Rect{int(c.X), int(c.Y), 100, 100}
	r.info("RectToDIP", "%v -> %+v", rect, d.RectToDIP(rect))
}

// targetArea is the foreground window's rectangle, or 400x300 at the
// cursor when no driver can read it.
func targetArea(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground) desktop.Rect {
	if drv != nil {
		if rect, ok := drv.windowRect(fg.ID); ok {
			r.info("target", "%s %q at %v", fg.Exe, fg.Title, rect)
			return rect
		}
	}
	c := d.Cursor()
	return desktop.Rect{int(c.X), int(c.Y), 400, 300}
}

func centerOf(t desktop.Rect) desktop.Point {
	return desktop.Point{X: float64(t[0] + t[2]/2), Y: float64(t[1] + t[3]/2)}
}

const testPage = `<!doctype html><html><body style="margin:0;background:transparent">` +
	`<div style="position:absolute;inset:40px;border-radius:24px;background:#2050c8"></div></body></html>`

var testBlue = color.RGBA{0x20, 0x50, 0xc8, 255}

// checkWindow opens a window as internal/ui opens a card, over the
// target, and checks it shows the target through its corners, paints its
// page, takes no focus, lets clicks through when asked, and attaches.
func checkWindow(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground, target desktop.Rect) {
	c := d.ToDIP(centerOf(target))
	b := mygo.Rectangle{X: int(c.X) - 160, Y: int(c.Y) - 100, Width: 320, Height: 200}
	var w *mygo.Window
	ready := make(chan struct{})
	var once sync.Once
	mygo.RunOnMain(func() {
		w = mygo.NewWindow(mygo.WindowOptions{
			X: b.X, Y: b.Y, Width: b.Width, Height: b.Height,
			Hidden: true, Frameless: true, Transparent: true, DisableShadow: true, DisableResize: true,
			DisableMinimize: true, DisableMaximize: true, DisableFullScreen: true, SkipTaskbar: true, AlwaysOnTop: true,
		})
		w.OnReadyToShow(func() { once.Do(func() { close(ready) }) })
	})
	defer w.Destroy()
	r.noErr("PrepareWindow", d.PrepareWindow(w))
	r.noErr("SetLevel screen saver", d.SetLevel(w, desktop.LevelScreenSaver))
	mygo.RunOnMain(func() { w.SetBounds(b) })
	r.noErr("SetFocusable false", d.SetFocusable(w, false))
	id := d.WindowID(w)
	r.check("WindowID", id != 0, "%#x", uint64(id))
	w.Page().LoadHTML(testPage, "")
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		r.info("OnReadyToShow", "did not fire within 5s; showing anyway")
	}

	mygo.RunOnMain(w.ShowInactive)
	time.Sleep(1500 * time.Millisecond)
	now, err := d.Foreground()
	r.check("showing took no focus", err == nil && now.ID == fg.ID, "foreground %#x, was %#x", uint64(now.ID), uint64(fg.ID))
	if drv == nil {
		r.skip("window pixels", "no driver reads the screen on this platform")
	} else {
		area := checkWindowPixels(r, d, drv, w, fg, b)
		mid := desktop.Point{X: float64(area[0] + area[2]/2), Y: float64(area[1] + area[3]/2)}
		at := drv.windowAt(mid)
		r.check("clicks pass through", at != id && at != 0, "window at the center %#x, ours %#x", uint64(at), uint64(id))
	}

	if fg.ID != 0 {
		r.noErr("AttachToOwner", d.AttachToOwner(w, fg.ID))
		if drv != nil {
			owner := drv.ownerOf(w)
			r.check("owner is the target's top-level window", owner == drv.rootOf(fg.ID), "owner %#x, target %#x", uint64(owner), uint64(fg.ID))
		}
		o, err := d.WindowOrigin(fg.ID)
		r.check("WindowOrigin", err == nil && int(o.X) == target[0] && int(o.Y) == target[1], "%+v %v", o, errText(err))
	}
}

// checkWindowPixels reads the shown test window off the screen: its page
// paints, its corners show what is behind, and Capture leaves it out. It
// returns the window's area in screen units.
func checkWindowPixels(r *report, d desktop.Desktop, drv selfDriver, w *mygo.Window, fg desktop.Foreground, b mygo.Rectangle) desktop.Rect {
	r.info("window style", "%s", drv.style(w))
	px := d.ToScreen(desktop.Point{X: float64(b.X), Y: float64(b.Y)})
	scale := d.UnitsPerDIP(px)
	area := desktop.Rect{int(px.X), int(px.Y), int(float64(b.Width) * scale), int(float64(b.Height) * scale)}
	behind, _, err := within(3*time.Second, func(ctx context.Context) (image.Image, error) { return d.Capture(ctx, area, fg.PID) })
	if !r.noErr("Capture over a Pointy window", err) {
		return area
	}
	r.savePNG("window-captured.png", behind)
	mid := behind.At(behind.Bounds().Dx()/2, behind.Bounds().Dy()/2)
	r.check("Capture leaves Pointy's windows out", !near(mid, testBlue, 24), "center %v, the window paints %v", mid, testBlue)
	time.Sleep(200 * time.Millisecond)
	shown, err := drv.screen(area)
	if !r.noErr("screen with the window shown", err) {
		return area
	}
	r.savePNG("window-shown.png", shown)
	corners := cornerDiff(behind, shown, int(8*scale))
	r.check("transparent corners show what is behind", corners < 24, "largest corner difference %d", corners)
	mid = shown.At(shown.Bounds().Dx()/2, shown.Bounds().Dy()/2)
	r.check("the page paints, and Capture showed it to recorders again", near(mid, testBlue, 24), "center %v, want %v", mid, testBlue)

	mygo.RunOnMain(func() { w.SetIgnoreMouseEvents(true) })
	time.Sleep(500 * time.Millisecond)
	if through, err := drv.screen(area); r.noErr("screen click-through", err) {
		r.savePNG("window-clickthrough.png", through)
		r.check("click-through window keeps transparent corners", cornerDiff(behind, through, int(8*scale)) < 24, "largest corner difference %d", cornerDiff(behind, through, int(8*scale)))
	}
	return area
}

func checkA11y(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground, target desktop.Rect) {
	want := os.Getenv("POINTY_SELFCHECK_TEXT")
	p := centerOf(target)
	if drv != nil && drv.setSelection(fg.ID, 0, -1) {
		time.Sleep(200 * time.Millisecond)
	}
	g, took, err := within(1500*time.Millisecond, d.Grab)
	r.check("Grab", err == nil, "%dms %+v %v", took.Milliseconds(), g, errText(err))
	if want != "" {
		r.check("Grab reads the selection", strings.Contains(g.Text, want), "%q", clipText(g.Text))
	}
	if drv != nil {
		drv.setSelection(fg.ID, 0, 0)
	}

	var pt desktop.PointReply
	for i := range 3 {
		pt, took, err = within(time.Second, func(ctx context.Context) (desktop.PointReply, error) { return d.PointAt(ctx, p) })
		r.check(fmt.Sprintf("PointAt #%d", i+1), err == nil && pt.OK && len(pt.Chain) > 0, "%dms, %d controls, %v", took.Milliseconds(), len(pt.Chain), errText(err))
	}
	for i, c := range pt.Chain {
		r.info(fmt.Sprintf("chain[%d]", i), "%s %q %q %v", c.Control, c.Class, c.Name, c.Rect)
	}
	r.info("PointAt leaf", "kids %v readable %v win %v", pt.LeafKids, pt.LeafReadable, pt.Win)

	el, took, err := within(3*time.Second, func(ctx context.Context) (desktop.ElementReply, error) { return d.ElementAt(ctx, p, 0) })
	r.check("ElementAt", err == nil && el.OK, "%dms %s %q rect %v win %v text %q %v", took.Milliseconds(), el.Control, el.ClassName, el.Rect, el.Win, clipText(el.Text), errText(err))
	if want != "" {
		r.check("ElementAt reads the target's text", strings.Contains(el.Text, want), "want %q", want)
	}
	if n := len(pt.Chain); n > 1 {
		top, _, err := within(3*time.Second, func(ctx context.Context) (desktop.ElementReply, error) { return d.ElementAt(ctx, p, n-1) })
		r.check("ElementAt the top of the chain", err == nil && top.Control == pt.Chain[n-1].Control, "%s, chain says %s", top.Control, pt.Chain[n-1].Control)
	}
}

func clipText(s string) string {
	if len(s) > 120 {
		return s[:120] + "…"
	}
	return s
}

func checkCursor(r *report, d desktop.Desktop, drv selfDriver) {
	var before string
	if drv != nil {
		before = drv.cursorFingerprint()
	}
	if !r.noErr("SwapCursor", d.SwapCursor()) {
		d.RestoreCursor()
		return
	}
	time.Sleep(300 * time.Millisecond)
	if drv == nil {
		d.RestoreCursor()
		return
	}
	swapped := drv.cursorFingerprint()
	d.RestoreCursor()
	time.Sleep(300 * time.Millisecond)
	after := drv.cursorFingerprint()
	r.check("SwapCursor changes the arrow", swapped != before, "%s -> %s", before, swapped)
	r.check("RestoreCursor brings the arrow back", after == before, "%s -> %s", swapped, after)
}

// checkHook clicks into the target while hooked, and once more after: the
// first must reach Pointy and not the target, the second the target.
func checkHook(r *report, d desktop.Desktop, drv selfDriver, fg desktop.Foreground, target desktop.Rect) {
	h, err := d.HookButtons()
	if !r.noErr("HookButtons", err) {
		return
	}
	if drv == nil {
		h.Close()
		r.skip("hook input", "no driver posts input on this platform")
		return
	}
	p := centerOf(target)
	p.Y += float64(target[3]) / 8
	drv.setSelection(fg.ID, 0, 0)
	start, end, haveSel := drv.selection(fg.ID)
	h.SetWheel(true)
	expect := func(name string, want desktop.Button, post func() error) {
		if err := post(); err != nil {
			r.check(name, false, "posting input: %v", err)
			return
		}
		select {
		case got := <-h.Events():
			r.check(name, got == want, "got %v, want %v", got, want)
		case <-time.After(time.Second):
			r.check(name, false, "no event within 1s")
		}
	}
	expect("hook reports a left click", desktop.LeftUp, func() error { return drv.click(p, false) })
	expect("hook reports the wheel down", desktop.WheelDown, func() error { return drv.wheel(p, -120) })
	expect("hook reports a right click", desktop.RightUp, func() error { return drv.click(p, true) })
	h.SetWheel(false)
	time.Sleep(200 * time.Millisecond)
	if haveSel {
		s, e, _ := drv.selection(fg.ID)
		r.check("hooked clicks never reach the target", s == start && e == end, "caret %d-%d, was %d-%d", s, e, start, end)
	}
	h.Close()
	r.info("hook closed", "unhooked")
	if !haveSel {
		r.skip("unhooked click", "the target has no edit control to read the caret from")
		return
	}
	drv.click(p, false)
	time.Sleep(300 * time.Millisecond)
	s, e, _ := drv.selection(fg.ID)
	r.check("after Close a click reaches the target", s != start || e != end, "caret %d-%d, was %d-%d", s, e, start, end)
}

// cornerDiff is the largest channel difference between a and b in the
// four inset squares of their corners.
func cornerDiff(a, b image.Image, inset int) int {
	w, h := a.Bounds().Dx(), a.Bounds().Dy()
	worst := 0
	for _, c := range [][2]int{{0, 0}, {w - 1, 0}, {0, h - 1}, {w - 1, h - 1}} {
		for dy := range inset {
			for dx := range inset {
				x, y := abs(c[0]-dx), abs(c[1]-dy)
				worst = max(worst, diff(a.At(x, y), b.At(x, y)))
			}
		}
	}
	return worst
}

func abs(v int) int { return max(v, -v) }

func diff(a, b color.Color) int {
	ar, ag, ab, _ := a.RGBA()
	br, bg, bb, _ := b.RGBA()
	d := func(x, y uint32) int { return abs(int(x>>8) - int(y>>8)) }
	return max(d(ar, br), d(ag, bg), d(ab, bb))
}

func near(a, b color.Color, tol int) bool { return diff(a, b) <= tol }

func uniform(img image.Image) bool {
	b := img.Bounds()
	first := img.At(b.Min.X, b.Min.Y)
	for y := b.Min.Y; y < b.Max.Y; y += 7 {
		for x := b.Min.X; x < b.Max.X; x += 7 {
			if diff(first, img.At(x, y)) > 8 {
				return false
			}
		}
	}
	return true
}

// pointy-mygo-test checks, on a real machine, whether mygo can host Pointy's
// transparent card and its click-through overlay. It judges every check
// itself from screen pixels and Win32 state, and writes the verdicts to
// pointy-mygo-result.txt next to the executable.
package main

import (
	"embed"
	"fmt"
	"image"
	"image/png"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

//go:embed web
var webFS embed.FS

const (
	cardW, cardH = 360, 240
	gap          = 20
	areaW        = 2*cardW + 3*gap // 780
	areaH        = 2*cardH + 3*gap // 540
	tol          = 24
)

type rgb struct{ R, G, B int }

func (c rgb) String() string { return fmt.Sprintf("(%d,%d,%d)", c.R, c.G, c.B) }

var (
	green   = rgb{40, 170, 90}  // the backdrop we put behind everything
	blue    = rgb{30, 80, 200}  // the card
	orange  = rgb{255, 120, 0}  // the overlay's highlight border
	halfRed = rgb{147, 85, 45}  // rgba(255,0,0,.5) over green
	_       = image.Rectangle{} // keep image imported on every platform
	fgStart uintptr             // foreground window when the program started
	out     *report
)

func near(a, b rgb, t int) bool {
	return abs(a.R-b.R) <= t && abs(a.G-b.G) <= t && abs(a.B-b.B) <= t
}
func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
func isBlack(c rgb) bool { return c.R <= 20 && c.G <= 20 && c.B <= 20 }
func isWhite(c rgb) bool { return c.R >= 235 && c.G >= 235 && c.B >= 235 }

func describe(c rgb, want rgb) string {
	s := c.String()
	switch {
	case near(c, want, tol):
		s += " ok"
	case isBlack(c):
		s += " BLACK"
	case isWhite(c):
		s += " WHITE"
	default:
		s += " WRONG"
	}
	return s
}

// prect is a rectangle of the screen in the units capture takes: physical
// pixels on Windows, points on macOS.
type prect struct{ L, T, R, B int }

func (r prect) String() string { return fmt.Sprintf("[%d,%d %dx%d]", r.L, r.T, r.R-r.L, r.B-r.T) }
func (r prect) W() int         { return r.R - r.L }
func (r prect) H() int         { return r.B - r.T }

// shot is a capture of the screen rectangle r.
type shot struct {
	img *image.RGBA
	r   prect
}

// at reads the pixel at screen point x, y.
func (s shot) at(x, y int) (rgb, bool) {
	if s.img == nil || x < s.r.L || y < s.r.T || x >= s.r.R || y >= s.r.B {
		return rgb{}, false
	}
	b := s.img.Bounds()
	ix := b.Min.X + (x-s.r.L)*b.Dx()/s.r.W()
	iy := b.Min.Y + (y-s.r.T)*b.Dy()/s.r.H()
	o := s.img.PixOffset(ix, iy)
	return rgb{int(s.img.Pix[o]), int(s.img.Pix[o+1]), int(s.img.Pix[o+2])}, true
}

// ---------------------------------------------------------------- report

type report struct {
	mu       sync.Mutex
	dir      string
	path     string
	head     []string
	verdicts []string
	lines    []string
	step     string
	started  time.Time
}

func newReport() *report {
	r := &report{started: time.Now()}
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe))
	}
	if h, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(h, "Desktop"))
	}
	dirs = append(dirs, os.TempDir())
	for _, d := range dirs {
		p := filepath.Join(d, "pointy-mygo-result.txt")
		if f, err := os.Create(p); err == nil {
			f.Close()
			r.dir, r.path = d, p
			break
		}
	}
	r.head = []string{
		"Pointy on mygo v0.8.3 - Windows test",
		fmt.Sprintf("started %s, exe %s/%s, Go %s", r.started.Format(time.RFC3339), runtime.GOOS, runtime.GOARCH, runtime.Version()),
		"variants: A = stock page window (Frameless+Transparent, URL); B = A + DwmEnableBlurBehindWindow(empty region) + transparent BackgroundColor;",
		"          C = native UI window (Content) holding NewWebView{Transparent} (mygo's NOREDIRECTIONBITMAP/DirectComposition path); D = native UI only, no WebView",
		"colors: backdrop green (40,170,90), card blue (30,80,200), highlight orange (255,120,0); tolerance +-24 per channel",
	}
	return r
}

func (r *report) setStep(s string) {
	r.mu.Lock()
	r.step = s
	r.mu.Unlock()
	r.add("== %s", s)
}

func (r *report) add(format string, a ...any) {
	r.mu.Lock()
	r.lines = append(r.lines, fmt.Sprintf("[%5.1fs] ", time.Since(r.started).Seconds())+fmt.Sprintf(format, a...))
	r.mu.Unlock()
	r.flush()
}

func (r *report) verdict(name string, pass bool, detail string) {
	v := "FAIL"
	if pass {
		v = "PASS"
	}
	line := fmt.Sprintf("%s  %s", v, name)
	if detail != "" {
		line += "  -- " + detail
	}
	r.mu.Lock()
	r.verdicts = append(r.verdicts, line)
	r.mu.Unlock()
	r.add("%s", line)
}

func (r *report) info(name, detail string) {
	line := fmt.Sprintf("INFO  %s  -- %s", name, detail)
	r.mu.Lock()
	r.verdicts = append(r.verdicts, line)
	r.mu.Unlock()
	r.add("%s", line)
}

func (r *report) text() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	for _, l := range r.head {
		b.WriteString(l + "\r\n")
	}
	b.WriteString("\r\n---- VERDICTS ----\r\n")
	for _, l := range r.verdicts {
		b.WriteString(l + "\r\n")
	}
	b.WriteString("\r\n---- LOG ----\r\n")
	for _, l := range r.lines {
		b.WriteString(l + "\r\n")
	}
	return b.String()
}

func (r *report) flush() {
	if r.path == "" {
		return
	}
	os.WriteFile(r.path, []byte("\xef\xbb\xbf"+r.text()), 0o644)
}

func (r *report) savePNG(name string, s shot) {
	if r.dir == "" || s.img == nil {
		return
	}
	p := filepath.Join(r.dir, name)
	f, err := os.Create(p)
	if err != nil {
		r.add("save %s: %v", name, err)
		return
	}
	defer f.Close()
	if err := png.Encode(f, s.img); err != nil {
		r.add("save %s: %v", name, err)
		return
	}
	r.add("saved %s (%dx%d px of screen %s)", name, s.img.Bounds().Dx(), s.img.Bounds().Dy(), s.r)
}

// onMain runs fn on the UI thread and turns a panic there into an error,
// so a failing step cannot take the process down before the report is out.
func onMain(what string, fn func()) (err error) {
	mygo.RunOnMain(func() {
		defer func() {
			if p := recover(); p != nil {
				err = fmt.Errorf("panic in %s: %v", what, p)
				out.add("%v\n%s", err, debug.Stack())
			}
		}()
		fn()
	})
	return err
}

// ---------------------------------------------------------------- main

var finishOnce sync.Once

func finish(summary string) {
	finishOnce.Do(func() {
		out.add("finished after %.1fs", time.Since(out.started).Seconds())
		out.flush()
		where := out.path
		if where == "" {
			where = "(could not write any result file)"
		}
		if os.Getenv("POINTY_CI") == "" {
			showMessage("Pointy 测试完成 / done", summary+"\n\n结果文件 / result file:\n"+where+"\n\n请把这个文件和同一文件夹里的 pointy-mygo-*.png 发回来。")
		}
		go func() { time.Sleep(3 * time.Second); os.Exit(0) }()
		mygo.App.Quit()
	})
}

func main() {
	fgStart = foreground()
	out = newReport()
	out.add("foreground window at start: %s", windowInfo(fgStart))
	defer func() {
		if p := recover(); p != nil {
			out.verdict("no panic", false, fmt.Sprintf("main: %v\n%s", p, debug.Stack()))
			finish("程序出错了 / crashed")
		}
	}()
	sub, _ := fs.Sub(webFS, "web")
	mygo.SetFrontend(sub)
	mygo.App.OnWindowAllClosed(func() {})
	platformInit()
	mygo.App.WhenReady(func() {
		out.add("App ready")
		go run()
	})
	go func() {
		time.Sleep(150 * time.Second)
		out.mu.Lock()
		step := out.step
		out.mu.Unlock()
		out.verdict("finished in time", false, "watchdog fired during step: "+step)
		finish("超时了 / timed out")
	}()
	if err := mygo.App.Run(); err != nil {
		out.verdict("mygo App.Run", false, err.Error())
		finish("mygo 无法启动 / mygo failed to start")
	}
	// The app quit; give finish a moment if it is still writing.
	time.Sleep(500 * time.Millisecond)
}

// ---------------------------------------------------------------- run

type kind int

const (
	kindPage     kind = iota // a window showing a page: what Pointy would write first
	kindPageBlur             // the same, plus DwmEnableBlurBehindWindow with an empty region
	kindUIWeb                // a window of native UI holding a transparent web view
	kindUI                   // native UI only, no web view
)

type variant struct {
	id    string
	kind  kind
	label string
}

var variants = []variant{
	{"A", kindPage, "A 原版 WebView 窗口 / stock page window"},
	{"B", kindPageBlur, "B WebView + DWM blur-behind 修补"},
	{"C", kindUIWeb, "C 原生 UI 里放透明 WebView"},
	{"D", kindUI, "D 纯原生 UI（无 WebView）"},
}

func needsWebView(k kind) bool { return k != kindUI }

var (
	bannerWin  *mygo.Window
	bannerText = "Pointy 测试进行中，请不要动鼠标和键盘… / testing, hands off"
)

func setBanner(s string) {
	if bannerWin == nil {
		return
	}
	bannerWin.Update(func() { bannerText = s })
}

func run() {
	defer func() {
		if p := recover(); p != nil {
			out.verdict("no panic", false, fmt.Sprintf("step %q: %v\n%s", out.step, p, debug.Stack()))
		}
		finish(summaryText())
	}()

	out.setStep("environment")
	for _, l := range sysInfo() {
		out.add("%s", l)
	}
	wvOK := mygo.WebViewAvailable()
	out.info("mygo.WebViewAvailable", fmt.Sprint(wvOK))
	disp := mygo.Screen.PrimaryDisplay()
	out.add("primary display: bounds %+v work %+v scale %.2f, displays %d", disp.Bounds, disp.WorkArea, disp.ScaleFactor, len(mygo.Screen.Displays()))
	scale := screenScale(disp)
	out.add("screen units per DIP: %.3f", scale)

	wa := disp.WorkArea
	ax := wa.X + (wa.Width-areaW)/2
	ay := wa.Y + (wa.Height-areaH)/2 + 30
	if ay-wa.Y < 70 {
		ay = wa.Y + 70
	}
	areaDIP := mygo.Rectangle{X: ax, Y: ay, Width: areaW, Height: areaH}
	area := toScreen(areaDIP, scale)
	out.add("test area DIP %+v -> screen %s", areaDIP, area)

	onMain("banner", func() {
		bannerWin = mygo.NewWindow(mygo.WindowOptions{
			Title: "Pointy test", X: ax, Y: ay - 64, Width: areaW, Height: 48,
			Frameless: true, SkipTaskbar: true, DisableShadow: true, DisableResize: true, AlwaysOnTop: true, Hidden: true,
			Content: ui.View(func(c *ui.Context) {
				ui.Box(c).Fill().Background(ui.RGB(32, 33, 36)).Padding(12, 16).Children(func() {
					ui.Text(c, bannerText).TextColor(ui.RGB(255, 255, 255)).FontSize(16)
				})
			}),
		})
		bannerWin.ShowInactive()
		noActivate(bannerWin)
	})

	var backdrop func()
	if err := onMain("backdrop", func() { backdrop = newBackdrop(area, green) }); err != nil || backdrop == nil {
		out.verdict("backdrop window", false, fmt.Sprint(err))
		return
	}
	defer onMain("close backdrop", backdrop)
	time.Sleep(800 * time.Millisecond)

	out.setStep("measurement self-check")
	selfCheck(area)

	out.setStep("cards")
	cards := cardTests(area, areaDIP, scale, wvOK)

	out.setStep("overlays")
	best := overlayTests(area, areaDIP, disp, wvOK)

	out.setStep("final pose")
	if best != nil {
		onMain("final overlay", func() { best.ShowInactive() })
	}
	setBanner("测完了。现在请截一张全屏图（PrtSc 或 Win+Shift+S），20 秒后自动结束")
	time.Sleep(1500 * time.Millisecond)
	if s, err := capture(pad(area, 40, scale)); err == nil {
		out.savePNG("pointy-mygo-final.png", s)
	}
	if os.Getenv("POINTY_CI") == "" {
		time.Sleep(18500 * time.Millisecond)
	}
	onMain("close", func() {
		for _, w := range cards {
			if w != nil {
				w.Destroy()
			}
		}
		if best != nil {
			best.Destroy()
		}
		if bannerWin != nil {
			bannerWin.Destroy()
		}
	})
}

func pad(r prect, dip int, scale float64) prect {
	p := int(float64(dip) * scale)
	return prect{r.L - p, r.T - p, r.R + p, r.B + p}
}

func toScreen(d mygo.Rectangle, scale float64) prect {
	return prect{int(float64(d.X)*scale + .5), int(float64(d.Y)*scale + .5), int(float64(d.X+d.Width)*scale + .5), int(float64(d.Y+d.Height)*scale + .5)}
}

func summaryText() string {
	out.mu.Lock()
	defer out.mu.Unlock()
	pass, fail := 0, 0
	for _, v := range out.verdicts {
		switch {
		case strings.HasPrefix(v, "PASS"):
			pass++
		case strings.HasPrefix(v, "FAIL"):
			fail++
		}
	}
	return fmt.Sprintf("测试结束 / finished: %d PASS, %d FAIL", pass, fail)
}

// selfCheck proves the capture reads what is on screen: the backdrop is a
// plain GDI window of a known color.
func selfCheck(area prect) {
	s, err := capture(area)
	if err != nil {
		out.verdict("self-check: GDI capture works", false, err.Error())
		return
	}
	bad := []string{}
	for _, fx := range []float64{.02, .5, .98} {
		for _, fy := range []float64{.02, .5, .98} {
			x, y := area.L+int(fx*float64(area.W())), area.T+int(fy*float64(area.H()))
			c, _ := s.at(x, y)
			if !near(c, green, tol) {
				bad = append(bad, fmt.Sprintf("%d,%d=%s", x, y, c))
			}
		}
	}
	out.verdict("self-check: GDI capture reads the green backdrop", len(bad) == 0, strings.Join(bad, " "))
	if d, err := captureDXGI(area); err != nil {
		out.info("self-check: DXGI duplication", "unavailable: "+err.Error())
	} else {
		c, _ := d.at(area.L+area.W()/2, area.T+area.H()/2)
		out.info("self-check: DXGI duplication", "center "+describe(c, green))
	}
}

// ---------------------------------------------------------------- windows

// makeWindow creates a hidden window of the variant's kind, on the main
// thread, with OnReadyToShow wired to ready.
func makeWindow(v variant, opts mygo.WindowOptions, page string, draw func(c *ui.Context), ready chan struct{}) (w *mygo.Window, err error) {
	var once sync.Once
	signal := func() { once.Do(func() { close(ready) }) }
	opts.Hidden = true
	opts.Frameless = true
	opts.Transparent = true
	opts.SkipTaskbar = true
	opts.DisableShadow = true
	opts.DisableResize = true
	err = onMain("create "+v.id, func() {
		switch v.kind {
		case kindPage, kindPageBlur:
			opts.URL = page
			if v.kind == kindPageBlur {
				opts.BackgroundColor = "transparent"
			}
			w = mygo.NewWindow(opts)
		case kindUIWeb:
			var wv *mygo.WebView
			opts.Content = ui.View(func(c *ui.Context) {
				c.Root().Background(ui.Transparent)
				if wv != nil {
					ui.WebView(c, wv).Fill()
				}
			})
			w = mygo.NewWindow(opts)
			var e error
			wv, e = w.NewWebView(mygo.WebViewOptions{URL: page, Transparent: true, BackgroundColor: "transparent"})
			if e != nil {
				out.add("%s: NewWebView: %v", v.id, e)
			}
			w.Invalidate()
		case kindUI:
			opts.Content = ui.View(func(c *ui.Context) {
				c.Root().Background(ui.Transparent)
				draw(c)
			})
			w = mygo.NewWindow(opts)
		}
		w.OnReadyToShow(signal)
		if v.kind == kindPageBlur {
			out.add("%s: blur-behind: %s", v.id, blurBehind(w))
		}
	})
	return w, err
}

func waitReady(id string, ready chan struct{}, d time.Duration) bool {
	t := time.Now()
	select {
	case <-ready:
		out.add("%s: OnReadyToShow after %dms", id, time.Since(t).Milliseconds())
		return true
	case <-time.After(d):
		out.add("%s: OnReadyToShow did not fire within %s (showing anyway)", id, d)
		return false
	}
}

// ---------------------------------------------------------------- cards

type pt struct {
	name string
	x, y int // CSS px in the window
	want rgb
}

var cardPoints = []pt{
	{"corner-TL", 6, 6, green}, {"corner-TR", 354, 6, green}, {"corner-BL", 6, 234, green}, {"corner-BR", 354, 234, green},
	{"roundcut-TL", 27, 27, green}, {"roundcut-TR", 333, 27, green}, {"roundcut-BL", 27, 213, green}, {"roundcut-BR", 333, 213, green},
	{"center", 180, 150, blue}, {"center-left", 100, 180, blue},
	{"half-alpha", 180, 228, halfRed},
}

func cardDraw(label string) func(c *ui.Context) {
	return func(c *ui.Context) {
		ui.Box(c).Absolute().Left(24).Top(24).Width(312).Height(192).Radius(20).Background(ui.RGB(30, 80, 200)).Padding(14, 16).Children(func() {
			ui.Text(c, label).TextColor(ui.RGB(255, 255, 255)).FontSize(15)
		})
		ui.Box(c).Absolute().Left(150).Top(222).Width(60).Height(12).Background(ui.RGBA(255, 0, 0, .5))
	}
}

func cardTests(area prect, areaDIP mygo.Rectangle, scale float64, wvOK bool) []*mygo.Window {
	wins := make([]*mygo.Window, len(variants))
	readys := make([]chan struct{}, len(variants))
	for i, v := range variants {
		if needsWebView(v.kind) && !wvOK {
			out.verdict("card "+v.label, false, "skipped: WebView2 runtime not available")
			continue
		}
		col, row := i%2, i/2
		opts := mygo.WindowOptions{
			Title: "Pointy card " + v.id,
			X:     areaDIP.X + gap + col*(cardW+gap), Y: areaDIP.Y + gap + row*(cardH+gap),
			Width: cardW, Height: cardH,
		}
		page := "/card.html?label=" + url.QueryEscape(v.label)
		readys[i] = make(chan struct{})
		w, err := makeWindow(v, opts, page, cardDraw(v.label), readys[i])
		if err != nil || w == nil {
			out.verdict("card "+v.label, false, fmt.Sprintf("create failed: %v", err))
			continue
		}
		wins[i] = w
		// Pointy owns the card by the app the user points at.
		ok, detail := setOwner(w, fgStart)
		out.verdict("owner "+v.id+": SetWindowLongPtrW(GWLP_HWNDPARENT, foreground at start)", ok, detail)
	}
	for i, v := range variants {
		if wins[i] != nil {
			waitReady(v.id, readys[i], 10*time.Second)
		}
	}
	var first *mygo.Window
	for i, v := range variants {
		if w := wins[i]; w != nil {
			onMain("show "+v.id, func() { w.ShowInactive() })
			if first == nil {
				first = w
			}
		}
	}
	if first != nil {
		onMain("backdrop below cards", func() {
			for _, w := range wins {
				if w != nil {
					raise(w)
				}
			}
			placeBelow(first)
		})
	}

	// Wait for each card to paint, then judge it.
	deadline := time.Now().Add(10 * time.Second)
	painted := make([]bool, len(variants))
	for time.Now().Before(deadline) {
		s, err := capture(area)
		if err != nil {
			out.add("capture: %v", err)
			break
		}
		all := true
		for i := range variants {
			if wins[i] == nil || painted[i] {
				continue
			}
			r := clientRect(wins[i])
			c, _ := s.at(mapPt(r, cardW, cardH, 180, 150))
			if near(c, blue, tol) {
				painted[i] = true
				out.add("%s: card painted after %.1fs", variants[i].id, time.Since(deadline.Add(-10*time.Second)).Seconds())
			} else {
				all = false
			}
		}
		if all {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	time.Sleep(600 * time.Millisecond)
	s, err := capture(area)
	if err != nil {
		out.verdict("capture after cards", false, err.Error())
		return wins
	}
	out.savePNG("pointy-mygo-cards.png", s)
	d, derr := captureDXGI(area)
	for i, v := range variants {
		w := wins[i]
		if w == nil {
			continue
		}
		r := clientRect(w)
		out.add("%s: client rect %s, dpi %d, exstyle %s", v.id, r, dpiOf(w), exStyle(w))
		var corners, centers []string
		cornersOK, centersOK, half := true, true, ""
		black, white := 0, 0
		for _, p := range cardPoints {
			x, y := mapPt(r, cardW, cardH, p.x, p.y)
			c, _ := s.at(x, y)
			desc := fmt.Sprintf("%s@%d,%d=%s", p.name, x, y, describe(c, p.want))
			if derr == nil {
				dc, _ := d.at(x, y)
				desc += " dxgi=" + dc.String()
			}
			switch {
			case p.want == green:
				corners = append(corners, desc)
				if !near(c, p.want, tol) {
					cornersOK = false
				}
				if isBlack(c) {
					black++
				}
				if isWhite(c) {
					white++
				}
			case p.want == blue:
				centers = append(centers, desc)
				if !near(c, p.want, tol) {
					centersOK = false
				}
			default:
				half = desc
				_ = near(c, p.want, 35)
			}
		}
		out.add("%s pixels: %s", v.id, strings.Join(append(corners, centers...), "; "))
		out.verdict("card "+v.label+": card body painted (center = card blue)", centersOK, strings.Join(centers, "; "))
		note := ""
		if black > 0 {
			note = fmt.Sprintf("%d corner samples BLACK; ", black)
		}
		if white > 0 {
			note += fmt.Sprintf("%d corner samples WHITE; ", white)
		}
		out.verdict("card "+v.label+": corners transparent (show the green backdrop)", cornersOK, note+fmt.Sprintf("%d samples", len(corners)))
		hc, _ := s.at(mapPt(r, cardW, cardH, 180, 228))
		out.info("card "+v.id+": 50% alpha strip (expect ~"+halfRed.String()+")", half+fmt.Sprintf(" blended=%v", near(hc, halfRed, 35)))
	}
	if derr != nil {
		out.add("DXGI cross-check unavailable: %v", derr)
	}
	return wins
}

// mapPt maps a CSS pixel of a window w x h DIPs to the screen.
func mapPt(r prect, w, h, x, y int) (int, int) {
	return r.L + x*r.W()/w, r.T + y*r.H()/h
}

// ---------------------------------------------------------------- overlays

// Highlight and sample points, in DIPs from the test area's top left. The
// cards sit at x 20..380 and 400..760, y 20..260 and 280..520: every
// sample is in a gap between them, over the green backdrop.
var (
	hl        = mygo.Rectangle{X: 200, Y: 150, Width: 380, Height: 240}
	ovPoints  = []pt{{"border-left", 203, 270, orange}, {"border-top", 390, 153, orange}, {"outside-left", 100, 270, green}, {"outside-below", 390, 470, green}, {"inside-hl", 300, 270, green}, {"inside-hl-2", 390, 330, green}}
	hitPoints = []pt{{"outside-left", 100, 270, green}, {"outside-below", 390, 470, green}}
)

func overlayTests(area prect, areaDIP mygo.Rectangle, disp mygo.Display, wvOK bool) *mygo.Window {
	var best *mygo.Window
	ox, oy := areaDIP.X-disp.Bounds.X, areaDIP.Y-disp.Bounds.Y // area origin inside the overlay, CSS px
	for _, v := range variants {
		if needsWebView(v.kind) && !wvOK {
			out.verdict("overlay "+v.label, false, "skipped: WebView2 runtime not available")
			continue
		}
		hx, hy := ox+hl.X, oy+hl.Y
		page := fmt.Sprintf("/overlay.html?x=%d&y=%d&w=%d&h=%d", hx, hy, hl.Width, hl.Height)
		draw := func(c *ui.Context) {
			ui.Box(c).Absolute().Left(float32(hx)).Top(float32(hy)).Width(float32(hl.Width)).Height(float32(hl.Height)).Border(6, ui.RGB(255, 120, 0))
		}
		ready := make(chan struct{})
		opts := mygo.WindowOptions{Title: "Pointy overlay " + v.id, X: disp.Bounds.X, Y: disp.Bounds.Y, Width: disp.Bounds.Width, Height: disp.Bounds.Height, AlwaysOnTop: true}
		w, err := makeWindow(v, opts, page, draw, ready)
		if err != nil || w == nil {
			out.verdict("overlay "+v.label, false, fmt.Sprintf("create failed: %v", err))
			continue
		}
		waitReady("overlay "+v.id, ready, 10*time.Second)
		onMain("overlay setup "+v.id, func() {
			w.SetBounds(disp.Bounds)
			w.SetIgnoreMouseEvents(true)
			noActivate(w)
		})
		fgBefore := foreground()
		onMain("overlay show "+v.id, func() { w.ShowInactive() })
		r := clientRect(w)
		out.add("overlay %s: client rect %s, exstyle %s", v.id, r, exStyle(w))
		sx := float64(r.W()) / float64(disp.Bounds.Width)
		at := func(p pt) (int, int) { return r.L + int(float64(ox+p.x)*sx), r.T + int(float64(oy+p.y)*sx) }

		t0 := time.Now()
		for time.Since(t0) < 6*time.Second {
			s, err := capture(area)
			if err != nil {
				break
			}
			if c, _ := s.at(at(ovPoints[0])); near(c, orange, tol) {
				out.add("overlay %s: highlight painted after %dms", v.id, time.Since(t0).Milliseconds())
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		time.Sleep(700 * time.Millisecond)
		fgAfter := foreground()
		s, err := capture(area)
		if err != nil {
			out.verdict("overlay "+v.id+" capture", false, err.Error())
		} else {
			out.savePNG("pointy-mygo-overlay-"+v.id+".png", s)
			var bord, clear []string
			bordOK, clearOK := true, true
			for _, p := range ovPoints {
				x, y := at(p)
				c, _ := s.at(x, y)
				desc := fmt.Sprintf("%s@%d,%d=%s", p.name, x, y, describe(c, p.want))
				if p.want == orange {
					bord = append(bord, desc)
					bordOK = bordOK && near(c, orange, tol)
				} else {
					clear = append(clear, desc)
					clearOK = clearOK && near(c, green, tol)
				}
			}
			out.verdict("overlay "+v.label+": highlight drawn", bordOK, strings.Join(bord, "; "))
			out.verdict("overlay "+v.label+": transparent outside the highlight (shows the green backdrop)", clearOK, strings.Join(clear, "; "))
			if bordOK && clearOK && best == nil {
				best = w
			}
		}
		out.verdict("overlay "+v.label+": does not take focus (GetForegroundWindow unchanged)", fgBefore == fgAfter && fgAfter != w.NativeHandle(),
			fmt.Sprintf("before %s, after %s", windowInfo(fgBefore), windowInfo(fgAfter)))
		var hits []string
		hitOK := true
		for _, p := range hitPoints {
			x, y := at(p)
			ok, desc := hitTest(x, y, w)
			hitOK = hitOK && ok
			hits = append(hits, fmt.Sprintf("%s@%d,%d -> %s", p.name, x, y, desc))
		}
		out.verdict("overlay "+v.label+": click-through (WindowFromPoint skips the overlay)", hitOK, strings.Join(hits, "; "))
		if w != best {
			onMain("overlay close "+v.id, func() { w.Destroy() })
		} else {
			onMain("overlay hide "+v.id, func() { w.Hide() })
		}
		time.Sleep(300 * time.Millisecond)
	}
	return best
}

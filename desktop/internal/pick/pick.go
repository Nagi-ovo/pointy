// Package pick turns a shake of the mouse into a card: it reads the
// selection, has the browser extension pick in a page, or lets the user
// point at a control in any app.
package pick

import (
	"context"
	"encoding/json/v2"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/browser"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	selectionWait  = 1500 * time.Millisecond
	ignoreLogEvery = 30 * time.Second
	thinText       = 30
)

// Overlay draws what the user points at; ui.Overlay is one.
type Overlay interface {
	Highlight(*contract.OverlayHighlight)
	Note(string)
	Shift(dx, dy float64)
	// Hold keeps only the box, right above owner.
	Hold(owner desktop.WindowID)
	Close()
}

// Card is how long a card keeps a pick drawn; ui.Held is one.
type Card interface {
	Release()
	Shift(dx, dy float64)
}

// Browser is the connected browser extensions.
type Browser interface {
	Count() int
	PickInBrowser(ctx context.Context, kind desktop.BrowserKind, cursor desktop.Point, urlHint string) browser.BrowserPick
}

// Deps are what picking reaches outside this package.
type Deps struct {
	Desktop    desktop.Desktop
	Settings   *config.Store
	Fullscreen func() bool
	Suppressed func() bool
	Browser    Browser
	// OpenOverlay covers a display with an overlay.
	OpenOverlay func(bounds mygo.Rectangle) Overlay
	DisplayAt   func(desktop.Point) mygo.Display
	// Keys registers global shortcuts and returns what unregisters them.
	Keys        func(map[string]func()) (unregister func())
	OpenGrab    func(contract.Grab, Card)
	ShowHint    func(string)
	CardFocused func() bool
	Log         func(kind string, err any)
}

func (d Deps) log(kind string, err any) {
	if d.Log != nil {
		d.Log(kind, err)
	}
}

// Picker runs one pick at a time.
type Picker struct {
	d Deps

	active        atomic.Bool
	fallbackNoted atomic.Bool

	mu        sync.Mutex
	cancel    context.CancelFunc
	lastQuiet time.Time
}

func New(d Deps) *Picker { return &Picker{d: d} }

// Watch picks where the mouse is shaken, until stop is closed.
func (p *Picker) Watch(stop <-chan struct{}) {
	level := func() config.ShakeLevel { return p.d.Settings.Get().ShakeLevel }
	watchShakes(p.d.Desktop, level, p.shakeAllowed, func(at desktop.Point) { go p.Pick(at) }, stop)
}

// Cancel ends the pick in progress, if any.
func (p *Picker) Cancel() {
	p.mu.Lock()
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (p *Picker) shakeAllowed() bool {
	s := p.d.Settings.Get()
	reason, ignore := "", true
	switch {
	case !s.Shake:
	case p.d.Fullscreen():
		reason = "fullscreen"
	case s.DND:
		reason = "dnd"
	case p.active.Load():
		reason = "picking"
	case p.d.CardFocused():
		reason = "card-focused"
	default:
		ignore = false
	}
	if reason != "" {
		p.mu.Lock()
		if time.Since(p.lastQuiet) > ignoreLogEvery {
			p.lastQuiet = time.Now()
			p.d.log("shake-ignored", reason)
		}
		p.mu.Unlock()
	}
	return !ignore
}

type fallback string

const (
	noFallback  fallback = ""
	noExtension fallback = "no-extension"
	noResponse  fallback = "no-response"
)

// note is the line a card shows the first time a browser pick fell back.
func (p *Picker) note(f fallback) *contract.GrabNote {
	if f == noFallback || !p.fallbackNoted.CompareAndSwap(false, true) {
		return nil
	}
	if f == noExtension {
		return &contract.GrabNote{Text: "浏览器扩展没连上，这次按普通程序指认，网页里指不到具体段落。", Install: true}
	}
	return &contract.GrabNote{Text: "浏览器扩展这次没响应，按普通程序指认的。"}
}

// Pick opens a card on what is at the mouse: the page element the
// extension picks, the selected text, or the control the user points at.
func (p *Picker) Pick(at desktop.Point) {
	if p.d.Suppressed() || !p.active.CompareAndSwap(false, true) {
		return
	}
	defer p.active.Store(false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.mu.Lock()
	p.cancel = cancel
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.cancel = nil
		p.mu.Unlock()
	}()

	d := p.d.Desktop
	fg, err := d.Foreground()
	if err != nil || blockedReason(d, fg) != "" {
		return
	}
	if hint := d.AccessHint(); hint != "" {
		p.d.ShowHint(hint)
		return
	}
	if d.ElevatedUnderCursor() {
		p.d.ShowHint("这个程序以管理员身份运行，Pointy 读不到")
		return
	}
	source := contract.GrabSource{App: fg.Exe, Title: fg.Title}
	f := noFallback
	if kind, ok := d.Browser(fg.Exe); ok {
		if p.d.Browser.Count() > 0 {
			r := p.d.Browser.PickInBrowser(ctx, kind, at, "")
			switch r.Outcome {
			case browser.Picked:
				g := contract.Grab{Source: source, Method: contract.MethodPick, URL: r.URL, PageTitle: r.PageTitle, Element: r.Element, Image: r.Image}
				if r.Element != nil {
					g.Text = r.Element.Text
				}
				p.d.OpenGrab(g, releaseOnly(r.Release))
				return
			case browser.PickCancelled:
				return
			}
			f = noResponse
		} else {
			f = noExtension
		}
		p.d.log("pick-fallback", fg.Exe+": "+string(f))
	}

	sctx, scancel := context.WithTimeout(ctx, selectionWait)
	sel, _ := d.Grab(sctx)
	scancel()
	if sel.IsPassword {
		return
	}
	if sel.OK && strings.TrimSpace(sel.Text) != "" {
		p.d.OpenGrab(contract.Grab{Source: source, Method: contract.MethodUIA, Text: sel.Text, Note: p.note(f)}, nil)
		return
	}
	p.pickControl(ctx, fg, f)
}

func (p *Picker) pickControl(ctx context.Context, fg desktop.Foreground, f fallback) {
	note := ""
	if f != noFallback {
		note = "浏览器扩展未连接"
	}
	r, err := pointNative(ctx, p.d, note)
	if err != nil {
		if !errors.Is(err, errPassword) {
			p.d.log("pick", err)
		}
		if errors.Is(err, errNoHook) {
			p.d.ShowHint("拦不住这次点击，没法指认。要先允许 Pointy 使用辅助功能")
		}
		return
	}
	if r == nil {
		return
	}
	el := r.element
	if p.d.Settings.Get().DebugPick {
		p.logDiag(fg, r)
	}
	text := el.Text
	fields := map[string]string{"控件": controlLabel(el.Control), "名称": firstRunes(el.Name, 120), "类名": el.ClassName}
	if el.Href != "" {
		fields["链接"] = el.Href
	}
	if r.opaque {
		text = ""
		fields = map[string]string{"控件": "程序界面"}
	}
	g := contract.Grab{
		Source:    contract.GrabSource{App: fg.Exe, Title: fg.Title},
		Method:    contract.MethodUIAPick,
		Element:   &contract.GrabElement{Kind: "ui-element", Site: fg.Exe, Tag: el.Control, Fields: fields, Text: text},
		Text:      text,
		WideImage: r.wide,
		ShotKind:  contract.ShotElement,
		Note:      p.note(f),
	}
	if r.focused {
		g.ShotKind = contract.ShotFocus
	}
	if r.opaque || r.focused || len(utf16.Encode([]rune(strings.TrimSpace(text)))) < thinText {
		g.Image = r.image
	}
	p.d.OpenGrab(g, r.held)
}

func (p *Picker) logDiag(fg desktop.Foreground, r *nativePick) {
	el := r.element
	diag := map[string]any{"exe": fg.Exe, "cls": el.ClassName, "control": el.Control, "kids": el.Kids, "readable": el.Readable,
		"text": len(utf16.Encode([]rune(strings.TrimSpace(el.Text)))), "opaque": r.opaque, "cover": nil}
	if el.Rect != nil && el.Win != nil {
		diag["cover"] = int(round(coverage(*el.Rect, *el.Win) * 100))
	}
	b, _ := json.Marshal(diag)
	p.d.log("pick-diag", string(b))
}

func firstRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// releaseOnly holds a browser pick, which the page draws and moves itself.
type releaseOnly func()

func (r releaseOnly) Release() {
	if r != nil {
		r()
	}
}

func (releaseOnly) Shift(dx, dy float64) {}

package pick

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

// Pointing at a control in another app runs as one state machine:
//
//	idle → pointing      the overlay follows the mouse; clicks and keys are Pointy's
//	pointing → confirming  a click or Space; the element under the mouse is read
//	confirming → held    the read finished; the box stays above the picked window
//	pointing, confirming → idle  right click, Escape, the timeout, or Cancel
//
// One goroutine owns a pick from start to held, so no state is shared.

const (
	pointPoll     = 70 * time.Millisecond
	pointTimeout  = 30 * time.Second
	holdMax       = 5 * time.Minute
	pointReadWait = time.Second
	elementWait   = 3 * time.Second
	captureWait   = 3 * time.Second
	focusStep     = 1.15
	focusMin      = 0.35
	focusMax      = 4
	minControl    = 4
	capturePad    = 3
)

var (
	// errNoHook means clicks could not be kept from the app, so pointing
	// does not start.
	errNoHook = errors.New("cannot hold the mouse")
	// errPassword means the user pointed at a password field.
	errPassword = errors.New("the control is a password field")
)

type phase int

const (
	phaseIdle phase = iota
	phasePointing
	phaseConfirming
	phaseHeld
)

// Held keeps a pick's box drawn above the window it was made in until the
// card it opened lets it go, or holdMax passes.
type Held struct {
	overlay Overlay
	once    sync.Once
	expire  *time.Timer
}

func newHeld(o Overlay) *Held {
	h := &Held{overlay: o}
	h.expire = time.AfterFunc(holdMax, h.Release)
	return h
}

func (h *Held) Release() {
	h.once.Do(func() {
		h.expire.Stop()
		h.overlay.Close()
	})
}

func (h *Held) Shift(dx, dy float64) { h.overlay.Shift(dx, dy) }

// nativePick is a control read in full, with its pictures.
type nativePick struct {
	element desktop.ElementReply
	image   string
	wide    string
	focused bool
	opaque  bool
	held    *Held
}

// drawn is a control of the chain that is big enough to draw.
type drawn struct {
	desktop.ChainItem
	rect   desktop.Rect
	opaque bool
}

type chainRead struct {
	at    desktop.Point
	reply desktop.PointReply
}

type elementRead struct {
	pick *nativePick
	err  error
}

// session is one pick of a control. Only its run goroutine touches it.
type session struct {
	d       Deps
	phase   phase
	display mygo.Display
	scale   float64
	overlay Overlay
	hook    desktop.ButtonHook

	at    desktop.Point
	chain []drawn
	level int
	zoom  float64
	shown string
}

// pointNative lets the user point at a control and returns it read, held
// on screen; nil means the user backed out or nothing was there.
func pointNative(ctx context.Context, d Deps, note contract.Message) (*nativePick, error) {
	at := d.Desktop.Cursor()
	hook, err := d.Desktop.HookButtons()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errNoHook, err)
	}
	display := d.DisplayAt(at)
	s := &session{d: d, display: display, scale: d.Desktop.UnitsPerDIP(at), at: at, zoom: 1, hook: hook}
	s.overlay = d.OpenOverlay(display.Bounds)
	if note.Key != "" {
		s.overlay.Note(note)
	}
	return s.run(ctx)
}

func (s *session) run(ctx context.Context) (*nativePick, error) {
	d := s.d.Desktop
	keys := make(chan string, 8)
	press := func(k string) func() {
		return func() {
			select {
			case keys <- k:
			default:
			}
		}
	}
	unregister := s.d.Keys(map[string]func(){"Space": press("Space"), "Escape": press("Escape"), "[": press("["), "]": press("]")})
	defer unregister()
	if err := d.SwapCursor(); err != nil {
		s.d.log("cursor", err)
	}
	d.PrewarmCapture()
	s.phase = phasePointing

	tick := time.NewTicker(pointPoll)
	timeout := time.NewTimer(pointTimeout)
	stopPointing := func() {
		s.hook.Close()
		d.RestoreCursor()
		tick.Stop()
		timeout.Stop()
	}
	defer stopPointing()

	chains := make(chan chainRead, 1)
	reading := false
	var elements chan elementRead
	end := func() (*nativePick, error) {
		s.phase = phaseIdle
		s.overlay.Close()
		return nil, nil
	}
	confirm := func() bool {
		stopPointing()
		elements = s.confirm(ctx)
		return elements != nil
	}

	for {
		select {
		case <-ctx.Done():
			return end()
		case <-timeout.C:
			return end()
		case <-tick.C:
			if s.phase != phasePointing || reading {
				continue
			}
			reading = true
			at := d.Cursor()
			go func() {
				rctx, cancel := context.WithTimeout(ctx, pointReadWait)
				defer cancel()
				r, _ := d.PointAt(rctx, at)
				chains <- chainRead{at, r}
			}()
		case r := <-chains:
			reading = false
			if s.phase == phasePointing {
				s.at = r.at
				s.setChain(r.reply)
				s.draw()
			}
		case b := <-s.hook.Events():
			switch {
			case b == desktop.RightUp:
				return end()
			case s.phase != phasePointing:
			case b == desktop.LeftUp:
				if !confirm() {
					return end()
				}
			default:
				s.zoomBy(b)
			}
		case k := <-keys:
			switch {
			case k == "Escape":
				return end()
			case s.phase != phasePointing:
			case k == "Space":
				if !confirm() {
					return end()
				}
			case k == "[":
				s.level = max(0, s.level-1)
				s.draw()
			case k == "]":
				s.level = max(0, min(len(s.chain)-1, s.level+1))
				s.draw()
			}
		case r := <-elements:
			if r.err != nil || r.pick == nil {
				s.overlay.Close()
				return nil, r.err
			}
			s.phase = phaseHeld
			owner := desktop.WindowID(0)
			if fg, err := d.Foreground(); err == nil {
				owner = fg.ID
			}
			s.overlay.Hold(owner)
			r.pick.held = newHeld(s.overlay)
			return r.pick, nil
		}
	}
}

// setChain keeps the controls big enough to draw; the innermost is checked
// for being opaque only when it is one of them.
func (s *session) setChain(r desktop.PointReply) {
	s.chain = s.chain[:0]
	for i, c := range r.Chain {
		if c.Rect == nil || c.Rect[2] <= minControl || c.Rect[3] <= minControl {
			continue
		}
		dr := drawn{ChainItem: c, rect: *c.Rect}
		if i == 0 {
			dr.opaque = isOpaque(shape{Class: c.Class, Type: c.Control, Rect: c.Rect, Win: r.Win, Kids: r.LeafKids, Readable: r.LeafReadable})
		}
		s.chain = append(s.chain, dr)
	}
}

func (s *session) current() (drawn, bool) {
	if len(s.chain) == 0 {
		return drawn{}, false
	}
	return s.chain[min(s.level, len(s.chain)-1)], true
}

func (s *session) local(r desktop.Rect) contract.LocalRect {
	dip := s.d.Desktop.RectToDIP(r)
	return contract.LocalRect{X: float64(dip.X - s.display.Bounds.X), Y: float64(dip.Y - s.display.Bounds.Y), Width: float64(dip.Width), Height: float64(dip.Height)}
}

func (s *session) draw() {
	c, ok := s.current()
	key := ""
	if ok {
		key = fmt.Sprint(c.rect, "|", c.Name)
		if c.opaque {
			key += fmt.Sprint("|", s.at, s.zoom)
		}
	}
	if key == s.shown {
		return
	}
	s.shown = key
	if !ok {
		s.hook.SetWheel(false)
		s.overlay.Highlight(nil)
		return
	}
	h := &contract.OverlayHighlight{LocalRect: s.local(c.rect), Control: i18n.Msg(i18n.Control(c.Control)), Name: c.Name}
	focused := false
	if c.opaque {
		if f, ok := focusRect(c.rect, s.at, s.scale, s.zoom); ok {
			lf := s.local(f)
			h.Focus, focused = &lf, true
		}
	}
	s.hook.SetWheel(focused)
	s.overlay.Highlight(h)
}

func (s *session) zoomBy(b desktop.Button) {
	if b == desktop.WheelUp {
		s.zoom *= focusStep
	} else {
		s.zoom /= focusStep
	}
	s.zoom = min(focusMax, max(focusMin, s.zoom))
	s.draw()
}

// confirm reads the control the user chose, or returns nil when nothing is
// under the mouse.
func (s *session) confirm(ctx context.Context) chan elementRead {
	if len(s.chain) == 0 {
		return nil
	}
	s.phase = phaseConfirming
	out := make(chan elementRead, 1)
	at, level, zoom := s.at, min(s.level, len(s.chain)-1), s.zoom
	go func() {
		p, err := s.read(ctx, at, level, zoom)
		out <- elementRead{p, err}
	}()
	return out
}

func (s *session) read(ctx context.Context, at desktop.Point, level int, zoom float64) (*nativePick, error) {
	ectx, cancel := context.WithTimeout(ctx, elementWait)
	el, err := s.d.Desktop.ElementAt(ectx, at, level)
	cancel()
	switch {
	case err != nil:
		return nil, err
	case el.IsPassword:
		return nil, errPassword
	case !el.OK:
		return nil, nil
	}
	sh := shape{Class: el.ClassName, Type: el.Control, Rect: el.Rect, Win: el.Win, Kids: el.Kids, Readable: el.Readable}
	p := &nativePick{element: el}
	p.opaque = isOpaque(sh) && (isWholeWindow(sh) || strings.TrimSpace(el.Text) == "")
	if el.Rect == nil {
		return p, nil
	}
	shot, wide := *el.Rect, (*desktop.Rect)(nil)
	if p.opaque {
		if f, ok := focusRect(*el.Rect, at, s.scale, zoom); ok {
			shot, wide, p.focused = f, el.Rect, true
		}
	}
	if !p.focused && el.Win != nil && *el.Win != *el.Rect {
		wide = el.Win
	}
	p.image = s.capture(ctx, shot, el.PID)
	if wide != nil {
		p.wide = s.capture(ctx, *wide, el.PID)
	}
	return p, nil
}

func (s *session) capture(ctx context.Context, r desktop.Rect, pid int) string {
	cctx, cancel := context.WithTimeout(ctx, captureWait)
	defer cancel()
	pad := int(round(capturePad * s.scale))
	img, err := s.d.Desktop.Capture(cctx, desktop.Rect{r[0] - pad, r[1] - pad, r[2] + 2*pad, r[3] + 2*pad}, pid)
	if err != nil {
		s.d.log("pick-capture", err)
		return ""
	}
	url, err := jpegDataURL(img)
	if err != nil {
		s.d.log("pick-capture", err)
	}
	return url
}

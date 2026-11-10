package pick

import (
	"context"
	"errors"
	"image"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

type fakeDesktop struct {
	desktop.Unsupported
	chain      desktop.PointReply
	element    desktop.ElementReply
	elementErr error
	gate       chan struct{}
	events     chan desktop.Button
	hookErr    error
	windows    map[int]desktop.Foreground
	front      *desktop.Foreground
	blocked    map[string]bool

	mu        sync.Mutex
	readUp    int
	reads     int
	tapOn     bool
	wheel     bool
	swapped   int
	restored  int
	captures  []desktop.Rect
	capturePI int
}

func (f *fakeDesktop) Cursor() desktop.Point { return desktop.Point{X: 500, Y: 300} }
func (f *fakeDesktop) Foreground() (desktop.Foreground, error) {
	if f.front != nil {
		return *f.front, nil
	}
	return desktop.Foreground{ID: 42}, nil
}
func (f *fakeDesktop) Blocked(exe string) bool { return f.blocked[exe] }
func (f *fakeDesktop) WindowAt(pid int, _ desktop.Point) (desktop.Foreground, error) {
	if w, ok := f.windows[pid]; ok {
		return w, nil
	}
	return desktop.Foreground{}, errors.ErrUnsupported
}
func (f *fakeDesktop) PointAt(context.Context, desktop.Point) (desktop.PointReply, error) {
	return f.chain, nil
}

func (f *fakeDesktop) ElementAt(ctx context.Context, p desktop.Point, up int) (desktop.ElementReply, error) {
	f.mu.Lock()
	f.reads++
	f.readUp = up
	f.mu.Unlock()
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return desktop.ElementReply{}, ctx.Err()
		}
	}
	return f.element, f.elementErr
}

func (f *fakeDesktop) HookButtons() (desktop.ButtonHook, error) {
	if f.hookErr != nil {
		return nil, f.hookErr
	}
	f.mu.Lock()
	f.tapOn = true
	f.mu.Unlock()
	return fakeHook{f}, nil
}

func (f *fakeDesktop) wheelOn() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.wheel }

func (f *fakeDesktop) SwapCursor() error { f.mu.Lock(); f.swapped++; f.mu.Unlock(); return nil }
func (f *fakeDesktop) RestoreCursor()    { f.mu.Lock(); f.restored++; f.mu.Unlock() }

func (f *fakeDesktop) Capture(_ context.Context, r desktop.Rect, pid int) (image.Image, error) {
	f.mu.Lock()
	f.captures = append(f.captures, r)
	f.capturePI = pid
	f.mu.Unlock()
	return image.NewRGBA(image.Rect(0, 0, r[2]*2, r[3]*2)), nil
}

type fakeHook struct{ f *fakeDesktop }

func (h fakeHook) Events() <-chan desktop.Button { return h.f.events }
func (h fakeHook) SetWheel(on bool)              { h.f.mu.Lock(); h.f.wheel = on; h.f.mu.Unlock() }
func (h fakeHook) Close()                        { h.f.mu.Lock(); h.f.tapOn = false; h.f.mu.Unlock() }

type fakeOverlay struct {
	mu         sync.Mutex
	highlights []*contract.OverlayHighlight
	notes      []contract.Message
	owner      desktop.WindowID
	held       bool
	closed     bool
}

func (o *fakeOverlay) Highlight(h *contract.OverlayHighlight) {
	o.mu.Lock()
	o.highlights = append(o.highlights, h)
	o.mu.Unlock()
}
func (o *fakeOverlay) Note(t contract.Message) {
	o.mu.Lock()
	o.notes = append(o.notes, t)
	o.mu.Unlock()
}
func (o *fakeOverlay) Shift(dx, dy float64) {}
func (o *fakeOverlay) Hold(owner desktop.WindowID) {
	o.mu.Lock()
	o.held, o.owner = true, owner
	o.mu.Unlock()
}
func (o *fakeOverlay) Close() { o.mu.Lock(); o.closed = true; o.mu.Unlock() }

func (o *fakeOverlay) last() *contract.OverlayHighlight {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.highlights) == 0 {
		return nil
	}
	return o.highlights[len(o.highlights)-1]
}

type rig struct {
	t       *testing.T
	d       *fakeDesktop
	overlay *fakeOverlay
	opened  atomic.Int32

	mu           sync.Mutex
	keys         map[string]func()
	unregistered bool
	hints        []string

	done chan struct{}
	pick *nativePick
	err  error
}

var textArea = desktop.ChainItem{Rect: rect(100, 100, 600, 300), Control: "ControlType.Document", Class: "AXTextArea"}
var window = desktop.ChainItem{Rect: rect(80, 60, 700, 400), Control: "ControlType.Window", Class: "AXWindow", Name: "notes.txt"}

func newRig(t *testing.T) *rig {
	d := &fakeDesktop{
		chain: desktop.PointReply{OK: true, Chain: []desktop.ChainItem{textArea, window}, Win: window.Rect, LeafReadable: true},
		element: desktop.ElementReply{OK: true, Control: textArea.Control, ClassName: textArea.Class, Rect: textArea.Rect,
			PID: 7, Win: window.Rect, Readable: true, Text: "a paragraph to ask about"},
		events: make(chan desktop.Button, 4),
	}
	return &rig{t: t, d: d, overlay: &fakeOverlay{}}
}

func (r *rig) deps() Deps {
	return Deps{
		Desktop: r.d,
		OpenOverlay: func(mygo.Rectangle) Overlay {
			r.opened.Add(1)
			return r.overlay
		},
		DisplayAt: func(desktop.Point) mygo.Display {
			return mygo.Display{Bounds: mygo.Rectangle{X: 0, Y: 0, Width: 1440, Height: 900}, ScaleFactor: 2}
		},
		ShowHint: func(h string) { r.mu.Lock(); r.hints = append(r.hints, h); r.mu.Unlock() },
		Keys: func(k map[string]func()) func() {
			r.mu.Lock()
			r.keys = k
			r.mu.Unlock()
			return func() { r.mu.Lock(); r.unregistered = true; r.mu.Unlock() }
		},
	}
}

func (r *rig) start(ctx context.Context) {
	r.done = make(chan struct{})
	go func() {
		r.pick, r.err = pointNative(ctx, r.deps(), contract.Message{})
		close(r.done)
	}()
}

func (r *rig) waitFor(what string, ok func() bool) {
	r.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			r.t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *rig) press(key string) {
	r.mu.Lock()
	fn := r.keys[key]
	r.mu.Unlock()
	fn()
}

func (r *rig) finish() {
	r.t.Helper()
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
		r.t.Fatal("the pick did not end")
	}
}

func (r *rig) pointed() { r.waitFor("a highlight", func() bool { return r.overlay.last() != nil }) }

func (r *rig) assertEnded() {
	r.t.Helper()
	r.d.mu.Lock()
	defer r.d.mu.Unlock()
	if r.d.tapOn || r.d.swapped != 1 || r.d.restored == 0 {
		r.t.Errorf("tap on %v, cursor swapped %d restored %d", r.d.tapOn, r.d.swapped, r.d.restored)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.unregistered {
		r.t.Error("the pointing keys stayed registered")
	}
}

func TestClickPicksTheControlAndHoldsTheBox(t *testing.T) {
	r := newRig(t)
	r.start(context.Background())
	r.pointed()
	if h := r.overlay.last(); h.X != 100 || h.Width != 600 || h.Control.Key != "control.Document" || h.Focus != nil {
		t.Fatalf("highlight %+v", h)
	}
	r.d.events <- desktop.LeftUp
	r.finish()
	if r.err != nil || r.pick == nil {
		t.Fatalf("pick %v, err %v", r.pick, r.err)
	}
	if r.pick.element.Text != "a paragraph to ask about" || r.pick.image == "" || r.pick.wide == "" || r.pick.opaque || r.pick.focused {
		t.Fatalf("pick %+v", r.pick)
	}
	if !strings.HasPrefix(r.pick.image, "data:image/jpeg;base64,") {
		t.Fatalf("image %.40q", r.pick.image)
	}
	want := []desktop.Rect{{97, 97, 606, 306}, {77, 57, 706, 406}}
	if len(r.d.captures) != 2 || r.d.captures[0] != want[0] || r.d.captures[1] != want[1] || r.d.capturePI != 7 {
		t.Fatalf("captured %v of pid %d, want %v of pid 7", r.d.captures, r.d.capturePI, want)
	}
	if !r.overlay.held || r.overlay.owner != 42 || r.overlay.closed {
		t.Fatalf("overlay held %v owner %d closed %v", r.overlay.held, r.overlay.owner, r.overlay.closed)
	}
	r.assertEnded()
	r.pick.held.Release()
	r.pick.held.Release()
	if !r.overlay.closed {
		t.Fatal("releasing the card's hold left the overlay open")
	}
}

func TestSpaceConfirmsLikeAClick(t *testing.T) {
	r := newRig(t)
	r.start(context.Background())
	r.pointed()
	r.press("Space")
	r.finish()
	if r.pick == nil || !r.overlay.held {
		t.Fatalf("pick %v held %v", r.pick, r.overlay.held)
	}
}

func TestRightClickCancels(t *testing.T) {
	r := newRig(t)
	r.start(context.Background())
	r.pointed()
	r.d.events <- desktop.RightUp
	r.finish()
	if r.pick != nil || r.err != nil || !r.overlay.closed || r.overlay.held || r.d.reads != 0 {
		t.Fatalf("pick %v err %v closed %v held %v reads %d", r.pick, r.err, r.overlay.closed, r.overlay.held, r.d.reads)
	}
	r.assertEnded()
}

func TestEscapeDuringConfirmingCancels(t *testing.T) {
	r := newRig(t)
	r.d.gate = make(chan struct{})
	r.start(context.Background())
	r.pointed()
	r.d.events <- desktop.LeftUp
	r.waitFor("the element read", func() bool { r.d.mu.Lock(); defer r.d.mu.Unlock(); return r.d.reads == 1 })
	r.press("Escape")
	r.finish()
	close(r.d.gate)
	if r.pick != nil || !r.overlay.closed || r.overlay.held {
		t.Fatalf("pick %v closed %v held %v", r.pick, r.overlay.closed, r.overlay.held)
	}
	r.assertEnded()
}

func TestCancelDuringConfirmingCancels(t *testing.T) {
	r := newRig(t)
	r.d.gate = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	r.start(ctx)
	r.pointed()
	r.press("Space")
	r.waitFor("the element read", func() bool { r.d.mu.Lock(); defer r.d.mu.Unlock(); return r.d.reads == 1 })
	cancel()
	r.finish()
	if r.pick != nil || !r.overlay.closed || r.overlay.held {
		t.Fatalf("pick %v closed %v held %v", r.pick, r.overlay.closed, r.overlay.held)
	}
}

func TestBracketClimbsToTheParent(t *testing.T) {
	r := newRig(t)
	r.start(context.Background())
	r.pointed()
	r.press("]")
	r.press("]")
	r.waitFor("the parent's box", func() bool { h := r.overlay.last(); return h.Control.Key == "control.Window" && h.Name == "notes.txt" })
	r.press("[")
	r.waitFor("the child's box", func() bool { return r.overlay.last().Control.Key == "control.Document" })
	r.press("]")
	r.press("Space")
	r.finish()
	if r.d.readUp != 1 {
		t.Fatalf("read %d levels up, want 1", r.d.readUp)
	}
}

func TestPasswordFieldOpensNothing(t *testing.T) {
	r := newRig(t)
	r.d.element = desktop.ElementReply{IsPassword: true}
	r.start(context.Background())
	r.pointed()
	r.d.events <- desktop.LeftUp
	r.finish()
	if r.pick != nil || !errors.Is(r.err, errPassword) || !r.overlay.closed {
		t.Fatalf("pick %v err %v closed %v", r.pick, r.err, r.overlay.closed)
	}
}

func TestNoInterceptMeansNoPointing(t *testing.T) {
	r := newRig(t)
	r.d.hookErr = errors.New("no tap")
	r.start(context.Background())
	r.finish()
	if !errors.Is(r.err, errNoHook) || r.opened.Load() != 0 || r.d.swapped != 0 {
		t.Fatalf("err %v, overlays %d, cursor swapped %d", r.err, r.opened.Load(), r.d.swapped)
	}
}

func TestWheelSizesTheFocusFrameOfAnOpaqueControl(t *testing.T) {
	r := newRig(t)
	shell := desktop.ChainItem{Rect: rect(0, 0, 1400, 860), Control: "ControlType.Group", Class: "AXGroup"}
	r.d.chain = desktop.PointReply{OK: true, Chain: []desktop.ChainItem{shell}, Win: rect(0, 0, 1400, 880)}
	r.d.element = desktop.ElementReply{OK: true, Control: shell.Control, ClassName: shell.Class, Rect: shell.Rect, PID: 7, Win: rect(0, 0, 1400, 880)}
	r.start(context.Background())
	r.pointed()
	first := r.overlay.last().Focus
	if first == nil || first.Width != 720 || !r.d.wheelOn() {
		t.Fatalf("focus %+v, wheel %v", first, r.d.wheelOn())
	}
	r.d.events <- desktop.WheelUp
	r.waitFor("a bigger frame", func() bool { f := r.overlay.last().Focus; return f != nil && f.Width == 828 })
	r.d.events <- desktop.LeftUp
	r.finish()
	if !r.pick.opaque || !r.pick.focused || len(r.d.captures) != 2 || r.d.captures[0][2] != 828+2*capturePad {
		t.Fatalf("pick %+v captures %v", r.pick, r.d.captures)
	}
}

func TestHighlightIsInTheOverlaysCoordinates(t *testing.T) {
	cases := []struct {
		name    string
		display mygo.Rectangle
		r       desktop.Rect
		want    contract.LocalRect
	}{
		{"primary display", mygo.Rectangle{X: 0, Y: 0, Width: 2560, Height: 1440}, desktop.Rect{309, 135, 656, 384}, contract.LocalRect{X: 309, Y: 135, Width: 656, Height: 384}},
		{"display right of and below the primary", mygo.Rectangle{X: 2560, Y: 458, Width: 1512, Height: 982}, desktop.Rect{2600, 500, 100, 50}, contract.LocalRect{X: 40, Y: 42, Width: 100, Height: 50}},
		{"display left of and above the primary", mygo.Rectangle{X: -1512, Y: -200, Width: 1512, Height: 982}, desktop.Rect{-1500, -190, 30, 20}, contract.LocalRect{X: 12, Y: 10, Width: 30, Height: 20}},
	}
	for _, c := range cases {
		s := &session{d: Deps{Desktop: &fakeDesktop{}}, display: mygo.Display{Bounds: c.display}}
		if got := s.local(c.r); got != c.want {
			t.Errorf("%s: local(%v) = %+v, want %+v", c.name, c.r, got, c.want)
		}
	}
}

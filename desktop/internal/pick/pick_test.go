package pick

import (
	"context"
	"testing"

	"github.com/pointylab/pointy/desktop/internal/browser"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

var terminal = desktop.Foreground{ID: 42, PID: 3, Exe: "terminal", Title: "zsh"}

// pickBehind points at the rig's control while fg is in front, and returns
// the grab a card would open on, if any.
func pickBehind(t *testing.T, r *rig, fg desktop.Foreground) *contract.Grab {
	t.Helper()
	var got *contract.Grab
	d := r.deps()
	d.Settings = config.LoadSettings(t.TempDir())
	d.OpenGrab = func(g contract.Grab, _ Card) { got = &g }
	done := make(chan struct{})
	go func() {
		New(d).pickControl(context.Background(), fg, noFallback)
		close(done)
	}()
	r.pointed()
	r.d.events <- desktop.LeftUp
	<-done
	return got
}

func TestCardNamesThePickedWindowNotTheForegroundOne(t *testing.T) {
	r := newRig(t)
	r.d.windows = map[int]desktop.Foreground{7: {ID: 9, PID: 7, Exe: "textedit", Title: "notes.txt"}}
	g := pickBehind(t, r, terminal)
	if g == nil {
		t.Fatal("no card opened")
	}
	if g.Source != (contract.GrabSource{App: "textedit", Title: "notes.txt"}) || g.Element.Site != "textedit" {
		t.Fatalf("source %+v site %q, want TextEdit's notes.txt", g.Source, g.Element.Site)
	}
}

func TestCardFallsBackToTheForegroundWhenThePickedWindowIsUnknown(t *testing.T) {
	r := newRig(t)
	g := pickBehind(t, r, terminal)
	if g == nil || g.Source != (contract.GrabSource{App: "terminal", Title: "zsh"}) {
		t.Fatalf("grab %+v", g)
	}
}

func TestPickInALoginWindowBehindOpensNothing(t *testing.T) {
	r := newRig(t)
	r.d.windows = map[int]desktop.Foreground{7: {ID: 9, PID: 7, Exe: "safari", Title: "Sign in to your bank"}}
	if g := pickBehind(t, r, terminal); g != nil {
		t.Fatalf("opened a card on %+v", g.Source)
	}
	if !r.overlay.closed {
		t.Fatal("the box stayed drawn over the login window")
	}
}

func (r *rig) hinted(t *testing.T, want contract.BlockReason) {
	t.Helper()
	h, _ := i18n.BlockHint(want)
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.hints) != 1 || r.hints[0] != h {
		t.Fatalf("hints %q, want [%q]", r.hints, h)
	}
}

func TestPickInALoginWindowBehindSaysWhy(t *testing.T) {
	r := newRig(t)
	r.d.windows = map[int]desktop.Foreground{7: {ID: 9, PID: 7, Exe: "safari", Title: "Sign in to your bank"}}
	pickBehind(t, r, terminal)
	r.hinted(t, contract.BlockLoginWindow)
}

func TestPointingAtAPasswordFieldSaysWhy(t *testing.T) {
	r := newRig(t)
	r.d.element = desktop.ElementReply{IsPassword: true}
	if g := pickBehind(t, r, terminal); g != nil {
		t.Fatalf("opened a card on %+v", g.Source)
	}
	r.hinted(t, contract.BlockPasswordField)
}

func TestShakeOverABlockedAppSaysWhyAndPointsAtNothing(t *testing.T) {
	for _, c := range []struct {
		front desktop.Foreground
		want  contract.BlockReason
	}{
		{desktop.Foreground{ID: 5, PID: 5, Exe: "1password", Title: "Vault"}, contract.BlockApp},
		{desktop.Foreground{ID: 6, PID: 6, Exe: "textedit", Title: "登录 - 网上银行"}, contract.BlockLoginWindow},
	} {
		r := newRig(t)
		r.d.front, r.d.blocked = &c.front, map[string]bool{"1password": true}
		d := r.deps()
		d.Suppressed = func() bool { return false }
		d.OpenGrab = func(g contract.Grab, _ Card) { t.Errorf("%s: opened a card on %+v", c.front.Exe, g.Source) }
		New(d).Pick(desktop.Point{X: 500, Y: 300})
		if r.opened.Load() != 0 {
			t.Errorf("%s: started pointing", c.front.Exe)
		}
		r.hinted(t, c.want)
	}
}

type fakeBrowser struct {
	cursor  desktop.Point
	blocked contract.BlockReason
}

func (*fakeBrowser) Count() int { return 1 }
func (b *fakeBrowser) PickInBrowser(_ context.Context, _ desktop.BrowserKind, cursor desktop.Point, _ string) browser.BrowserPick {
	b.cursor = cursor
	return browser.BrowserPick{Outcome: browser.PickCancelled, Blocked: b.blocked}
}

// The page finds the element under the cursor as cursor / devicePixelRatio
// minus the window's screenX, so it needs the cursor in device pixels.
func TestBrowserPickGetsTheCursorInDevicePixels(t *testing.T) {
	r := newRig(t)
	r.d.front = &desktop.Foreground{ID: 8, PID: 8, Exe: "google chrome", Title: "Example"}
	b := &fakeBrowser{}
	d := r.deps()
	d.Suppressed = func() bool { return false }
	d.Browser = b
	New(d).Pick(desktop.Point{X: 500, Y: 300})
	if b.cursor != (desktop.Point{X: 1000, Y: 600}) {
		t.Fatalf("cursor %+v, want 1000,600 on a display at scale 2", b.cursor)
	}
}

func TestPageRefusingAPasswordFieldSaysWhy(t *testing.T) {
	r := newRig(t)
	r.d.front = &desktop.Foreground{ID: 8, PID: 8, Exe: "google chrome", Title: "Example"}
	d := r.deps()
	d.Suppressed = func() bool { return false }
	d.Browser = &fakeBrowser{blocked: contract.BlockPasswordField}
	d.OpenGrab = func(g contract.Grab, _ Card) { t.Errorf("opened a card on %+v", g) }
	New(d).Pick(desktop.Point{X: 500, Y: 300})
	r.hinted(t, contract.BlockPasswordField)
}

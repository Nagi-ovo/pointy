package pick

import (
	"context"
	"testing"

	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
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

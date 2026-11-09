package ui

import (
	"context"
	"encoding/json/jsontext"
	"math"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/contract"
)

// Services are bound with mygo.Bind. Each is a page API of app/types.d.ts,
// method for method; the window that calls is the one it acts on.
func (u *UI) Services() []any { return []any{&Card{u}, &Pill{u}, &Notice{u}, &Intro{u}} }

// Card is window.card.
type Card struct{ u *UI }

func (s *Card) with(ctx context.Context, fn func(*card)) {
	w := mygo.CallerWindow(ctx)
	mygo.RunOnMain(func() {
		if c := s.u.cardOf(w); c != nil {
			fn(c)
		}
	})
}

// Init is what the card shows.
func (s *Card) Init(ctx context.Context) contract.CardInit {
	var init contract.CardInit
	s.with(ctx, func(c *card) { init = c.init })
	return init
}

// Send passes a request to the agent and reports whether it went out.
func (s *Card) Send(ctx context.Context, msg jsontext.Value) bool { return s.u.deps.Agent.Request(msg) }

func (s *Card) Close(ctx context.Context) { s.with(ctx, func(c *card) { c.win.Close() }) }

// OpenAgent closes the card and brings the agent forward.
func (s *Card) OpenAgent(ctx context.Context, sessionID string) {
	s.with(ctx, func(c *card) { c.win.Close() })
	s.u.deps.Agent.Open(sessionID)
}

func (s *Card) Copy(ctx context.Context, text string) { mygo.Clipboard.WriteText(text) }

// Resize fits the card to its content's height.
func (s *Card) Resize(ctx context.Context, height float64) {
	s.with(ctx, func(c *card) { s.u.resizeCard(c, int(height)) })
}

// MenuRoom makes room for an open menu, or gives it back with 0.
func (s *Card) MenuRoom(ctx context.Context, height float64) {
	s.with(ctx, func(c *card) { s.u.menuRoom(c, int(math.Ceil(height))) })
}

// Rendered marks a state of the card. Screenshots now come from
// mygo-automation, so it does nothing.
func (s *Card) Rendered(ctx context.Context, name string) {}

// Keep turns the card into a pill while its task runs on.
func (s *Card) Keep(ctx context.Context, info contract.KeepInfo) {
	s.with(ctx, func(c *card) { s.u.keep(c, info) })
}

func (s *Card) OpenLink(ctx context.Context, href string)  { openLink(href) }
func (s *Card) OpenImage(ctx context.Context, path string) { openImage(path) }
func (s *Card) ExtensionGuide(ctx context.Context)         { go s.u.ShowExtensionGuide() }
func (s *Card) GripStart(ctx context.Context)              { s.with(ctx, s.u.gripStart) }
func (s *Card) GripMove(ctx context.Context)               { s.with(ctx, s.u.gripMove) }
func (s *Card) GripEnd(ctx context.Context)                { mygo.RunOnMain(func() { s.u.grip = nil }) }

// Asked ends the pick the card came from, once the question went out.
func (s *Card) Asked(ctx context.Context) { s.with(ctx, func(c *card) { c.releasePick() }) }

// Pill is window.pill.
type Pill struct{ u *UI }

// Open puts the pill's card back.
func (s *Pill) Open(ctx context.Context, id string) { mygo.RunOnMain(func() { s.u.openPill(id) }) }

// Dismiss drops the pill and its card.
func (s *Pill) Dismiss(ctx context.Context, id string) {
	mygo.RunOnMain(func() { s.u.dismissPill(id) })
}

// Resize fits the pill window to its page.
func (s *Pill) Resize(ctx context.Context, height float64) {
	mygo.RunOnMain(func() { s.u.placePills(int(math.Ceil(height))) })
}

// Notice is window.notice.
type Notice struct{ u *UI }

func (s *Notice) with(ctx context.Context, fn func(*notice)) {
	w := mygo.CallerWindow(ctx)
	mygo.RunOnMain(func() {
		if n := s.u.noticeOf(w); n != nil {
			fn(n)
		}
	})
}

// Init is what the notice says.
func (s *Notice) Init(ctx context.Context) contract.NoticeInit {
	var init contract.NoticeInit
	s.with(ctx, func(n *notice) { init = n.init })
	return init
}

// Choose answers the notice with a button's id, or null for none.
func (s *Notice) Choose(ctx context.Context, id *string) {
	s.with(ctx, func(n *notice) { s.u.finishNotice(n, id) })
}

func (s *Notice) Resize(ctx context.Context, height float64) {
	s.with(ctx, func(n *notice) { s.u.resizeNotice(n, int(math.Round(height))) })
}

func (s *Notice) Copy(ctx context.Context, text string) {
	s.with(ctx, func(*notice) { mygo.Clipboard.WriteText(text) })
}

// Intro is window.intro.
type Intro struct{ u *UI }

func (s *Intro) Init(ctx context.Context) contract.IntroInit {
	return contract.IntroInit{Version: s.u.deps.Version}
}

// Done ends the intro.
func (s *Intro) Done(ctx context.Context) {
	w := mygo.CallerWindow(ctx)
	mygo.RunOnMain(func() {
		if in := s.u.intro; in != nil && in.win == w {
			s.u.finishIntro(in)
		}
	})
}

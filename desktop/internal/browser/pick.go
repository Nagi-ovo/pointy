package browser

import (
	"context"
	"time"

	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/server"
)

const (
	pickTimeout      = 60 * time.Second
	pickStartTimeout = 4 * time.Second
)

// PickOutcome is how a pick in the browser ended.
type PickOutcome int

const (
	Picked PickOutcome = iota
	// PickCancelled means the user backed out; nothing opens.
	PickCancelled
	// PickUnavailable means the extension could not pick on this page, so
	// Pointy picks the browser as an app instead.
	PickUnavailable
)

// BrowserPick is what the extension picked on the page.
type BrowserPick struct {
	Outcome   PickOutcome
	URL       string
	PageTitle string
	Element   *contract.GrabElement
	Image     string
	// Blocked says why the page refused the pick, when it did.
	Blocked contract.BlockReason
	// Release lets the page drop its highlight.
	Release func()
}

// pickReply is a pick message from the extension.
type pickReply struct {
	Type      string                `json:"type"`
	ReqID     string                `json:"reqId"`
	URL       string                `json:"url"`
	PageTitle string                `json:"pageTitle"`
	Element   *contract.GrabElement `json:"element"`
	Image     string                `json:"image"`
	Blocked   contract.BlockReason  `json:"blocked"`
}

type picking struct {
	reqID   string
	started chan struct{}
	reply   chan pickReply
}

func (h *handler) onPick(m server.Message) {
	var r pickReply
	if m.Decode(&r) != nil {
		return
	}
	e := h.e
	e.mu.Lock()
	p := e.picking
	e.mu.Unlock()
	if p == nil || p.reqID != r.ReqID {
		return
	}
	if r.Type == "pick-started" {
		select {
		case <-p.started:
		default:
			close(p.started)
		}
		return
	}
	select {
	case p.reply <- r:
	default:
	}
}

// extensionFor prefers an extension in the kind of browser the user
// points at.
func (e *Extensions) extensionFor(kind desktop.BrowserKind) *server.Conn {
	e.mu.Lock()
	defer e.mu.Unlock()
	var fallback *server.Conn
	for _, x := range e.conns {
		if x.browser == string(kind) {
			return x.conn
		}
		fallback = x.conn
	}
	return fallback
}

// PickInBrowser has the extension in a browser of kind let the user pick
// an element on the page under cursor.
func (e *Extensions) PickInBrowser(ctx context.Context, kind desktop.BrowserKind, cursor desktop.Point, urlHint string) BrowserPick {
	c := e.extensionFor(kind)
	if c == nil {
		return BrowserPick{Outcome: PickUnavailable}
	}
	p := &picking{reqID: config.RandomHex(16), started: make(chan struct{}), reply: make(chan pickReply, 1)}
	e.mu.Lock()
	e.picking = p
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		if e.picking == p {
			e.picking = nil
		}
		e.mu.Unlock()
	}()
	err := c.Send(map[string]any{"type": "pick-start", "reqId": p.reqID, "cursor": map[string]float64{"x": cursor.X, "y": cursor.Y}, "urlHint": urlHint})
	if err != nil {
		return BrowserPick{Outcome: PickUnavailable}
	}
	abort := func() { c.Send(map[string]string{"type": "pick-abort", "reqId": p.reqID}) }
	start := time.NewTimer(pickStartTimeout)
	defer start.Stop()
	whole := time.NewTimer(pickTimeout)
	defer whole.Stop()
	started := p.started
	for {
		select {
		case <-started:
			started = nil
			start.Stop()
		case <-start.C:
			e.log("pick-no-start", "extension did not start pick "+p.reqID)
			return BrowserPick{Outcome: PickUnavailable}
		case <-whole.C:
			abort()
			return BrowserPick{Outcome: PickCancelled}
		case <-ctx.Done():
			abort()
			return BrowserPick{Outcome: PickCancelled}
		case <-c.Closed():
			return BrowserPick{Outcome: PickUnavailable}
		case r := <-p.reply:
			release := func() { c.Send(map[string]string{"type": "pick-release", "reqId": p.reqID}) }
			switch r.Type {
			case "picked":
				return BrowserPick{Outcome: Picked, URL: r.URL, PageTitle: r.PageTitle, Element: r.Element, Image: r.Image, Release: release}
			case "pick-unavailable":
				return BrowserPick{Outcome: PickUnavailable, Release: release}
			default:
				return BrowserPick{Outcome: PickCancelled, Blocked: r.Blocked, Release: release}
			}
		}
	}
}

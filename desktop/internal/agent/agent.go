// Package agent relays between cards and the DSH plugin. Card requests and
// plugin events pass through as JSON; the relay reads only what it acts on:
// a message's type, session, title and reason.
package agent

import (
	"encoding/json/jsontext"
	"encoding/json/v2"
	"strings"
	"sync"

	"github.com/pointylab/pointy/desktop/internal/server"
)

const Name = "DSH"

// TaskEvent is what pills follow of a session.
type TaskEvent struct {
	Type      string
	SessionID string
	Title     string
	Reason    string
}

// Status is shown in the tray.
type Status struct {
	Connected        bool
	Version          string
	PendingApprovals int
}

// Deps are what the relay reaches outside itself. Unset ones do nothing.
type Deps struct {
	ToCards  func(msg jsontext.Value)
	OnTask   func(TaskEvent)
	Notify   func(title, body string, onClick func())
	ShowHint func(text string)
	FocusTab func(origin string) bool
	OpenURL  func(url string)
	// AllowForeground lets the app Pointy opens come to the front.
	AllowForeground func()
	OnChange        func()
	Log             func(kind string, err any)
}

type ui struct {
	web    bool
	origin string
}

// DSH is the relay to the DSH plugin.
type DSH struct {
	deps Deps
	host *host

	mu            sync.Mutex
	plugin        *server.Conn
	version       string
	everConnected bool
	pending       int
	ui            ui
}

func New(deps Deps, h HostOptions) *DSH {
	a := &DSH{deps: deps}
	a.host = newHost(h, a.Connected, deps.Log)
	return a
}

func (a *DSH) Status() Status {
	a.mu.Lock()
	defer a.mu.Unlock()
	return Status{Connected: a.plugin != nil, Version: a.version, PendingApprovals: a.pending}
}

func (a *DSH) Connected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.plugin != nil
}

// Attach takes over an authenticated plugin connection, closing the one
// before it.
func (a *DSH) Attach(c *server.Conn) server.Handler {
	a.mu.Lock()
	old := a.plugin
	a.plugin = c
	a.everConnected = true
	a.mu.Unlock()
	if old != nil && old != c {
		old.Close()
	}
	a.host.linked()
	a.changed()
	return pluginHandler{a, c}
}

type pluginHandler struct {
	a *DSH
	c *server.Conn
}

func (h pluginHandler) OnMessage(m server.Message) { h.a.onPluginMessage(m) }

func (h pluginHandler) OnClosed() {
	a := h.a
	a.mu.Lock()
	if a.plugin != h.c {
		a.mu.Unlock()
		return
	}
	a.plugin = nil
	a.version = ""
	ever := a.everConnected
	a.mu.Unlock()
	a.changed()
	a.host.unlinked(ever)
}

type pluginMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Reason    string `json:"reason"`
	Plugin    string `json:"plugin"`
	Kind      any    `json:"kind"`
	Origin    any    `json:"origin"`
}

func forCards(t string) bool {
	return strings.HasPrefix(t, "ask-") || t == "sessions" || t == "suggestions" || t == "title"
}

func (a *DSH) onPluginMessage(m server.Message) {
	var msg pluginMessage
	if m.Decode(&msg) != nil || msg.Type == "" {
		return
	}
	switch msg.Type {
	case "ready":
		a.mu.Lock()
		a.version = msg.Plugin
		a.mu.Unlock()
		a.changed()
	case "ui":
		origin, _ := msg.Origin.(string)
		u := ui{web: msg.Kind == "web", origin: origin}
		a.mu.Lock()
		a.ui = u
		a.mu.Unlock()
		logged := struct {
			Kind   string `json:"kind"`
			Origin string `json:"origin,omitempty"`
		}{"desktop", origin}
		if u.web {
			logged.Kind = "web"
		}
		a.log("dsh-ui", string(mustJSON(logged)))
	case "approval":
		a.mu.Lock()
		a.pending++
		a.mu.Unlock()
		if a.deps.Notify != nil {
			sid := msg.SessionID
			a.deps.Notify("DSH 有个操作等你批准", "点这里打开 DSH", func() { a.Open(sid) })
		}
		a.changed()
	case "approval-closed":
		a.mu.Lock()
		a.pending = max(0, a.pending-1)
		a.mu.Unlock()
		a.changed()
	}
	switch msg.Type {
	case "ask-done", "ask-error", "state", "title":
		if a.deps.OnTask != nil {
			a.deps.OnTask(TaskEvent{Type: msg.Type, SessionID: msg.SessionID, Title: msg.Title, Reason: msg.Reason})
		}
	}
	if forCards(msg.Type) && a.deps.ToCards != nil {
		a.deps.ToCards(m.Raw)
	}
}

var relayed = map[string]bool{"ask": true, "suggest-request": true, "sessions-request": true, "sessions-search": true}

// Request passes a card's request to the plugin and reports whether it
// went out.
func (a *DSH) Request(msg jsontext.Value) bool {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(msg, &head) != nil || !relayed[head.Type] {
		return false
	}
	return a.send(msg)
}

func (a *DSH) send(b []byte) bool {
	a.mu.Lock()
	c := a.plugin
	a.mu.Unlock()
	return c != nil && c.SendRaw(b) == nil
}

// Open brings DSH forward, on the session when one is given.
func (a *DSH) Open(sessionID string) {
	if a.deps.AllowForeground != nil {
		a.deps.AllowForeground()
	}
	a.mu.Lock()
	u := a.ui
	a.mu.Unlock()
	if u.web {
		if a.deps.FocusTab == nil || !a.deps.FocusTab(u.origin) {
			if a.deps.ShowHint != nil {
				a.deps.ShowHint("已在浏览器里的 DSH 切到这个会话")
			}
		}
	} else if a.deps.OpenURL != nil {
		a.deps.OpenURL("dsh://open")
	}
	if sessionID != "" {
		a.send(mustJSON(map[string]string{"type": "focus", "sessionId": sessionID}))
	}
}

// WillQuit runs the cleanup due when the plugin was uninstalled.
func (a *DSH) WillQuit() { a.host.willQuit() }

func (a *DSH) changed() {
	if a.deps.OnChange != nil {
		a.deps.OnChange()
	}
}

func (a *DSH) log(kind string, err any) {
	if a.deps.Log != nil {
		a.deps.Log(kind, err)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v, json.Deterministic(true))
	return b
}

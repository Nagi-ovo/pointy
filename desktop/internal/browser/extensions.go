// Package browser talks to Pointy's browser extension: it authenticates
// paired extensions and keeps the unpacked extension the user loads in a
// fixed place.
package browser

import (
	"cmp"
	"encoding/json/v2"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
	"github.com/pointylab/pointy/desktop/internal/server"
)

// Deps are what the extensions reach outside this package. Unset ones do
// nothing.
type Deps struct {
	Home string
	// BundledDir is the extension shipped with this build.
	BundledDir string
	OnChange   func()
	Log        func(kind string, err any)
	// ShowNotice asks the user, as ui.UI.ShowNotice does.
	ShowNotice func(contract.NoticeInit, time.Duration) (choice <-chan *string, cancel func())
	// OnSelection opens a card on what the user sent from the browser.
	OnSelection func(contract.Grab)
	// ShowHint says, for a moment, why a selection opened nothing.
	ShowHint func(string)
}

type extension struct {
	conn    *server.Conn
	browser string
}

// Extensions are the connected browser extensions.
type Extensions struct {
	deps Deps

	mu      sync.Mutex
	conns   map[string]extension
	denied  map[string]bool
	pairing bool
	picking *picking
}

func New(d Deps) *Extensions {
	return &Extensions{deps: d, conns: map[string]extension{}, denied: map[string]bool{}}
}

// UserDir is where the user loads the unpacked extension from. It stays put
// when the plugin moves to a new version.
func (e *Extensions) UserDir() string { return filepath.Join(e.deps.Home, "extension") }

func manifestVersion(dir string) string {
	var m struct {
		Version string `json:"version"`
	}
	if b, err := os.ReadFile(filepath.Join(dir, "manifest.json")); err == nil {
		json.Unmarshal(b, &m)
	}
	return m.Version
}

// SyncUserExtension copies the bundled extension to UserDir when its
// version changed.
func (e *Extensions) SyncUserExtension() {
	bundled := manifestVersion(e.deps.BundledDir)
	user := e.UserDir()
	if bundled == "" || filepath.Clean(e.deps.BundledDir) == filepath.Clean(user) || manifestVersion(user) == bundled {
		return
	}
	if err := copyDir(e.deps.BundledDir, user); err != nil {
		e.log("extension-copy", err)
	}
}

func copyDir(from, to string) error {
	return filepath.WalkDir(from, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		target := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
}

// Authenticate checks an extension's proof against its paired token, and
// returns its handler, or nil to refuse it.
func (e *Extensions) Authenticate(c *server.Conn, hello server.Hello, nonce string) server.Handler {
	token := config.ExtensionTokens(e.deps.Home)[hello.ID]
	if token == "" || !server.Verify(token, "ext|"+nonce, hello.Proof) {
		return nil
	}
	c.Send(map[string]string{"type": "hello-ok", "proof": server.Sign(token, "pet|"+hello.Nonce)})
	e.mu.Lock()
	old, had := e.conns[hello.ID]
	e.conns[hello.ID] = extension{conn: c, browser: hello.Browser}
	e.mu.Unlock()
	if had {
		old.conn.Close()
	}
	e.changed()
	if v := manifestVersion(e.deps.BundledDir); v != "" && hello.Version != "" && hello.Version != v {
		c.Send(map[string]string{"type": "reload"})
	}
	return &handler{e: e, id: hello.ID, conn: c}
}

type handler struct {
	e    *Extensions
	id   string
	conn *server.Conn
}

func (h *handler) OnMessage(m server.Message) {
	switch m.Type {
	case "pick-started", "picked", "pick-cancel", "pick-unavailable":
		h.onPick(m)
		return
	}
	if m.Type != "selection" || h.e.deps.OnSelection == nil {
		return
	}
	var sel struct {
		contract.Grab
		Browser string `json:"browser"`
	}
	if m.Decode(&sel) != nil {
		return
	}
	g := sel.Grab
	if desktop.LoginTitle(g.PageTitle) && g.Blocked == "" {
		g.Blocked = contract.BlockLoginWindow
	}
	if g.Blocked != "" {
		if hint, ok := i18n.BlockHint(g.Blocked); ok && h.e.deps.ShowHint != nil {
			h.e.deps.ShowHint(hint)
		}
		return
	}
	g.Source = contract.GrabSource{App: cmp.Or(sel.Browser, "browser"), Title: g.PageTitle}
	g.Method = contract.MethodExtension
	h.e.deps.OnSelection(g)
}

func (h *handler) OnClosed() {
	e := h.e
	e.mu.Lock()
	cur, ok := e.conns[h.id]
	if ok && cur.conn == h.conn {
		delete(e.conns, h.id)
	}
	e.mu.Unlock()
	if ok && cur.conn == h.conn {
		e.changed()
	}
}

// Count is how many extensions are connected.
func (e *Extensions) Count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.conns)
}

// FocusTab asks an extension to bring forward the tab at origin.
func (e *Extensions) FocusTab(origin string) bool {
	if origin == "" {
		return false
	}
	e.mu.Lock()
	var c *server.Conn
	for _, x := range e.conns {
		c = x.conn
		break
	}
	e.mu.Unlock()
	return c != nil && c.Send(map[string]string{"type": "focus-tab", "origin": origin}) == nil
}

func (e *Extensions) changed() {
	if e.deps.OnChange != nil {
		e.deps.OnChange()
	}
}

func (e *Extensions) log(kind string, err any) {
	if e.deps.Log != nil {
		e.deps.Log(kind, err)
	}
}

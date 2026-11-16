package agent

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pointylab/pointy/desktop/internal/server"
)

const token = "t"

type fakePlugin struct {
	t  *testing.T
	ws *websocket.Conn
	ok map[string]any
}

// testServer serves one DSH relay. attached receives once Pointy has taken
// over each plugin connection, which happens after it sends hello-ok.
type testServer struct {
	url      string
	attached chan struct{}
}

// connect returns a plugin that finished the handshake and that Pointy has
// taken over, so a.Request reaches it.
func (s *testServer) connect(t *testing.T) *fakePlugin {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), s.url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	p := &fakePlugin{t: t, ws: ws}
	ch := p.read()
	p.send(map[string]any{"type": "hello", "nonce": "n", "proof": server.Sign(token, "plugin|"+ch["type+nonce"].(string))})
	if p.ok = p.read(); p.ok["type"] != "hello-ok" {
		t.Fatalf("handshake %v", p.ok)
	}
	select {
	case <-s.attached:
	case <-time.After(5 * time.Second):
		t.Fatal("Pointy did not take over the plugin")
	}
	return p
}

func (p *fakePlugin) read() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := p.ws.Read(ctx)
	if err != nil {
		return map[string]any{"error": err}
	}
	m := map[string]any{}
	json.Unmarshal(b, &m)
	if m["type"] == "challenge" {
		m["type+nonce"] = m["nonce"]
	}
	return m
}

func (p *fakePlugin) send(v any) {
	b, _ := json.Marshal(v)
	if err := p.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		p.t.Fatal(err)
	}
}

func serve(t *testing.T, a *DSH) *testServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	s := &testServer{url: "ws://" + ln.Addr().String(), attached: make(chan struct{}, 8)}
	attach := func(c *server.Conn) server.Handler {
		h := a.Attach(c)
		s.attached <- struct{}{}
		return h
	}
	go server.Serve(ln, server.Routes{Token: token, Managed: a.Managed, Plugin: attach, Extension: func(*server.Conn, server.Hello, string) server.Handler { return nil }})
	return s
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !ok(); {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSecondPluginReplacesFirst(t *testing.T) {
	a := New(Deps{}, HostOptions{})
	srv := serve(t, a)
	first := srv.connect(t)
	second := srv.connect(t)
	if m := first.read(); m["error"] == nil {
		t.Fatalf("first plugin got %v, want it closed", m)
	}
	if !a.Connected() {
		t.Fatal("not connected after the second plugin took over")
	}
	if !a.Request(jsontext.Value(`{"type":"sessions-request","reqId":"r1"}`)) {
		t.Fatal("request not sent")
	}
	if m := second.read(); m["reqId"] != "r1" {
		t.Fatalf("second plugin got %v", m)
	}
}

func TestRelay(t *testing.T) {
	toCards := make(chan string, 8)
	tasks := make(chan TaskEvent, 8)
	notified := make(chan func(), 1)
	opened := make(chan string, 1)
	a := New(Deps{
		ToCards:  func(m jsontext.Value) { toCards <- string(m) },
		OnTask:   func(e TaskEvent) { tasks <- e },
		Notify:   func(_, _ string, click func()) { notified <- click },
		OpenURL:  func(u string) { opened <- u },
		FocusTab: func(string) bool { return false },
	}, HostOptions{})
	p := serve(t, a).connect(t)

	if a.Request(jsontext.Value(`{"type":"focus"}`)) {
		t.Fatal("relayed a type cards may not send")
	}
	ask := `{"type":"ask","askId":"a1","question":"q","material":{"ctx":[]}}`
	if !a.Request(jsontext.Value(ask)) {
		t.Fatal("ask not relayed")
	}
	if m := p.read(); m["askId"] != "a1" || m["question"] != "q" {
		t.Fatalf("plugin got %v", m)
	}

	delta := `{"type":"ask-delta","askId":"a1","text":"hi","extra":[1,2]}`
	p.send(jsontext.Value(delta))
	if got := <-toCards; got != delta {
		t.Fatalf("cards got %s, want it unchanged", got)
	}
	p.send(map[string]any{"type": "ask-done", "askId": "a1", "sessionId": "s1", "reason": "completed", "title": "T"})
	<-toCards
	if e := <-tasks; e != (TaskEvent{Type: "ask-done", SessionID: "s1", Title: "T", Reason: "completed"}) {
		t.Fatalf("task %+v", e)
	}

	p.send(map[string]any{"type": "approval", "sessionId": "s1"})
	click := <-notified
	waitFor(t, "approval counted", func() bool { return a.Status().PendingApprovals == 1 })
	click()
	if u := <-opened; u != "dsh://open" {
		t.Fatalf("opened %q", u)
	}
	if m := p.read(); m["type"] != "focus" || m["sessionId"] != "s1" {
		t.Fatalf("plugin got %v", m)
	}
	p.send(map[string]any{"type": "approval-closed"})
	p.send(map[string]any{"type": "approval-closed"})
	p.send(map[string]any{"type": "ready", "plugin": "9.9.9"})
	waitFor(t, "ready", func() bool { return a.Status().Version == "9.9.9" })
	if n := a.Status().PendingApprovals; n != 0 {
		t.Fatalf("pending %d", n)
	}
}

func TestOpenInWebUI(t *testing.T) {
	focused := make(chan string, 1)
	a := New(Deps{FocusTab: func(o string) bool { focused <- o; return true }, OpenURL: func(string) { t.Error("opened the desktop app for a web UI") }}, HostOptions{})
	p := serve(t, a).connect(t)
	p.send(map[string]any{"type": "ui", "kind": "web", "origin": "http://127.0.0.1:3093"})
	p.send(map[string]any{"type": "ready"})
	waitFor(t, "ready", func() bool { return a.Status().Connected })
	time.Sleep(50 * time.Millisecond)
	a.Open("")
	if o := <-focused; o != "http://127.0.0.1:3093" {
		t.Fatalf("focused %q", o)
	}
}

func deadPID(t *testing.T) int {
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Skip(err)
	}
	return cmd.Process.Pid
}

func TestOrphaned(t *testing.T) {
	h := newHost(HostOptions{HostPID: deadPID(t)}, func() bool { return false }, nil)
	if !h.orphaned() {
		t.Fatal("dead host not seen")
	}
	h = newHost(HostOptions{HostPID: os.Getpid()}, func() bool { return false }, nil)
	if h.orphaned() {
		t.Fatal("live host seen as dead")
	}
}

func TestPluginQuit(t *testing.T) {
	unmanagedQuit := make(chan struct{}, 1)
	unmanaged := New(Deps{}, HostOptions{Managed: false, Quit: func() { unmanagedQuit <- struct{}{} }})
	p1 := serve(t, unmanaged).connect(t)
	p1.send(map[string]any{"type": "quit"})
	p1.send(map[string]any{"type": "ready", "plugin": "1.0.0"})
	waitFor(t, "ready after ignored quit", func() bool { return unmanaged.Status().Version == "1.0.0" })
	select {
	case <-unmanagedQuit:
		t.Fatal("unmanaged Pointy quit on plugin request")
	default:
	}

	managedQuit := make(chan struct{}, 1)
	logged := make(chan string, 1)
	managed := New(Deps{Log: func(kind string, _ any) { logged <- kind }}, HostOptions{Managed: true, Quit: func() { managedQuit <- struct{}{} }})
	p2 := serve(t, managed).connect(t)
	p2.send(map[string]any{"type": "quit"})
	select {
	case <-managedQuit:
	case <-time.After(5 * time.Second):
		t.Fatal("managed Pointy did not quit on plugin request")
	}
	if kind := <-logged; kind != "quit" {
		t.Fatalf("logged %q, want quit", kind)
	}
}

func TestUninstallCleanup(t *testing.T) {
	profile := t.TempDir()
	manifest := filepath.Join(profile, "package.json")
	root := filepath.Join(profile, "node_modules", "@pointylab", "dsh")
	home := t.TempDir()
	os.MkdirAll(root, 0o755)
	var removed []string
	h := newHost(HostOptions{Managed: true, PluginRoot: root, Cleanup: []string{home, filepath.Join(home, "missing")},
		RemoveAfterExit: func(p []string) error { removed = p; return nil }}, func() bool { return false }, nil)
	os.WriteFile(filepath.Join(root, "package.json"), []byte("{}"), 0o644)
	h.willQuit()
	if removed != nil {
		t.Fatal("cleaned up while the plugin is installed")
	}

	os.Remove(filepath.Join(root, "package.json"))
	for _, field := range []string{"dependencies", "devDependencies", "optionalDependencies"} {
		os.WriteFile(manifest, []byte(`{"`+field+`":{"@pointylab/dsh":"^0.5.1"}}`), 0o644)
		h.willQuit()
		if removed != nil {
			t.Fatalf("cleaned up while %s still lists the plugin", field)
		}
	}

	os.WriteFile(manifest, []byte(`{"dependencies":{"other":"1.0.0"}}`), 0o644)
	h.willQuit()
	if len(removed) != 2 || removed[0] != home || removed[1] != root {
		t.Fatalf("removed %v", removed)
	}

	removed = nil
	os.Remove(manifest)
	h.willQuit()
	if len(removed) != 2 || removed[0] != home || removed[1] != root {
		t.Fatalf("removed without manifest %v", removed)
	}
	if FindPluginRoot(filepath.Join(root, "pet", "Pointy.app", "Contents", "MacOS", "Pointy")) != root {
		t.Fatal("plugin root not found from the executable")
	}
}

func TestRemovedPluginGetsTimeToComeBack(t *testing.T) {
	defer func(q, g, p time.Duration) { quitGrace, removalGrace, removalPoll = q, g, p }(quitGrace, removalGrace, removalPoll)
	quitGrace, removalPoll = 10*time.Millisecond, 10*time.Millisecond
	root := filepath.Join(t.TempDir(), "node_modules", "@pointylab", "dsh")
	os.MkdirAll(root, 0o755)
	start := func(grace time.Duration) chan struct{} {
		removalGrace = grace
		quit := make(chan struct{}, 1)
		h := newHost(HostOptions{Managed: true, PluginRoot: root, Quit: func() { quit <- struct{}{} }}, func() bool { return false }, nil)
		h.unlinked(true)
		return quit
	}

	// An update: the package comes back, and Pointy quits without waiting out the grace.
	quit := start(time.Minute)
	select {
	case <-quit:
		t.Fatal("quit while the plugin looked removed")
	case <-time.After(200 * time.Millisecond):
	}
	os.WriteFile(filepath.Join(root, "package.json"), []byte("{}"), 0o644)
	select {
	case <-quit:
	case <-time.After(5 * time.Second):
		t.Fatal("did not quit once the plugin was back")
	}

	// An uninstall: nothing comes back, and Pointy quits once the grace is over.
	os.Remove(filepath.Join(root, "package.json"))
	quit = start(200 * time.Millisecond)
	select {
	case <-quit:
	case <-time.After(5 * time.Second):
		t.Fatal("did not quit after the plugin was removed")
	}
}

func TestAdoptOnReady(t *testing.T) {
	quit := make(chan struct{}, 1)
	a := New(Deps{}, HostOptions{Quit: func() { quit <- struct{}{} }})
	t.Cleanup(a.host.stop)
	srv := serve(t, a)

	p1 := srv.connect(t)
	if p1.ok["managed"] != false {
		t.Fatalf("hello-ok %v, want managed: false", p1.ok)
	}
	p1.send(map[string]any{"type": "ready", "plugin": "0.5.2"})
	waitFor(t, "ready", func() bool { return a.Status().Version == "0.5.2" })
	if a.Managed() {
		t.Fatal("managed without hostPid")
	}
	p1.send(map[string]any{"type": "ready", "plugin": "0.5.2", "hostPid": os.Getpid()})
	waitFor(t, "adopted", a.Managed)

	p2 := srv.connect(t)
	if p2.ok["managed"] != true {
		t.Fatalf("hello-ok %v, want managed: true", p2.ok)
	}
	p2.send(map[string]any{"type": "quit"})
	select {
	case <-quit:
	case <-time.After(5 * time.Second):
		t.Fatal("adopted Pointy ignored quit")
	}
}

func TestAdoptStartsOrphanCheck(t *testing.T) {
	defer func(o, q time.Duration) { orphanPoll, quitGrace = o, q }(orphanPoll, quitGrace)
	orphanPoll = 10 * time.Millisecond
	quitGrace = time.Minute // only the orphan check may quit

	quit := make(chan struct{}, 1)
	a := New(Deps{}, HostOptions{Quit: func() { quit <- struct{}{} }})
	t.Cleanup(a.host.stop)
	p := serve(t, a).connect(t)
	p.send(map[string]any{"type": "ready", "plugin": "0.5.2", "hostPid": deadPID(t)})
	waitFor(t, "adopted", a.Managed)
	p.ws.Close(websocket.StatusNormalClosure, "")
	select {
	case <-quit:
	case <-time.After(5 * time.Second):
		t.Fatal("adopted Pointy outlived its host")
	}
}

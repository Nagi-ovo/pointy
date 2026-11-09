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
}

func connect(t *testing.T, url string) *fakePlugin {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	p := &fakePlugin{t, ws}
	ch := p.read()
	p.send(map[string]any{"type": "hello", "nonce": "n", "proof": server.Sign(token, "plugin|"+ch["type+nonce"].(string))})
	if ok := p.read(); ok["type"] != "hello-ok" {
		t.Fatalf("handshake %v", ok)
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

func serve(t *testing.T, a *DSH) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go server.Serve(ln, server.Routes{Token: token, Plugin: a.Attach, Extension: func(*server.Conn, server.Hello, string) server.Handler { return nil }})
	return "ws://" + ln.Addr().String()
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
	url := serve(t, a)
	first := connect(t, url)
	waitFor(t, "first plugin", a.Connected)
	second := connect(t, url)
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
	p := connect(t, serve(t, a))

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
	p := connect(t, serve(t, a))
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

func TestUninstallCleanup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "node_modules", "@pointylab", "dsh")
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
	h.willQuit()
	if len(removed) != 2 || removed[0] != home || removed[1] != root {
		t.Fatalf("removed %v", removed)
	}
	if FindPluginRoot(filepath.Join(root, "pet", "Pointy.app", "Contents", "MacOS", "Pointy")) != root {
		t.Fatal("plugin root not found from the executable")
	}
}

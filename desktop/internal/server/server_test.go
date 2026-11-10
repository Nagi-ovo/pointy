package server

import (
	"context"
	"encoding/json/v2"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const token = "test-token"

type recorder struct {
	msgs   chan Message
	closed chan struct{}
}

func (r *recorder) OnMessage(m Message) { r.msgs <- m }
func (r *recorder) OnClosed()           { close(r.closed) }

func start(t *testing.T, r Routes) (string, chan *recorder) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	plugins := make(chan *recorder, 4)
	if r.Token == "" {
		r.Token = token
	}
	if r.Plugin == nil {
		r.Plugin = func(*Conn) Handler {
			h := &recorder{msgs: make(chan Message, 8), closed: make(chan struct{})}
			plugins <- h
			return h
		}
	}
	if r.Extension == nil {
		r.Extension = func(*Conn, Hello, string) Handler { return nil }
	}
	go Serve(ln, r)
	return "ws://" + ln.Addr().String(), plugins
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func dial(t *testing.T, url string) *client {
	t.Helper()
	ws, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return &client{t, ws}
}

func (c *client) read() (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, b, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	json.Unmarshal(b, &m)
	return m, nil
}

func (c *client) send(v any) {
	b, _ := json.Marshal(v)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) hello(proofKey string) map[string]string {
	ch, err := c.read()
	if err != nil || ch["type"] != "challenge" {
		c.t.Fatalf("challenge %v %v", ch, err)
	}
	c.send(map[string]any{"type": "hello", "v": 1, "nonce": "client-nonce", "proof": Sign(proofKey, "plugin|"+ch["nonce"])})
	reply, _ := c.read()
	return reply
}

func closedByServer(err error) bool {
	return websocket.CloseStatus(err) == websocket.StatusNormalClosure || errors.Is(err, net.ErrClosed)
}

func TestPluginProof(t *testing.T) {
	url, plugins := start(t, Routes{})
	c := dial(t, url)
	reply := c.hello(token)
	if reply["type"] != "hello-ok" || !Verify(token, "pet|client-nonce", reply["proof"]) || reply["runtime"] != "go" {
		t.Fatalf("reply %v", reply)
	}
	h := <-plugins
	c.send(map[string]string{"type": "ready", "plugin": "1"})
	if m := <-h.msgs; m.Type != "ready" {
		t.Fatalf("handler got %q", m.Type)
	}
	c.ws.Close(websocket.StatusNormalClosure, "")
	<-h.closed
}

func TestBadProofCloses(t *testing.T) {
	url, plugins := start(t, Routes{})
	c := dial(t, url)
	ch, _ := c.read()
	c.send(map[string]any{"type": "hello", "nonce": "n", "proof": Sign("wrong", "plugin|"+ch["nonce"])})
	if _, err := c.read(); !closedByServer(err) {
		t.Fatalf("read after bad proof: %v", err)
	}
	if len(plugins) != 0 {
		t.Fatal("a bad proof reached the plugin handler")
	}
}

func TestSilentConnectionIsKicked(t *testing.T) {
	url, _ := start(t, Routes{Kick: 200 * time.Millisecond})
	c := dial(t, url)
	if m, _ := c.read(); m["type"] != "challenge" {
		t.Fatalf("first message %v", m)
	}
	if _, err := c.read(); !closedByServer(err) {
		t.Fatalf("silent connection: %v", err)
	}
}

func TestAuthenticatedConnectionIsNotKicked(t *testing.T) {
	url, plugins := start(t, Routes{Kick: 200 * time.Millisecond})
	c := dial(t, url)
	c.hello(token)
	h := <-plugins
	time.Sleep(400 * time.Millisecond)
	c.send(map[string]string{"type": "still-here"})
	if m := <-h.msgs; m.Type != "still-here" {
		t.Fatalf("got %q", m.Type)
	}
}

func TestExtensionRoute(t *testing.T) {
	var got Hello
	url, _ := start(t, Routes{Extension: func(c *Conn, h Hello, nonce string) Handler {
		got = h
		if !Verify("ext-token", "ext|"+nonce, h.Proof) {
			return nil
		}
		c.Send(map[string]string{"type": "hello-ok"})
		return &recorder{msgs: make(chan Message, 1), closed: make(chan struct{})}
	}})
	c := dial(t, url)
	ch, _ := c.read()
	c.send(map[string]any{"type": "hello", "role": "extension", "id": "e1", "nonce": "n", "proof": Sign("ext-token", "ext|"+ch["nonce"])})
	if m, _ := c.read(); m["type"] != "hello-ok" || got.ID != "e1" {
		t.Fatalf("reply %v hello %+v", m, got)
	}
}

func TestNotJSONIsIgnored(t *testing.T) {
	url, _ := start(t, Routes{})
	c := dial(t, url)
	ch, _ := c.read()
	c.ws.Write(context.Background(), websocket.MessageText, []byte("{oops"))
	c.send(map[string]any{"type": "hello", "nonce": "n", "proof": Sign(token, "plugin|"+ch["nonce"])})
	if m, _ := c.read(); m["type"] != "hello-ok" {
		t.Fatalf("got %v", m)
	}
}

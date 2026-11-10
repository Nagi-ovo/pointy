// Package server is the local WebSocket server the DSH plugin and the
// browser extension connect to. Each connection gets a challenge and must
// answer it with an HMAC proof before it reaches a handler.
package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pointylab/pointy/desktop/internal/config"
)

const (
	readLimit = 8 << 20
	writeWait = 5 * time.Second
)

// Message is one JSON message from a peer, with its type read.
type Message struct {
	Type string
	Raw  jsontext.Value
}

// Decode reads the message into v.
func (m Message) Decode(v any) error { return json.Unmarshal(m.Raw, v) }

// Handler receives an authenticated connection's messages, one at a time.
type Handler interface {
	OnMessage(Message)
	OnClosed()
}

// Conn is one peer. Its methods are safe for concurrent use.
type Conn struct {
	ws     *websocket.Conn
	Origin string
	once   sync.Once
	closed chan struct{}
}

// Send writes v as a JSON text message.
func (c *Conn) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.SendRaw(b)
}

// SendRaw writes an encoded JSON message.
func (c *Conn) SendRaw(b []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeWait)
	defer cancel()
	return c.ws.Write(ctx, websocket.MessageText, b)
}

// Close closes the connection without waiting for the peer.
func (c *Conn) Close() {
	c.once.Do(func() { go c.ws.Close(websocket.StatusNormalClosure, "") })
}

// Closed is closed once the connection is gone.
func (c *Conn) Closed() <-chan struct{} { return c.closed }

// Hello is the handshake message of a peer.
type Hello struct {
	Type    string `json:"type"`
	Role    string `json:"role"`
	Nonce   string `json:"nonce"`
	Proof   string `json:"proof"`
	ID      string `json:"id"`
	Browser string `json:"browser"`
	Version string `json:"version"`
	Manual  bool   `json:"manual"`
}

// Routes says who handles a connection once it introduced itself.
type Routes struct {
	// Token is the secret the plugin proves it knows.
	Token string
	// Plugin takes an authenticated plugin.
	Plugin func(*Conn) Handler
	// Extension checks an extension's hello against the challenge nonce it
	// was sent and returns its handler, or nil to refuse it.
	Extension func(c *Conn, hello Hello, nonce string) Handler
	// Pair handles a pairing request and owns the connection from then on.
	// stopKick keeps the server from closing it while the user decides.
	Pair func(c *Conn, hello Hello, stopKick func())
	// Kick closes connections that have not authenticated in time; 10 s
	// when zero.
	Kick time.Duration
	// OnError reports failures that close nothing.
	OnError func(kind string, err error)
}

// Sign is the hex HMAC-SHA256 of data under token.
func Sign(token, data string) string {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte(data))
	return hex.EncodeToString(m.Sum(nil))
}

// Verify reports whether proof is the signature of data under token.
func Verify(token, data, proof string) bool {
	return hmac.Equal([]byte(proof), []byte(Sign(token, data)))
}

// Serve accepts connections on ln until it is closed.
func Serve(ln net.Listener, r Routes) error {
	if r.Kick == 0 {
		r.Kick = 10 * time.Second
	}
	return http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// The extension's Origin is checked by its route; the plugin has none.
		ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		ws.SetReadLimit(readLimit)
		c := &Conn{ws: ws, Origin: req.Header.Get("Origin"), closed: make(chan struct{})}
		r.serve(c)
	}))
}

func (r Routes) serve(c *Conn) {
	defer close(c.closed)
	nonce := config.RandomHex(16)
	if c.Send(map[string]string{"type": "challenge", "nonce": nonce}) != nil {
		c.Close()
		return
	}
	var handler Handler
	kick := time.AfterFunc(r.Kick, c.Close)
	defer kick.Stop()
	for {
		_, data, err := c.ws.Read(context.Background())
		if err != nil {
			break
		}
		var head struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &head) != nil {
			continue
		}
		msg := Message{Type: head.Type, Raw: data}
		if handler != nil {
			handler.OnMessage(msg)
			continue
		}
		var hello Hello
		msg.Decode(&hello)
		switch {
		case hello.Type == "pair-request" && r.Pair != nil:
			r.Pair(c, hello, func() { kick.Stop() })
		case hello.Type != "hello" || hello.Nonce == "":
			c.Close()
		case hello.Role == "extension":
			if handler = r.Extension(c, hello, nonce); handler == nil {
				c.Close()
			} else {
				kick.Stop()
			}
		case !Verify(r.Token, "plugin|"+nonce, hello.Proof):
			c.Close()
		default:
			kick.Stop()
			if err := c.Send(map[string]string{"type": "hello-ok", "proof": Sign(r.Token, "pet|"+hello.Nonce), "runtime": "go"}); err != nil && r.OnError != nil {
				r.OnError("server", err)
			}
			handler = r.Plugin(c)
		}
	}
	c.Close()
	if handler != nil {
		handler.OnClosed()
	}
}

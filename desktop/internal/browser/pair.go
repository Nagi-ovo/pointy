package browser

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"time"

	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/i18n"
	"github.com/pointylab/pointy/desktop/internal/server"
)

const (
	pairAskTimeout = 60 * time.Second
	pairKeepAlive  = 10 * time.Second
)

// Only a browser extension's page has such an Origin; a web page cannot
// forge it.
var extensionOrigin = regexp.MustCompile(`(?i)^(chrome|moz)-extension://[a-z0-9-]+$`)

// Pair asks the user whether an extension may connect, and gives it a
// token when they allow it.
func (e *Extensions) Pair(c *server.Conn, hello server.Hello, stopKick func()) {
	origin := c.Origin
	if !extensionOrigin.MatchString(origin) {
		c.Close()
		return
	}
	e.mu.Lock()
	denied, busy := e.denied[origin] && !hello.Manual, e.pairing || e.deps.ShowNotice == nil
	if !denied && !busy {
		e.pairing = true
	}
	e.mu.Unlock()
	if denied {
		c.Send(map[string]string{"type": "pair-denied"})
		c.Close()
		return
	}
	if busy {
		c.Send(map[string]string{"type": "pair-busy"})
		c.Close()
		return
	}
	stopKick()
	browser := "Chrome"
	if hello.Browser == "edge" {
		browser = "Edge"
	}
	choice, cancel := e.deps.ShowNotice(contract.NoticeInit{
		Title:   i18n.Msg(i18n.PairTitle, "browser", browser),
		Body:    []contract.NoticeParagraph{{Text: i18n.Msg(i18n.PairBody)}},
		Buttons: []contract.NoticeButton{{ID: "deny", Label: i18n.Msg(i18n.PairDeny)}, {ID: "allow", Label: i18n.Msg(i18n.PairAllow), Primary: true}},
	}, pairAskTimeout)
	go func() {
		// The extension's service worker stops unless it hears from Pointy
		// while the user decides.
		keep := time.NewTicker(pairKeepAlive)
		defer keep.Stop()
		var answer *string
		closed := c.Closed()
	wait:
		for {
			select {
			case answer = <-choice:
				break wait
			case <-closed:
				closed = nil
				cancel()
			case <-keep.C:
				c.Send(map[string]string{"type": "pair-wait"})
			}
		}
		e.mu.Lock()
		e.pairing = false
		allowed := answer != nil && *answer == "allow"
		if allowed {
			delete(e.denied, origin)
		} else if answer != nil && *answer == "deny" {
			e.denied[origin] = true
		}
		e.mu.Unlock()
		if !allowed {
			c.Send(map[string]string{"type": "pair-denied"})
			c.Close()
			return
		}
		id, token := uuid(), config.RandomHex(32)
		if err := config.SaveExtensionToken(e.deps.Home, id, token); err != nil {
			e.log("pair", err)
		}
		c.Send(map[string]string{"type": "paired", "id": id, "token": token})
		c.Close()
	}()
}

func uuid() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

//go:build e2e

package main

import (
	"time"

	"github.com/egoist/mygo"
	_ "github.com/egoist/mygo/plugins/automation"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/ui"
)

// E2E opens Pointy's windows on request, for tests driving the app through
// mygo-automation: `eval --window <e2e> "mygo.call('E2E.OpenGrab', grab)"`.
type E2E struct{}

func (E2E) OpenGrab(g contract.Grab) { windows.OpenGrab(g, nil) }
func (E2E) OpenPair(code string)     { windows.OpenCard(contract.CardInit{Mode: "pair", Code: code}, nil) }
func (E2E) ShowHint(text string)     { windows.ShowHint(text) }
func (E2E) ShowIntro()               { go windows.ShowIntro() }
func (E2E) ShowWelcome()             { go windows.ShowWelcome() }
func (E2E) ShowExtensionGuide()      { go windows.ShowExtensionGuide() }
func (E2E) ShowNotice(n contract.NoticeInit, ms int) {
	windows.ShowNotice(n, time.Duration(ms)*time.Millisecond)
}

var e2eOverlays []*ui.Overlay

// Overlay covers the display holding x, y with a pointing overlay and
// returns the bounds it asked for, to compare with where it lands.
func (E2E) Overlay(x, y int) mygo.Rectangle {
	b := mygo.Screen.DisplayNearestPoint(mygo.Point{X: x, Y: y}).Bounds
	e2eOverlays = append(e2eOverlays, windows.OpenOverlay(b))
	return b
}

func (E2E) CloseOverlays() {
	for _, o := range e2eOverlays {
		o.Close()
	}
	e2eOverlays = nil
}

func init() {
	mygo.Bind(E2E{})
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{Title: "e2e", Hidden: true, Width: 200, Height: 100})
		w.Page().LoadHTML("<!doctype html><title>e2e</title>", "")
	})
}

// Package ui owns Pointy's windows. Their state lives on the main thread:
// bound methods, timers and relayed events reach it through mygo.RunOnMain.
package ui

import (
	"encoding/json/jsontext"
	"io/fs"
	"slices"
	"strconv"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

type kind int

const (
	kindCard kind = iota
	kindPill
	kindNotice
	kindHint
	kindIntro
	kindOverlay
)

type focusMode int

const (
	// focusTake shows the window with the keyboard.
	focusTake focusMode = iota
	// focusInactive shows it without taking the keyboard; a click gives it.
	focusInactive
	// focusNever never gives it the keyboard.
	focusNever
)

// surface is one kind of window. owner says whether it follows the window
// the user works in; the code that opens it does the following.
type surface struct {
	page         string
	focus        focusMode
	clickThrough bool
	level        desktop.Level
	owner        bool
}

var surfaces = map[kind]surface{
	kindCard:    {page: "card", focus: focusTake, level: desktop.LevelFloating, owner: true},
	kindPill:    {page: "pill", focus: focusInactive, level: desktop.LevelFloating},
	kindNotice:  {page: "notice", focus: focusInactive, level: desktop.LevelFloating},
	kindHint:    {focus: focusNever, clickThrough: true, level: desktop.LevelScreenSaver},
	kindIntro:   {page: "intro", focus: focusNever, clickThrough: true, level: desktop.LevelScreenSaver},
	kindOverlay: {page: "overlay", focus: focusNever, clickThrough: true, level: desktop.LevelScreenSaver, owner: true},
}

var pageURL = map[string]string{
	"card":    "/card/card.html",
	"pill":    "/pill/pill.html",
	"notice":  "/notice/notice.html",
	"intro":   "/intro/intro.html",
	"overlay": "/pick/overlay/overlay.html",
}

// options are the mygo options of a window of this kind; it starts hidden.
func (s surface) options(b mygo.Rectangle, preload string) mygo.WindowOptions {
	o := mygo.WindowOptions{
		X: b.X, Y: b.Y, Width: b.Width, Height: b.Height,
		Hidden:            true,
		Frameless:         true,
		Transparent:       true,
		DisableShadow:     true,
		DisableResize:     true,
		DisableMinimize:   true,
		DisableMaximize:   true,
		DisableFullScreen: true,
		SkipTaskbar:       true,
		AlwaysOnTop:       true,
	}
	if s.page != "" {
		o.URL = pageURL[s.page]
		o.Page.PreloadScript = preload
	}
	return o
}

// Agent is the relay cards ask through.
type Agent interface {
	Request(msg jsontext.Value) bool
	Open(sessionID string)
}

// Deps are what the windows reach outside this package.
type Deps struct {
	Agent      Agent
	AgentName  string
	Desktop    desktop.Desktop
	Visibility *Visibility
	Settings   *config.Store
	// Pages is the frontend: the pages, and the bridge adapters in bridge/.
	Pages fs.FS
	// Version is the installed Pointy's, which the intro shows.
	Version            string
	ExtensionDir       func() string
	SyncExtension      func()
	ExtensionConnected func() int
	Log                func(kind string, err any)
}

// UI is every window Pointy shows. Its fields are main-thread only.
type UI struct {
	deps    Deps
	preload map[string]string

	cards     []*card
	current   *card
	cardWidth int
	grip      *gripDrag

	pills   []*pill
	pillWin *mygo.Window

	notice *notice
	intro  *intro
	hint   *hint
}

// New makes the UI; bind its Services before mygo runs and Start it once
// mygo is ready.
func New() *UI { return &UI{cardWidth: cardW} }

// Start loads the bridge adapters and follows Visibility.
func (u *UI) Start(d Deps) error {
	u.deps = d
	service, err := fs.ReadFile(d.Pages, "bridge/service.js")
	if err != nil {
		return err
	}
	u.preload = map[string]string{}
	for page := range pageURL {
		b, err := fs.ReadFile(d.Pages, "bridge/"+page+".js")
		if err != nil {
			return err
		}
		u.preload[page] = "(() => {\n" + string(service) + "\n" + string(b) + "\n})()"
	}
	d.Visibility.OnChange(func(hidden bool) { mygo.RunOnMain(func() { u.visibilityChanged(hidden) }) })
	return nil
}

// open creates a window of kind k, hidden. Main thread only.
func (u *UI) open(k kind, b mygo.Rectangle) *mygo.Window {
	s := surfaces[k]
	// The page says its texts in the language Pointy shows when it opens.
	preload := "window.pointyLocale = " + strconv.Quote(i18n.Locale()) + ";\n" + u.preload[s.page]
	w := mygo.NewWindow(s.options(b, preload))
	u.check("window-prepare", u.deps.Desktop.PrepareWindow(w))
	if s.level != desktop.LevelFloating {
		u.check("window-level", u.deps.Desktop.SetLevel(w, s.level))
		w.SetBounds(b)
	}
	if s.focus == focusNever {
		u.check("window-focus", u.deps.Desktop.SetFocusable(w, false))
	}
	if s.clickThrough {
		w.SetIgnoreMouseEvents(true)
	}
	return w
}

// show shows a window as its kind wants.
func show(w *mygo.Window, k kind) {
	if surfaces[k].focus == focusTake {
		w.Show()
		w.Focus()
		return
	}
	w.ShowInactive()
}

// OwnWindows are the system ids of Pointy's cards, which never count as
// another app in full screen.
func (u *UI) OwnWindows() []desktop.WindowID {
	var ids []desktop.WindowID
	mygo.RunOnMain(func() {
		for _, c := range u.cards {
			if !c.win.IsDestroyed() {
				ids = append(ids, u.deps.Desktop.WindowID(c.win))
			}
		}
	})
	return ids
}

func (u *UI) visibilityChanged(hidden bool) {
	c := u.current
	if hidden {
		if c != nil {
			if c.win.IsVisible() {
				c.win.Hide()
				c.hiddenBySuppress = true
			}
			c.releasePick()
		}
		if u.pillWin != nil && u.pillWin.IsVisible() {
			u.pillWin.Hide()
		}
		return
	}
	if c != nil && !c.win.IsDestroyed() && c.hiddenBySuppress {
		c.hiddenBySuppress = false
		c.win.ShowInactive()
	}
	if u.pillWin != nil && !u.pillWin.IsDestroyed() && !u.pillWin.IsVisible() {
		u.pillWin.ShowInactive()
	}
}

func (u *UI) check(kind string, err error) {
	if err != nil && u.deps.Log != nil {
		u.deps.Log(kind, err)
	}
}

func (u *UI) log(kind string, err any) {
	if u.deps.Log != nil {
		u.deps.Log(kind, err)
	}
}

// Events pages listen to.
var (
	agentEvent     = mygo.NewEvent[jsontext.Value]("agent")
	cardSetAside   = mygo.NewEvent[struct{}]("cardSetAside")
	cardRestore    = mygo.NewEvent[struct{}]("cardRestore")
	pillsEvent     = mygo.NewEvent[[]contract.PillItem]("pills")
	highlightEvent = mygo.NewEvent[*contract.OverlayHighlight]("highlight")
	holdEvent      = mygo.NewEvent[struct{}]("hold")
	shiftEvent     = mygo.NewEvent[contract.Shift]("shift")
	noteEvent      = mygo.NewEvent[contract.Message]("note")
)

func removeFrom[T comparable](list []T, x T) []T {
	return slices.DeleteFunc(list, func(y T) bool { return y == x })
}

package ui

import (
	"encoding/json/jsontext"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	mascotRoom    = 50
	cardW         = 520 + mascotRoom
	cardMinW      = 360 + mascotRoom
	cardMinH      = 200
	cardHAsk      = 300
	cardHPair     = 230
	cardHAnswer   = 560
	setAsideGrace = 1500 * time.Millisecond
	followPoll    = 16 * time.Millisecond
	glideFrame    = 16 * time.Millisecond
)

// Held is the pick a card came from, kept drawn while the card needs it.
type Held interface {
	Release()
	// Shift moves the pick's drawing as the window it was made in moves.
	Shift(dx, dy float64)
}

type card struct {
	win   *mygo.Window
	init  contract.CardInit
	width int
	held  Held

	kept             bool
	keptBounds       mygo.Rectangle
	hiddenBySuppress bool
	manualSize       bool
	menuBaseH        int
	stopGlide        chan struct{}
}

func (c *card) releasePick() {
	if c.held != nil {
		h := c.held
		c.held = nil
		h.Release()
	}
}

type gripDrag struct {
	c *card
	b mygo.Rectangle
	p mygo.Point
}

// placeCard puts a card of width × height just below and right of the
// cursor, inside the work area.
func placeCard(cursor mygo.Point, wa mygo.Rectangle, width, height int) mygo.Rectangle {
	x := min(max(cursor.X+12, wa.X), wa.X+wa.Width-width)
	y := min(max(cursor.Y+16, wa.Y), wa.Y+wa.Height-height)
	return mygo.Rectangle{X: x, Y: y, Width: width, Height: height}
}

func cardBounds(height, width int) mygo.Rectangle {
	cursor := mygo.Screen.CursorScreenPoint()
	return placeCard(cursor, mygo.Screen.DisplayNearestPoint(cursor).WorkArea, width, height)
}

// OpenGrab opens a card asking about g. held is the pick that made it,
// released once the card no longer needs it.
func (u *UI) OpenGrab(g contract.Grab, held Held) {
	u.OpenCard(contract.CardInit{Grab: &g, Agent: &contract.AgentInfo{Name: u.deps.AgentName}}, held)
}

// OpenCard opens a card, setting the current one aside.
func (u *UI) OpenCard(init contract.CardInit, held Held) {
	mygo.RunOnMain(func() { u.openCard(init, held) })
}

func (u *UI) openCard(init contract.CardInit, held Held) {
	if u.deps.Visibility.Suppressed() {
		if held != nil {
			held.Release()
		}
		return
	}
	u.setAside()
	var owner desktop.WindowID
	if init.Mode != "pair" {
		if fg, err := u.deps.Desktop.Foreground(); err == nil && fg.ID != 0 && !slices.Contains(u.ownIDs(), fg.ID) {
			owner = fg.ID
		}
	}
	height := cardHAsk
	if init.Mode == "pair" {
		height = cardHPair
	}
	c := &card{init: init, width: u.cardWidth, held: held}
	c.win = u.open(kindCard, cardBounds(height, c.width))
	u.cards = append(u.cards, c)
	u.current = c
	c.win.OnClosed(func() {
		c.releasePick()
		u.cards = removeFrom(u.cards, c)
		if u.current == c {
			u.current = nil
		}
		before := len(u.pills)
		u.pills = slices.DeleteFunc(u.pills, func(p *pill) bool { return p.card == c })
		if len(u.pills) != before {
			u.updatePills()
		}
	})
	if owner != 0 {
		if err := u.deps.Desktop.AttachToOwner(c.win, owner); err != nil {
			u.log("card-owner", err)
		}
		go u.followOwner(c, owner)
	}
	c.win.OnReadyToShow(func() { show(c.win, kindCard) })
}

func (u *UI) ownIDs() []desktop.WindowID {
	ids := make([]desktop.WindowID, 0, len(u.cards))
	for _, c := range u.cards {
		ids = append(ids, u.deps.Desktop.WindowID(c.win))
	}
	return ids
}

func (u *UI) cardOf(w *mygo.Window) *card {
	for _, c := range u.cards {
		if c.win == w {
			return c
		}
	}
	return nil
}

// followOwner moves the card with the window it belongs to. Positions are
// kept as floats, since rounding each step drifts at fractional scales.
func (u *UI) followOwner(c *card, owner desktop.WindowID) {
	d := u.deps.Desktop
	last, err := d.WindowOrigin(owner)
	if err != nil {
		return
	}
	var px, py float64
	var placed mygo.Point
	havePos := false
	t := time.NewTicker(followPoll)
	defer t.Stop()
	for range t.C {
		if c.win.IsDestroyed() {
			return
		}
		now, err := d.WindowOrigin(owner)
		if err != nil {
			return
		}
		if now == last {
			continue
		}
		a, b := d.ToDIP(last), d.ToDIP(now)
		last = now
		dx, dy := b.X-a.X, b.Y-a.Y
		mygo.RunOnMain(func() {
			if c.win.IsDestroyed() {
				return
			}
			if c.held != nil {
				c.held.Shift(dx, dy)
			}
			if !c.win.IsVisible() {
				return
			}
			r := c.win.Bounds()
			if !havePos || abs(r.X-placed.X) > 2 || abs(r.Y-placed.Y) > 2 {
				px, py, havePos = float64(r.X), float64(r.Y), true
			}
			px, py = px+dx, py+dy
			placed = mygo.Point{X: int(math.Round(px)), Y: int(math.Round(py))}
			c.win.SetBounds(mygo.Rectangle{X: placed.X, Y: placed.Y, Width: c.width, Height: r.Height})
		})
	}
}

func abs(x int) int { return max(x, -x) }

// setAside lets the current card finish what it shows, then closes it
// unless it was kept as a pill.
func (u *UI) setAside() {
	old := u.current
	if old == nil || old.win.IsDestroyed() {
		return
	}
	u.current = nil
	cardSetAside.Emit(old.win, struct{}{})
	time.AfterFunc(setAsideGrace, func() {
		mygo.RunOnMain(func() {
			if !old.win.IsDestroyed() && !old.kept && old != u.current {
				old.win.Destroy()
			}
		})
	})
}

// ToCards relays an agent event to every card.
func (u *UI) ToCards(msg jsontext.Value) {
	var wins []*mygo.Window
	mygo.RunOnMain(func() {
		for _, c := range u.cards {
			wins = append(wins, c.win)
		}
	})
	for _, w := range wins {
		agentEvent.Emit(w, msg)
	}
}

var imageFile = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|bmp|svg)$`)

func openLink(href string) {
	switch {
	case strings.HasPrefix(strings.ToLower(href), "http://"), strings.HasPrefix(strings.ToLower(href), "https://"):
		mygo.Shell.OpenExternal(href)
	case filepath.IsAbs(href) && exists(href):
		mygo.Shell.ShowItemInFolder(href)
	}
}

func openImage(path string) {
	if filepath.IsAbs(path) && imageFile.MatchString(path) && exists(path) {
		mygo.Shell.OpenPath(path)
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (u *UI) resizeCard(c *card, height int) {
	if c.manualSize {
		return
	}
	b := c.win.Bounds()
	wa := mygo.Screen.DisplayMatching(b).WorkArea
	if height == 0 {
		height = cardHAnswer
	}
	h := min(height, wa.Height)
	if c.menuBaseH > 0 {
		c.menuBaseH = h
		return
	}
	c.win.SetBounds(mygo.Rectangle{X: b.X, Y: min(b.Y, wa.Y+wa.Height-h), Width: c.width, Height: h})
}

// menuRoom grows the card so an open menu fits, and gives the height back
// when height is 0.
func (u *UI) menuRoom(c *card, height int) {
	b := c.win.Bounds()
	if height == 0 {
		if c.menuBaseH > 0 {
			b.Height = c.menuBaseH
			c.win.SetBounds(b)
		}
		c.menuBaseH = 0
		return
	}
	if height <= b.Height {
		return
	}
	wa := mygo.Screen.DisplayMatching(b).WorkArea
	if c.menuBaseH == 0 {
		c.menuBaseH = b.Height
	}
	b.Height = min(height, wa.Y+wa.Height-b.Y)
	c.win.SetBounds(b)
}

// The grip sizes the card from the cursor as Go reads it; the page's own
// coordinates are off at fractional scales.
func (u *UI) gripStart(c *card) {
	u.grip = &gripDrag{c: c, b: c.win.Bounds(), p: mygo.Screen.CursorScreenPoint()}
}

func (u *UI) gripMove(c *card) {
	g := u.grip
	if g == nil || g.c != c || c.win.IsDestroyed() {
		return
	}
	now := mygo.Screen.CursorScreenPoint()
	wa := mygo.Screen.DisplayMatching(g.b).WorkArea
	width := min(max(cardMinW, g.b.Width+now.X-g.p.X), wa.X+wa.Width-g.b.X)
	height := min(max(cardMinH, g.b.Height+now.Y-g.p.Y), wa.Y+wa.Height-g.b.Y)
	c.manualSize = true
	c.width = width
	u.cardWidth = width
	c.win.SetBounds(mygo.Rectangle{X: g.b.X, Y: g.b.Y, Width: width, Height: height})
}

// keep turns a card whose task runs on into a pill.
func (u *UI) keep(c *card, info contract.KeepInfo) {
	if info.SessionID == "" {
		c.win.Close()
		return
	}
	c.kept = true
	c.keptBounds = c.win.Bounds()
	if !c.win.IsVisible() {
		c.win.Hide()
	} else {
		u.glide(c, c.keptBounds, trayCorner(c.keptBounds), 220*time.Millisecond, func() {
			if c.kept && !c.win.IsDestroyed() {
				c.win.Hide()
			}
		})
	}
	c.releasePick()
	if u.current == c {
		u.current = nil
	}
	state := info.State
	if state != contract.PillDone && state != contract.PillError {
		state = contract.PillRun
	}
	title := info.Title
	if title == "" {
		title = "新任务"
	}
	u.pills = slices.DeleteFunc(u.pills, func(p *pill) bool { return p.card == c })
	u.pills = append(u.pills, &pill{PillItem: contract.PillItem{ID: pillID(c), Title: title, State: state}, sessionID: info.SessionID, card: c, fixedTitle: info.FixedTitle})
	u.updatePills()
}

// restore brings a kept card back from its pill.
func (u *UI) restore(c *card) {
	if c.win.IsDestroyed() {
		return
	}
	if u.current != c {
		u.setAside()
	}
	c.kept = false
	u.current = c
	cur := c.win.Bounds()
	to := c.keptBounds
	to.Height = cur.Height
	if !onSomeScreen(c.keptBounds) {
		to = cardBounds(cur.Height, c.width)
	}
	cardRestore.Emit(c.win, struct{}{})
	from := trayCorner(to)
	c.win.SetBounds(from)
	show(c.win, kindCard)
	u.glide(c, from, to, 240*time.Millisecond, nil)
}

func onSomeScreen(k mygo.Rectangle) bool {
	for _, d := range mygo.Screen.Displays() {
		w := d.WorkArea
		if k.X < w.X+w.Width && k.X+k.Width > w.X && k.Y < w.Y+w.Height && k.Y+k.Height > w.Y {
			return true
		}
	}
	return false
}

func trayCorner(b mygo.Rectangle) mygo.Rectangle {
	w := mygo.Screen.PrimaryDisplay().WorkArea
	return mygo.Rectangle{X: w.X + w.Width - b.Width, Y: w.Y + w.Height - b.Height, Width: b.Width, Height: b.Height}
}

// glide moves the card from one place to another with an ease-out.
func (u *UI) glide(c *card, from, to mygo.Rectangle, d time.Duration, done func()) {
	if c.stopGlide != nil {
		close(c.stopGlide)
	}
	stop := make(chan struct{})
	c.stopGlide = stop
	t0 := time.Now()
	go func() {
		tick := time.NewTicker(glideFrame)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
			}
			t := min(1, float64(time.Since(t0))/float64(d))
			e := 1 - math.Pow(1-t, 3)
			finished := false
			mygo.RunOnMain(func() {
				select {
				case <-stop:
					finished = true
					return
				default:
				}
				if c.win.IsDestroyed() {
					finished = true
					return
				}
				c.win.SetBounds(mygo.Rectangle{
					X: from.X + int(math.Round(float64(to.X-from.X)*e)), Y: from.Y + int(math.Round(float64(to.Y-from.Y)*e)),
					Width: to.Width, Height: to.Height,
				})
				if t >= 1 {
					finished = true
					if c.stopGlide == stop {
						c.stopGlide = nil
					}
					if done != nil {
						done()
					}
				}
			})
			if finished {
				return
			}
		}
	}()
}

// OnTask updates the pills of a session.
func (u *UI) OnTask(e agent.TaskEvent) {
	mygo.RunOnMain(func() {
		changed := false
		for _, p := range u.pills {
			if p.sessionID != e.SessionID {
				continue
			}
			if e.Title != "" && !p.fixedTitle && e.Title != p.Title {
				p.Title = e.Title
				changed = true
			}
			if p.State != contract.PillRun {
				continue
			}
			switch e.Type {
			case "ask-done":
				p.State = contract.PillError
				if e.Reason == "completed" {
					p.State = contract.PillDone
				}
				changed = true
			case "ask-error":
				p.State = contract.PillError
				changed = true
			}
		}
		if changed {
			u.updatePills()
		}
	})
}

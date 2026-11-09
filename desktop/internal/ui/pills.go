package ui

import (
	"fmt"
	"slices"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/contract"
)

const (
	pillW = 300
	pillH = 60
)

// pill is a kept card whose task runs on, shown in the bottom-right corner.
type pill struct {
	contract.PillItem
	sessionID  string
	card       *card
	fixedTitle bool
}

func pillID(c *card) string { return fmt.Sprintf("card%d", c.win.ID()) }

func (u *UI) pillItems() []contract.PillItem {
	items := make([]contract.PillItem, len(u.pills))
	for i, p := range u.pills {
		items[i] = p.PillItem
	}
	return items
}

// updatePills shows the pills, or closes their window when none is left.
func (u *UI) updatePills() {
	if len(u.pills) == 0 {
		if u.pillWin != nil && !u.pillWin.IsDestroyed() {
			u.pillWin.Destroy()
		}
		u.pillWin = nil
		return
	}
	if u.pillWin == nil || u.pillWin.IsDestroyed() {
		wa := mygo.Screen.PrimaryDisplay().WorkArea
		w := u.open(kindPill, mygo.Rectangle{X: wa.X + wa.Width - pillW, Y: wa.Y + wa.Height - pillH, Width: pillW, Height: pillH})
		// The page reports its height from an animation frame, which WebKit
		// runs only for windows on screen.
		w.OnReadyToShow(func() {
			if !u.deps.Visibility.Suppressed() {
				show(w, kindPill)
			}
		})
		u.pillWin = w
	}
	pillsEvent.Emit(u.pillWin, u.pillItems())
}

// placePills fits the pill window to its page, in the corner.
func (u *UI) placePills(height int) {
	if u.pillWin == nil || u.pillWin.IsDestroyed() {
		return
	}
	wa := mygo.Screen.PrimaryDisplay().WorkArea
	h := max(1, min(height, wa.Height))
	u.pillWin.SetBounds(mygo.Rectangle{X: wa.X + wa.Width - pillW, Y: wa.Y + wa.Height - h, Width: pillW, Height: h})
	if !u.pillWin.IsVisible() && !u.deps.Visibility.Suppressed() {
		show(u.pillWin, kindPill)
	}
}

func (u *UI) takePill(id string) *pill {
	i := slices.IndexFunc(u.pills, func(p *pill) bool { return p.ID == id })
	if i < 0 {
		return nil
	}
	p := u.pills[i]
	u.pills = slices.Delete(u.pills, i, i+1)
	u.updatePills()
	return p
}

func (u *UI) openPill(id string) {
	if p := u.takePill(id); p != nil {
		u.restore(p.card)
	}
}

func (u *UI) dismissPill(id string) {
	if p := u.takePill(id); p != nil && !p.card.win.IsDestroyed() {
		p.card.win.Destroy()
	}
}

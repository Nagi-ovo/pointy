package windows

// This file has no build constraint, so its tests run on every platform.
// It follows mygo's internal/windows/dips.go (v0.8.3), which is internal:
// screen units must land where mygo puts its DIPs, or cards would drift
// from the windows they follow on displays of different scales.

import (
	"math"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// monitor is a display in physical pixels, with its DPI.
type monitor struct {
	bounds mygo.Rectangle
	dpi    int
}

// dipSpace places the monitors in mygo's DIPs: a monitor's DIPs start at
// its top-left pixel scaled by the smallest scale of all, and go on in its
// own scale from there.
type dipSpace struct {
	monitors []monitor
	minDPI   int
}

func newDIPSpace(monitors []monitor, fallback int) dipSpace {
	if fallback <= 0 {
		fallback = 96
	}
	s := dipSpace{minDPI: fallback}
	for i, m := range monitors {
		if m.dpi <= 0 {
			m.dpi = fallback
		}
		if i == 0 || m.dpi < s.minDPI {
			s.minDPI = m.dpi
		}
		s.monitors = append(s.monitors, m)
	}
	return s
}

// origin is where monitor i's top-left pixel is in pixels and in DIPs,
// and its DPI; 0, 0 at the fallback DPI without monitors.
func (s dipSpace) origin(i int) (px, dip mygo.Point, dpi int) {
	if i < 0 || i >= len(s.monitors) {
		return mygo.Point{}, mygo.Point{}, s.minDPI
	}
	m := s.monitors[i]
	px = mygo.Point{X: m.bounds.X, Y: m.bounds.Y}
	dip = mygo.Point{X: scaled(px.X, 96, s.minDPI), Y: scaled(px.Y, 96, s.minDPI)}
	return px, dip, m.dpi
}

func (s dipSpace) bounds(i int) mygo.Rectangle {
	return s.toDIPOn(i, s.monitors[i].bounds)
}

func (s dipSpace) toDIPOn(i int, r mygo.Rectangle) mygo.Rectangle {
	px, dip, dpi := s.origin(i)
	return mygo.Rectangle{
		X: dip.X + scaled(r.X-px.X, 96, dpi), Y: dip.Y + scaled(r.Y-px.Y, 96, dpi),
		Width: scaled(r.Width, 96, dpi), Height: scaled(r.Height, 96, dpi),
	}
}

// pixelMonitor is the monitor r, in pixels, is the most on, or the nearest.
func (s dipSpace) pixelMonitor(r mygo.Rectangle) int {
	return mostOn(r, len(s.monitors), func(i int) mygo.Rectangle { return s.monitors[i].bounds })
}

// dipMonitor is the monitor r, in DIPs, is the most on, or the nearest.
func (s dipSpace) dipMonitor(r mygo.Rectangle) int {
	return mostOn(r, len(s.monitors), s.bounds)
}

// rectToDIP converts a rectangle in pixels through the scale of the
// monitor it is the most on.
func (s dipSpace) rectToDIP(r desktop.Rect) mygo.Rectangle {
	px := mygo.Rectangle{X: r[0], Y: r[1], Width: r[2], Height: r[3]}
	return s.toDIPOn(s.pixelMonitor(px), px)
}

// pointToDIP converts a point in pixels through the scale of the monitor
// it is on. Fractions are kept: a card that follows a window adds up the
// window's moves.
func (s dipSpace) pointToDIP(p desktop.Point) desktop.Point {
	px, dip, dpi := s.origin(s.pixelMonitor(pixelAt(p)))
	k := 96 / float64(dpi)
	return desktop.Point{X: float64(dip.X) + (p.X-float64(px.X))*k, Y: float64(dip.Y) + (p.Y-float64(px.Y))*k}
}

// pointToPixels converts a point in DIPs through the scale of the monitor
// it is on in DIPs.
func (s dipSpace) pointToPixels(p desktop.Point) desktop.Point {
	px, dip, dpi := s.origin(s.dipMonitor(pixelAt(p)))
	k := float64(dpi) / 96
	return desktop.Point{X: float64(px.X) + (p.X-float64(dip.X))*k, Y: float64(px.Y) + (p.Y-float64(dip.Y))*k}
}

// unitsPerDIP is the scale of the monitor the pixel p is on.
func (s dipSpace) unitsPerDIP(p desktop.Point) float64 {
	_, _, dpi := s.origin(s.pixelMonitor(pixelAt(p)))
	return float64(dpi) / 96
}

func pixelAt(p desktop.Point) mygo.Rectangle {
	return mygo.Rectangle{X: int(math.Floor(p.X)), Y: int(math.Floor(p.Y)), Width: 1, Height: 1}
}

// scaled is v × num / den rounded to the nearest integer, halves up.
func scaled(v, num, den int) int { return floorDiv(2*v*num+den, 2*den) }

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && a < 0 {
		q--
	}
	return q
}

// mostOn is the monitor r overlaps the most, else the nearest; -1 without
// monitors. Ties keep the system's order.
func mostOn(r mygo.Rectangle, n int, bounds func(int) mygo.Rectangle) int {
	best, bestArea, bestDist := -1, int64(0), int64(math.MaxInt64)
	for i := range n {
		b := bounds(i)
		w := min(r.X+r.Width, b.X+b.Width) - max(r.X, b.X)
		h := min(r.Y+r.Height, b.Y+b.Height) - max(r.Y, b.Y)
		var area, dist int64
		if w > 0 && h > 0 {
			area = int64(w) * int64(h)
		} else {
			dx, dy := int64(max(0, -w)), int64(max(0, -h))
			dist = dx*dx + dy*dy
		}
		if best < 0 || area > bestArea || area == bestArea && area == 0 && dist < bestDist {
			best, bestArea, bestDist = i, area, dist
		}
	}
	return best
}

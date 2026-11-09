package pick

import (
	"time"

	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	shakePoll     = 16 * time.Millisecond
	shakeCooldown = 1500 * time.Millisecond
	shakeMinSeen  = 6
	maxVertical   = 120
)

// shakeLevel is how hard the mouse must shake: this many reversals of at
// least amplitude within window.
type shakeLevel struct {
	window    time.Duration
	reversals int
	amplitude float64
}

var shakeLevels = map[config.ShakeLevel]shakeLevel{
	config.ShakeLow:    {400 * time.Millisecond, 4, 60},
	config.ShakeMedium: {450 * time.Millisecond, 3, 40},
	config.ShakeHigh:   {500 * time.Millisecond, 3, 28},
}

type sample struct {
	t time.Time
	p desktop.Point
}

// shaker recognises a shake in the cursor positions it is fed.
type shaker struct {
	samples  []sample
	lastFire time.Time
}

// feed adds the cursor position at now and reports whether it completes a
// shake. allowed is asked last, once the movement is a shake.
func (s *shaker) feed(now time.Time, p desktop.Point, level config.ShakeLevel, allowed func() bool) bool {
	l, ok := shakeLevels[level]
	if !ok {
		l = shakeLevels[config.ShakeMedium]
	}
	s.samples = append(s.samples, sample{now, p})
	drop := 0
	for drop < len(s.samples) && now.Sub(s.samples[drop].t) > l.window {
		drop++
	}
	s.samples = s.samples[drop:]
	if len(s.samples) < shakeMinSeen || now.Sub(s.lastFire) < shakeCooldown {
		return false
	}
	xs := make([]float64, len(s.samples))
	top, bottom := p.Y, p.Y
	for i, x := range s.samples {
		xs[i] = x.p.X
		top, bottom = min(top, x.p.Y), max(bottom, x.p.Y)
	}
	if countReversals(xs, l.amplitude) < l.reversals || bottom-top > maxVertical || !allowed() {
		return false
	}
	s.lastFire = now
	s.samples = s.samples[:0]
	return true
}

// watchShakes polls the cursor until stop is closed and calls onShake
// where the mouse was shaken.
func watchShakes(d desktop.Desktop, level func() config.ShakeLevel, allowed func() bool, onShake func(desktop.Point), stop <-chan struct{}) {
	var s shaker
	t := time.NewTicker(shakePoll)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			p := d.Cursor()
			if s.feed(now, p, level(), func() bool { return allowed() && !d.ButtonDown() && d.CursorVisible() }) {
				onShake(p)
			}
		}
	}
}

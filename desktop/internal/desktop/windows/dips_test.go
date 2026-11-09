package windows

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func mon(x, y, w, h, dpi int) monitor {
	return monitor{bounds: mygo.Rectangle{X: x, Y: y, Width: w, Height: h}, dpi: dpi}
}

// The layouts and the DIPs they must land on are mygo's own tests'
// (internal/windows/dips_test.go, v0.8.3).
var layouts = map[string][]monitor{
	"200% and 175% to its right":        {mon(0, 0, 3840, 2160, 192), mon(3840, 0, 2560, 1600, 168)},
	"200% and 175% to its right, lower": {mon(0, 0, 3840, 2160, 192), mon(3840, 647, 2560, 1600, 168)},
	"100% and 200% to its right":        {mon(0, 0, 2560, 1440, 96), mon(2560, 0, 3840, 2160, 192)},
	"200% and 100% to its left":         {mon(0, 0, 3840, 2160, 192), mon(-2560, 0, 2560, 1440, 96)},
	"150% twice":                        {mon(0, 0, 2880, 1800, 144), mon(2880, 0, 2880, 1800, 144)},
	"150% alone":                        {mon(0, 0, 2880, 1800, 144)},
}

func TestMonitorsLandWhereMygoPutsThem(t *testing.T) {
	for _, tt := range []struct {
		layout string
		want   []mygo.Rectangle
	}{
		{"200% and 175% to its right", []mygo.Rectangle{{Width: 1920, Height: 1080}, {X: 2194, Width: 1463, Height: 914}}},
		{"200% and 175% to its right, lower", []mygo.Rectangle{{Width: 1920, Height: 1080}, {X: 2194, Y: 370, Width: 1463, Height: 914}}},
		{"100% and 200% to its right", []mygo.Rectangle{{Width: 2560, Height: 1440}, {X: 2560, Width: 1920, Height: 1080}}},
		{"200% and 100% to its left", []mygo.Rectangle{{Width: 1920, Height: 1080}, {X: -2560, Width: 2560, Height: 1440}}},
		{"150% twice", []mygo.Rectangle{{Width: 1920, Height: 1200}, {X: 1920, Width: 1920, Height: 1200}}},
	} {
		s := newDIPSpace(layouts[tt.layout], 96)
		for i, want := range tt.want {
			r := s.monitors[i].bounds
			if got := s.rectToDIP(desktop.Rect{r.X, r.Y, r.Width, r.Height}); got != want {
				t.Errorf("%s: monitor %d at %+v, want %+v", tt.layout, i, got, want)
			}
		}
	}
}

func TestPointsConvertBothWays(t *testing.T) {
	for name, monitors := range layouts {
		s := newDIPSpace(monitors, 96)
		for i, m := range monitors {
			b := m.bounds
			for _, f := range [][2]float64{{0, 0}, {.25, .5}, {.5, .5}, {.99, .99}} {
				p := desktop.Point{X: float64(b.X) + f[0]*float64(b.Width), Y: float64(b.Y) + f[1]*float64(b.Height)}
				d := s.pointToDIP(p)
				db := s.bounds(i)
				if d.X < float64(db.X) || d.Y < float64(db.Y) || d.X > float64(db.X+db.Width) || d.Y > float64(db.Y+db.Height) {
					t.Errorf("%s: pixel %+v of monitor %d is DIP %+v, outside its DIPs %+v", name, p, i, d, db)
				}
				back := s.pointToPixels(d)
				if abs(back.X-p.X) > 1e-6 || abs(back.Y-p.Y) > 1e-6 {
					t.Errorf("%s: pixel %+v came back as %+v", name, p, back)
				}
			}
		}
	}
}

func TestPointsAtScale(t *testing.T) {
	s := newDIPSpace(layouts["150% alone"], 96)
	if got := s.pointToDIP(desktop.Point{X: 300, Y: 150}); got != (desktop.Point{X: 200, Y: 100}) {
		t.Errorf("pixel 300,150 at 150%% is DIP %+v, want 200,100", got)
	}
	if got := s.pointToPixels(desktop.Point{X: 200, Y: 100}); got != (desktop.Point{X: 300, Y: 150}) {
		t.Errorf("DIP 200,100 at 150%% is pixel %+v, want 300,150", got)
	}
	if got := s.unitsPerDIP(desktop.Point{X: 10, Y: 10}); got != 1.5 {
		t.Errorf("units per DIP at 150%% = %v", got)
	}
	if got := s.rectToDIP(desktop.Rect{300, 150, 90, 45}); got != (mygo.Rectangle{X: 200, Y: 100, Width: 60, Height: 30}) {
		t.Errorf("rect at 150%% is %+v", got)
	}
}

func TestPointOffEveryMonitorTakesTheNearest(t *testing.T) {
	s := newDIPSpace(layouts["100% and 200% to its right"], 96)
	if got := s.unitsPerDIP(desktop.Point{X: 9000, Y: 10}); got != 2 {
		t.Errorf("a pixel right of the 200%% monitor got scale %v", got)
	}
	if got := newDIPSpace(nil, 144).unitsPerDIP(desktop.Point{}); got != 1.5 {
		t.Errorf("without monitors the fallback DPI gives %v", got)
	}
}

func abs(x float64) float64 { return max(x, -x) }

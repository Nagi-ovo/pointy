package pick

import (
	"testing"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func rect(x, y, w, h int) *desktop.Rect { return &desktop.Rect{x, y, w, h} }

func TestFocusRect(t *testing.T) {
	type in struct {
		r           *desktop.Rect
		x, y, scale float64
		zoom        float64
	}
	cases := []struct {
		name string
		in   in
		want *desktop.Rect
	}{
		{"a box not much bigger than the frame keeps no frame", in{rect(0, 0, 1000, 440), 500, 200, 1, 1}, nil},
		{"the size check scales with units per DIP", in{rect(0, 0, 2000, 880), 500, 200, 2, 1}, nil},
		{"one long side is enough, cut to the box", in{rect(0, 0, 2000, 300), 1000, 150, 1, 1}, rect(640, 0, 720, 300)},
		{"the frame is centred on the pointer", in{rect(0, 0, 2000, 1000), 1000, 500, 1, 1}, rect(640, 340, 720, 320)},
		{"the frame stays inside the box, top left", in{rect(100, 100, 2000, 1000), 120, 110, 1, 1}, rect(100, 100, 720, 320)},
		{"the frame stays inside the box, bottom right", in{rect(100, 100, 2000, 1000), 2090, 1090, 1, 1}, rect(1380, 780, 720, 320)},
		{"the frame scales with units per DIP", in{rect(0, 0, 4000, 2000), 2000, 1000, 2, 1}, rect(1280, 680, 1440, 640)},
		{"the frame scales with zoom", in{rect(0, 0, 4000, 2000), 2000, 1000, 1, 2}, rect(1280, 680, 1440, 640)},
		{"zooming past the box is clamped to the box", in{rect(0, 0, 1200, 500), 600, 250, 1, 4}, rect(0, 0, 1200, 500)},
	}
	for _, c := range cases {
		got, ok := focusRect(*c.in.r, desktop.Point{X: c.in.x, Y: c.in.y}, c.in.scale, c.in.zoom)
		switch {
		case c.want == nil && ok:
			t.Errorf("%s: got %v, want no frame", c.name, got)
		case c.want != nil && (!ok || got != *c.want):
			t.Errorf("%s: got %v %v, want %v", c.name, got, ok, *c.want)
		}
	}
}

func TestIsOpaque(t *testing.T) {
	win := rect(0, 0, 1000, 800)
	cases := []struct {
		name string
		s    shape
		want bool
	}{
		{"a Chromium render widget is opaque whatever it reports", shape{Class: "Chrome_RenderWidgetHostHWND", Kids: true, Readable: true}, true},
		{"a Chromium top window is opaque", shape{Class: "Chrome_WidgetWin_1"}, true},
		{"a D3D surface is opaque", shape{Class: "Intermediate D3D Window"}, true},
		{"a look-alike class is not a Chromium shell", shape{Class: "Chrome_WidgetWin_x"}, false},
		{"a control that is the whole window is opaque despite children", shape{Type: typeWindow, Rect: rect(0, 0, 1000, 790), Win: win, Kids: true, Readable: true}, true},
		{"a window control smaller than its window is not whole", shape{Type: typeWindow, Rect: rect(0, 0, 1000, 700), Win: win, Kids: true}, false},
		{"a childless unreadable control filling the window is opaque", shape{Type: "ControlType.Pane", Rect: rect(0, 0, 1000, 720), Win: win}, true},
		{"one covering less than 90% is not", shape{Type: "ControlType.Pane", Rect: rect(0, 0, 1000, 700), Win: win}, false},
		{"children make a control readable", shape{Type: "ControlType.Pane", Rect: rect(0, 0, 1000, 800), Win: win, Kids: true}, false},
		{"a text interface makes a control readable", shape{Type: "ControlType.Document", Rect: rect(0, 0, 1000, 800), Win: win, Readable: true}, false},
		{"without its own rect nothing is opaque by size", shape{Type: "ControlType.Pane", Win: win}, false},
		{"without the window rect nothing is opaque by size", shape{Type: "ControlType.Pane", Rect: rect(0, 0, 1000, 800)}, false},
	}
	for _, c := range cases {
		if got := isOpaque(c.s); got != c.want {
			t.Errorf("%s: isOpaque = %v, want %v", c.name, got, c.want)
		}
	}
}

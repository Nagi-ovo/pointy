package ui

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func TestSurfacesStartHiddenFramelessAndOnTop(t *testing.T) {
	b := mygo.Rectangle{X: 10, Y: 20, Width: 300, Height: 60}
	for k, s := range surfaces {
		o := s.options(b, "preload")
		if !o.Hidden || !o.Frameless || !o.Transparent || !o.SkipTaskbar || !o.AlwaysOnTop || !o.DisableResize || !o.DisableShadow {
			t.Errorf("kind %d: options %+v", k, o)
		}
		if o.X != 10 || o.Y != 20 || o.Width != 300 || o.Height != 60 {
			t.Errorf("kind %d: bounds %d,%d %dx%d", k, o.X, o.Y, o.Width, o.Height)
		}
		if s.page == "" {
			if o.URL != "" || o.Page.PreloadScript != "" {
				t.Errorf("kind %d has no page but loads %q", k, o.URL)
			}
			continue
		}
		if o.URL != pageURL[s.page] || o.URL == "" || o.Page.PreloadScript != "preload" {
			t.Errorf("kind %d: url %q preload %q", k, o.URL, o.Page.PreloadScript)
		}
	}
}

func TestSurfacesFocusAndLevels(t *testing.T) {
	want := map[kind]struct {
		focus        focusMode
		clickThrough bool
		level        desktop.Level
	}{
		kindCard:    {focusTake, false, desktop.LevelFloating},
		kindPill:    {focusInactive, false, desktop.LevelFloating},
		kindNotice:  {focusInactive, false, desktop.LevelFloating},
		kindHint:    {focusNever, true, desktop.LevelScreenSaver},
		kindIntro:   {focusNever, true, desktop.LevelScreenSaver},
		kindOverlay: {focusNever, true, desktop.LevelScreenSaver},
	}
	if len(surfaces) != len(want) {
		t.Fatalf("%d surfaces, want %d", len(surfaces), len(want))
	}
	for k, w := range want {
		s := surfaces[k]
		if s.focus != w.focus || s.clickThrough != w.clickThrough || s.level != w.level {
			t.Errorf("kind %d: %+v", k, s)
		}
	}
}

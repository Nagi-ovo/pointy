package ui

import (
	"sync"

	"github.com/pointylab/pointy/desktop/internal/config"
)

// Visibility says whether Pointy keeps out of sight: while another app is
// in full screen, or do-not-disturb is on.
type Visibility struct {
	settings *config.Store

	mu         sync.Mutex
	fullscreen bool
	listeners  []func(hidden bool)
}

func NewVisibility(s *config.Store) *Visibility { return &Visibility{settings: s} }

func (v *Visibility) Fullscreen() bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.fullscreen
}

func (v *Visibility) Suppressed() bool { return v.Fullscreen() || v.settings.Get().DND }

func (v *Visibility) SetFullscreen(on bool) {
	v.mu.Lock()
	same := v.fullscreen == on
	v.fullscreen = on
	v.mu.Unlock()
	if !same {
		v.Changed()
	}
}

// Changed tells the listeners, after a setting that hides Pointy changed.
func (v *Visibility) Changed() {
	v.mu.Lock()
	fns := append([]func(bool){}, v.listeners...)
	v.mu.Unlock()
	hidden := v.Suppressed()
	for _, fn := range fns {
		fn(hidden)
	}
}

func (v *Visibility) OnChange(fn func(hidden bool)) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.listeners = append(v.listeners, fn)
}

//go:build darwin

package darwin

import (
	"errors"
	"sync"
	"sync/atomic"

	"github.com/ebitengine/purego"
	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// The event tap sits at the head of the session's event stream on the main
// run loop. It is created once, the first time the user points with
// Accessibility granted, and enabled only while pointing. Its callback
// reads atomics and posts to a buffered channel, so it never waits.

const (
	sessionEventTap      = 1
	headInsertEventTap   = 0
	tapOptionDefault     = 0
	eventLeftDown        = 1
	eventLeftUp          = 2
	eventRightDown       = 3
	eventRightUp         = 4
	eventScrollWheel     = 22
	eventTapDisabledTime = 0xFFFFFFFE
	eventTapDisabledUser = 0xFFFFFFFF
	scrollDeltaAxis1     = 11
	tapMask              = 1<<eventLeftDown | 1<<eventLeftUp | 1<<eventRightDown | 1<<eventRightUp | 1<<eventScrollWheel
)

var errNoTap = errors.New("the event tap could not be created; Accessibility is not granted")

var tap struct {
	mu       sync.Mutex
	port     uintptr
	callback uintptr
	on       atomic.Bool
	wheel    atomic.Bool
	events   chan desktop.Button
}

func onTapEvent(proxy, typ, event, refcon uintptr) uintptr {
	t := uint32(typ)
	if t == eventTapDisabledTime || t == eventTapDisabledUser {
		if tap.on.Load() {
			cgEventTapEnable(tap.port, true)
		}
		return event
	}
	if !tap.on.Load() {
		return event
	}
	post := func(b desktop.Button) {
		select {
		case tap.events <- b:
		default:
		}
	}
	switch t {
	case eventScrollWheel:
		if !tap.wheel.Load() {
			return event
		}
		switch d := cgEventGetIntegerValueField(event, scrollDeltaAxis1); {
		case d > 0:
			post(desktop.WheelUp)
		case d < 0:
			post(desktop.WheelDown)
		}
	case eventLeftUp:
		post(desktop.LeftUp)
	case eventRightUp:
		post(desktop.RightUp)
	}
	return 0
}

func installTap() error {
	tap.mu.Lock()
	defer tap.mu.Unlock()
	if tap.port != 0 {
		return nil
	}
	load()
	if tap.callback == 0 {
		tap.callback = purego.NewCallback(onTapEvent)
		tap.events = make(chan desktop.Button, 16)
	}
	mygo.RunOnMain(func() {
		port := cgEventTapCreate(sessionEventTap, headInsertEventTap, tapOptionDefault, tapMask, tap.callback, 0)
		if port == 0 {
			return
		}
		cgEventTapEnable(port, false)
		source := cfMachPortCreateRunLoopSource(0, port, 0)
		cfRunLoopAddSource(cfRunLoopGetMain(), source, kCFRunLoopCommonModes)
		tap.port = port
	})
	if tap.port == 0 {
		return errNoTap
	}
	return nil
}

// buttonHook is the tap while one pick holds it.
type buttonHook struct{ once sync.Once }

func (*buttonHook) Events() <-chan desktop.Button { return tap.events }
func (*buttonHook) SetWheel(on bool)              { tap.wheel.Store(on) }

func (h *buttonHook) Close() {
	h.once.Do(func() {
		tap.on.Store(false)
		tap.wheel.Store(false)
		cgEventTapEnable(tap.port, false)
	})
}

func (*Desktop) HookButtons() (desktop.ButtonHook, error) {
	if err := installTap(); err != nil {
		return nil, err
	}
	for len(tap.events) > 0 {
		<-tap.events
	}
	tap.wheel.Store(false)
	tap.on.Store(true)
	cgEventTapEnable(tap.port, true)
	return &buttonHook{}, nil
}

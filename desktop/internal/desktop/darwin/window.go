//go:build darwin

package darwin

import (
	"sync"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// mygo only offers the floating level, so the screen-saver level and the
// windows that never take the keyboard go through the NSWindow itself.

const (
	nsFloatingWindowLevel    = 3
	nsScreenSaverWindowLevel = 1000
	nsWindowAbove            = 1
	restackPoll              = 100 * time.Millisecond
)

func nsWindow(w *mygo.Window) objc.ID { return objc.ID(w.NativeHandle()) }

func (*Desktop) WindowID(w *mygo.Window) desktop.WindowID {
	var id desktop.WindowID
	mygo.RunOnMain(func() {
		if h := nsWindow(w); h != 0 {
			id = desktop.WindowID(objc.Send[int](h, sel("windowNumber")))
		}
	})
	return id
}

func (*Desktop) SetLevel(w *mygo.Window, l desktop.Level) error {
	level := nsFloatingWindowLevel
	if l == desktop.LevelScreenSaver {
		level = nsScreenSaverWindowLevel
	}
	mygo.RunOnMain(func() { nsWindow(w).Send(sel("setLevel:"), level) })
	return nil
}

// nonKey lists the windows whose canBecomeKeyWindow answers NO. mygo's
// window classes answer YES; swapping one instance's class crashes AppKit,
// so the method of the class itself is replaced once and asks this set.
// Main thread only, where AppKit asks.
var (
	nonKey   = map[objc.ID]bool{}
	replaced = map[uintptr]bool{}
)

func replaceKeyMethods(c uintptr) {
	if replaced[c] {
		return
	}
	replaced[c] = true
	for _, name := range []string{"canBecomeKeyWindow", "canBecomeMainWindow"} {
		s := sel(name)
		m := classGetInstanceMethod(c, s)
		if m == 0 {
			continue
		}
		original := methodGetImplementation(m)
		imp := objc.NewIMP(func(self objc.ID, cmd objc.SEL) bool {
			if nonKey[self] {
				return false
			}
			r, _, _ := purego.SyscallN(original, uintptr(self), uintptr(cmd))
			return r&0xff != 0
		})
		classReplaceMethod(c, s, imp, methodGetTypeEncoding(m))
	}
}

func (*Desktop) SetFocusable(w *mygo.Window, focusable bool) error {
	load()
	mygo.RunOnMain(func() {
		h := nsWindow(w)
		if h == 0 {
			return
		}
		replaceKeyMethods(objc.Send[uintptr](h, sel("class")))
		if focusable {
			delete(nonKey, h)
			return
		}
		nonKey[h] = true
		w.OnClosed(func() { delete(nonKey, h) })
	})
	return nil
}

// attached maps a foreign window to the Pointy windows kept right above it.
var (
	attachMu  sync.Mutex
	attached  = map[desktop.WindowID][]*mygo.Window{}
	restackOn bool
)

func (d *Desktop) AttachToOwner(w *mygo.Window, owner desktop.WindowID) error {
	w.SetAlwaysOnTop(false)
	attachMu.Lock()
	defer attachMu.Unlock()
	attached[owner] = append(attached[owner], w)
	if !restackOn {
		restackOn = true
		go d.restackLoop()
	}
	return nil
}

func (d *Desktop) restackLoop() {
	for range time.Tick(restackPoll) {
		if !d.restack() {
			return
		}
	}
}

// restack puts the windows of each owner back above it when the owner's app
// is in front and one of them slipped below. It reports whether any owner
// is left to watch.
func (d *Desktop) restack() bool {
	front := frontmostPID()
	onScreen := windowList(listOnScreenOnly|listExcludeDesktopEls, 0)
	index := make(map[desktop.WindowID]int, len(onScreen))
	for i, w := range onScreen {
		index[w.id] = i
	}
	attachMu.Lock()
	type job struct {
		owner desktop.WindowID
		wins  []*mygo.Window
	}
	var jobs []job
	for owner, list := range attached {
		var live []*mygo.Window
		for _, w := range list {
			if !w.IsDestroyed() {
				live = append(live, w)
			}
		}
		oi, ok := index[owner]
		if len(live) == 0 || !ok {
			delete(attached, owner)
			continue
		}
		attached[owner] = live
		if onScreen[oi].pid == front {
			jobs = append(jobs, job{owner, live})
		}
	}
	left := len(attached) > 0
	if !left {
		restackOn = false
	}
	attachMu.Unlock()

	for _, j := range jobs {
		oi := index[j.owner]
		var shown []*mygo.Window
		slipped := false
		for _, w := range j.wins {
			if !w.IsVisible() {
				continue
			}
			shown = append(shown, w)
			if i, ok := index[d.WindowID(w)]; !ok || i > oi {
				slipped = true
			}
		}
		if !slipped {
			continue
		}
		mygo.RunOnMain(func() {
			below := j.owner
			for _, w := range shown {
				h := nsWindow(w)
				if h == 0 {
					continue
				}
				h.Send(sel("orderWindow:relativeTo:"), nsWindowAbove, int(below))
				below = desktop.WindowID(objc.Send[int](h, sel("windowNumber")))
			}
		})
	}
	return left
}

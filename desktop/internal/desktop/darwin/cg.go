//go:build darwin

package darwin

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	listOnScreenOnly      = 1
	listIncludingWindow   = 8
	listExcludeDesktopEls = 16
)

type cgWindow struct {
	id     desktop.WindowID
	pid    int
	layer  int
	title  string
	bounds *mygo.Rectangle
}

// windowList returns the windows the window server lists, front to back.
func windowList(option uint32, relativeTo desktop.WindowID) []cgWindow {
	load()
	var out []cgWindow
	withPool(func() {
		arr := objc.ID(cgWindowListCopyWindowInfo(option, uint32(relativeTo)))
		if arr == 0 {
			return
		}
		defer cfRelease(uintptr(arr))
		get := func(d objc.ID, k string) objc.ID { return d.Send(sel("objectForKey:"), nsString(k)) }
		num := func(d objc.ID, k string) int {
			v := get(d, k)
			if v == 0 {
				return 0
			}
			return objc.Send[int](v, sel("longValue"))
		}
		n := objc.Send[int](arr, sel("count"))
		out = make([]cgWindow, 0, n)
		for i := range n {
			d := arr.Send(sel("objectAtIndex:"), i)
			w := cgWindow{
				id:    desktop.WindowID(num(d, "kCGWindowNumber")),
				pid:   num(d, "kCGWindowOwnerPID"),
				layer: num(d, "kCGWindowLayer"),
				title: goString(get(d, "kCGWindowName")),
			}
			if b := get(d, "kCGWindowBounds"); b != 0 {
				f := func(k string) int { return int(objc.Send[float64](get(b, k), sel("doubleValue"))) }
				w.bounds = &mygo.Rectangle{X: f("X"), Y: f("Y"), Width: f("Width"), Height: f("Height")}
			}
			out = append(out, w)
		}
	})
	return out
}

func frontmostPID() int {
	load()
	var pid int
	withPool(func() {
		app := class("NSWorkspace").Send(sel("sharedWorkspace")).Send(sel("frontmostApplication"))
		if app != 0 {
			pid = objc.Send[int](app, sel("processIdentifier"))
		}
	})
	return pid
}

func frontWindow() (cgWindow, bool) {
	pid := frontmostPID()
	for _, w := range windowList(listOnScreenOnly|listExcludeDesktopEls, 0) {
		if w.pid == pid && w.layer == 0 {
			return w, true
		}
	}
	return cgWindow{}, false
}

func processPath(pid int) string {
	buf := make([]byte, 4096)
	n := procPidpath(int32(pid), &buf[0], uint32(len(buf)))
	if n <= 0 {
		return ""
	}
	return string(buf[:n])
}

func process(pid int) desktop.Foreground {
	p := desktop.Foreground{PID: pid, ExePath: processPath(pid)}
	p.Exe = strings.ToLower(filepath.Base(p.ExePath))
	return p
}

func (*Desktop) Foreground() (desktop.Foreground, error) {
	pid := frontmostPID()
	if pid == 0 {
		return desktop.Foreground{}, nil
	}
	fg := process(pid)
	for _, w := range windowList(listOnScreenOnly|listExcludeDesktopEls, 0) {
		if w.pid == pid && w.layer == 0 {
			fg.ID, fg.Title = w.id, w.title
			break
		}
	}
	return fg, nil
}

var errNoProcess = errors.New("process is gone")

func (*Desktop) WindowAt(pid int, p desktop.Point) (desktop.Foreground, error) {
	w := process(pid)
	if pid <= 0 || w.ExePath == "" {
		return desktop.Foreground{}, errNoProcess
	}
	if cw, ok := windowOf(pid, p); ok {
		w.ID, w.Title = cw.id, cw.title
	}
	return w, nil
}

func (*Desktop) FullscreenActive(own []desktop.WindowID) (bool, error) {
	w, ok := frontWindow()
	if !ok || w.bounds == nil || w.pid == os.Getpid() || slices.Contains(own, w.id) {
		return false, nil
	}
	b := *w.bounds
	for _, d := range mygo.Screen.Displays() {
		r := d.Bounds
		if b.X <= r.X && b.Y <= r.Y && b.X+b.Width >= r.X+r.Width && b.Y+b.Height >= r.Y+r.Height {
			return true, nil
		}
	}
	return false, nil
}

var errNoWindow = errors.New("window is not on screen")

func (*Desktop) WindowOrigin(id desktop.WindowID) (desktop.Point, error) {
	list := windowList(listIncludingWindow, id)
	if len(list) == 0 || list[0].bounds == nil {
		return desktop.Point{}, errNoWindow
	}
	return desktop.Point{X: float64(list[0].bounds.X), Y: float64(list[0].bounds.Y)}, nil
}

const (
	eventSourceCombined = 0
	mouseLeft           = 0
	mouseRight          = 1
	mouseCenter         = 2
)

func (*Desktop) Cursor() desktop.Point {
	load()
	e := cgEventCreate(0)
	if e == 0 {
		return desktop.Point{}
	}
	defer cfRelease(e)
	p := cgEventGetLocation(e)
	return desktop.Point{X: p.X, Y: p.Y}
}

func (*Desktop) ButtonDown() bool {
	load()
	for _, b := range []uint32{mouseLeft, mouseRight, mouseCenter} {
		if cgEventSourceButtonState(eventSourceCombined, b) {
			return true
		}
	}
	return false
}

// windowOf is the frontmost window of process pid that holds p.
func windowOf(pid int, p desktop.Point) (cgWindow, bool) {
	for _, w := range windowList(listOnScreenOnly|listExcludeDesktopEls, 0) {
		if w.pid != pid || w.bounds == nil {
			continue
		}
		b := w.bounds
		if p.X >= float64(b.X) && p.Y >= float64(b.Y) && p.X < float64(b.X+b.Width) && p.Y < float64(b.Y+b.Height) {
			return w, true
		}
	}
	return cgWindow{}, false
}

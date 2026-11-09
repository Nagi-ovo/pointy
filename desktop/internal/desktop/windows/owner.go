//go:build windows

package windows

import (
	"errors"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"golang.org/x/sys/windows"
)

var (
	procSetWindowLongPtrW = user32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procSetLastError      = kernel32.NewProc("SetLastError")
)

// GWLP_HWNDPARENT and GWL_EXSTYLE, negative indices as uintptr.
const (
	gwlpHwndParent = ^uintptr(7)
	gwlExStyle     = ^uintptr(19)
)

var errNoWindow = errors.New("windows: the window is gone")

func (*Desktop) WindowID(w *mygo.Window) desktop.WindowID {
	return desktop.WindowID(w.NativeHandle())
}

// AttachToOwner makes the card a window owned by owner's top-level window:
// Windows keeps it above that window, hides it behind whatever covers that
// window, and brings it back with it.
func (*Desktop) AttachToOwner(w *mygo.Window, owner desktop.WindowID) error {
	var root uintptr
	if owner != 0 {
		if root = uintptr(rootOf(windows.HWND(owner))); root == 0 {
			return errNoWindow
		}
	}
	w.SetAlwaysOnTop(false)
	var err error
	mygo.RunOnMain(func() { err = setWindowLong(w.NativeHandle(), gwlpHwndParent, root) })
	return err
}

// setWindowLong tells a failure from a previous value of 0 by the last
// error, as SetWindowLongPtr's documentation asks.
func setWindowLong(h, index, value uintptr) error {
	procSetLastError.Call(0)
	prev, _, e := procSetWindowLongPtrW.Call(h, index, value)
	if errno, ok := e.(windows.Errno); prev == 0 && ok && errno != 0 {
		return errno
	}
	return nil
}

func getWindowLong(h, index uintptr) uintptr {
	v, _, _ := procGetWindowLongPtrW.Call(h, index)
	return v
}

func (*Desktop) WindowOrigin(id desktop.WindowID) (desktop.Point, error) {
	root := rootOf(windows.HWND(id))
	if root == 0 || !windows.IsWindow(root) {
		return desktop.Point{}, errNoWindow
	}
	r, ok := windowRect(root)
	if !ok {
		return desktop.Point{}, errNoWindow
	}
	return desktop.Point{X: float64(r.Left), Y: float64(r.Top)}, nil
}

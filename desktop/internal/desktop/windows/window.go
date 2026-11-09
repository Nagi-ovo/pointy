//go:build windows

package windows

import (
	"fmt"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var (
	procSetWindowPos              = user32.NewProc("SetWindowPos")
	procCreateRectRgn             = gdi32.NewProc("CreateRectRgn")
	procDeleteObject              = gdi32.NewProc("DeleteObject")
	procDwmEnableBlurBehindWindow = dwmapi.NewProc("DwmEnableBlurBehindWindow")
)

const (
	hwndTopmost      = ^uintptr(0)
	swpNoSize        = 0x0001
	swpNoMove        = 0x0002
	swpNoZOrder      = 0x0004
	swpNoActivate    = 0x0010
	swpFrameChanged  = 0x0020
	wsExNoActivate   = 0x08000000
	dwmBBEnable      = 0x1
	dwmBBBlurRegion  = 0x2
	emptyRegionRight = ^uintptr(0)
)

// transparencyFix is how a window shows what is behind the transparent
// parts of its page. mygo v0.8.3 gives a page window a redirection bitmap,
// which DWM draws opaque, so its corners would show black.
type transparencyFix int

const (
	// stockWindow keeps mygo's window as it is (variant A of
	// pointylab/pointy#9).
	stockWindow transparencyFix = iota
	// blurBehind clears the window's background and turns on DWM's blur
	// behind an empty region, which makes DWM honor the alpha of the
	// window's surface without blurring anything: winit's and tao's fix
	// (variant B of #9). It needs nothing from inside mygo.
	blurBehind
)

// transparency is the fix every Pointy window gets. Variant C of #9, a
// window of native UI holding a transparent web view, cannot be applied
// from here: it changes how internal/ui creates windows.
const transparency = blurBehind

func (*Desktop) PrepareWindow(w *mygo.Window) error {
	if transparency == stockWindow {
		return nil
	}
	if err := w.SetBackgroundColor("transparent"); err != nil {
		return err
	}
	var err error
	mygo.RunOnMain(func() { err = enableBlurBehind(w.NativeHandle()) })
	return err
}

type dwmBlurBehind struct {
	Flags                 uint32
	Enable                int32
	RgnBlur               uintptr
	TransitionOnMaximized int32
}

func enableBlurBehind(h uintptr) error {
	if err := procDwmEnableBlurBehindWindow.Find(); err != nil {
		return err
	}
	rgn, _, _ := procCreateRectRgn.Call(0, 0, emptyRegionRight, emptyRegionRight)
	defer procDeleteObject.Call(rgn)
	bb := dwmBlurBehind{Flags: dwmBBEnable | dwmBBBlurRegion, Enable: 1, RgnBlur: rgn}
	if hr, _, _ := procDwmEnableBlurBehindWindow.Call(h, uintptr(unsafe.Pointer(&bb))); int32(hr) < 0 {
		return fmt.Errorf("DwmEnableBlurBehindWindow: 0x%08x", uint32(hr))
	}
	return nil
}

// SetLevel: Windows has one band of topmost windows. A window of the
// screen-saver level is raised to the top of it, above the taskbar.
func (*Desktop) SetLevel(w *mygo.Window, l desktop.Level) error {
	w.SetAlwaysOnTop(true)
	if l == desktop.LevelScreenSaver {
		mygo.RunOnMain(func() {
			procSetWindowPos.Call(w.NativeHandle(), hwndTopmost, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
		})
	}
	return nil
}

// SetFocusable false gives the window WS_EX_NOACTIVATE: clicks and showing
// it never take the keyboard from the app the user works in.
func (*Desktop) SetFocusable(w *mygo.Window, focusable bool) error {
	var err error
	mygo.RunOnMain(func() {
		h := w.NativeHandle()
		ex := getWindowLong(h, gwlExStyle)
		if focusable {
			ex &^= wsExNoActivate
		} else {
			ex |= wsExNoActivate
		}
		if err = setWindowLong(h, gwlExStyle, ex); err == nil {
			procSetWindowPos.Call(h, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)
		}
	})
	return err
}

package main

import (
	"fmt"
	"hash/fnv"
	"image"
	"strings"
	"syscall"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	win "github.com/pointylab/pointy/desktop/internal/desktop/windows"
	win32 "golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	user32                = win32.NewLazySystemDLL("user32.dll")
	gdi32                 = win32.NewLazySystemDLL("gdi32.dll")
	procGetWindowRect     = user32.NewProc("GetWindowRect")
	procGetAncestor       = user32.NewProc("GetAncestor")
	procGetWindow         = user32.NewProc("GetWindow")
	procWindowFromPoint   = user32.NewProc("WindowFromPoint")
	procGetWindowLongPtrW = user32.NewProc("GetWindowLongPtrW")
	procEnumChildWindows  = user32.NewProc("EnumChildWindows")
	procSendMessageW      = user32.NewProc("SendMessageW")
	procSetCursorPos      = user32.NewProc("SetCursorPos")
	procSendInput         = user32.NewProc("SendInput")
	procLoadCursorW       = user32.NewProc("LoadCursorW")
	procGetIconInfo       = user32.NewProc("GetIconInfo")
	procGetDpiForSystem   = user32.NewProc("GetDpiForSystem")
	procGetBitmapBits     = gdi32.NewProc("GetBitmapBits")
	procDeleteObject      = gdi32.NewProc("DeleteObject")
)

const (
	gaRoot          = 2
	gwOwner         = 4
	emGetSel        = 0x00B0
	emSetSel        = 0x00B1
	inputMouse      = 0
	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseWheel      = 0x0800
	idcArrow        = 32512
	gwlExStyleIndex = ^uintptr(19)
)

type winDriver struct{}

func newSelfDriver() selfDriver { return winDriver{} }

type wrect struct{ Left, Top, Right, Bottom int32 }

func pointArg(p desktop.Point) uintptr {
	return uintptr(uint32(int32(p.X))) | uintptr(uint32(int32(p.Y)))<<32
}

func regValue(path, name string) string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE)
	if err != nil {
		return "?"
	}
	defer k.Close()
	if s, _, err := k.GetStringValue(name); err == nil {
		return s
	}
	return "?"
}

func (winDriver) info() []string {
	v := win32.RtlGetVersion()
	cv := `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	dpi, _, _ := procGetDpiForSystem.Call()
	webview := regValue(`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, "pv")
	return []string{
		fmt.Sprintf("Windows %d.%d build %d, %s %s", v.MajorVersion, v.MinorVersion, v.BuildNumber, regValue(cv, "ProductName"), regValue(cv, "DisplayVersion")),
		fmt.Sprintf("system DPI %d, WebView2 runtime %s", dpi, webview),
	}
}

func (winDriver) windowRect(id desktop.WindowID) (desktop.Rect, bool) {
	var r wrect
	ok, _, _ := procGetWindowRect.Call(uintptr(id), uintptr(unsafe.Pointer(&r)))
	return desktop.Rect{int(r.Left), int(r.Top), int(r.Right - r.Left), int(r.Bottom - r.Top)}, ok != 0
}

func (winDriver) rootOf(id desktop.WindowID) desktop.WindowID {
	r, _, _ := procGetAncestor.Call(uintptr(id), gaRoot)
	return desktop.WindowID(r)
}

func (winDriver) ownerOf(w *mygo.Window) desktop.WindowID {
	var o uintptr
	mygo.RunOnMain(func() { o, _, _ = procGetWindow.Call(w.NativeHandle(), gwOwner) })
	return desktop.WindowID(o)
}

func (d winDriver) windowAt(p desktop.Point) desktop.WindowID {
	h, _, _ := procWindowFromPoint.Call(pointArg(p))
	return d.rootOf(desktop.WindowID(h))
}

func (winDriver) style(w *mygo.Window) string {
	var ex uintptr
	mygo.RunOnMain(func() { ex, _, _ = procGetWindowLongPtrW.Call(w.NativeHandle(), gwlExStyleIndex) })
	var names []string
	for _, f := range []struct {
		bit  uintptr
		name string
	}{{0x08000000, "NOACTIVATE"}, {0x80, "TOOLWINDOW"}, {0x8, "TOPMOST"}, {0x80000, "LAYERED"}, {0x20, "TRANSPARENT"}, {0x200000, "NOREDIRECTIONBITMAP"}} {
		if ex&f.bit != 0 {
			names = append(names, f.name)
		}
	}
	return fmt.Sprintf("ex style %#08x %s", ex, strings.Join(names, "|"))
}

// editClasses are the text controls of classic and Windows 11 Notepad.
var editClasses = map[string]bool{"Edit": true, "RichEditD2DPT": true, "RICHEDIT50W": true}

var (
	foundEdit uintptr
	childProc = syscall.NewCallback(func(h, _ uintptr) uintptr {
		var buf [64]uint16
		n, _ := win32.GetClassName(win32.HWND(h), &buf[0], int32(len(buf)))
		if editClasses[win32.UTF16ToString(buf[:n])] {
			foundEdit = h
			return 0
		}
		return 1
	})
)

// edit is the target's text control. The self-check calls it from one
// goroutine at a time.
func edit(target desktop.WindowID) uintptr {
	foundEdit = 0
	procEnumChildWindows.Call(uintptr(target), childProc, 0)
	return foundEdit
}

func (winDriver) selection(target desktop.WindowID) (int, int, bool) {
	e := edit(target)
	if e == 0 {
		return 0, 0, false
	}
	r, _, _ := procSendMessageW.Call(e, emGetSel, 0, 0)
	return int(r & 0xFFFF), int(r >> 16 & 0xFFFF), true
}

func (winDriver) setSelection(target desktop.WindowID, start, end int) bool {
	e := edit(target)
	if e == 0 {
		return false
	}
	procSendMessageW.Call(e, emSetSel, uintptr(start), uintptr(end))
	return true
}

// mouseInput is INPUT holding a MOUSEINPUT on 64-bit Windows.
type mouseInput struct {
	Type      uint32
	_         uint32
	Dx, Dy    int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	_         uint32
	ExtraInfo uintptr
}

func send(flags ...[2]uint32) error {
	in := make([]mouseInput, len(flags))
	for i, f := range flags {
		in[i] = mouseInput{Type: inputMouse, Flags: f[0], MouseData: f[1]}
	}
	n, _, err := procSendInput.Call(uintptr(len(in)), uintptr(unsafe.Pointer(&in[0])), unsafe.Sizeof(in[0]))
	if int(n) != len(in) {
		return err
	}
	return nil
}

func moveTo(p desktop.Point) error {
	if ok, _, err := procSetCursorPos.Call(uintptr(int32(p.X)), uintptr(int32(p.Y))); ok == 0 {
		return err
	}
	return nil
}

func (winDriver) move(p desktop.Point) error { return moveTo(p) }

func (winDriver) screen(r desktop.Rect) (image.Image, error) { return win.CaptureScreen(r) }

func (winDriver) click(p desktop.Point, right bool) error {
	if err := moveTo(p); err != nil {
		return err
	}
	if right {
		return send([2]uint32{mouseRightDown}, [2]uint32{mouseRightUp})
	}
	return send([2]uint32{mouseLeftDown}, [2]uint32{mouseLeftUp})
}

func (winDriver) wheel(p desktop.Point, delta int) error {
	if err := moveTo(p); err != nil {
		return err
	}
	return send([2]uint32{mouseWheel, uint32(int32(delta))})
}

// cursorFingerprint hashes the bitmaps of the system arrow, which
// SetSystemCursor replaces in place.
func (winDriver) cursorFingerprint() string {
	h, _, _ := procLoadCursorW.Call(0, idcArrow)
	var info struct {
		Icon            int32
		HotX, HotY      uint32
		_               uint32
		Mask, ColorBits uintptr
	}
	if ok, _, _ := procGetIconInfo.Call(h, uintptr(unsafe.Pointer(&info))); ok == 0 {
		return "unreadable"
	}
	sum := fnv.New64a()
	for _, bmp := range []uintptr{info.Mask, info.ColorBits} {
		if bmp == 0 {
			continue
		}
		buf := make([]byte, 1<<16)
		n, _, _ := procGetBitmapBits.Call(bmp, uintptr(len(buf)), uintptr(unsafe.Pointer(&buf[0])))
		sum.Write(buf[:n])
		procDeleteObject.Call(bmp)
	}
	return fmt.Sprintf("%016x", sum.Sum64())
}

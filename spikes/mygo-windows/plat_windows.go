//go:build windows

package main

import (
	"errors"
	"fmt"
	"image"
	"os"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/outputduplication"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	pGetWindowLongPtrW   = user32.NewProc("GetWindowLongPtrW")
	pSetWindowLongPtrW   = user32.NewProc("SetWindowLongPtrW")
	pGetWindow           = user32.NewProc("GetWindow")
	pGetAncestor         = user32.NewProc("GetAncestor")
	pWindowFromPoint     = user32.NewProc("WindowFromPoint")
	pGetClientRect       = user32.NewProc("GetClientRect")
	pClientToScreen      = user32.NewProc("ClientToScreen")
	pGetWindowTextW      = user32.NewProc("GetWindowTextW")
	pGetDpiForWindow     = user32.NewProc("GetDpiForWindow")
	pGetDpiForSystem     = user32.NewProc("GetDpiForSystem")
	pGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	pSetWindowPos        = user32.NewProc("SetWindowPos")
	pShowWindow          = user32.NewProc("ShowWindow")
	pUpdateWindow        = user32.NewProc("UpdateWindow")
	pDestroyWindow       = user32.NewProc("DestroyWindow")
	pCreateWindowExW     = user32.NewProc("CreateWindowExW")
	pRegisterClassExW    = user32.NewProc("RegisterClassExW")
	pDefWindowProcW      = user32.NewProc("DefWindowProcW")
	pGetDC               = user32.NewProc("GetDC")
	pReleaseDC           = user32.NewProc("ReleaseDC")
	pCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection    = gdi32.NewProc("CreateDIBSection")
	pSelectObject        = gdi32.NewProc("SelectObject")
	pBitBlt              = gdi32.NewProc("BitBlt")
	pDeleteObject        = gdi32.NewProc("DeleteObject")
	pDeleteDC            = gdi32.NewProc("DeleteDC")
	pCreateSolidBrush    = gdi32.NewProc("CreateSolidBrush")
	pCreateRectRgn       = gdi32.NewProc("CreateRectRgn")
	pDwmEnableBlurBehind = dwmapi.NewProc("DwmEnableBlurBehindWindow")
	pDwmIsComposition    = dwmapi.NewProc("DwmIsCompositionEnabled")
	pSetLastError        = kernel32.NewProc("SetLastError")
	pGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
)

const (
	gwlExStyle     = ^uintptr(19) // -20
	gwlpHwndParent = ^uintptr(7)  // -8
	gwOwner        = 4
	gaRoot         = 2

	wsPopup         = 0x80000000
	wsExNoActivate  = 0x08000000
	wsExToolWindow  = 0x00000080
	wsExTopmost     = 0x00000008
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	wsExNoRedirect  = 0x00200000

	swpNoSize         = 0x0001
	swpNoMove         = 0x0002
	swpNoZOrder       = 0x0004
	swpNoActivate     = 0x0010
	swpFrameChanged   = 0x0020
	swShowNoActivate  = 4
	srcCopyCaptureBlt = 0x00CC0020 | 0x40000000
)

func platformInit() {}

func foreground() uintptr { return uintptr(windows.GetForegroundWindow()) }

func windowInfo(h uintptr) string {
	if h == 0 {
		return "none(0)"
	}
	cls := make([]uint16, 256)
	windows.GetClassName(windows.HWND(h), &cls[0], int32(len(cls)))
	title := make([]uint16, 128)
	pGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&title[0])), uintptr(len(title)))
	var pid uint32
	windows.GetWindowThreadProcessId(windows.HWND(h), &pid)
	who := "other process"
	if int(pid) == os.Getpid() {
		who = "OURS"
	}
	if h == backdropHwnd {
		who = "OURS: green backdrop"
	}
	return fmt.Sprintf("0x%x class=%q title=%q pid=%d (%s)", h, windows.UTF16ToString(cls), windows.UTF16ToString(title), pid, who)
}

func regString(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return "(no key)"
	}
	defer k.Close()
	if s, _, err := k.GetStringValue(name); err == nil {
		return s
	}
	if v, _, err := k.GetIntegerValue(name); err == nil {
		return fmt.Sprint(v)
	}
	return "(no value)"
}

func sysInfo() []string {
	v := windows.RtlGetVersion()
	cv := `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	lines := []string{
		fmt.Sprintf("Windows NT %d.%d build %d (RtlGetVersion); Windows 11 if build >= 22000", v.MajorVersion, v.MinorVersion, v.BuildNumber),
		fmt.Sprintf("ProductName=%s DisplayVersion=%s EditionID=%s CurrentBuild=%s UBR=%s",
			regString(registry.LOCAL_MACHINE, cv, "ProductName"), regString(registry.LOCAL_MACHINE, cv, "DisplayVersion"),
			regString(registry.LOCAL_MACHINE, cv, "EditionID"), regString(registry.LOCAL_MACHINE, cv, "CurrentBuild"),
			regString(registry.LOCAL_MACHINE, cv, "UBR")),
	}
	var pm, nm uint16
	if err := windows.IsWow64Process2(windows.CurrentProcess(), &pm, &nm); err == nil {
		lines = append(lines, fmt.Sprintf("exe arch %s, native machine 0x%x (0x8664 x64, 0xAA64 arm64), process machine 0x%x", runtime.GOARCH, nm, pm))
	}
	guid := `{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	lines = append(lines, "WebView2 runtime pv: HKLM WOW6432Node="+regString(registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\`+guid, "pv")+
		", HKLM="+regString(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\EdgeUpdate\Clients\`+guid, "pv")+
		", HKCU="+regString(registry.CURRENT_USER, `Software\Microsoft\EdgeUpdate\Clients\`+guid, "pv"))
	dpi := uintptr(0)
	if pGetDpiForSystem.Find() == nil {
		dpi, _, _ = pGetDpiForSystem.Call()
	}
	sm := func(i uintptr) int { r, _, _ := pGetSystemMetrics.Call(i); return int(int32(r)) }
	var comp int32
	if pDwmIsComposition.Find() == nil {
		pDwmIsComposition.Call(uintptr(unsafe.Pointer(&comp)))
	}
	lines = append(lines,
		fmt.Sprintf("system DPI %d (scale %.2f), monitors %d, virtual screen %d,%d %dx%d, remote session %v, DWM composition %v",
			dpi, float64(dpi)/96, sm(80), sm(76), sm(77), sm(78), sm(79), sm(0x1000) != 0, comp != 0),
		"transparency effects (Personalize\\EnableTransparency)="+regString(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, "EnableTransparency"),
	)
	return lines
}

func screenScale(d mygo.Display) float64 {
	if d.ScaleFactor > 0 {
		return d.ScaleFactor
	}
	if pGetDpiForSystem.Find() == nil {
		dpi, _, _ := pGetDpiForSystem.Call()
		return float64(dpi) / 96
	}
	return 1
}

// ---------------------------------------------------------------- backdrop

var backdropHwnd uintptr

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

// newBackdrop shows a plain GDI window filled with c: the known "desktop"
// that transparent pixels must show. Main thread only.
func newBackdrop(r prect, c rgb) func() {
	inst, _, _ := pGetModuleHandleW.Call(0)
	brush, _, _ := pCreateSolidBrush.Call(uintptr(c.R) | uintptr(c.G)<<8 | uintptr(c.B)<<16)
	name, _ := windows.UTF16PtrFromString("PointyTestBackdrop")
	wc := wndClassEx{WndProc: pDefWindowProcW.Addr(), Instance: inst, Background: brush, ClassName: name}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	title, _ := windows.UTF16PtrFromString("Pointy test backdrop")
	h, _, err := pCreateWindowExW.Call(wsExToolWindow|wsExNoActivate, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(title)), wsPopup,
		uintptr(r.L), uintptr(r.T), uintptr(r.W()), uintptr(r.H()), 0, 0, inst, 0)
	if h == 0 {
		out.add("CreateWindowExW backdrop: %v", err)
		return nil
	}
	backdropHwnd = h
	pShowWindow.Call(h, swShowNoActivate)
	pUpdateWindow.Call(h)
	return func() { pDestroyWindow.Call(h); backdropHwnd = 0 }
}

// raise puts w on top of the other windows of its band, without activating it.
func raise(w *mygo.Window) {
	pSetWindowPos.Call(w.NativeHandle(), 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

// placeBelow puts the backdrop right under w.
func placeBelow(w *mygo.Window) {
	if backdropHwnd != 0 {
		pSetWindowPos.Call(backdropHwnd, w.NativeHandle(), 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
}

// ---------------------------------------------------------------- window state

func noActivate(w *mygo.Window) {
	h := w.NativeHandle()
	ex, _, _ := pGetWindowLongPtrW.Call(h, gwlExStyle)
	pSetWindowLongPtrW.Call(h, gwlExStyle, ex|wsExNoActivate|wsExToolWindow)
	pSetWindowPos.Call(h, 0, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)
}

func exStyle(w *mygo.Window) string {
	ex, _, _ := pGetWindowLongPtrW.Call(w.NativeHandle(), gwlExStyle)
	var f []string
	for _, b := range []struct {
		bit  uintptr
		name string
	}{{wsExNoActivate, "NOACTIVATE"}, {wsExToolWindow, "TOOLWINDOW"}, {wsExTopmost, "TOPMOST"}, {wsExLayered, "LAYERED"}, {wsExTransparent, "TRANSPARENT"}, {wsExNoRedirect, "NOREDIRECTIONBITMAP"}} {
		if ex&b.bit != 0 {
			f = append(f, b.name)
		}
	}
	return fmt.Sprintf("0x%08x %s", ex, strings.Join(f, "|"))
}

type dwmBlurBehind struct {
	Flags                 uint32
	Enable                int32
	RgnBlur               uintptr
	TransitionOnMaximized int32
}

// blurBehind is the transparency fix winit and tao use for windows with a
// redirection bitmap: blur behind an empty region makes DWM honor the
// alpha of the window's surface without blurring anything.
func blurBehind(w *mygo.Window) string {
	if pDwmEnableBlurBehind.Find() != nil {
		return "DwmEnableBlurBehindWindow missing"
	}
	rgn, _, _ := pCreateRectRgn.Call(0, 0, ^uintptr(0), ^uintptr(0))
	bb := dwmBlurBehind{Flags: 1 | 2, Enable: 1, RgnBlur: rgn}
	hr, _, _ := pDwmEnableBlurBehind.Call(w.NativeHandle(), uintptr(unsafe.Pointer(&bb)))
	pDeleteObject.Call(rgn)
	return fmt.Sprintf("DwmEnableBlurBehindWindow hr=0x%08x", uint32(hr))
}

func setOwner(w *mygo.Window, owner uintptr) (ok bool, detail string) {
	if owner == 0 {
		return false, "no foreground window at start"
	}
	onMain("setOwner", func() {
		h := w.NativeHandle()
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		pSetLastError.Call(0)
		prev, _, e := pSetWindowLongPtrW.Call(h, gwlpHwndParent, owner)
		errno, _ := e.(windows.Errno)
		got, _, _ := pGetWindow.Call(h, gwOwner)
		ok = got == owner && (prev != 0 || errno == 0)
		detail = fmt.Sprintf("owner %s; previous 0x%x, GetLastError %d, GetWindow(GW_OWNER)=0x%x", windowInfo(owner), prev, uint32(errno), got)
	})
	return ok, detail
}

func clientRect(w *mygo.Window) prect {
	h := w.NativeHandle()
	var r struct{ L, T, R, B int32 }
	pGetClientRect.Call(h, uintptr(unsafe.Pointer(&r)))
	p := struct{ X, Y int32 }{}
	pClientToScreen.Call(h, uintptr(unsafe.Pointer(&p)))
	return prect{int(p.X), int(p.Y), int(p.X + r.R), int(p.Y + r.B)}
}

func dpiOf(w *mygo.Window) int {
	if pGetDpiForWindow.Find() != nil {
		return 0
	}
	d, _, _ := pGetDpiForWindow.Call(w.NativeHandle())
	return int(d)
}

func hitTest(x, y int, overlay *mygo.Window) (bool, string) {
	h, _, _ := pWindowFromPoint.Call(uintptr(uint32(int32(x))) | uintptr(uint32(int32(y)))<<32)
	root, _, _ := pGetAncestor.Call(h, gaRoot)
	ok := h != 0 && root != overlay.NativeHandle()
	return ok, fmt.Sprintf("root %s", windowInfo(root))
}

// ---------------------------------------------------------------- capture

type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// capture reads the screen rectangle with GDI: BitBlt from the screen DC
// with CAPTUREBLT, which includes layered windows.
func capture(r prect) (shot, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	w, h := r.W(), r.H()
	if w <= 0 || h <= 0 {
		return shot{}, errors.New("empty rect")
	}
	screen, _, _ := pGetDC.Call(0)
	if screen == 0 {
		return shot{}, errors.New("GetDC(0) failed")
	}
	defer pReleaseDC.Call(0, screen)
	mem, _, _ := pCreateCompatibleDC.Call(screen)
	defer pDeleteDC.Call(mem)
	bi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	var bits unsafe.Pointer
	bmp, _, err := pCreateDIBSection.Call(screen, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		return shot{}, fmt.Errorf("CreateDIBSection: %v", err)
	}
	defer pDeleteObject.Call(bmp)
	old, _, _ := pSelectObject.Call(mem, bmp)
	ok, _, err := pBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(r.L), uintptr(r.T), srcCopyCaptureBlt)
	pSelectObject.Call(mem, old)
	if ok == 0 {
		return shot{}, fmt.Errorf("BitBlt: %v", err)
	}
	src := unsafe.Slice((*byte)(bits), w*h*4)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		img.Pix[i*4], img.Pix[i*4+1], img.Pix[i*4+2], img.Pix[i*4+3] = src[i*4+2], src[i*4+1], src[i*4], 255
	}
	return shot{img, r}, nil
}

// captureDXGI reads the screen through DXGI desktop duplication, a second
// path that does not go through GDI, to cross-check capture.
func captureDXGI(r prect) (res shot, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	device, ctx, err := d3d11.NewD3D11Device()
	if err != nil {
		return shot{}, err
	}
	defer device.Release()
	defer ctx.Release()
	var last error = errors.New("no output contains the area")
	for o := uint(0); o < 8; o++ {
		dup, err := outputduplication.NewIDXGIOutputDuplication(device, ctx, o)
		if err != nil {
			last = err
			continue
		}
		b, err := dup.GetBounds()
		if err != nil || r.L < b.Min.X || r.T < b.Min.Y || r.R > b.Max.X || r.B > b.Max.Y {
			dup.Release()
			continue
		}
		img := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
		for try := 0; try < 15; try++ {
			if err = dup.GetImage(img, 200); err == nil {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		dup.Release()
		if err != nil {
			return shot{}, err
		}
		return shot{img, prect{b.Min.X, b.Min.Y, b.Max.X, b.Max.Y}}, nil
	}
	return shot{}, last
}

func showMessage(title, text string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	windows.MessageBox(0, m, t, 0x40|0x40000|0x10000) // MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND
}

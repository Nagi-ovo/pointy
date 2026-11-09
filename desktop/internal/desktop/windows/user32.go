//go:build windows

package windows

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	shcore   = windows.NewLazySystemDLL("shcore.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procGetWindowTextW               = user32.NewProc("GetWindowTextW")
	procGetAncestor                  = user32.NewProc("GetAncestor")
	procWindowFromPoint              = user32.NewProc("WindowFromPoint")
	procGetWindowRect                = user32.NewProc("GetWindowRect")
	procMonitorFromWindow            = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW              = user32.NewProc("GetMonitorInfoW")
	procEnumDisplayMonitors          = user32.NewProc("EnumDisplayMonitors")
	procGetDpiForSystem              = user32.NewProc("GetDpiForSystem")
	procGetCursorPos                 = user32.NewProc("GetCursorPos")
	procGetCursorInfo                = user32.NewProc("GetCursorInfo")
	procGetAsyncKeyState             = user32.NewProc("GetAsyncKeyState")
	procAllowSetForegroundWindow     = user32.NewProc("AllowSetForegroundWindow")
	procSHQueryUserNotificationState = shell32.NewProc("SHQueryUserNotificationState")
	procGetDpiForMonitor             = shcore.NewProc("GetDpiForMonitor")
)

const (
	gaRoot                  = 2
	monitorDefaultToNearest = 2
	cursorShowing           = 1
	vkLButton               = 1
	vkRButton               = 2
	vkMButton               = 4
	asfwAny                 = 0xFFFFFFFF
)

type rect struct{ Left, Top, Right, Bottom int32 }

func (r rect) desktop() desktop.Rect {
	return desktop.Rect{int(r.Left), int(r.Top), int(r.Right - r.Left), int(r.Bottom - r.Top)}
}

type point struct{ X, Y int32 }

// byValue passes a POINT by value: on amd64 and arm64, the only targets
// mygo has on Windows, its eight bytes go in one register.
func (p point) byValue() uintptr { return uintptr(uint32(p.X)) | uintptr(uint32(p.Y))<<32 }

type monitorInfo struct {
	Size    uint32
	Monitor rect
	Work    rect
	Flags   uint32
}

func windowText(h windows.HWND) string {
	var buf [512]uint16
	n, _, _ := procGetWindowTextW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

func className(h windows.HWND) string {
	var buf [256]uint16
	n, _ := windows.GetClassName(h, &buf[0], int32(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

func rootOf(h windows.HWND) windows.HWND {
	r, _, _ := procGetAncestor.Call(uintptr(h), gaRoot)
	return windows.HWND(r)
}

func windowRect(h windows.HWND) (rect, bool) {
	var r rect
	ok, _, _ := procGetWindowRect.Call(uintptr(h), uintptr(unsafe.Pointer(&r)))
	return r, ok != 0
}

func monitorRectOf(h windows.HWND) (rect, bool) {
	m, _, _ := procMonitorFromWindow.Call(uintptr(h), monitorDefaultToNearest)
	info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	ok, _, _ := procGetMonitorInfoW.Call(m, uintptr(unsafe.Pointer(&info)))
	return info.Monitor, ok != 0
}

func cursorPos() (point, bool) {
	var p point
	ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	return p, ok != 0
}

func processOf(h windows.HWND) uint32 {
	var pid uint32
	windows.GetWindowThreadProcessId(h, &pid)
	return pid
}

func processPath(pid uint32) string {
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(p)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(p, 0, &buf[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func elevated(pid uint32) bool {
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(p)
	var t windows.Token
	if windows.OpenProcessToken(p, windows.TOKEN_QUERY, &t) != nil {
		return false
	}
	defer t.Close()
	return t.IsElevated()
}

func notificationState() int32 {
	var s int32
	if procSHQueryUserNotificationState.Find() != nil {
		return 0
	}
	if hr, _, _ := procSHQueryUserNotificationState.Call(uintptr(unsafe.Pointer(&s))); hr != 0 {
		return 0
	}
	return s
}

func (*Desktop) FullscreenActive(own []desktop.WindowID) (bool, error) {
	state := notificationState()
	fg := windows.GetForegroundWindow()
	skip := fg == 0 || slices.Contains(own, desktop.WindowID(fg))
	var class string
	var r, m rect
	if !skip {
		class = className(fg)
		var okR, okM bool
		r, okR = windowRect(fg)
		m, okM = monitorRectOf(fg)
		skip = !okR || !okM
	}
	return fullscreen(state, class, r.desktop(), m.desktop(), skip), nil
}

func (*Desktop) Foreground() (desktop.Foreground, error) {
	h := windows.GetForegroundWindow()
	if h == 0 {
		return desktop.Foreground{}, nil
	}
	pid := processOf(h)
	exe := processPath(pid)
	return desktop.Foreground{
		ID:      desktop.WindowID(h),
		Title:   windowText(h),
		PID:     int(pid),
		ExePath: exe,
		Exe:     strings.ToLower(filepath.Base(exe)),
	}, nil
}

var selfElevated = windows.GetCurrentProcessToken().IsElevated()

// ElevatedUnderCursor: Windows keeps a normal Pointy from reading an
// administrator's window, and its mouse hook gets no clicks there.
// An elevated Pointy reads it fine.
func (*Desktop) ElevatedUnderCursor() bool {
	if selfElevated {
		return false
	}
	p, ok := cursorPos()
	if !ok {
		return false
	}
	h, _, _ := procWindowFromPoint.Call(p.byValue())
	if h == 0 {
		return false
	}
	root := rootOf(windows.HWND(h))
	if root == 0 {
		root = windows.HWND(h)
	}
	pid := processOf(root)
	return pid != 0 && elevated(pid)
}

func (*Desktop) AllowAnyForeground() { procAllowSetForegroundWindow.Call(asfwAny) }

func (*Desktop) Cursor() desktop.Point {
	p, _ := cursorPos()
	return desktop.Point{X: float64(p.X), Y: float64(p.Y)}
}

func (*Desktop) CursorVisible() bool {
	var info struct {
		Size    uint32
		Flags   uint32
		Cursor  uintptr
		ScreenP point
	}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&info)))
	return ok != 0 && info.Flags&cursorShowing != 0
}

func (*Desktop) ButtonDown() bool {
	for _, vk := range []uintptr{vkLButton, vkRButton, vkMButton} {
		if r, _, _ := procGetAsyncKeyState.Call(vk); r&0x8000 != 0 {
			return true
		}
	}
	return false
}

// AccessHint is empty: Windows lets any app read others' controls.
func (*Desktop) AccessHint() string { return "" }

func (*Desktop) Browser(exe string) (desktop.BrowserKind, bool) {
	k, ok := browsers[exe]
	return k, ok
}

func (*Desktop) Blocked(exe string) bool { return blockedApps[exe] }

// Monitors are enumerated through one callback for the process's life:
// syscall.NewCallback slots are never freed.
var (
	monitorMu   sync.Mutex
	monitorSink func(uintptr)
	monitorProc = syscall.NewCallback(func(m, _, _, _ uintptr) uintptr {
		monitorSink(m)
		return 1
	})
)

func monitors() []monitor {
	monitorMu.Lock()
	defer monitorMu.Unlock()
	var out []monitor
	monitorSink = func(m uintptr) {
		info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
		if ok, _, _ := procGetMonitorInfoW.Call(m, uintptr(unsafe.Pointer(&info))); ok == 0 {
			return
		}
		r := info.Monitor
		out = append(out, monitor{bounds: mygo.Rectangle{X: int(r.Left), Y: int(r.Top), Width: int(r.Right - r.Left), Height: int(r.Bottom - r.Top)}, dpi: monitorDPI(m)})
	}
	procEnumDisplayMonitors.Call(0, 0, monitorProc, 0)
	monitorSink = nil
	return out
}

func monitorDPI(m uintptr) int {
	if procGetDpiForMonitor.Find() == nil {
		var dx, dy uint32
		if hr, _, _ := procGetDpiForMonitor.Call(m, 0, uintptr(unsafe.Pointer(&dx)), uintptr(unsafe.Pointer(&dy))); hr == 0 && dx != 0 {
			return int(dx)
		}
	}
	return systemDPI()
}

func systemDPI() int {
	if procGetDpiForSystem.Find() == nil {
		if d, _, _ := procGetDpiForSystem.Call(); d != 0 {
			return int(d)
		}
	}
	return 96
}

func space() dipSpace { return newDIPSpace(monitors(), systemDPI()) }

func (*Desktop) ToDIP(p desktop.Point) desktop.Point     { return space().pointToDIP(p) }
func (*Desktop) ToScreen(p desktop.Point) desktop.Point  { return space().pointToPixels(p) }
func (*Desktop) RectToDIP(r desktop.Rect) mygo.Rectangle { return space().rectToDIP(r) }
func (*Desktop) UnitsPerDIP(p desktop.Point) float64     { return space().unitsPerDIP(p) }

// RemoveAfterExit hands the deletion to PowerShell, which waits for this
// process to exit. It goes through cmd's start: a console child spawned
// directly closes when Pointy exits, as Electron's runtime found.
func (*Desktop) RemoveAfterExit(paths []string) error {
	cmdExe := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	c := exec.Command(cmdExe)
	c.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /d /c start "" /min powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ` + cleanupCommand(os.Getpid(), paths),
		HideWindow:    true,
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	if err := c.Start(); err != nil {
		return err
	}
	return c.Process.Release()
}

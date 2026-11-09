//go:build windows

package windows

import (
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"github.com/pointylab/pointy/desktop/internal/desktop"
	"golang.org/x/sys/windows"
)

var (
	procSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procPeekMessageW        = user32.NewProc("PeekMessageW")
	procPostThreadMessageW  = user32.NewProc("PostThreadMessageW")
	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
)

const (
	whMouseLL   = 14
	wmQuit      = 0x0012
	pmNoRemove  = 0
	hookBacklog = 16
)

var errHooked = errors.New("windows: the mouse is already hooked")

type msllHookStruct struct {
	Pt        point
	MouseData uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

// msg is MSG on 64-bit Windows.
type msg [48]byte

// hooked is the hook the callback serves, or nil. Windows unhooks a
// low-level hook that keeps it waiting, so the callback only reads this,
// decides by onMouse and posts without blocking.
var hooked atomic.Pointer[buttonHook]

// mouseProc is created once: syscall.NewCallback slots are never freed.
var mouseProc = syscall.NewCallback(func(code, wParam, lParam uintptr) uintptr {
	if h := hooked.Load(); h != nil && int32(code) >= 0 {
		m := *(**msllHookStruct)(unsafe.Pointer(&lParam))
		a := onMouse(uint32(wParam), m.MouseData, h.wheel.Load())
		if a.report {
			select {
			case h.events <- a.button:
			default:
			}
		}
		if a.swallow {
			return 1
		}
	}
	r, _, _ := procCallNextHookEx.Call(0, code, wParam, lParam)
	return r
})

// buttonHook is a WH_MOUSE_LL hook on its own locked thread, whose message
// loop Windows calls the hook from.
type buttonHook struct {
	events chan desktop.Button
	wheel  atomic.Bool
	tid    uint32
	done   chan struct{}
	close  sync.Once
}

func (*Desktop) HookButtons() (desktop.ButtonHook, error) {
	h := &buttonHook{events: make(chan desktop.Button, hookBacklog), done: make(chan struct{})}
	ready := make(chan error, 1)
	go h.run(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return h, nil
}

func (h *buttonHook) run(ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(h.done)
	if !hooked.CompareAndSwap(nil, h) {
		ready <- errHooked
		return
	}
	defer hooked.CompareAndSwap(h, nil)
	var m msg
	// The thread's message queue must exist before Close posts to it.
	procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, pmNoRemove)
	module, _, _ := procGetModuleHandleW.Call(0)
	hook, _, err := procSetWindowsHookExW.Call(whMouseLL, mouseProc, module, 0)
	if hook == 0 {
		ready <- err
		return
	}
	defer procUnhookWindowsHookEx.Call(hook)
	h.tid = windows.GetCurrentThreadId()
	ready <- nil
	for {
		if r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0); int32(r) <= 0 {
			return
		}
	}
}

func (h *buttonHook) Events() <-chan desktop.Button { return h.events }
func (h *buttonHook) SetWheel(v bool)               { h.wheel.Store(v) }

// Close unhooks and returns once the mouse is the other apps' again.
func (h *buttonHook) Close() {
	h.close.Do(func() {
		procPostThreadMessageW.Call(uintptr(h.tid), wmQuit, 0, 0)
		<-h.done
	})
}

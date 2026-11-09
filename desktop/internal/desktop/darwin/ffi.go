//go:build darwin

package darwin

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var (
	cfRelease                  func(uintptr)
	cgWindowListCopyWindowInfo func(option, relativeTo uint32) uintptr
	procPidpath                func(pid int32, buf *byte, size uint32) int32
	poolPush                   func() uintptr
	poolPop                    func(uintptr)
	classGetInstanceMethod     func(class uintptr, sel objc.SEL) uintptr
	methodGetTypeEncoding      func(method uintptr) uintptr
	methodGetImplementation    func(method uintptr) uintptr
	classReplaceMethod         func(class uintptr, sel objc.SEL, imp objc.IMP, types uintptr) uintptr
)

var loadOnce sync.Once

func load() {
	loadOnce.Do(func() {
		open := func(path string) uintptr {
			h, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				panic(err)
			}
			return h
		}
		cf := open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
		cg := open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		sys := open("/usr/lib/libSystem.B.dylib")
		rt := open("/usr/lib/libobjc.A.dylib")
		purego.RegisterLibFunc(&cfRelease, cf, "CFRelease")
		purego.RegisterLibFunc(&cgWindowListCopyWindowInfo, cg, "CGWindowListCopyWindowInfo")
		purego.RegisterLibFunc(&procPidpath, sys, "proc_pidpath")
		purego.RegisterLibFunc(&poolPush, rt, "objc_autoreleasePoolPush")
		purego.RegisterLibFunc(&poolPop, rt, "objc_autoreleasePoolPop")
		purego.RegisterLibFunc(&classGetInstanceMethod, rt, "class_getInstanceMethod")
		purego.RegisterLibFunc(&methodGetTypeEncoding, rt, "method_getTypeEncoding")
		purego.RegisterLibFunc(&methodGetImplementation, rt, "method_getImplementation")
		purego.RegisterLibFunc(&classReplaceMethod, rt, "class_replaceMethod")
	})
}

func sel(s string) objc.SEL  { return objc.RegisterName(s) }
func class(s string) objc.ID { return objc.ID(objc.GetClass(s)) }

// withPool drains the autoreleased objects fn makes, which a goroutine's
// thread has no pool for. The pool belongs to the thread, so the goroutine
// stays on it.
func withPool(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	p := poolPush()
	defer poolPop(p)
	fn()
}

func nsString(s string) objc.ID {
	b := append([]byte(s), 0)
	return class("NSString").Send(sel("stringWithUTF8String:"), unsafe.Pointer(&b[0]))
}

func goString(ns objc.ID) string {
	if ns == 0 {
		return ""
	}
	p := objc.Send[unsafe.Pointer](ns, sel("UTF8String"))
	if p == nil {
		return ""
	}
	n := 0
	for *(*byte)(unsafe.Add(p, n)) != 0 {
		n++
	}
	return string(unsafe.Slice((*byte)(p), n))
}

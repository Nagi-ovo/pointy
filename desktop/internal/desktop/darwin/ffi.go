//go:build darwin

package darwin

import (
	"runtime"
	"sync"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type cgPoint struct{ X, Y float64 }
type cgSize struct{ W, H float64 }
type cgRect struct {
	Origin cgPoint
	Size   cgSize
}
type cfRange struct{ Location, Length int }

var (
	cfRetain                      func(uintptr) uintptr
	cfRelease                     func(uintptr)
	cfGetTypeID                   func(uintptr) uint
	cfStringCreateWithCString     func(alloc uintptr, s string, encoding uint32) uintptr
	cfStringGetLength             func(uintptr) int
	cfStringGetCharacters         func(s uintptr, r cfRange, buf *uint16)
	cfArrayGetCount               func(uintptr) int
	cfArrayGetValueAtIndex        func(uintptr, int) uintptr
	cfURLGetString                func(uintptr) uintptr
	cfRunLoopGetMain              func() uintptr
	cfRunLoopAddSource            func(loop, source, mode uintptr)
	cfMachPortCreateRunLoopSource func(alloc, port uintptr, order int) uintptr

	axIsProcessTrustedWithOptions        func(options uintptr) bool
	axUIElementCreateSystemWide          func() uintptr
	axUIElementCreateApplication         func(pid int32) uintptr
	axUIElementCopyElementAtPosition     func(app uintptr, x, y float32, out *uintptr) int32
	axUIElementCopyAttributeValue        func(el, attr uintptr, out *uintptr) int32
	axUIElementCopyParameterizedAttr     func(el, attr, param uintptr, out *uintptr) int32
	axUIElementSetAttributeValue         func(el, attr, value uintptr) int32
	axUIElementGetPid                    func(el uintptr, pid *int32) int32
	axUIElementSetMessagingTimeout       func(el uintptr, seconds float32) int32
	axValueGetValue                      func(v uintptr, typ int32, out unsafe.Pointer) bool
	axValueCreate                        func(typ int32, value unsafe.Pointer) uintptr
	cgWindowListCopyWindowInfo           func(option, relativeTo uint32) uintptr
	cgEventCreate                        func(source uintptr) uintptr
	cgEventGetLocation                   func(event uintptr) cgPoint
	cgEventSourceButtonState             func(state int32, button uint32) bool
	cgEventTapCreate                     func(tap, place, options uint32, mask uint64, callback, refcon uintptr) uintptr
	cgEventTapEnable                     func(tap uintptr, enable bool)
	cgEventGetIntegerValueField          func(event uintptr, field uint32) int64
	cgsDefaultConnection                 func() int32
	cgsSetConnectionProperty             func(a, b int32, key, value uintptr) int32
	cgImageGetWidth                      func(uintptr) int
	cgImageGetHeight                     func(uintptr) int
	cgImageRelease                       func(uintptr)
	cgColorSpaceCreateWithName           func(name uintptr) uintptr
	cgColorSpaceRelease                  func(uintptr)
	cgBitmapContextCreate                func(data uintptr, w, h, bitsPerComponent, bytesPerRow int, space uintptr, info uint32) uintptr
	cgBitmapContextGetData               func(ctx uintptr) unsafe.Pointer
	cgContextDrawImage                   func(ctx uintptr, r cgRect, img uintptr)
	cgContextSetInterpolationQuality     func(ctx uintptr, q int32)
	cgContextRelease                     func(uintptr)
	cgWindowListCreateImage              func(r cgRect, option, window, imageOption uint32) uintptr
	procPidpath                          func(pid int32, buf *byte, size uint32) int32
	poolPush                             func() uintptr
	poolPop                              func(uintptr)
	classGetInstanceMethod               func(class uintptr, sel objc.SEL) uintptr
	methodGetTypeEncoding                func(method uintptr) uintptr
	methodGetImplementation              func(method uintptr) uintptr
	classReplaceMethod                   func(class uintptr, sel objc.SEL, imp objc.IMP, types uintptr) uintptr
	kCFRunLoopCommonModes                uintptr
	kCFBooleanTrue                       uintptr
	kAXTrustedCheckOptionPrompt          uintptr
	kCGColorSpaceSRGB                    uintptr
	cfStringType, cfArrayType, cfURLType uint
	axValueType, axElementType           uint
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
		constant := func(lib uintptr, name string) uintptr {
			p, err := purego.Dlsym(lib, name)
			if err != nil {
				panic(err)
			}
			return **(**uintptr)(unsafe.Pointer(&p))
		}
		cf := open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
		cg := open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
		as := open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
		sys := open("/usr/lib/libSystem.B.dylib")
		rt := open("/usr/lib/libobjc.A.dylib")
		open("/System/Library/Frameworks/AppKit.framework/AppKit")
		if _, err := purego.Dlopen("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit", purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
			screenCaptureKit = false
		}
		reg := purego.RegisterLibFunc
		reg(&cfRetain, cf, "CFRetain")
		reg(&cfRelease, cf, "CFRelease")
		reg(&cfGetTypeID, cf, "CFGetTypeID")
		reg(&cfStringCreateWithCString, cf, "CFStringCreateWithCString")
		reg(&cfStringGetLength, cf, "CFStringGetLength")
		reg(&cfStringGetCharacters, cf, "CFStringGetCharacters")
		reg(&cfArrayGetCount, cf, "CFArrayGetCount")
		reg(&cfArrayGetValueAtIndex, cf, "CFArrayGetValueAtIndex")
		reg(&cfURLGetString, cf, "CFURLGetString")
		reg(&cfRunLoopGetMain, cf, "CFRunLoopGetMain")
		reg(&cfRunLoopAddSource, cf, "CFRunLoopAddSource")
		reg(&cfMachPortCreateRunLoopSource, cf, "CFMachPortCreateRunLoopSource")
		reg(&axIsProcessTrustedWithOptions, as, "AXIsProcessTrustedWithOptions")
		reg(&axUIElementCreateSystemWide, as, "AXUIElementCreateSystemWide")
		reg(&axUIElementCreateApplication, as, "AXUIElementCreateApplication")
		reg(&axUIElementCopyElementAtPosition, as, "AXUIElementCopyElementAtPosition")
		reg(&axUIElementCopyAttributeValue, as, "AXUIElementCopyAttributeValue")
		reg(&axUIElementCopyParameterizedAttr, as, "AXUIElementCopyParameterizedAttributeValue")
		reg(&axUIElementSetAttributeValue, as, "AXUIElementSetAttributeValue")
		reg(&axUIElementGetPid, as, "AXUIElementGetPid")
		reg(&axUIElementSetMessagingTimeout, as, "AXUIElementSetMessagingTimeout")
		reg(&axValueGetValue, as, "AXValueGetValue")
		reg(&axValueCreate, as, "AXValueCreate")
		reg(&cgWindowListCopyWindowInfo, cg, "CGWindowListCopyWindowInfo")
		reg(&cgEventCreate, cg, "CGEventCreate")
		reg(&cgEventGetLocation, cg, "CGEventGetLocation")
		reg(&cgEventSourceButtonState, cg, "CGEventSourceButtonState")
		reg(&cgEventTapCreate, cg, "CGEventTapCreate")
		reg(&cgEventTapEnable, cg, "CGEventTapEnable")
		reg(&cgEventGetIntegerValueField, cg, "CGEventGetIntegerValueField")
		reg(&cgsDefaultConnection, cg, "_CGSDefaultConnection")
		reg(&cgsSetConnectionProperty, cg, "CGSSetConnectionProperty")
		reg(&cgImageGetWidth, cg, "CGImageGetWidth")
		reg(&cgImageGetHeight, cg, "CGImageGetHeight")
		reg(&cgImageRelease, cg, "CGImageRelease")
		reg(&cgColorSpaceCreateWithName, cg, "CGColorSpaceCreateWithName")
		reg(&cgColorSpaceRelease, cg, "CGColorSpaceRelease")
		reg(&cgBitmapContextCreate, cg, "CGBitmapContextCreate")
		reg(&cgBitmapContextGetData, cg, "CGBitmapContextGetData")
		reg(&cgContextDrawImage, cg, "CGContextDrawImage")
		reg(&cgContextSetInterpolationQuality, cg, "CGContextSetInterpolationQuality")
		reg(&cgContextRelease, cg, "CGContextRelease")
		if p, err := purego.Dlsym(cg, "CGWindowListCreateImage"); err == nil {
			purego.RegisterFunc(&cgWindowListCreateImage, p)
		}
		reg(&procPidpath, sys, "proc_pidpath")
		reg(&poolPush, rt, "objc_autoreleasePoolPush")
		reg(&poolPop, rt, "objc_autoreleasePoolPop")
		reg(&classGetInstanceMethod, rt, "class_getInstanceMethod")
		reg(&methodGetTypeEncoding, rt, "method_getTypeEncoding")
		reg(&methodGetImplementation, rt, "method_getImplementation")
		reg(&classReplaceMethod, rt, "class_replaceMethod")
		kCFRunLoopCommonModes = constant(cf, "kCFRunLoopCommonModes")
		kCFBooleanTrue = constant(cf, "kCFBooleanTrue")
		kAXTrustedCheckOptionPrompt = constant(as, "kAXTrustedCheckOptionPrompt")
		kCGColorSpaceSRGB = constant(cg, "kCGColorSpaceSRGB")
		typeID := func(lib uintptr, name string) uint {
			var fn func() uint
			reg(&fn, lib, name)
			return fn()
		}
		cfStringType = typeID(cf, "CFStringGetTypeID")
		cfArrayType = typeID(cf, "CFArrayGetTypeID")
		cfURLType = typeID(cf, "CFURLGetTypeID")
		axValueType = typeID(as, "AXValueGetTypeID")
		axElementType = typeID(as, "AXUIElementGetTypeID")
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

// cfString creates a CFString the caller releases.
func cfString(s string) uintptr { return cfStringCreateWithCString(0, s, 0x08000100) }

func isType(ref uintptr, typ uint) bool { return ref != 0 && cfGetTypeID(ref) == typ }

// stringOf reads a CFString, cut to max UTF-16 units; ok is false for
// anything else.
func stringOf(ref uintptr, max int) (string, bool) {
	if !isType(ref, cfStringType) {
		return "", false
	}
	n := min(cfStringGetLength(ref), max)
	if n <= 0 {
		return "", true
	}
	buf := make([]uint16, n)
	cfStringGetCharacters(ref, cfRange{0, n}, &buf[0])
	return string(utf16.Decode(buf)), true
}

func arrayOf(ref uintptr) []uintptr {
	if !isType(ref, cfArrayType) {
		return nil
	}
	out := make([]uintptr, cfArrayGetCount(ref))
	for i := range out {
		out[i] = cfArrayGetValueAtIndex(ref, i)
	}
	return out
}

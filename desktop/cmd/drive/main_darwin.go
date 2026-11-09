//go:build darwin

// Command drive posts real mouse input and reads what the window server
// and accessibility see, for tests of pointing:
//
//	drive move X Y            move the mouse
//	drive shake X Y           shake it around X, Y
//	drive click X Y [right]   click there
//	drive listen SECS X Y     count the clicks at X, Y that reach apps (a tail tap)
//	drive cursor              the cursor seed and the hot spot shown
//	drive front               the frontmost app's pid
//	drive at X Y [PID]        the pid owning the top window at X, Y, skipping PID
//	drive chain X Y           the accessibility chain at X, Y
//	drive locked              whether the screen is locked
//	drive idle                seconds since the last keyboard or mouse input
//	drive windows PID         the on-screen windows of PID, front to back, in points
//	drive displays            the displays' bounds, in points
//	drive extras PID          the menu bar icons of PID, in points
package main

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/desktop/darwin"
)

func init() { runtime.LockOSThread() }

type point struct{ X, Y float64 }
type rect struct {
	Origin point
	Size   struct{ W, H float64 }
}

const (
	eventLeftDown  = 1
	eventLeftUp    = 2
	eventRightDown = 3
	eventRightUp   = 4
	eventMoved     = 5
	hidEventTap    = 0
	sessionTap     = 1
	tailAppend     = 1
	listenOnly     = 1
)

var (
	cgEventCreateMouseEvent func(source uintptr, typ uint32, p point, button uint32) uintptr
	cgEventPost             func(tap uint32, event uintptr)
	cgEventGetLocation      func(event uintptr) point
	cgEventTapCreate        func(tap, place, options uint32, mask uint64, callback, refcon uintptr) uintptr
	cgEventTapEnable        func(tap uintptr, enable bool)
	cfMachPortSource        func(alloc, port uintptr, order int) uintptr
	cfRunLoopGetCurrent     func() uintptr
	cfRunLoopAddSource      func(loop, source, mode uintptr)
	cfRunLoopRunInMode      func(mode uintptr, seconds float64, returnAfterSource bool) int32
	cfRelease               func(uintptr)
	cursorSeed              func() int32
	sessionDictionary       func() uintptr
	windowList              func(option, relativeTo uint32) uintptr
	secondsSinceInput       func(state int32, typ uint32) float64
	activeDisplays          func(max uint32, ids *uint32, count *uint32) int32
	displayBounds           func(id uint32) rect
	kCFRunLoopDefaultMode   uintptr
	axCreateApplication     func(pid int32) uintptr
	axCopyAttribute         func(el, attr uintptr, out *uintptr) int32
	axValueGetValue         func(v uintptr, typ int32, out unsafe.Pointer) bool
)

func load() {
	open := func(p string) uintptr {
		h, err := purego.Dlopen(p, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			panic(err)
		}
		return h
	}
	cg := open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
	cf := open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
	open("/System/Library/Frameworks/AppKit.framework/AppKit")
	as := open("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
	purego.RegisterLibFunc(&axCreateApplication, as, "AXUIElementCreateApplication")
	purego.RegisterLibFunc(&axCopyAttribute, as, "AXUIElementCopyAttributeValue")
	purego.RegisterLibFunc(&axValueGetValue, as, "AXValueGetValue")
	purego.RegisterLibFunc(&cgEventCreateMouseEvent, cg, "CGEventCreateMouseEvent")
	purego.RegisterLibFunc(&cgEventPost, cg, "CGEventPost")
	purego.RegisterLibFunc(&cgEventGetLocation, cg, "CGEventGetLocation")
	purego.RegisterLibFunc(&cgEventTapCreate, cg, "CGEventTapCreate")
	purego.RegisterLibFunc(&cgEventTapEnable, cg, "CGEventTapEnable")
	purego.RegisterLibFunc(&cursorSeed, cg, "CGSCurrentCursorSeed")
	purego.RegisterLibFunc(&sessionDictionary, cg, "CGSessionCopyCurrentDictionary")
	purego.RegisterLibFunc(&windowList, cg, "CGWindowListCopyWindowInfo")
	purego.RegisterLibFunc(&secondsSinceInput, cg, "CGEventSourceSecondsSinceLastEventType")
	purego.RegisterLibFunc(&activeDisplays, cg, "CGGetActiveDisplayList")
	purego.RegisterLibFunc(&displayBounds, cg, "CGDisplayBounds")
	purego.RegisterLibFunc(&cfMachPortSource, cf, "CFMachPortCreateRunLoopSource")
	purego.RegisterLibFunc(&cfRunLoopGetCurrent, cf, "CFRunLoopGetCurrent")
	purego.RegisterLibFunc(&cfRunLoopAddSource, cf, "CFRunLoopAddSource")
	purego.RegisterLibFunc(&cfRunLoopRunInMode, cf, "CFRunLoopRunInMode")
	purego.RegisterLibFunc(&cfRelease, cf, "CFRelease")
	p, err := purego.Dlsym(cf, "kCFRunLoopDefaultMode")
	if err != nil {
		panic(err)
	}
	kCFRunLoopDefaultMode = **(**uintptr)(unsafe.Pointer(&p))
}

func post(typ uint32, p point, button uint32) {
	e := cgEventCreateMouseEvent(0, typ, p, button)
	cgEventPost(hidEventTap, e)
	cfRelease(e)
}

func shake(at point) {
	for i := range 16 {
		dx := 60.0
		if i%2 == 1 {
			dx = -60
		}
		post(eventMoved, point{at.X + dx, at.Y}, 0)
		time.Sleep(25 * time.Millisecond)
	}
	post(eventMoved, at, 0)
}

func click(at point, right bool) {
	down, up, button := uint32(eventLeftDown), uint32(eventLeftUp), uint32(0)
	if right {
		down, up, button = eventRightDown, eventRightUp, 1
	}
	post(down, at, button)
	time.Sleep(40 * time.Millisecond)
	post(up, at, button)
}

// listen counts the clicks at a point that a listen-only tap at the tail
// of the session sees, which are the clicks apps receive there.
func listen(seconds float64, at point) map[string]int64 {
	var counts [5]atomic.Int64
	cb := purego.NewCallback(func(proxy, typ, event, refcon uintptr) uintptr {
		p := cgEventGetLocation(event)
		near := p.X-at.X < 3 && at.X-p.X < 3 && p.Y-at.Y < 3 && at.Y-p.Y < 3
		if t := uint32(typ); t < uint32(len(counts)) && near {
			counts[t].Add(1)
		}
		return event
	})
	mask := uint64(1<<eventLeftDown | 1<<eventLeftUp | 1<<eventRightDown | 1<<eventRightUp)
	port := cgEventTapCreate(sessionTap, tailAppend, listenOnly, mask, cb, 0)
	if port == 0 {
		fail("the listen-only tap could not be created")
	}
	cfRunLoopAddSource(cfRunLoopGetCurrent(), cfMachPortSource(0, port, 0), kCFRunLoopDefaultMode)
	cgEventTapEnable(port, true)
	fmt.Fprintln(os.Stderr, "listening")
	deadline := time.Now().Add(time.Duration(seconds * float64(time.Second)))
	for time.Now().Before(deadline) {
		cfRunLoopRunInMode(kCFRunLoopDefaultMode, time.Until(deadline).Seconds(), false)
	}
	return map[string]int64{
		"leftDown": counts[eventLeftDown].Load(), "leftUp": counts[eventLeftUp].Load(),
		"rightDown": counts[eventRightDown].Load(), "rightUp": counts[eventRightUp].Load(),
	}
}

func sel(s string) objc.SEL  { return objc.RegisterName(s) }
func class(s string) objc.ID { return objc.ID(objc.GetClass(s)) }

func cursor() map[string]any {
	c := class("NSCursor").Send(sel("currentSystemCursor"))
	var hot point
	if c != 0 {
		hot = objc.Send[point](c, sel("hotSpot"))
	}
	arrow := objc.Send[point](class("NSCursor").Send(sel("arrowCursor")), sel("hotSpot"))
	return map[string]any{"seed": cursorSeed(), "hotSpot": hot, "arrowHotSpot": arrow}
}

func front() int {
	app := class("NSWorkspace").Send(sel("sharedWorkspace")).Send(sel("frontmostApplication"))
	return objc.Send[int](app, sel("processIdentifier"))
}

func nsString(s string) objc.ID {
	b := append([]byte(s), 0)
	return class("NSString").Send(sel("stringWithUTF8String:"), unsafe.Pointer(&b[0]))
}

// ownerAt is the pid of the frontmost on-screen window holding p, other
// than skip's.
func ownerAt(p point, skip int) int {
	list := objc.ID(windowList(1|16, 0))
	if list == 0 {
		return 0
	}
	defer cfRelease(uintptr(list))
	get := func(d objc.ID, k string) objc.ID { return d.Send(sel("objectForKey:"), nsString(k)) }
	for i := range objc.Send[int](list, sel("count")) {
		d := list.Send(sel("objectAtIndex:"), i)
		pid := objc.Send[int](get(d, "kCGWindowOwnerPID"), sel("intValue"))
		b := get(d, "kCGWindowBounds")
		f := func(k string) float64 { return objc.Send[float64](get(b, k), sel("doubleValue")) }
		if pid == skip || objc.Send[float64](get(d, "kCGWindowAlpha"), sel("doubleValue")) == 0 {
			continue
		}
		if p.X >= f("X") && p.Y >= f("Y") && p.X < f("X")+f("Width") && p.Y < f("Y")+f("Height") {
			return pid
		}
	}
	return 0
}

type windowInfo struct {
	ID    int
	Layer int
	X, Y  float64
	W, H  float64
}

func windowsOf(pid int) []windowInfo {
	list := objc.ID(windowList(1, 0))
	if list == 0 {
		return nil
	}
	defer cfRelease(uintptr(list))
	get := func(d objc.ID, k string) objc.ID { return d.Send(sel("objectForKey:"), nsString(k)) }
	var out []windowInfo
	for i := range objc.Send[int](list, sel("count")) {
		d := list.Send(sel("objectAtIndex:"), i)
		if objc.Send[int](get(d, "kCGWindowOwnerPID"), sel("intValue")) != pid {
			continue
		}
		b := get(d, "kCGWindowBounds")
		f := func(k string) float64 { return objc.Send[float64](get(b, k), sel("doubleValue")) }
		out = append(out, windowInfo{
			ID: objc.Send[int](get(d, "kCGWindowNumber"), sel("intValue")), Layer: objc.Send[int](get(d, "kCGWindowLayer"), sel("intValue")),
			X: f("X"), Y: f("Y"), W: f("Width"), H: f("Height"),
		})
	}
	return out
}

type extra struct {
	Name       string
	X, Y, W, H float64
}

// extras are pid's menu bar icons, which macOS 26 draws in Control
// Center's windows, so only accessibility tells them from the others.
func extras(pid int) []extra {
	attr := func(el uintptr, name string) uintptr {
		var out uintptr
		if el == 0 || axCopyAttribute(el, uintptr(nsString(name)), &out) != 0 {
			return 0
		}
		return out
	}
	bar := attr(axCreateApplication(int32(pid)), "AXExtrasMenuBar")
	if bar == 0 {
		return nil
	}
	items := objc.ID(attr(bar, "AXChildren"))
	var out []extra
	for i := range objc.Send[int](items, sel("count")) {
		it := uintptr(items.Send(sel("objectAtIndex:"), i))
		var p point
		var s struct{ W, H float64 }
		axValueGetValue(attr(it, "AXPosition"), 1, unsafe.Pointer(&p))
		axValueGetValue(attr(it, "AXSize"), 2, unsafe.Pointer(&s))
		name := ""
		for _, a := range []string{"AXTitle", "AXDescription", "AXHelp"} {
			if v := objc.ID(attr(it, a)); v != 0 && name == "" {
				name = goString(v)
			}
		}
		out = append(out, extra{Name: name, X: p.X, Y: p.Y, W: s.W, H: s.H})
	}
	return out
}

func goString(ns objc.ID) string {
	if ns == 0 || !objc.Send[bool](ns, sel("isKindOfClass:"), class("NSString")) {
		return ""
	}
	return objc.Send[string](ns, sel("UTF8String"))
}

func locked() bool {
	d := objc.ID(sessionDictionary())
	if d == 0 {
		return false
	}
	defer cfRelease(uintptr(d))
	v := d.Send(sel("objectForKey:"), nsString("CGSSessionScreenIsLocked"))
	return v != 0 && objc.Send[bool](v, sel("boolValue"))
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "drive:", msg)
	os.Exit(1)
}

func num(args []string, i int) float64 {
	if i >= len(args) {
		fail("missing a number")
	}
	f, err := strconv.ParseFloat(args[i], 64)
	if err != nil {
		fail(err.Error())
	}
	return f
}

func print(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

func main() {
	load()
	args := os.Args[1:]
	if len(args) == 0 {
		fail("usage: drive move|shake|click|listen|cursor|front|chain|locked")
	}
	switch args[0] {
	case "move":
		post(eventMoved, point{num(args, 1), num(args, 2)}, 0)
	case "shake":
		shake(point{num(args, 1), num(args, 2)})
	case "click":
		click(point{num(args, 1), num(args, 2)}, len(args) > 3 && args[3] == "right")
	case "listen":
		print(listen(num(args, 1), point{num(args, 2), num(args, 3)}))
	case "cursor":
		print(cursor())
	case "front":
		print(front())
	case "chain":
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		c, err := darwin.New("").PointAt(ctx, desktop.Point{X: num(args, 1), Y: num(args, 2)})
		if err != nil {
			fail(err.Error())
		}
		print(c)
	case "at":
		skip := 0
		if len(args) > 3 {
			skip = int(num(args, 3))
		}
		print(ownerAt(point{num(args, 1), num(args, 2)}, skip))
	case "windows":
		print(windowsOf(int(num(args, 1))))
	case "extras":
		print(extras(int(num(args, 1))))
	case "displays":
		var ids [8]uint32
		var n uint32
		activeDisplays(8, &ids[0], &n)
		var out []windowInfo
		for _, id := range ids[:n] {
			b := displayBounds(id)
			out = append(out, windowInfo{ID: int(id), X: b.Origin.X, Y: b.Origin.Y, W: b.Size.W, H: b.Size.H})
		}
		print(out)
	case "idle":
		const hidSystemState, anyInput = 1, ^uint32(0)
		print(secondsSinceInput(hidSystemState, anyInput))
	case "locked":
		print(locked())
	default:
		fail("unknown command " + args[0])
	}
}

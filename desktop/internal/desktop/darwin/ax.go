//go:build darwin

package darwin

import (
	"context"
	"math"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// Accessibility reads run on one locked OS thread, one at a time. A reply
// that arrives after its caller gave up is dropped; the messaging timeout
// bounds how long one call into a stuck app can hold the thread.

const (
	axMessagingTimeout = 0.8
	maxText            = 4000
	maxString          = 200_000
	chainDepth         = 8
	axValueCGPoint     = 1
	axValueCGSize      = 2
	axValueCFRange     = 4
	textWalkLimit      = 300
)

var (
	axOnce sync.Once
	axJobs = make(chan func(*axRead))
)

// axRead is one request on the worker thread. Every CF object it copies is
// released when the request ends.
type axRead struct {
	systemWide uintptr
	held       []uintptr
}

func startAX() {
	axOnce.Do(func() {
		load()
		ready := make(chan struct{})
		go func() {
			runtime.LockOSThread()
			systemWide := axUIElementCreateSystemWide()
			axUIElementSetMessagingTimeout(systemWide, axMessagingTimeout)
			close(ready)
			for job := range axJobs {
				r := &axRead{systemWide: systemWide}
				pool := poolPush()
				job(r)
				poolPop(pool)
				for _, ref := range r.held {
					cfRelease(ref)
				}
			}
		}()
		<-ready
	})
}

// axDo runs fn on the accessibility thread and waits for it until ctx ends.
func axDo[T any](ctx context.Context, fn func(*axRead) (T, error)) (T, error) {
	startAX()
	type reply struct {
		v   T
		err error
	}
	out := make(chan reply, 1)
	job := func(r *axRead) {
		if ctx.Err() != nil {
			return
		}
		v, err := fn(r)
		out <- reply{v, err}
	}
	var zero T
	select {
	case axJobs <- job:
	case <-ctx.Done():
		return zero, ctx.Err()
	}
	select {
	case r := <-out:
		return r.v, r.err
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}

func (r *axRead) hold(ref uintptr) uintptr {
	if ref != 0 {
		r.held = append(r.held, ref)
	}
	return ref
}

// attrNames are created once and never released.
var attrNames = map[string]uintptr{}

func attrName(name string) uintptr {
	ref, ok := attrNames[name]
	if !ok {
		ref = cfString(name)
		attrNames[name] = ref
	}
	return ref
}

func (r *axRead) attr(el uintptr, name string) uintptr {
	var out uintptr
	if axUIElementCopyAttributeValue(el, attrName(name), &out) != 0 {
		return 0
	}
	return r.hold(out)
}

// str is a string attribute; ok is false when the element has no string
// there.
func (r *axRead) str(el uintptr, name string) (string, bool) {
	return stringOf(r.attr(el, name), maxString)
}

func (r *axRead) s(el uintptr, name string) string {
	s, _ := r.str(el, name)
	return s
}

func (r *axRead) rect(el uintptr) *desktop.Rect {
	pos, size := r.attr(el, "AXPosition"), r.attr(el, "AXSize")
	if !isType(pos, axValueType) || !isType(size, axValueType) {
		return nil
	}
	var p cgPoint
	var s cgSize
	if !axValueGetValue(pos, axValueCGPoint, unsafe.Pointer(&p)) || !axValueGetValue(size, axValueCGSize, unsafe.Pointer(&s)) {
		return nil
	}
	if s.W <= 0 || s.H <= 0 {
		return nil
	}
	return &desktop.Rect{jsRound(p.X), jsRound(p.Y), jsRound(s.W), jsRound(s.H)}
}

// controlTypes maps macOS roles onto the UI Automation types the pick
// labels and rules are written for.
var controlTypes = map[string]string{
	"AXWindow": "Window", "AXSheet": "Window", "AXDialog": "Window", "AXTextArea": "Document", "AXWebArea": "Document",
	"AXTextField": "Edit", "AXComboBox": "Edit", "AXSearchField": "Edit", "AXStaticText": "Text", "AXHeading": "Text",
	"AXList": "List", "AXOutline": "List", "AXBrowser": "List", "AXTable": "Table", "AXGrid": "Table", "AXRow": "DataItem",
	"AXCell": "DataItem", "AXButton": "Button", "AXPopUpButton": "Button", "AXMenuButton": "Button", "AXCheckBox": "Button",
	"AXRadioButton": "Button", "AXGroup": "Group", "AXSplitGroup": "Group", "AXScrollArea": "Pane", "AXLayoutArea": "Pane",
	"AXLink": "Hyperlink", "AXImage": "Image", "AXMenuItem": "MenuItem", "AXMenuBarItem": "MenuItem", "AXDisclosureTriangle": "TreeItem",
}

func controlType(role string) string {
	if t, ok := controlTypes[role]; ok {
		return "ControlType." + t
	}
	return "ControlType.Custom"
}

var spaces = regexp.MustCompile(`\s+`)

func oneLine(s string, n int) string {
	s = strings.TrimSpace(spaces.ReplaceAllString(s, " "))
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func (r *axRead) isPassword(el uintptr) bool {
	return r.s(el, "AXRole") == "AXSecureTextField" || r.s(el, "AXSubrole") == "AXSecureTextField"
}

func (r *axRead) name(el uintptr) string {
	for _, a := range []string{"AXTitle", "AXDescription", "AXHelp"} {
		if s := r.s(el, a); s != "" {
			return s
		}
	}
	return ""
}

func (r *axRead) children(el uintptr) []uintptr { return arrayOf(r.attr(el, "AXChildren")) }

func (r *axRead) readable(el uintptr) bool {
	_, value := r.str(el, "AXValue")
	_, selected := r.str(el, "AXSelectedText")
	return value || selected
}

// opened are the apps whose accessibility tree Pointy switched on.
var opened = map[int32]bool{}

// openElectronTree asks an Electron app (QQ, VS Code) to build its
// accessibility tree, which they skip by default, once per process.
func openElectronTree(el uintptr) {
	var pid int32
	if axUIElementGetPid(el, &pid) != 0 || opened[pid] {
		return
	}
	opened[pid] = true
	app := axUIElementCreateApplication(pid)
	axUIElementSetAttributeValue(app, attrName("AXManualAccessibility"), kCFBooleanTrue)
	cfRelease(app)
}

func (r *axRead) chainAt(p desktop.Point) []uintptr {
	var out uintptr
	if axUIElementCopyElementAtPosition(r.systemWide, float32(p.X), float32(p.Y), &out) != 0 || out == 0 {
		return nil
	}
	el := r.hold(out)
	openElectronTree(el)
	var chain []uintptr
	for el != 0 && len(chain) < chainDepth {
		if r.s(el, "AXRole") == "AXApplication" {
			break
		}
		chain = append(chain, el)
		parent := r.attr(el, "AXParent")
		if !isType(parent, axElementType) {
			break
		}
		el = parent
	}
	return chain
}

func (r *axRead) windowRect(el uintptr) *desktop.Rect {
	w := r.attr(el, "AXWindow")
	if !isType(w, axElementType) {
		return nil
	}
	return r.rect(w)
}

func (r *axRead) visibleText(el uintptr) (string, bool) {
	v := r.attr(el, "AXVisibleCharacterRange")
	var rg cfRange
	if !isType(v, axValueType) || !axValueGetValue(v, axValueCFRange, unsafe.Pointer(&rg)) {
		return "", false
	}
	rg.Length = min(rg.Length, maxText)
	param := r.hold(axValueCreate(axValueCFRange, unsafe.Pointer(&rg)))
	var out uintptr
	if axUIElementCopyParameterizedAttr(el, attrName("AXStringForRange"), param, &out) != 0 {
		return "", false
	}
	return stringOf(r.hold(out), maxString)
}

func (r *axRead) text(el uintptr) string {
	if v := r.s(el, "AXValue"); v != "" {
		if u := utf16Len(v); u > maxText {
			if vis, ok := r.visibleText(el); ok && vis != "" {
				return vis
			}
			return lastUTF16(v, maxText)
		}
		return v
	}
	if r.s(el, "AXRole") == "AXLink" {
		if n := r.name(el); n != "" {
			return n
		}
	}
	var lines []string
	length, seen := 0, 0
	stack := []uintptr{el}
	for len(stack) > 0 && seen < textWalkLimit && length < maxText {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		seen++
		own := r.s(n, "AXValue")
		if own == "" {
			own = r.s(n, "AXTitle")
		}
		if own == "" {
			own = r.s(n, "AXDescription")
		}
		if own != "" {
			lines = append(lines, own)
			length += utf16Len(own)
		}
		kids := r.children(n)
		for i := len(kids) - 1; i >= 0; i-- {
			stack = append(stack, kids[i])
		}
	}
	return strings.Join(lines, "\n")
}

func (r *axRead) href(el uintptr) string {
	u := r.attr(el, "AXURL")
	if !isType(u, cfURLType) {
		return ""
	}
	s, _ := stringOf(cfURLGetString(u), maxString)
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return s
	}
	return ""
}

func (*Desktop) Grab(ctx context.Context) (desktop.GrabReply, error) {
	return axDo(ctx, func(r *axRead) (desktop.GrabReply, error) {
		el := r.attr(r.systemWide, "AXFocusedUIElement")
		if !isType(el, axElementType) {
			return desktop.GrabReply{}, nil
		}
		g := desktop.GrabReply{IsPassword: r.isPassword(el), Control: controlType(r.s(el, "AXRole"))}
		if g.IsPassword {
			return g, nil
		}
		g.Text, g.OK = r.str(el, "AXSelectedText")
		return g, nil
	})
}

func (*Desktop) PointAt(ctx context.Context, p desktop.Point) (desktop.PointReply, error) {
	return axDo(ctx, func(r *axRead) (desktop.PointReply, error) {
		els := r.chainAt(p)
		reply := desktop.PointReply{OK: true, Chain: []desktop.ChainItem{}}
		for _, el := range els {
			role := r.s(el, "AXRole")
			name := r.name(el)
			if name == "" && role == "AXStaticText" {
				name = r.s(el, "AXValue")
			}
			reply.Chain = append(reply.Chain, desktop.ChainItem{Rect: r.rect(el), Control: controlType(role), Class: role, Name: oneLine(name, 60)})
		}
		if len(els) > 0 {
			reply.LeafKids = len(r.children(els[0])) > 0
			reply.LeafReadable = r.readable(els[0])
			reply.Win = r.windowRect(els[0])
		}
		return reply, nil
	})
}

func (*Desktop) ElementAt(ctx context.Context, p desktop.Point, up int) (desktop.ElementReply, error) {
	return axDo(ctx, func(r *axRead) (desktop.ElementReply, error) {
		chain := r.chainAt(p)
		if len(chain) == 0 {
			return desktop.ElementReply{}, nil
		}
		el := chain[min(max(up, 0), len(chain)-1)]
		if r.isPassword(el) {
			return desktop.ElementReply{IsPassword: true}, nil
		}
		role := r.s(el, "AXRole")
		var pid int32
		axUIElementGetPid(el, &pid)
		e := desktop.ElementReply{
			OK:        true,
			Name:      r.name(el),
			Control:   controlType(role),
			ClassName: role,
			Rect:      r.rect(el),
			Kids:      len(r.children(el)) > 0,
			Readable:  r.readable(el),
			Win:       r.windowRect(el),
			Text:      firstUTF16(strings.TrimSpace(r.text(el)), maxText),
			PID:       int(pid),
		}
		if role == "AXLink" {
			e.Href = r.href(el)
		}
		return e, nil
	})
}

// jsRound rounds halves up, as the Electron helper did.
func jsRound(x float64) int { return int(math.Floor(x + 0.5)) }

// Text limits count UTF-16 units, as the Electron helper did.

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func firstUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func lastUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[len(u)-n:]))
}

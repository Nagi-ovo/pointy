//go:build windows

package windows

// UI Automation through raw IUIAutomation vtables (UIAutomationClient.h),
// in place of app/pick/native/uia-selection.ps1. Each call follows the
// script's command of the same name; uiareply.go shapes the replies.

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var (
	clsidCUIAutomation8 = ole.NewGUID("{e22ad333-b25f-460c-83d0-0581107395c9}")
	clsidCUIAutomation  = ole.NewGUID("{ff48dba4-60ef-4201-aa87-54103eef594e}")
	iidIUIAutomation    = ole.NewGUID("{30cbe57d-d9d0-452a-ab13-7ac5ac4825ee}")
	iidIUIAutomation2   = ole.NewGUID("{34723aff-0c9d-49d0-9896-7ab52df8cd8a}")
)

// Vtable slots, counted from IUnknown's three.
const (
	unkQueryInterface = 0
	unkAddRef         = 1
	unkRelease        = 2

	autoCompareElements         = 3
	autoGetRootElement          = 5
	autoElementFromPoint        = 7
	autoGetFocusedElement       = 8
	autoControlViewWalker       = 14
	autoCreatePropertyCondition = 23
	auto2PutTransactionTimeout  = 63

	walkerGetParent      = 3
	walkerGetFirstChild  = 4
	walkerGetNextSibling = 6

	elemFindAll           = 6
	elemGetCurrentPattern = 16
	elemProcessID         = 20
	elemControlType       = 21
	elemName              = 23
	elemClassName         = 30
	elemIsPassword        = 35
	elemBoundingRect      = 43

	arrayLength     = 3
	arrayGetElement = 4

	textGetSelection     = 5
	textGetVisibleRanges = 6
	textDocumentRange    = 7

	rangeGetText = 12

	valueCurrentValue = 4
)

const (
	patternValue               = 10002
	patternText                = 10014
	propIsTextPatternAvailable = 30040
	treeScopeDescendants       = 4
	variantTrue                = -1
	transactionTimeoutMs       = 800
)

// com is a COM interface pointer.
type com struct{ vtbl *[128]uintptr }

func (o *com) call(slot int, args ...uintptr) error {
	hr, _, _ := syscall.SyscallN(o.vtbl[slot], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)
	if int32(hr) < 0 {
		return ole.NewError(hr)
	}
	return nil
}

// out calls a method whose last argument receives an interface pointer.
func (o *com) out(slot int, args ...uintptr) *com {
	var r *com
	if o.call(slot, append(args, uintptr(unsafe.Pointer(&r)))...) != nil {
		return nil
	}
	return r
}

func (o *com) addRef() *com {
	syscall.SyscallN(o.vtbl[unkAddRef], uintptr(unsafe.Pointer(o)))
	return o
}

func (o *com) release() {
	if o != nil {
		syscall.SyscallN(o.vtbl[unkRelease], uintptr(unsafe.Pointer(o)))
	}
}

func (o *com) bstr(slot int) string {
	var b *uint16
	if o.call(slot, uintptr(unsafe.Pointer(&b))) != nil || b == nil {
		return ""
	}
	defer ole.SysFreeString((*int16)(unsafe.Pointer(b)))
	return ole.BstrToString(b)
}

func (o *com) int32At(slot int) int32 {
	var v int32
	o.call(slot, uintptr(unsafe.Pointer(&v)))
	return v
}

// uia is one IUIAutomation and what every command needs from it. It
// belongs to the worker thread that made it.
type uia struct {
	auto     *com
	walker   *com
	root     *com
	textCond *com
}

func newUIA() (*uia, error) {
	unk, err := ole.CreateInstance(clsidCUIAutomation8, iidIUIAutomation)
	if err != nil {
		if unk, err = ole.CreateInstance(clsidCUIAutomation, iidIUIAutomation); err != nil {
			return nil, err
		}
	}
	u := &uia{auto: (*com)(unsafe.Pointer(unk))}
	// The 0.8 s the macOS side gives AX: a hung app costs one command, not
	// UIA's default 20 s. IUIAutomation2 is Windows 8 and later.
	if a2 := u.auto.out(unkQueryInterface, uintptr(unsafe.Pointer(iidIUIAutomation2))); a2 != nil {
		a2.call(auto2PutTransactionTimeout, transactionTimeoutMs)
		a2.release()
	}
	u.walker = u.auto.out(autoControlViewWalker)
	u.root = u.auto.out(autoGetRootElement)
	cond := ole.VARIANT{VT: ole.VT_BOOL, Val: variantTrue}
	// A VARIANT is 24 bytes: amd64 and arm64 pass it by reference.
	u.textCond = u.auto.out(autoCreatePropertyCondition, propIsTextPatternAvailable, uintptr(unsafe.Pointer(&cond)))
	if u.walker == nil || u.root == nil || u.textCond == nil {
		u.release()
		return nil, ole.NewError(0x80004005)
	}
	return u, nil
}

func (u *uia) release() {
	u.textCond.release()
	u.root.release()
	u.walker.release()
	u.auto.release()
}

func (u *uia) describe(e *com) control {
	var r rect
	e.call(elemBoundingRect, uintptr(unsafe.Pointer(&r)))
	return control{
		typeID:   e.int32At(elemControlType),
		name:     e.bstr(elemName),
		class:    e.bstr(elemClassName),
		rect:     rectOf(r.Left, r.Top, r.Right, r.Bottom),
		password: e.int32At(elemIsPassword) != 0,
		pid:      int(e.int32At(elemProcessID)),
	}
}

func (u *uia) pattern(e *com, id uintptr) *com { return e.out(elemGetCurrentPattern, id) }

func (u *uia) readable(e *com) bool {
	for _, id := range []uintptr{patternText, patternValue} {
		if p := u.pattern(e, id); p != nil {
			p.release()
			return true
		}
	}
	return false
}

func (u *uia) hasKids(e *com) bool {
	c := u.walker.out(walkerGetFirstChild, uintptr(unsafe.Pointer(e)))
	c.release()
	return c != nil
}

// parent is e's parent in the control view, or nil at the top level.
func (u *uia) parent(e *com) *com {
	p := u.walker.out(walkerGetParent, uintptr(unsafe.Pointer(e)))
	if p == nil {
		return nil
	}
	var same int32
	u.auto.call(autoCompareElements, uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(u.root)), uintptr(unsafe.Pointer(&same)))
	if same != 0 {
		p.release()
		return nil
	}
	return p
}

// windowRect is the rectangle of e's top-level window.
func (u *uia) windowRect(e *com) *desktop.Rect {
	top := e.addRef()
	for {
		p := u.parent(top)
		if p == nil {
			break
		}
		top.release()
		top = p
	}
	defer top.release()
	return u.describe(top).rect
}

// textChildAt is the smallest control with a Text pattern under x, y
// inside win, or nil.
func (u *uia) textChildAt(win *com, x, y float64) *com {
	arr := win.out(elemFindAll, treeScopeDescendants, uintptr(unsafe.Pointer(u.textCond)))
	if arr == nil {
		return nil
	}
	defer arr.release()
	n := arr.int32At(arrayLength)
	rects := make([]*desktop.Rect, n)
	for i := range n {
		if e := arr.out(arrayGetElement, uintptr(i)); e != nil {
			rects[i] = u.describe(e).rect
			e.release()
		}
	}
	best := smallestAt(rects, x, y)
	if best < 0 {
		return nil
	}
	return arr.out(arrayGetElement, uintptr(best))
}

// chain is the control under x, y and its control-view ancestors, at most
// depth. The caller releases them.
func (u *uia) chain(x, y float64, depth int) []*com {
	el := u.auto.out(autoElementFromPoint, point{X: int32(x), Y: int32(y)}.byValue())
	if el == nil {
		return nil
	}
	if u.describe(el).typeID == typeWindow && !u.readable(el) {
		if inner := u.textChildAt(el, x, y); inner != nil {
			el.release()
			el = inner
		}
	}
	var out []*com
	for {
		out = append(out, el)
		if len(out) == depth {
			return out
		}
		if el = u.parent(el); el == nil {
			return out
		}
	}
}

func releaseAll(list []*com) {
	for _, e := range list {
		e.release()
	}
}

func rangeText(r *com, max int) string {
	var b *uint16
	if r.call(rangeGetText, uintptr(max), uintptr(unsafe.Pointer(&b))) != nil || b == nil {
		return ""
	}
	defer ole.SysFreeString((*int16)(unsafe.Pointer(b)))
	return ole.BstrToString(b)
}

// rangeTexts reads every range of an IUIAutomationTextRangeArray. It is
// never nil.
func rangeTexts(arr *com, max int) []string {
	n := arr.int32At(arrayLength)
	out := make([]string, 0, n)
	for i := range n {
		if r := arr.out(arrayGetElement, uintptr(i)); r != nil {
			out = append(out, rangeText(r, max))
			r.release()
		}
	}
	return out
}

// text is what the user would read in e: its text, a link's words, its
// value, or else the names of the controls inside it.
func (u *uia) text(e *com, c control) string {
	if tp := u.pattern(e, patternText); tp != nil {
		defer tp.release()
		doc := tp.out(textDocumentRange)
		if doc == nil {
			return ""
		}
		all := rangeText(doc, maxText+1)
		doc.release()
		return documentText(all, func() string {
			arr := tp.out(textGetVisibleRanges)
			if arr == nil {
				return ""
			}
			defer arr.release()
			return strings.Join(rangeTexts(arr, maxText), "\n")
		})
	}
	if c.typeID == typeHyperlink && c.name != "" {
		return c.name
	}
	if v := u.value(e); v != "" {
		return v
	}
	var lines []string
	length, seen := 0, 0
	stack := []*com{e.addRef()}
	defer func() { releaseAll(stack) }()
	for len(stack) > 0 && seen < maxWalk && length < maxText {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		seen++
		if name := n.bstr(elemName); name != "" {
			lines = append(lines, name)
			length += utf8.RuneCountInString(name) + 1
		}
		var kids []*com
		for k := u.walker.out(walkerGetFirstChild, uintptr(unsafe.Pointer(n))); k != nil; k = u.walker.out(walkerGetNextSibling, uintptr(unsafe.Pointer(k))) {
			kids = append(kids, k)
		}
		n.release()
		for i := len(kids) - 1; i >= 0; i-- {
			stack = append(stack, kids[i])
		}
	}
	return strings.Join(lines, "\n")
}

func (u *uia) value(e *com) string {
	vp := u.pattern(e, patternValue)
	if vp == nil {
		return ""
	}
	defer vp.release()
	return vp.bstr(valueCurrentValue)
}

func (u *uia) grab() desktop.GrabReply {
	el := u.auto.out(autoGetFocusedElement)
	if el == nil {
		return desktop.GrabReply{}
	}
	defer el.release()
	c := u.describe(el)
	var selection []string
	if !c.password {
		if tp := u.pattern(el, patternText); tp != nil {
			if arr := tp.out(textGetSelection); arr != nil {
				selection = rangeTexts(arr, maxGrab)
				arr.release()
			} else {
				selection = []string{}
			}
			tp.release()
		}
	}
	return grabReply(c, selection)
}

func (u *uia) point(p desktop.Point) desktop.PointReply {
	chain := u.chain(p.X, p.Y, chainDepth)
	defer releaseAll(chain)
	controls := make([]control, len(chain))
	for i, e := range chain {
		controls[i] = u.describe(e)
	}
	if len(chain) == 0 {
		return pointReply(nil, false, false, nil)
	}
	return pointReply(controls, u.hasKids(chain[0]), u.readable(chain[0]), u.windowRect(chain[0]))
}

func (u *uia) element(p desktop.Point, up int) desktop.ElementReply {
	chain := u.chain(p.X, p.Y, chainDepth)
	defer releaseAll(chain)
	if len(chain) == 0 {
		return desktop.ElementReply{}
	}
	el := chain[max(0, min(up, len(chain)-1))]
	c := u.describe(el)
	if c.password {
		return elementReply(c, false, false, nil, "", "")
	}
	var value string
	if c.typeID == typeHyperlink {
		value = u.value(el)
	}
	return elementReply(c, u.hasKids(el), u.readable(el), u.windowRect(el), u.text(el, c), value)
}

// uiaWorker owns one COM apartment on one locked thread, as the
// PowerShell helper owned its process: a call into an app that hangs
// blocks this thread, never mygo's.
type uiaWorker struct {
	calls chan func(*uia)
	quit  chan struct{}
	stop  sync.Once
}

func startUIA() (*uiaWorker, error) {
	w := &uiaWorker{calls: make(chan func(*uia)), quit: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		// The thread stays locked: it ends with this goroutine, and its
		// COM state with it.
		runtime.LockOSThread()
		if err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED); err != nil {
			ready <- err
			return
		}
		defer ole.CoUninitialize()
		u, err := newUIA()
		if err != nil {
			ready <- err
			return
		}
		defer u.release()
		ready <- nil
		for {
			select {
			case fn := <-w.calls:
				fn(u)
			case <-w.quit:
				return
			}
		}
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return w, nil
}

// uiaClient hands commands to the current worker. A command that misses
// its deadline leaves its worker to finish alone, and the next command
// starts a new one, as the Electron side killed and restarted the script.
type uiaClient struct {
	mu sync.Mutex
	w  *uiaWorker
}

func (c *uiaClient) worker() (*uiaWorker, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.w == nil {
		w, err := startUIA()
		if err != nil {
			return nil, err
		}
		c.w = w
	}
	return c.w, nil
}

func (c *uiaClient) abandon(w *uiaWorker) {
	c.mu.Lock()
	if c.w == w {
		c.w = nil
	}
	c.mu.Unlock()
	w.stop.Do(func() { close(w.quit) })
}

func uiaCall[T any](ctx context.Context, c *uiaClient, fn func(*uia) T) (T, error) {
	var zero T
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	w, err := c.worker()
	if err != nil {
		return zero, err
	}
	out := make(chan T, 1)
	select {
	case w.calls <- func(u *uia) { out <- fn(u) }:
	case <-ctx.Done():
		c.abandon(w)
		return zero, ctx.Err()
	}
	select {
	case v := <-out:
		return v, nil
	case <-ctx.Done():
		c.abandon(w)
		return zero, ctx.Err()
	}
}

func (d *Desktop) Grab(ctx context.Context) (desktop.GrabReply, error) {
	return uiaCall(ctx, &d.uia, (*uia).grab)
}

func (d *Desktop) PointAt(ctx context.Context, p desktop.Point) (desktop.PointReply, error) {
	return uiaCall(ctx, &d.uia, func(u *uia) desktop.PointReply { return u.point(p) })
}

func (d *Desktop) ElementAt(ctx context.Context, p desktop.Point, up int) (desktop.ElementReply, error) {
	return uiaCall(ctx, &d.uia, func(u *uia) desktop.ElementReply { return u.element(p, up) })
}

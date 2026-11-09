// Package desktop is what Pointy needs from the operating system beyond
// mygo: the other apps' windows and controls, the mouse while the user
// points, and cleanup after Pointy exits. Screen units are points on macOS
// and physical pixels on Windows.
package desktop

import (
	"image"

	"github.com/egoist/mygo"
)

// WindowID is a system window: a CGWindowID on macOS, an HWND on Windows.
type WindowID uint64

// Point is a position in screen units.
type Point struct{ X, Y float64 }

// Rect is a rectangle in screen units: x, y, width and height, as the
// accessibility replies carry it.
type Rect [4]int

// Level is how high a Pointy window floats.
type Level int

const (
	// LevelFloating floats above other apps' windows, as cards and pills do.
	LevelFloating Level = iota
	// LevelScreenSaver floats above everything, menus and the Dock included.
	LevelScreenSaver
)

// Foreground is the window the user works in.
type Foreground struct {
	ID      WindowID
	Title   string
	PID     int
	ExePath string
	// Exe is the executable's base name, in lower case.
	Exe string
}

// BrowserKind is the browser family whose extension store a browser uses.
type BrowserKind string

const (
	BrowserChrome BrowserKind = "chrome"
	BrowserEdge   BrowserKind = "edge"
)

// Button is what the mouse did while the user points.
type Button int

const (
	LeftUp Button = iota
	RightUp
	WheelUp
	WheelDown
)

// ButtonHook holds the mouse while the user points: other apps get no
// clicks, nor the wheel while SetWheel(true), and Events reports them.
type ButtonHook interface {
	Events() <-chan Button
	SetWheel(bool)
	Close()
}

// Desktop is implemented once per platform. Methods are safe from any
// goroutine.
type Desktop interface {
	A11y

	// FullscreenActive reports whether another app's window covers a
	// whole display. own lists Pointy's windows, which never count.
	FullscreenActive(own []WindowID) (bool, error)
	Foreground() (Foreground, error)
	// WindowID returns the system id of a Pointy window.
	WindowID(*mygo.Window) WindowID
	// AttachToOwner keeps a Pointy window directly above owner while owner's
	// app is in front, in place of floating above every app.
	AttachToOwner(w *mygo.Window, owner WindowID) error
	SetLevel(*mygo.Window, Level) error
	// SetFocusable false keeps a window from ever taking the keyboard.
	SetFocusable(w *mygo.Window, focusable bool) error
	// PrepareWindow does what a new Pointy window needs beyond its mygo
	// options, before it first shows.
	PrepareWindow(*mygo.Window) error
	// WindowOrigin is a window's top-left corner.
	WindowOrigin(id WindowID) (Point, error)
	// ToDIP converts screen units to mygo's coordinates.
	ToDIP(Point) Point
	// ToScreen converts mygo's coordinates to screen units.
	ToScreen(Point) Point
	// RectToDIP converts a rectangle in screen units to mygo's coordinates.
	RectToDIP(Rect) mygo.Rectangle
	// UnitsPerDIP is how many screen units a DIP spans at p.
	UnitsPerDIP(p Point) float64
	// AllowAnyForeground lets the app Pointy opens come to the front.
	AllowAnyForeground()
	// RemoveAfterExit deletes paths once this process has exited.
	RemoveAfterExit(paths []string) error

	// Cursor is the mouse position.
	Cursor() Point
	CursorVisible() bool
	// ButtonDown reports whether any mouse button is held.
	ButtonDown() bool
	// ElevatedUnderCursor reports whether the window under the mouse runs
	// with more rights than Pointy, which then cannot read it.
	ElevatedUnderCursor() bool
	// AccessHint is what the user must grant before Pointy can read other
	// apps, or "".
	AccessHint() string
	// Browser reports whether exe, as Foreground names it, is a browser
	// the extension runs in.
	Browser(exe string) (BrowserKind, bool)
	// Blocked reports whether exe is an app Pointy never reads, such as a
	// password manager.
	Blocked(exe string) bool
	HookButtons() (ButtonHook, error)
	// SwapCursor shows Pointy's cursor in every app until RestoreCursor.
	SwapCursor() error
	RestoreCursor()
	// Capture returns the pixels of r, in screen units, at the display's
	// resolution.
	Capture(r Rect) (image.Image, error)
}

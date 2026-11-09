// Package desktop is what Pointy needs from the operating system beyond
// mygo: the other apps' windows, and cleanup after Pointy exits. Screen
// units are points on macOS and physical pixels on Windows.
package desktop

// WindowID is a system window: a CGWindowID on macOS, an HWND on Windows.
type WindowID uint64

// Point is a position in screen units.
type Point struct{ X, Y float64 }

// Foreground is the window the user works in.
type Foreground struct {
	ID      WindowID
	Title   string
	PID     int
	ExePath string
	// Exe is the executable's base name, in lower case.
	Exe string
}

// Desktop is implemented once per platform. Methods are safe from any
// goroutine.
type Desktop interface {
	// FullscreenActive reports whether another app's window covers a
	// whole display. own lists Pointy's windows, which never count.
	FullscreenActive(own []WindowID) (bool, error)
	Foreground() (Foreground, error)
	// WindowID returns the system id of a window from mygo's NativeHandle.
	WindowID(handle uintptr) WindowID
	// AttachToOwner keeps a Pointy window directly above owner while owner's
	// app is in front, in place of floating above every app.
	AttachToOwner(handle uintptr, owner WindowID) error
	// WindowOrigin is a window's top-left corner.
	WindowOrigin(id WindowID) (Point, error)
	// ToDIP converts screen units to mygo's coordinates.
	ToDIP(Point) Point
	// AllowAnyForeground lets the app Pointy opens come to the front.
	AllowAnyForeground()
	// RemoveAfterExit deletes paths once this process has exited.
	RemoveAfterExit(paths []string) error
}

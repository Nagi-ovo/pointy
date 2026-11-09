package desktop

import (
	"context"
	"errors"
	"image"

	"github.com/egoist/mygo"
)

// Unsupported answers every method with errors.ErrUnsupported, or with
// what a desktop without the feature would answer. Platform
// implementations embed it for what they do not have yet.
type Unsupported struct{}

var _ Desktop = Unsupported{}

func (Unsupported) FullscreenActive([]WindowID) (bool, error)  { return false, errors.ErrUnsupported }
func (Unsupported) Foreground() (Foreground, error)            { return Foreground{}, errors.ErrUnsupported }
func (Unsupported) WindowID(*mygo.Window) WindowID             { return 0 }
func (Unsupported) AttachToOwner(*mygo.Window, WindowID) error { return errors.ErrUnsupported }
func (Unsupported) SetLevel(*mygo.Window, Level) error         { return errors.ErrUnsupported }
func (Unsupported) SetFocusable(*mygo.Window, bool) error      { return errors.ErrUnsupported }
func (Unsupported) PrepareWindow(*mygo.Window) error           { return nil }
func (Unsupported) WindowOrigin(WindowID) (Point, error)       { return Point{}, errors.ErrUnsupported }
func (Unsupported) ToDIP(p Point) Point                        { return p }
func (Unsupported) ToScreen(p Point) Point                     { return p }
func (Unsupported) UnitsPerDIP(Point) float64                  { return 1 }
func (Unsupported) AllowAnyForeground()                        {}
func (Unsupported) RemoveAfterExit([]string) error             { return errors.ErrUnsupported }
func (Unsupported) Cursor() Point                              { return Point{} }
func (Unsupported) CursorVisible() bool                        { return true }
func (Unsupported) ButtonDown() bool                           { return false }
func (Unsupported) ElevatedUnderCursor() bool                  { return false }
func (Unsupported) AccessHint() string                         { return "" }
func (Unsupported) Browser(string) (BrowserKind, bool)         { return "", false }
func (Unsupported) Blocked(string) bool                        { return false }
func (Unsupported) HookButtons() (ButtonHook, error)           { return nil, errors.ErrUnsupported }
func (Unsupported) SwapCursor() error                          { return errors.ErrUnsupported }
func (Unsupported) RestoreCursor()                             {}
func (Unsupported) PrewarmCapture()                            {}

func (Unsupported) RectToDIP(r Rect) mygo.Rectangle {
	return mygo.Rectangle{X: r[0], Y: r[1], Width: r[2], Height: r[3]}
}

func (Unsupported) Grab(context.Context) (GrabReply, error) {
	return GrabReply{}, errors.ErrUnsupported
}

func (Unsupported) PointAt(context.Context, Point) (PointReply, error) {
	return PointReply{}, errors.ErrUnsupported
}

func (Unsupported) ElementAt(context.Context, Point, int) (ElementReply, error) {
	return ElementReply{}, errors.ErrUnsupported
}

func (Unsupported) Capture(context.Context, Rect, int) (image.Image, error) {
	return nil, errors.ErrUnsupported
}

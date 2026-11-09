package desktop

import "errors"

// Unsupported answers every method with errors.ErrUnsupported. Platform
// implementations embed it for what they do not have yet.
type Unsupported struct{}

var _ Desktop = Unsupported{}

func (Unsupported) FullscreenActive([]WindowID) (bool, error) { return false, errors.ErrUnsupported }
func (Unsupported) Foreground() (Foreground, error)           { return Foreground{}, errors.ErrUnsupported }
func (Unsupported) WindowID(uintptr) WindowID                 { return 0 }
func (Unsupported) AttachToOwner(uintptr, WindowID) error     { return errors.ErrUnsupported }
func (Unsupported) WindowOrigin(WindowID) (Point, error)      { return Point{}, errors.ErrUnsupported }
func (Unsupported) ToDIP(p Point) Point                       { return p }
func (Unsupported) AllowAnyForeground()                       {}
func (Unsupported) RemoveAfterExit([]string) error            { return errors.ErrUnsupported }

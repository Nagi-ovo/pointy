package pick

import (
	"math"
	"regexp"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// chromiumShell is the one control an Electron app such as QQ shows when
// its accessibility is off.
var chromiumShell = regexp.MustCompile(`^Chrome_(RenderWidgetHostHWND|WidgetWin_\d+)$|^Intermediate D3D Window$`)

const typeWindow = "ControlType.Window"

// shape is what decides whether a control can be read or only looked at.
type shape struct {
	Class          string
	Type           string
	Rect, Win      *desktop.Rect
	Kids, Readable bool
}

// isOpaque reports whether a control hides what it shows from
// accessibility, so a pick takes a picture of it in place of its text.
func isOpaque(s shape) bool {
	if chromiumShell.MatchString(s.Class) || isWholeWindow(s) {
		return true
	}
	if s.Kids || s.Readable || s.Rect == nil || s.Win == nil {
		return false
	}
	return coverage(*s.Rect, *s.Win) >= 0.9
}

func coverage(r, w desktop.Rect) float64 {
	return float64(r[2]*r[3]) / float64(max(1, w[2]*w[3]))
}

func isWholeWindow(s shape) bool {
	return s.Type == typeWindow && s.Rect != nil && s.Win != nil && coverage(*s.Rect, *s.Win) >= 0.98
}

const (
	focusW = 720
	focusH = 320
)

// focusRect is the frame around p that a pick of a large opaque control
// keeps, scale being screen units per DIP and zoom the wheel's. It is
// false when the control is small enough to keep whole.
func focusRect(r desktop.Rect, p desktop.Point, scale, zoom float64) (desktop.Rect, bool) {
	rx, ry, rw, rh := float64(r[0]), float64(r[1]), float64(r[2]), float64(r[3])
	if rw <= focusW*scale*1.4 && rh <= focusH*scale*1.4 {
		return desktop.Rect{}, false
	}
	cw := min(round(focusW*scale*zoom), rw)
	ch := min(round(focusH*scale*zoom), rh)
	x := min(max(p.X-cw/2, rx), rx+rw-cw)
	y := min(max(p.Y-ch/2, ry), ry+rh-ch)
	return desktop.Rect{int(round(x)), int(round(y)), int(cw), int(ch)}, true
}

// round rounds halves up, as the Electron runtime did.
func round(x float64) float64 { return math.Floor(x + 0.5) }

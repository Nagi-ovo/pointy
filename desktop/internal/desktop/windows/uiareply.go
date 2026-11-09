package windows

// How UI Automation's answers become the replies of uia-selection.ps1. No
// build constraint: the shaping is tested on every platform, and uia.go
// only reads the controls.

import (
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	maxText    = 4000
	maxGrab    = 20000
	chainDepth = 8
	nameLength = 60
	// maxWalk caps the controls whose names make up a control without text.
	maxWalk = 300
)

// control is what uia.go reads of one control.
type control struct {
	typeID   int32
	name     string
	class    string
	rect     *desktop.Rect
	password bool
	pid      int
}

// controlTypes are UIA's control type ids from 50000 (UIA_ButtonControlTypeId)
// on, by the names .NET's ControlType.ProgrammaticName gives them.
var controlTypes = [...]string{
	"Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu",
	"MenuBar", "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem",
	"Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem",
	"Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom",
	"AppBar",
}

const (
	typeHyperlink int32 = 50005
	typeWindow    int32 = 50032
)

func controlName(id int32) string {
	if i := int(id) - 50000; i >= 0 && i < len(controlTypes) {
		return "ControlType." + controlTypes[i]
	}
	return "ControlType.Custom"
}

// rectOf turns a native RECT into a rectangle, or nil where the control
// has none.
func rectOf(left, top, right, bottom int32) *desktop.Rect {
	if right <= left || bottom <= top {
		return nil
	}
	return &desktop.Rect{int(left), int(top), int(right - left), int(bottom - top)}
}

// contains is .NET's Rect.Contains, edges included.
func contains(r desktop.Rect, x, y float64) bool {
	return x >= float64(r[0]) && y >= float64(r[1]) && x <= float64(r[0]+r[2]) && y <= float64(r[1]+r[3])
}

// smallestAt is the index of the smallest rectangle that holds x, y, or -1.
// A top-level window under the point gives way to it: XAML hosts such as
// Windows Terminal answer the window itself for any point.
func smallestAt(rects []*desktop.Rect, x, y float64) int {
	best, area := -1, 0
	for i, r := range rects {
		if r == nil || !contains(*r, x, y) {
			continue
		}
		if a := r[2] * r[3]; best < 0 || a < area {
			best, area = i, a
		}
	}
	return best
}

var whitespace = regexp.MustCompile(`\s+`)

// oneLine collapses whitespace and keeps the first n characters.
func oneLine(s string, n int) string {
	return clip(whitespace.ReplaceAllString(s, " "), n)
}

// clip keeps the first n characters of s.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for range n {
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return s[:i]
}

// documentText picks what a text control shows: all of it when short, else
// the part on screen (a terminal's buffer starts long before what the user
// sees), else its start. doc was read with a limit of maxText+1 UTF-16
// units, which UIA counts in.
func documentText(doc string, visible func() string) string {
	if utf16Len(doc) <= maxText {
		return doc
	}
	if v := visible(); strings.TrimSpace(v) != "" {
		return v
	}
	return clip(doc, maxText)
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

var webURL = regexp.MustCompile(`^https?://`)

// grabReply describes the focused control; selection is nil where it has
// no Text pattern.
func grabReply(c control, selection []string) desktop.GrabReply {
	r := desktop.GrabReply{IsPassword: c.password, Control: controlName(c.typeID)}
	if !c.password && selection != nil {
		r.OK, r.Text = true, strings.Join(selection, "\n")
	}
	return r
}

func pointReply(chain []control, leafKids, leafReadable bool, win *desktop.Rect) desktop.PointReply {
	r := desktop.PointReply{OK: true, Chain: make([]desktop.ChainItem, len(chain))}
	for i, c := range chain {
		r.Chain[i] = desktop.ChainItem{Rect: c.rect, Control: controlName(c.typeID), Class: c.class, Name: oneLine(c.name, nameLength)}
	}
	if len(chain) > 0 {
		r.LeafKids, r.LeafReadable, r.Win = leafKids, leafReadable, win
	}
	return r
}

// elementReply describes the picked control; value is its Value pattern's,
// which for a link is its address.
func elementReply(c control, kids, readable bool, win *desktop.Rect, text, value string) desktop.ElementReply {
	if c.password {
		return desktop.ElementReply{IsPassword: true}
	}
	r := desktop.ElementReply{
		OK:        true,
		Name:      c.name,
		Control:   controlName(c.typeID),
		ClassName: c.class,
		Rect:      c.rect,
		Kids:      kids,
		Readable:  readable,
		Win:       win,
		Text:      clip(strings.TrimSpace(text), maxText),
		PID:       c.pid,
	}
	if c.typeID == typeHyperlink && webURL.MatchString(value) {
		r.Href = value
	}
	return r
}

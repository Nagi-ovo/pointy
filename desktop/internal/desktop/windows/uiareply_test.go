package windows

import (
	"encoding/json/v2"
	"strings"
	"testing"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func TestControlNamesMatchDotNet(t *testing.T) {
	for id, want := range map[int32]string{
		50000: "ControlType.Button",
		50004: "ControlType.Edit",
		50005: "ControlType.Hyperlink",
		50020: "ControlType.Text",
		50025: "ControlType.Custom",
		50030: "ControlType.Document",
		50032: "ControlType.Window",
		50033: "ControlType.Pane",
		50040: "ControlType.AppBar",
		50041: "ControlType.Custom",
		0:     "ControlType.Custom",
	} {
		if got := controlName(id); got != want {
			t.Errorf("control type %d is %q, want %q", id, got, want)
		}
	}
}

func TestRectOfDropsEmptyRects(t *testing.T) {
	if r := rectOf(10, 20, 110, 70); r == nil || *r != (desktop.Rect{10, 20, 100, 50}) {
		t.Errorf("rect 10,20-110,70 is %v", r)
	}
	if r := rectOf(0, 0, 0, 0); r != nil {
		t.Errorf("an empty rect is %v, want nil", r)
	}
}

func TestSmallestAtPicksTheInnermostControl(t *testing.T) {
	big, small, away := &desktop.Rect{0, 0, 100, 100}, &desktop.Rect{40, 40, 20, 20}, &desktop.Rect{200, 0, 5, 5}
	if got := smallestAt([]*desktop.Rect{big, nil, small, away}, 50, 50); got != 2 {
		t.Errorf("at 50,50 picked %d, want the small one", got)
	}
	if got := smallestAt([]*desktop.Rect{big, small}, 100, 100); got != 0 {
		t.Errorf("on the big one's edge picked %d", got)
	}
	if got := smallestAt([]*desktop.Rect{small}, 5, 5); got != -1 {
		t.Errorf("outside every rect picked %d", got)
	}
}

func TestOneLine(t *testing.T) {
	if got := oneLine("Save\n\t as…", 60); got != "Save as…" {
		t.Errorf("got %q", got)
	}
	if got := oneLine(strings.Repeat("字", 70), 60); got != strings.Repeat("字", 60) {
		t.Errorf("long names keep 60 characters, got %d", len([]rune(got)))
	}
}

func TestDocumentTextPrefersWhatIsOnScreen(t *testing.T) {
	short := "hello"
	if got := documentText(short, func() string { t.Error("read the visible range of a short text"); return "" }); got != short {
		t.Errorf("short text became %q", got)
	}
	long := strings.Repeat("a", maxText) + "b"
	if got := documentText(long, func() string { return "on screen" }); got != "on screen" {
		t.Errorf("long text with a visible range became %q", got)
	}
	if got := documentText(long, func() string { return " \n" }); got != strings.Repeat("a", maxText) {
		t.Errorf("long text without a visible range kept %d characters", len(got))
	}
}

func TestGrabReply(t *testing.T) {
	edit := control{typeID: 50004}
	if got := grabReply(edit, []string{"one", "two"}); got != (desktop.GrabReply{OK: true, Control: "ControlType.Edit", Text: "one\ntwo"}) {
		t.Errorf("selection reply %+v", got)
	}
	if got := grabReply(edit, []string{}); !got.OK || got.Text != "" {
		t.Errorf("a text control with nothing selected answers %+v", got)
	}
	if got := grabReply(edit, nil); got.OK {
		t.Errorf("a control without a Text pattern answers %+v", got)
	}
	if got := grabReply(control{typeID: 50004, password: true}, []string{"secret"}); got.OK || got.Text != "" || !got.IsPassword {
		t.Errorf("a password field answers %+v", got)
	}
}

func TestPointReplyShape(t *testing.T) {
	win := &desktop.Rect{0, 0, 800, 600}
	chain := []control{
		{typeID: 50030, name: "Text  editor\n", class: "Edit", rect: &desktop.Rect{8, 50, 784, 500}},
		{typeID: 50032, name: "a.txt - Notepad", class: "Notepad", rect: win},
	}
	got, err := json.Marshal(pointReply(chain, false, true, win))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ok":true,"chain":[{"rect":[8,50,784,500],"control":"ControlType.Document","cls":"Edit","name":"Text editor "},{"rect":[0,0,800,600],"control":"ControlType.Window","cls":"Notepad","name":"a.txt - Notepad"}],"leafReadable":true,"win":[0,0,800,600]}`
	if string(got) != want {
		t.Errorf("point reply\n got %s\nwant %s", got, want)
	}
	empty, _ := json.Marshal(pointReply(nil, true, true, win))
	if string(empty) != `{"ok":true,"chain":[],"win":null}` {
		t.Errorf("nothing under the point answers %s", empty)
	}
}

func TestElementReply(t *testing.T) {
	link := control{typeID: typeHyperlink, name: "Docs", rect: &desktop.Rect{1, 2, 3, 4}, pid: 4242}
	got := elementReply(link, false, true, nil, "  Docs \n", "https://example.com/docs")
	if !got.OK || got.Text != "Docs" || got.Href != "https://example.com/docs" || got.Control != "ControlType.Hyperlink" || got.PID != 4242 {
		t.Errorf("link reply %+v", got)
	}
	if got := elementReply(link, false, true, nil, "Docs", "javascript:void(0)"); got.Href != "" {
		t.Errorf("a link to a script got href %q", got.Href)
	}
	if got := elementReply(control{typeID: 50020}, false, false, nil, "x", "https://example.com"); got.Href != "" {
		t.Errorf("plain text got href %q", got.Href)
	}
	if got := elementReply(control{typeID: 50030}, false, true, nil, strings.Repeat("字", maxText+5), ""); len([]rune(got.Text)) != maxText {
		t.Errorf("long text kept %d characters", len([]rune(got.Text)))
	}
	pw := elementReply(control{typeID: 50004, name: "Password", password: true, pid: 4242}, false, true, nil, "hunter2", "")
	if pw != (desktop.ElementReply{IsPassword: true}) {
		t.Errorf("a password field answers %+v", pw)
	}
}

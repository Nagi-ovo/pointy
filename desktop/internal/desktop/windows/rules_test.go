package windows

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func wheelData(delta int16) uint32 { return uint32(uint16(delta)) << 16 }

func TestMouseHookTakesClicksAndOnlyTheWheelItWants(t *testing.T) {
	const wmMouseMove, wmMButtonUp = 0x0200, 0x0208
	for _, tt := range []struct {
		name  string
		msg   uint32
		data  uint32
		wheel bool
		want  hookAction
	}{
		{"left down", wmLButtonDown, 0, false, hookAction{swallow: true}},
		{"left up", wmLButtonUp, 0, false, hookAction{swallow: true, report: true, button: desktop.LeftUp}},
		{"right down", wmRButtonDown, 0, false, hookAction{swallow: true}},
		{"right up", wmRButtonUp, 0, true, hookAction{swallow: true, report: true, button: desktop.RightUp}},
		{"move", wmMouseMove, 0, true, hookAction{}},
		{"middle up", wmMButtonUp, 0, true, hookAction{}},
		{"wheel not wanted", wmMouseWheel, wheelData(120), false, hookAction{}},
		{"wheel up", wmMouseWheel, wheelData(120), true, hookAction{swallow: true, report: true, button: desktop.WheelUp}},
		{"wheel down", wmMouseWheel, wheelData(-120), true, hookAction{swallow: true, report: true, button: desktop.WheelDown}},
		{"wheel, a touchpad's small step down", wmMouseWheel, wheelData(-8), true, hookAction{swallow: true, report: true, button: desktop.WheelDown}},
		{"wheel without a delta", wmMouseWheel, 0, true, hookAction{swallow: true}},
	} {
		if got := onMouse(tt.msg, tt.data, tt.wheel); got != tt.want {
			t.Errorf("%s: %+v, want %+v", tt.name, got, tt.want)
		}
	}
}

func TestFullscreen(t *testing.T) {
	monitor := desktop.Rect{0, 0, 1920, 1080}
	video := desktop.Rect{0, 0, 1920, 1080}
	maximized := desktop.Rect{-8, -8, 1936, 1048}
	for _, tt := range []struct {
		name  string
		state int32
		class string
		fg    desktop.Rect
		own   bool
		want  bool
	}{
		{"a game in exclusive full screen", qunsRunningD3DFullScreen, "UnityWndClass", maximized, false, true},
		{"a slideshow", qunsPresentationMode, "screenClass", maximized, false, true},
		{"a borderless video player", 1, "MediaPlayer", video, false, true},
		{"a maximized window above the taskbar", 1, "Notepad", maximized, false, false},
		{"the desktop", 1, "Progman", video, false, false},
		{"the taskbar", 1, "Shell_TrayWnd", video, false, false},
		{"Pointy's own window", 1, "mygo", video, true, false},
		{"something topmost filling the screen, not in front", 2, "Notepad", maximized, false, false},
	} {
		if got := fullscreen(tt.state, tt.class, tt.fg, monitor, tt.own); got != tt.want {
			t.Errorf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestCursorSize(t *testing.T) {
	for scale, want := range map[float64]int{1: 32, 1.25: 32, 1.5: 48, 1.75: 48, 2: 64, 3: 64, .5: 32} {
		if got := cursorSize(scale); got != want {
			t.Errorf("at %v the cursor is %d pixels, want %d", scale, got, want)
		}
	}
}

func TestCleanupCommandQuotesPathsForPowerShell(t *testing.T) {
	enc := cleanupCommand(4242, []string{`C:\Users\o'neil\.pointy`, `C:\Users\o'neil\AppData\Local\Pointy`})
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("not base64 UTF-16: %v", err)
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	script := string(utf16.Decode(u))
	for _, want := range []string{
		"Wait-Process -Id 4242 ",
		`'C:\Users\o''neil\.pointy', 'C:\Users\o''neil\AppData\Local\Pointy'`,
		"Remove-Item -LiteralPath $p -Recurse -Force",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("script lacks %q:\n%s", want, script)
		}
	}
}

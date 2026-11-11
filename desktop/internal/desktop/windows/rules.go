package windows

// Decisions the Win32 calls take, kept free of them so that their tests
// run on every platform.

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

const (
	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	wmRButtonDown = 0x0204
	wmRButtonUp   = 0x0205
	wmMouseWheel  = 0x020A
)

// hookAction is what the mouse hook does with one event while the user
// points: swallow keeps it from every app, and report sends button.
type hookAction struct {
	swallow bool
	report  bool
	button  desktop.Button
}

// onMouse decides for a low-level mouse message. mouseData is
// MSLLHOOKSTRUCT's, whose high word is the wheel's delta. Both buttons are
// swallowed down and up, so that no app sees half a click; moves pass.
func onMouse(msg uint32, mouseData uint32, wheel bool) hookAction {
	switch msg {
	case wmLButtonDown, wmRButtonDown:
		return hookAction{swallow: true}
	case wmLButtonUp:
		return hookAction{swallow: true, report: true, button: desktop.LeftUp}
	case wmRButtonUp:
		return hookAction{swallow: true, report: true, button: desktop.RightUp}
	case wmMouseWheel:
		if !wheel {
			return hookAction{}
		}
		switch delta := int16(mouseData >> 16); {
		case delta > 0:
			return hookAction{swallow: true, report: true, button: desktop.WheelUp}
		case delta < 0:
			return hookAction{swallow: true, report: true, button: desktop.WheelDown}
		}
		return hookAction{swallow: true}
	}
	return hookAction{}
}

const (
	qunsRunningD3DFullScreen = 3
	qunsPresentationMode     = 4
)

// shellClasses are the desktop and the taskbars, which cover a display
// without being an app in full screen.
var shellClasses = map[string]bool{"Progman": true, "WorkerW": true, "Shell_TrayWnd": true, "Shell_SecondaryTrayWnd": true}

// fullscreen decides from SHQueryUserNotificationState and the foreground
// window, unless skipFg: it is Pointy's own or could not be read.
// QUNS_BUSY does not count: any topmost window that fills a
// display sets it, such as a screen recorder's mask; an app the user
// watches in full screen is the foreground window, which the second test
// catches, and borderless games often report no full-screen state at all.
// A maximized window (fgZoomed) never counts: its invisible borders reach
// past the display, and with an auto-hidden taskbar it covers all of it.
// Games and F11 full screen are not maximized.
func fullscreen(state int32, fgClass string, fg, monitor desktop.Rect, fgZoomed, skipFg bool) bool {
	if state == qunsRunningD3DFullScreen || state == qunsPresentationMode {
		return true
	}
	if skipFg || fgZoomed || shellClasses[fgClass] {
		return false
	}
	return fg[0] <= monitor[0] && fg[1] <= monitor[1] && fg[0]+fg[2] >= monitor[0]+monitor[2] && fg[1]+fg[3] >= monitor[1]+monitor[3]
}

// cursorSize is the size of Pointy's cursor files nearest to 32 pixels at
// scale.
func cursorSize(scale float64) int {
	want := 32 * scale
	best := 32
	for _, s := range []int{48, 64} {
		if d, b := float64(s)-want, float64(best)-want; max(d, -d) < max(b, -b) {
			best = s
		}
	}
	return best
}

// browsers are the browsers the extension runs in, by executable.
var browsers = map[string]desktop.BrowserKind{
	"chrome.exe":  desktop.BrowserChrome,
	"msedge.exe":  desktop.BrowserEdge,
	"brave.exe":   desktop.BrowserChrome,
	"vivaldi.exe": desktop.BrowserChrome,
}

// blockedApps are never read: password managers and the system's sign-in
// and consent screens.
var blockedApps = map[string]bool{
	"keepass.exe": true, "keepassxc.exe": true, "1password.exe": true, "bitwarden.exe": true, "lastpass.exe": true,
	"enpass.exe": true, "dashlane.exe": true, "roboform.exe": true, "credentialuibroker.exe": true, "consent.exe": true,
	"logonui.exe": true, "lockapp.exe": true,
}

// cleanupCommand is the PowerShell that waits up to 30 seconds for
// process pid to exit, then deletes paths, retrying while WebView2's
// processes still hold files in them. It comes back encoded for
// -EncodedCommand.
func cleanupCommand(pid int, paths []string) string {
	quote := func(p string) string { return "'" + strings.ReplaceAll(p, "'", "''") + "'" }
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = quote(p)
	}
	script := strings.Join([]string{
		fmt.Sprintf("Wait-Process -Id %d -Timeout 30 -ErrorAction SilentlyContinue", pid),
		"$paths = @(" + strings.Join(quoted, ", ") + ")",
		"for ($i = 0; $i -lt 20; $i++) {",
		"  $left = @($paths | Where-Object { Test-Path -LiteralPath $_ })",
		"  if ($left.Count -eq 0) { break }",
		"  foreach ($p in $left) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }",
		"  Start-Sleep -Milliseconds 500",
		"}",
	}, "\n")
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

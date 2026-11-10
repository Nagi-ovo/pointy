//go:build darwin

package darwin

import "github.com/pointylab/pointy/desktop/internal/desktop"

// Foreground names apps by their executable's base name in lower case.

var browsers = map[string]desktop.BrowserKind{
	"google chrome": desktop.BrowserChrome, "google chrome beta": desktop.BrowserChrome, "google chrome dev": desktop.BrowserChrome,
	"google chrome canary": desktop.BrowserChrome, "google chrome for testing": desktop.BrowserChrome,
	"microsoft edge": desktop.BrowserEdge, "brave browser": desktop.BrowserChrome, "vivaldi": desktop.BrowserChrome,
	"chromium": desktop.BrowserChrome, "arc": desktop.BrowserChrome,
}

var blocked = map[string]bool{
	"1password": true, "1password 7": true, "bitwarden": true, "keepassxc": true, "enpass": true, "dashlane": true,
	"lastpass": true, "keychain access": true, "passwords": true, "securityagent": true, "loginwindow": true,
	"coreautha": true, "screensaverengine": true,
}

func (*Desktop) Browser(exe string) (desktop.BrowserKind, bool) {
	k, ok := browsers[exe]
	return k, ok
}

func (*Desktop) Blocked(exe string) bool { return blocked[exe] }

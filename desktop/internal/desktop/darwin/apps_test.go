//go:build darwin

package darwin

import (
	"testing"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

func TestBrowserKnowsEveryChromeChannel(t *testing.T) {
	d := &Desktop{}
	for _, exe := range []string{"google chrome", "google chrome beta", "google chrome dev", "google chrome canary", "google chrome for testing", "chromium"} {
		if k, ok := d.Browser(exe); !ok || k != desktop.BrowserChrome {
			t.Errorf("Browser(%q) = %q, %v; want chrome", exe, k, ok)
		}
	}
	if _, ok := d.Browser("textedit"); ok {
		t.Error("TextEdit counts as a browser")
	}
}

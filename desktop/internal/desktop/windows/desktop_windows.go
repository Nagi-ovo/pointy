// Package windows implements desktop.Desktop on Windows, where screen units
// are physical pixels: mygo makes the process per-monitor DPI aware. It
// ports app/core/os/win32.ts and app/pick/native/uia-selection.ps1. The
// files without a build constraint hold its decisions, tested on every
// platform; the others make the Win32 and UI Automation calls.
package windows

import (
	"sync/atomic"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

type Desktop struct {
	cursorDir     string
	cursorSwapped atomic.Bool
	uia           uiaClient
}

var _ desktop.Desktop = (*Desktop)(nil)

// New takes the directory of Pointy's cursor files. It puts the user's
// cursors back, in case a Pointy before this one died while the user
// pointed.
func New(cursorDir string) *Desktop {
	restoreCursors()
	return &Desktop{cursorDir: cursorDir}
}

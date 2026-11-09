//go:build windows

package windows

import (
	"fmt"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procLoadImageW            = user32.NewProc("LoadImageW")
	procSetSystemCursor       = user32.NewProc("SetSystemCursor")
	procDestroyCursor         = user32.NewProc("DestroyCursor")
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
)

const (
	imageCursor    = 2
	lrLoadFromFile = 0x10
	spiSetCursors  = 0x57
)

// swappedCursors are OCR_NORMAL, OCR_IBEAM, OCR_HAND and OCR_CROSS: the
// shapes the cursor takes over the apps the user points in.
var swappedCursors = []uintptr{32512, 32513, 32649, 32515}

// SwapCursor replaces the system cursors with Pointy's, in the size the
// display under the mouse wants.
func (d *Desktop) SwapCursor() error {
	scale := space().unitsPerDIP(d.Cursor())
	file := filepath.Join(d.cursorDir, fmt.Sprintf("cursor-%d.cur", cursorSize(scale)))
	name, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	for _, id := range swappedCursors {
		// SetSystemCursor takes the handle over and destroys it, so each
		// shape gets its own copy.
		h, _, err := procLoadImageW.Call(0, uintptr(unsafe.Pointer(name)), imageCursor, 0, 0, lrLoadFromFile)
		if h == 0 {
			return fmt.Errorf("load %s: %w", file, err)
		}
		if ok, _, err := procSetSystemCursor.Call(h, id); ok == 0 {
			procDestroyCursor.Call(h)
			return fmt.Errorf("SetSystemCursor %d: %w", id, err)
		}
		d.cursorSwapped.Store(true)
	}
	return nil
}

func (d *Desktop) RestoreCursor() {
	if d.cursorSwapped.Swap(false) {
		restoreCursors()
	}
}

// restoreCursors has Windows reload the user's cursor scheme from the
// registry, which Pointy never writes.
func restoreCursors() { procSystemParametersInfoW.Call(spiSetCursors, 0, 0, 0) }

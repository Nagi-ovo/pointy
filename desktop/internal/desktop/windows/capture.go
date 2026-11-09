//go:build windows

package windows

import (
	"context"
	"errors"
	"fmt"
	"image"
	"sync"
	"unsafe"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var (
	procGetDC                    = user32.NewProc("GetDC")
	procReleaseDC                = user32.NewProc("ReleaseDC")
	procCreateCompatibleDC       = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection         = gdi32.NewProc("CreateDIBSection")
	procSelectObject             = gdi32.NewProc("SelectObject")
	procBitBlt                   = gdi32.NewProc("BitBlt")
	procDeleteDC                 = gdi32.NewProc("DeleteDC")
	procSetWindowDisplayAffinity = user32.NewProc("SetWindowDisplayAffinity")
	procDwmFlush                 = dwmapi.NewProc("DwmFlush")
)

const (
	// SRCCOPY with CAPTUREBLT, which takes layered windows in too.
	srcCopyCaptureBlt     = 0x00CC0020 | 0x40000000
	wdaNone               = 0
	wdaExcludeFromCapture = 0x11
	// excludeFrames is how many compositions pass before a window left out
	// of captures is gone from the screen GDI reads.
	excludeFrames = 2
)

// captureMu keeps one capture from putting Pointy's windows back while
// another takes its copy.
var captureMu sync.Mutex

func (*Desktop) PrewarmCapture() {}

// Capture copies r from the screen, which shows whatever window is in
// front there, so pid is not needed. A pick's overlay is still up while
// the pick is read, so Pointy's windows are left out of captures for the
// copy (Windows 10 2004 and later) and shown to screen recorders again
// after.
func (*Desktop) Capture(ctx context.Context, r desktop.Rect, _ int) (image.Image, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	captureMu.Lock()
	defer captureMu.Unlock()
	defer excludeOwnWindows()()
	return CaptureScreen(r)
}

// excludeOwnWindows leaves Pointy's shown windows out of captures and
// returns what puts them back. It sets WDA_EXCLUDEFROMCAPTURE alone, not
// the WDA_MONITOR older Windows falls back to, which would black out the
// whole display the overlay covers.
func excludeOwnWindows() (restore func()) {
	var left []uintptr
	mygo.RunOnMain(func() {
		for _, w := range mygo.Windows() {
			if w.IsDestroyed() || !w.IsVisible() {
				continue
			}
			h := w.NativeHandle()
			if ok, _, _ := procSetWindowDisplayAffinity.Call(h, wdaExcludeFromCapture); ok != 0 {
				left = append(left, h)
			}
		}
	})
	if len(left) > 0 && procDwmFlush.Find() == nil {
		for range excludeFrames {
			procDwmFlush.Call()
		}
	}
	return func() {
		mygo.RunOnMain(func() {
			for _, h := range left {
				procSetWindowDisplayAffinity.Call(h, wdaNone)
			}
		})
	}
}

type bitmapInfoHeader struct {
	Size          uint32
	Width, Height int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
}

// CaptureScreen copies r from the screen with GDI, Pointy's windows
// included. Screen units are pixels on Windows, so the image is r's size.
func CaptureScreen(r desktop.Rect) (image.Image, error) {
	w, h := r[2], r[3]
	if w <= 0 || h <= 0 {
		return nil, errors.New("windows: nothing to capture")
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, errors.New("windows: GetDC failed")
	}
	defer procReleaseDC.Call(0, screen)
	mem, _, _ := procCreateCompatibleDC.Call(screen)
	if mem == 0 {
		return nil, errors.New("windows: CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(mem)
	bi := bitmapInfoHeader{Width: int32(w), Height: -int32(h), Planes: 1, BitCount: 32}
	bi.Size = uint32(unsafe.Sizeof(bi))
	var bits unsafe.Pointer
	bmp, _, err := procCreateDIBSection.Call(screen, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		return nil, fmt.Errorf("CreateDIBSection: %w", err)
	}
	defer procDeleteObject.Call(bmp)
	old, _, _ := procSelectObject.Call(mem, bmp)
	ok, _, err := procBitBlt.Call(mem, 0, 0, uintptr(w), uintptr(h), screen, uintptr(r[0]), uintptr(r[1]), srcCopyCaptureBlt)
	procSelectObject.Call(mem, old)
	if ok == 0 {
		return nil, fmt.Errorf("BitBlt: %w", err)
	}
	src := unsafe.Slice((*byte)(bits), w*h*4)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(src); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = src[i+2], src[i+1], src[i], 255
	}
	return img, nil
}

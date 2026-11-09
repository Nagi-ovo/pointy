//go:build windows

package windows

import (
	"errors"
	"fmt"
	"image"
	"runtime"
	"unsafe"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var (
	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
)

// SRCCOPY with CAPTUREBLT, which takes layered windows in too.
const srcCopyCaptureBlt = 0x00CC0020 | 0x40000000

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

// Capture copies r from the screen with GDI. Screen units are pixels on
// Windows, so the image is r's size.
func (*Desktop) Capture(r desktop.Rect) (image.Image, error) {
	w, h := r[2], r[3]
	if w <= 0 || h <= 0 {
		return nil, errors.New("windows: nothing to capture")
	}
	// ReleaseDC must run on the thread that called GetDC, and GDI batches
	// its calls per thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
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

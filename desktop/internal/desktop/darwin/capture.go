//go:build darwin

package darwin

import (
	"context"
	"errors"
	"image"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego/objc"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

// A pick's picture is taken of the one window it points into, so Pointy's
// overlay and cards never show in it and nothing has to hide first.
// ScreenCaptureKit takes it on macOS 14 and later; its window list is slow
// the first time, so pointing fetches it ahead. Below 14, or when
// ScreenCaptureKit fails, CoreGraphics takes it.

const (
	shareableFresh       = 30 * time.Second
	listOptionIncluding  = 8
	imageIgnoreFraming   = 1
	imageBestResolution  = 8
	alphaPremultLast     = 1
	byteOrder32Big       = 4 << 12
	interpolationHigh    = 3
	captureBytesPerPixel = 4
)

var screenCaptureKit = true

var (
	errNoCaptureWindow = errors.New("no window of that app under the rectangle")
	errCaptureFailed   = errors.New("the window could not be captured")
)

var shareable struct {
	mu      sync.Mutex
	content objc.ID
	at      time.Time
}

func haveScreenCaptureKit() bool {
	load()
	return screenCaptureKit && class("SCScreenshotManager") != 0
}

// fetchShareable asks ScreenCaptureKit for the windows on screen and keeps
// the answer.
func fetchShareable(ctx context.Context) (objc.ID, error) {
	type reply struct{ content, err objc.ID }
	out := make(chan reply, 1)
	block := objc.NewBlock(func(_ objc.Block, content, err objc.ID) {
		if content != 0 {
			content.Send(sel("retain"))
		}
		out <- reply{content, err}
	})
	defer block.Release()
	class("SCShareableContent").Send(sel("getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:"), true, true, block)
	select {
	case r := <-out:
		if r.content == 0 {
			return 0, errCaptureFailed
		}
		shareable.mu.Lock()
		if shareable.content != 0 {
			shareable.content.Send(sel("release"))
		}
		shareable.content, shareable.at = r.content, time.Now()
		r.content.Send(sel("retain"))
		shareable.mu.Unlock()
		return r.content, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func (*Desktop) PrewarmCapture() {
	if !haveScreenCaptureKit() {
		return
	}
	go withPool(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if c, err := fetchShareable(ctx); err == nil {
			c.Send(sel("release"))
		}
	})
}

// scWindow finds window id in the kept window list, or in a fresh one.
// The caller releases what it returns.
func scWindow(ctx context.Context, id desktop.WindowID) (objc.ID, error) {
	find := func(content objc.ID) objc.ID {
		windows := content.Send(sel("windows"))
		for i := range objc.Send[int](windows, sel("count")) {
			w := windows.Send(sel("objectAtIndex:"), i)
			if desktop.WindowID(objc.Send[uint32](w, sel("windowID"))) == id {
				return w.Send(sel("retain"))
			}
		}
		return 0
	}
	shareable.mu.Lock()
	content := shareable.content
	if content != 0 && time.Since(shareable.at) < shareableFresh {
		content.Send(sel("retain"))
	} else {
		content = 0
	}
	shareable.mu.Unlock()
	if content != 0 {
		w := find(content)
		content.Send(sel("release"))
		if w != 0 {
			return w, nil
		}
	}
	content, err := fetchShareable(ctx)
	if err != nil {
		return 0, err
	}
	defer content.Send(sel("release"))
	if w := find(content); w != 0 {
		return w, nil
	}
	return 0, errNoCaptureWindow
}

func captureSCK(ctx context.Context, win cgWindow, r cgRect) (img *image.RGBA, err error) {
	withPool(func() {
		var w objc.ID
		if w, err = scWindow(ctx, win.id); err != nil {
			return
		}
		defer w.Send(sel("release"))
		filter := class("SCContentFilter").Send(sel("alloc")).Send(sel("initWithDesktopIndependentWindow:"), w)
		defer filter.Send(sel("release"))
		scale := float64(objc.Send[float32](filter, sel("pointPixelScale")))
		conf := class("SCStreamConfiguration").Send(sel("new"))
		defer conf.Send(sel("release"))
		local := cgRect{cgPoint{r.Origin.X - float64(win.bounds.X), r.Origin.Y - float64(win.bounds.Y)}, r.Size}
		conf.Send(sel("setSourceRect:"), local)
		conf.Send(sel("setWidth:"), int(r.Size.W*scale+0.5))
		conf.Send(sel("setHeight:"), int(r.Size.H*scale+0.5))
		conf.Send(sel("setShowsCursor:"), false)
		type reply struct {
			img uintptr
			err objc.ID
		}
		out := make(chan reply, 1)
		block := objc.NewBlock(func(_ objc.Block, img uintptr, err objc.ID) {
			if img != 0 {
				cfRetain(img)
			}
			out <- reply{img, err}
		})
		defer block.Release()
		class("SCScreenshotManager").Send(sel("captureImageWithFilter:configuration:completionHandler:"), filter, conf, block)
		select {
		case rep := <-out:
			if rep.img == 0 {
				err = errCaptureFailed
				return
			}
			defer cgImageRelease(rep.img)
			img = rgbaOf(rep.img)
		case <-ctx.Done():
			err = ctx.Err()
		}
	})
	if err == nil && img == nil {
		err = errCaptureFailed
	}
	return img, err
}

func captureCG(win cgWindow, r cgRect) (*image.RGBA, error) {
	if cgWindowListCreateImage == nil {
		return nil, errCaptureFailed
	}
	ref := cgWindowListCreateImage(r, listOptionIncluding, uint32(win.id), imageIgnoreFraming|imageBestResolution)
	if ref == 0 {
		return nil, errCaptureFailed
	}
	defer cgImageRelease(ref)
	if img := rgbaOf(ref); img != nil {
		return img, nil
	}
	return nil, errCaptureFailed
}

// rgbaOf draws a CGImage into RGBA pixels over white, since window
// corners are transparent and JPEG has no alpha.
func rgbaOf(ref uintptr) *image.RGBA {
	w, h := cgImageGetWidth(ref), cgImageGetHeight(ref)
	if w <= 0 || h <= 0 {
		return nil
	}
	space := cgColorSpaceCreateWithName(kCGColorSpaceSRGB)
	defer cgColorSpaceRelease(space)
	ctx := cgBitmapContextCreate(0, w, h, 8, w*captureBytesPerPixel, space, alphaPremultLast|byteOrder32Big)
	if ctx == 0 {
		return nil
	}
	defer cgContextRelease(ctx)
	cgContextDrawImage(ctx, cgRect{Size: cgSize{float64(w), float64(h)}}, ref)
	data := cgBitmapContextGetData(ctx)
	if data == nil {
		return nil
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, unsafe.Slice((*byte)(data), len(img.Pix)))
	for i := 0; i < len(img.Pix); i += 4 {
		if a := img.Pix[i+3]; a != 255 {
			under := 255 - a
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = img.Pix[i]+under, img.Pix[i+1]+under, img.Pix[i+2]+under, 255
		}
	}
	return img
}

func (*Desktop) Capture(ctx context.Context, r desktop.Rect, pid int) (image.Image, error) {
	win, ok := windowOf(pid, desktop.Point{X: float64(r[0] + r[2]/2), Y: float64(r[1] + r[3]/2)})
	if !ok {
		return nil, errNoCaptureWindow
	}
	b := win.bounds
	x0, y0 := max(r[0], b.X), max(r[1], b.Y)
	x1, y1 := min(r[0]+r[2], b.X+b.Width), min(r[1]+r[3], b.Y+b.Height)
	if x1-x0 < 2 || y1-y0 < 2 {
		return nil, errNoCaptureWindow
	}
	clip := cgRect{cgPoint{float64(x0), float64(y0)}, cgSize{float64(x1 - x0), float64(y1 - y0)}}
	if haveScreenCaptureKit() {
		if img, err := captureSCK(ctx, win, clip); err == nil {
			return img, nil
		}
	}
	return captureCG(win, clip)
}

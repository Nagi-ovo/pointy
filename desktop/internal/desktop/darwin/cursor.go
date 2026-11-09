//go:build darwin

package darwin

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

// A background app may set the cursor only once the window server's
// private SetsCursorInBackground is on. The app under the mouse sets its
// own cursor back as the mouse moves, so the whale is set again every
// frame while the user points.

const (
	cursorPoints = 32
	cursorReset  = 16 * time.Millisecond
)

var errNoCursor = errors.New("the cursor images could not be loaded")

var cursor struct {
	mu     sync.Mutex
	whale  objc.ID
	stop   chan struct{}
	active atomic.Bool
}

// makeWhale builds the cursor from the same image and hot spot as the
// Windows cursor file. Main thread only.
func (d *Desktop) makeWhale() objc.ID {
	dir := filepath.Join(d.assets, "cursor")
	cur, err := os.ReadFile(filepath.Join(dir, "cursor-32.cur"))
	if err != nil || len(cur) < 14 {
		return 0
	}
	hot := cgPoint{X: float64(binary.LittleEndian.Uint16(cur[10:])), Y: float64(binary.LittleEndian.Uint16(cur[12:]))}
	conn := cgsDefaultConnection()
	key := cfString("SetsCursorInBackground")
	cgsSetConnectionProperty(conn, conn, key, kCFBooleanTrue)
	cfRelease(key)
	var whale objc.ID
	withPool(func() {
		img := class("NSImage").Send(sel("alloc")).Send(sel("initWithContentsOfFile:"), nsString(filepath.Join(dir, "cursor-64.png")))
		if img == 0 {
			return
		}
		img.Send(sel("setSize:"), cgSize{cursorPoints, cursorPoints})
		whale = class("NSCursor").Send(sel("alloc")).Send(sel("initWithImage:hotSpot:"), img, hot)
		img.Send(sel("release"))
	})
	return whale
}

func (d *Desktop) SwapCursor() error {
	load()
	cursor.mu.Lock()
	defer cursor.mu.Unlock()
	if cursor.stop != nil {
		return nil
	}
	if cursor.whale == 0 {
		mygo.RunOnMain(func() { cursor.whale = d.makeWhale() })
		if cursor.whale == 0 {
			return errNoCursor
		}
	}
	stop := make(chan struct{})
	cursor.stop = stop
	cursor.active.Store(true)
	whale := cursor.whale
	set := func() {
		if cursor.active.Load() {
			whale.Send(sel("set"))
		}
	}
	mygo.RunOnMain(set)
	go func() {
		t := time.NewTicker(cursorReset)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				mygo.RunOnMain(set)
			}
		}
	}()
	return nil
}

func (*Desktop) RestoreCursor() {
	cursor.mu.Lock()
	defer cursor.mu.Unlock()
	if cursor.stop == nil {
		return
	}
	cursor.active.Store(false)
	close(cursor.stop)
	cursor.stop = nil
	mygo.RunOnMain(func() { class("NSCursor").Send(sel("arrowCursor")).Send(sel("set")) })
}

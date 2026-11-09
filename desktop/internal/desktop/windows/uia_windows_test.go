package windows

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/pointylab/pointy/desktop/internal/desktop"
	"golang.org/x/sys/windows"
)

var (
	procFindWindowW                   = user32.NewProc("FindWindowW")
	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
)

func TestMain(m *testing.M) {
	// What mygo does at start: UIA and GDI then speak physical pixels.
	procSetProcessDpiAwarenessContext.Call(^uintptr(3))
	os.Exit(m.Run())
}

// openNotepad shows text in a Notepad of its own and returns its window.
func openNotepad(t *testing.T, text string) windows.HWND {
	t.Helper()
	dir := t.TempDir()
	name := "pointy-uia-" + time.Now().Format("150405.000") + ".txt"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("notepad.exe", filepath.Join(dir, name))
	if err := cmd.Start(); err != nil {
		t.Skipf("no Notepad: %v", err)
	}
	title, _ := windows.UTF16PtrFromString(name + " - Notepad")
	var h uintptr
	for deadline := time.Now().Add(10 * time.Second); h == 0 && time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		h, _, _ = procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	}
	if h == 0 {
		cmd.Process.Kill()
		t.Fatalf("Notepad showed no window titled %q", name+" - Notepad")
	}
	t.Cleanup(func() {
		const wmClose = 0x0010
		procPostMessageW.Call(h, wmClose, 0, 0)
		cmd.Process.Kill()
	})
	return windows.HWND(h)
}

var procPostMessageW = user32.NewProc("PostMessageW")

func TestUIAReadsNotepad(t *testing.T) {
	const text = "Pointy reads this line through UI Automation."
	h := openNotepad(t, text)
	r, ok := windowRect(h)
	if !ok {
		t.Fatal("no rect for Notepad")
	}
	// Below the menu bar, in the text.
	p := desktop.Point{X: float64(r.Left+r.Right) / 2, Y: float64(r.Top+r.Bottom) / 2}
	d := New(t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	point, err := d.PointAt(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !point.OK || len(point.Chain) == 0 {
		t.Fatalf("nothing under %+v: %+v", p, point)
	}
	if c := point.Chain[0].Control; c != "ControlType.Document" && c != "ControlType.Edit" {
		t.Errorf("under the text is %q", c)
	}
	if point.Win == nil || point.Win[2] < 100 {
		t.Errorf("Notepad's window is %v", point.Win)
	}

	el, err := d.ElementAt(ctx, p, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !el.OK || !strings.Contains(el.Text, text) {
		t.Errorf("element under the text answers %+v", el)
	}

	up, err := d.ElementAt(ctx, p, len(point.Chain)-1)
	if err != nil {
		t.Fatal(err)
	}
	if up.Control != point.Chain[len(point.Chain)-1].Control {
		t.Errorf("the top of the chain is %q, element at that level %q", point.Chain[len(point.Chain)-1].Control, up.Control)
	}
}

func TestWindowAtNamesNotepad(t *testing.T) {
	h := openNotepad(t, "Pointy names this window.")
	r, ok := windowRect(h)
	if !ok {
		t.Fatal("no rect for Notepad")
	}
	p := desktop.Point{X: float64(r.Left+r.Right) / 2, Y: float64(r.Top+r.Bottom) / 2}
	d := New(t.TempDir())
	w, err := d.WindowAt(int(processOf(h)), p)
	if err != nil {
		t.Fatal(err)
	}
	if w.ID != desktop.WindowID(h) || w.Exe != "notepad.exe" || !strings.HasPrefix(w.Title, "pointy-uia-") {
		t.Errorf("WindowAt the middle of Notepad = %+v, want window %#x", w, h)
	}
	if _, err := d.WindowAt(os.Getpid(), p); err == nil {
		t.Error("WindowAt named a window of Pointy's own process")
	}
}

// A command stuck in an app that hangs costs its deadline, and the next
// command runs on a new worker at once.
func TestUIAMovesOnFromAHungCommand(t *testing.T) {
	var c uiaClient
	short, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := uiaCall(short, &c, func(*uia) bool { time.Sleep(2 * time.Second); return true }); err == nil {
		t.Fatal("the hung command answered")
	}
	if waited := time.Since(start); waited > time.Second {
		t.Errorf("the hung command held its caller %v", waited)
	}
	ctx, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if ok, err := uiaCall(ctx, &c, func(*uia) bool { return true }); err != nil || !ok {
		t.Errorf("the next command failed: %v", err)
	}
}

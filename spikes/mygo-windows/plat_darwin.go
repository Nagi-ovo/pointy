//go:build darwin

// The macOS side exists only to dry-run the test's page logic, layout and
// sampling on a Mac: none of the Win32 checks have a meaning here.
package main

import (
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func platformInit() { mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory) }

func foreground() uintptr         { return 0 }
func windowInfo(h uintptr) string { return fmt.Sprintf("0x%x", h) }
func sysInfo() []string {
	v, _ := exec.Command("sw_vers", "-productVersion").Output()
	return []string{"macOS " + string(v) + " (dry run: Win32 checks are stubs)"}
}
func screenScale(mygo.Display) float64 { return 1 }

var backdropWin *mygo.Window

func newBackdrop(r prect, c rgb) func() {
	backdropWin = mygo.NewWindow(mygo.WindowOptions{
		X: r.L, Y: r.T, Width: r.W(), Height: r.H(), Frameless: true, SkipTaskbar: true, DisableShadow: true, DisableResize: true,
		Content: ui.View(func(cx *ui.Context) { ui.Box(cx).Fill().Background(ui.RGB(uint8(c.R), uint8(c.G), uint8(c.B))) }),
	})
	backdropWin.ShowInactive()
	return func() { backdropWin.Destroy() }
}

func raise(*mygo.Window)                            {}
func placeBelow(*mygo.Window)                       {}
func noActivate(*mygo.Window)                       {}
func exStyle(*mygo.Window) string                   { return "n/a" }
func blurBehind(*mygo.Window) string                { return "n/a on macOS" }
func dpiOf(*mygo.Window) int                        { return 0 }
func hitTest(int, int, *mygo.Window) (bool, string) { return true, "n/a on macOS" }
func setOwner(*mygo.Window, uintptr) (bool, string) { return true, "n/a on macOS" }

func clientRect(w *mygo.Window) prect {
	var b mygo.Rectangle
	mygo.RunOnMain(func() { b = w.ContentBounds() })
	return prect{b.X, b.Y, b.X + b.Width, b.Y + b.Height}
}

// capture uses screencapture and converts to sRGB, so values compare with
// the CSS colors.
func capture(r prect) (shot, error) {
	dir, _ := os.MkdirTemp("", "pointy-cap")
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "c.png")
	if err := exec.Command("screencapture", "-x", "-t", "png", fmt.Sprintf("-R%d,%d,%d,%d", r.L, r.T, r.W(), r.H()), p).Run(); err != nil {
		return shot{}, err
	}
	exec.Command("sips", "--matchTo", "/System/Library/ColorSync/Profiles/sRGB Profile.icc", p).Run()
	f, err := os.Open(p)
	if err != nil {
		return shot{}, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return shot{}, err
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, rgba.Bounds(), img, img.Bounds().Min, draw.Src)
	return shot{rgba, r}, nil
}

func captureDXGI(prect) (shot, error) { return shot{}, errors.New("n/a on macOS") }

func showMessage(title, text string) { fmt.Println(title + "\n" + text) }

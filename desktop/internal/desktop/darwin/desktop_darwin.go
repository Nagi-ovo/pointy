//go:build darwin

// Package darwin implements desktop.Desktop on macOS, where screen units
// are points with the origin at the primary display's top-left corner.
package darwin

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"

	"github.com/ebitengine/purego/objc"
	"github.com/pointylab/pointy/desktop/internal/desktop"
)

var _ desktop.Desktop = (*Desktop)(nil)

// Desktop answers ToDIP, ToScreen, RectToDIP and UnitsPerDIP as
// desktop.Unsupported does, since macOS screen units are points, as
// mygo's are.
type Desktop struct {
	desktop.Unsupported
	assets string
}

// New takes the directory holding Pointy's cursor images.
func New(assets string) *Desktop { return &Desktop{assets: assets} }

var accessPrompted atomic.Bool

// AccessHint shows the system's Accessibility prompt the first time it
// finds the grant missing.
func (*Desktop) AccessHint() string {
	load()
	trusted := false
	withPool(func() {
		prompt := !accessPrompted.Load()
		value := class("NSNumber").Send(sel("numberWithBool:"), prompt)
		options := class("NSDictionary").Send(sel("dictionaryWithObject:forKey:"), value, objc.ID(kAXTrustedCheckOptionPrompt))
		trusted = axIsProcessTrustedWithOptions(uintptr(options))
	})
	if trusted {
		return ""
	}
	accessPrompted.Store(true)
	return "要先允许 Pointy 使用辅助功能：系统设置 → 隐私与安全性 → 辅助功能"
}

// AllowAnyForeground does nothing: an app Pointy opens comes forward on
// its own.
func (*Desktop) AllowAnyForeground() {}

func (*Desktop) RemoveAfterExit(paths []string) error {
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
	}
	script := fmt.Sprintf("i=0; while kill -0 %d 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; rm -rf %s", os.Getpid(), strings.Join(quoted, " "))
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

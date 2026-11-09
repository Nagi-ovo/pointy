//go:build darwin

// Package darwin implements desktop.Desktop on macOS, where screen units
// are points with the origin at the primary display's top-left corner.
package darwin

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/pointylab/pointy/desktop/internal/desktop"
)

type Desktop struct {
	desktop.Unsupported
}

func New() *Desktop { return &Desktop{} }

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

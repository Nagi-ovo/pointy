package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	orphanPoll = 5 * time.Second
	quitGrace  = 10 * time.Second
)

// HostOptions describe how DSH runs Pointy.
type HostOptions struct {
	// Managed is POINTY_MANAGED: DSH started Pointy, and Pointy quits
	// without it.
	Managed bool
	// HostPID is POINTY_HOST_PID, the DSH process.
	HostPID int
	// PluginRoot is the plugin's install directory, when Pointy runs from
	// one; uninstalling the plugin removes its package.json.
	PluginRoot string
	// Cleanup lists what goes with the plugin: Pointy's home and data.
	Cleanup []string
	// RemoveAfterExit deletes paths once Pointy has exited.
	RemoveAfterExit func([]string) error
	Quit            func()
}

type host struct {
	opts      HostOptions
	connected func() bool
	log       func(string, any)

	mu   sync.Mutex
	quit *time.Timer
}

func newHost(o HostOptions, connected func() bool, log func(string, any)) *host {
	if log == nil {
		log = func(string, any) {}
	}
	if o.Quit == nil {
		o.Quit = func() {}
	}
	h := &host{opts: o, connected: connected, log: log}
	if o.Managed && o.HostPID > 0 {
		go func() {
			for range time.Tick(orphanPoll) {
				if h.orphaned() {
					h.log("orphan", fmt.Sprintf("DSH host %d is gone and no plugin is connected; quitting", o.HostPID))
					o.Quit()
					return
				}
			}
		}()
	}
	return h
}

func (h *host) orphaned() bool { return !h.connected() && !processAlive(h.opts.HostPID) }

func (h *host) linked() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.quit != nil {
		h.quit.Stop()
	}
}

func (h *host) unlinked(everConnected bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.quit != nil {
		h.quit.Stop()
	}
	if everConnected && h.opts.Managed {
		h.quit = time.AfterFunc(quitGrace, func() {
			if !h.connected() {
				h.opts.Quit()
			}
		})
	}
}

var pluginDir = regexp.MustCompile(`(?i)[\\/]node_modules[\\/]@pointylab[\\/]dsh$`)

// uninstalled reports whether DSH removed the plugin: pnpm deletes its
// package.json, while files Pointy holds open stay behind.
func (h *host) uninstalled() bool {
	root := h.opts.PluginRoot
	if root == "" || !pluginDir.MatchString(root) {
		return false
	}
	_, err := os.Stat(filepath.Join(root, "package.json"))
	return os.IsNotExist(err)
}

func (h *host) willQuit() {
	if !h.opts.Managed || !h.uninstalled() || h.opts.RemoveAfterExit == nil {
		return
	}
	var targets []string
	for _, p := range append(h.opts.Cleanup, h.opts.PluginRoot) {
		if _, err := os.Stat(p); err == nil {
			targets = append(targets, p)
		}
	}
	h.log("uninstall", "plugin removed; cleaning "+strings.Join(targets, ", "))
	if err := h.opts.RemoveAfterExit(targets); err != nil {
		h.log("uninstall", err)
	}
}

// FindPluginRoot returns the plugin directory that holds exe, or "".
func FindPluginRoot(exe string) string {
	for dir := filepath.Dir(exe); ; {
		if pluginDir.MatchString(dir) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

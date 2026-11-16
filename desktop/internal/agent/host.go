package agent

import (
	"encoding/json/v2"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Variables so tests can shorten them.
var (
	orphanPoll = 5 * time.Second
	quitGrace  = 10 * time.Second
	// DSH updates a plugin by removing it and then installing the new
	// version, which can take a while to download. A plugin that looks
	// removed gets this long to come back before Pointy quits and cleans up.
	removalGrace = 2 * time.Minute
	removalPoll  = 2 * time.Second
)

// HostOptions describe how DSH runs Pointy.
type HostOptions struct {
	// Managed is POINTY_MANAGED: DSH started Pointy, and Pointy quits
	// without it.
	Managed bool
	// HostPID is POINTY_HOST_PID, the DSH process.
	HostPID int
	// PluginRoot is the plugin's install directory (POINTY_PLUGIN_ROOT, or
	// inferred from the executable path).
	PluginRoot string
	// Cleanup lists what goes with the plugin: Pointy's home and data.
	Cleanup []string
	// RemoveAfterExit deletes paths once Pointy has exited.
	RemoveAfterExit func([]string) error
	Quit            func()
}

type host struct {
	opts         HostOptions
	connected    func() bool
	log          func(string, any)
	orphanPoll   time.Duration
	quitGrace    time.Duration
	removalGrace time.Duration
	removalPoll  time.Duration
	done         chan struct{}

	mu      sync.Mutex
	managed bool
	hostPID int
	stopped bool
	quit    *time.Timer
}

func newHost(o HostOptions, connected func() bool, log func(string, any)) *host {
	if log == nil {
		log = func(string, any) {}
	}
	if o.Quit == nil {
		o.Quit = func() {}
	}
	h := &host{
		opts:         o,
		connected:    connected,
		log:          log,
		orphanPoll:   orphanPoll,
		quitGrace:    quitGrace,
		removalGrace: removalGrace,
		removalPoll:  removalPoll,
		done:         make(chan struct{}),
		managed:      o.Managed,
		hostPID:      o.HostPID,
	}
	if o.Managed && o.HostPID > 0 {
		go h.watchOrphan()
	}
	return h
}

func (h *host) stop() {
	h.mu.Lock()
	if !h.stopped {
		h.stopped = true
		close(h.done)
	}
	if h.quit != nil {
		h.quit.Stop()
	}
	h.mu.Unlock()
}

func (h *host) watchOrphan() {
	ticker := time.NewTicker(h.orphanPoll)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-ticker.C:
			if h.orphaned() {
				h.mu.Lock()
				pid := h.hostPID
				h.mu.Unlock()
				h.log("orphan", fmt.Sprintf("DSH host %d is gone and no plugin is connected; quitting", pid))
				h.opts.Quit()
				return
			}
		}
	}
}

func (h *host) orphaned() bool {
	h.mu.Lock()
	pid := h.hostPID
	h.mu.Unlock()
	return !h.connected() && !processAlive(pid)
}

func (h *host) isManaged() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.managed
}

// adopt makes Pointy managed by hostPID when it was started without the
// plugin's environment, as macOS does when it reopens Pointy after a
// permission grant.
func (h *host) adopt(hostPID int) {
	h.mu.Lock()
	if h.stopped || hostPID <= 0 || h.hostPID > 0 {
		h.mu.Unlock()
		return
	}
	h.managed = true
	h.hostPID = hostPID
	h.mu.Unlock()
	h.log("managed", fmt.Sprintf("adopted by DSH host %d", hostPID))
	go h.watchOrphan()
}

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
	if !h.stopped && everConnected && h.managed {
		deadline := time.Now().Add(h.removalGrace)
		var check func()
		check = func() {
			if h.connected() {
				return
			}
			if h.uninstalled() && time.Now().Before(deadline) {
				h.mu.Lock()
				if !h.stopped {
					h.quit = time.AfterFunc(h.removalPoll, check)
				}
				h.mu.Unlock()
				return
			}
			h.opts.Quit()
		}
		h.quit = time.AfterFunc(h.quitGrace, check)
	}
}

const pluginPackage = "@pointylab/dsh"

var pluginDir = regexp.MustCompile(`(?i)[\\/]node_modules[\\/]@pointylab[\\/]dsh$`)

// uninstalled reports whether DSH removed the plugin: its package.json is
// gone and the profile manifest no longer lists @pointylab/dsh (a failed
// in-place update can leave the package directory without package.json while
// the dependency remains in the manifest).
func (h *host) uninstalled() bool {
	if h.opts.PluginRoot == "" {
		return false
	}
	root := filepath.Clean(h.opts.PluginRoot)
	if !pluginDir.MatchString(root) {
		return false
	}
	if _, err := os.Stat(filepath.Join(root, "package.json")); !os.IsNotExist(err) {
		return false
	}
	manifest := filepath.Join(root, "..", "..", "..", "package.json")
	return !hasPluginDep(manifest)
}

func hasPluginDep(manifest string) bool {
	b, err := os.ReadFile(manifest)
	if err != nil {
		return false
	}
	var pkg struct {
		Dependencies         map[string]any `json:"dependencies"`
		DevDependencies      map[string]any `json:"devDependencies"`
		OptionalDependencies map[string]any `json:"optionalDependencies"`
	}
	if json.Unmarshal(b, &pkg) != nil {
		return false
	}
	_, dep := pkg.Dependencies[pluginPackage]
	_, dev := pkg.DevDependencies[pluginPackage]
	_, opt := pkg.OptionalDependencies[pluginPackage]
	return dep || dev || opt
}

func (h *host) willQuit() {
	if !h.isManaged() || !h.uninstalled() || h.opts.RemoveAfterExit == nil {
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

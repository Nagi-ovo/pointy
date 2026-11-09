// Command Pointy is the desktop runtime: the local server the DSH plugin
// and the browser extension connect to, the menu bar icon, and the windows
// of cards, pills and notices.
package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/browser"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/server"
	"github.com/pointylab/pointy/desktop/internal/ui"
)

const fullscreenPoll = 500 * time.Millisecond

func main() {
	home := config.Home()
	logError := func(kind string, err any) { config.LogError(home, kind, err) }
	mygo.App.SetName("Pointy")
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})
	var dsh *agent.DSH
	mygo.App.WhenReady(func() { dsh = start(home, logError) })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		if dsh != nil {
			dsh.WillQuit()
		}
	})
	if err := mygo.App.Run(); err != nil {
		logError("run", err)
		os.Exit(1)
	}
}

func start(home string, logError func(string, any)) *agent.DSH {
	// The port is the single-instance lock: a second Pointy on it exits.
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(config.Port())))
	if err != nil {
		if !errors.Is(err, syscall.EADDRINUSE) {
			logError("server", err)
		}
		mygo.App.Exit(0)
		return nil
	}
	token, err := config.Token(home)
	if err != nil {
		logError("token", err)
		mygo.App.Exit(1)
		return nil
	}
	root := resourceRoot()
	sys := newDesktop()
	settings := config.LoadSettings(home)
	vis := ui.NewVisibility(settings)

	var tray *ui.Tray
	changed := func() { tray.Update() }
	exts := browser.New(browser.Deps{Home: home, BundledDir: filepath.Join(root, "extension"), OnChange: changed, Log: logError})
	exts.SyncUserExtension()

	exe, _ := os.Executable()
	userData, _ := mygo.App.Path(mygo.PathUserData)
	hostPID, _ := strconv.Atoi(os.Getenv("POINTY_HOST_PID"))
	dsh := agent.New(agent.Deps{
		Notify:          func(title, body string, click func()) { tray.Notify(title, body, click) },
		FocusTab:        exts.FocusTab,
		OpenURL:         func(u string) { mygo.Shell.OpenExternal(u) },
		AllowForeground: sys.AllowAnyForeground,
		OnChange:        changed,
		Log:             logError,
	}, agent.HostOptions{
		Managed:         config.Managed(),
		HostPID:         hostPID,
		PluginRoot:      agent.FindPluginRoot(exe),
		Cleanup:         []string{home, userData},
		RemoveAfterExit: sys.RemoveAfterExit,
		Quit:            mygo.App.Quit,
	})

	go func() {
		err := server.Serve(ln, server.Routes{
			Token:     token,
			Plugin:    dsh.Attach,
			Extension: exts.Authenticate,
			OnError:   func(kind string, err error) { logError(kind, err) },
		})
		logError("server", err)
	}()

	icon, err := os.ReadFile(filepath.Join(root, "assets", "tray@2x.png"))
	if err != nil {
		logError("tray", err)
	}
	tray, err = ui.NewTray(ui.TrayDeps{
		Settings:           settings,
		Visibility:         vis,
		Agent:              dsh.Status,
		Extensions:         exts.Count,
		ShowExtensionGuide: func() {},
		ShowWelcome:        func() {},
		Quit:               mygo.App.Quit,
		Log:                logError,
	}, icon)
	if err != nil {
		logError("tray", err)
	}
	vis.OnChange(func(bool) { tray.Update() })

	go func() {
		for range time.Tick(fullscreenPoll) {
			on, err := sys.FullscreenActive(nil)
			vis.SetFullscreen(err == nil && on)
		}
	}()
	return dsh
}

// resourceRoot is the directory holding app/, extension/ and assets/:
// POINTY_ROOT, the app bundle's Resources, or the build/ directory of the
// checkout the executable sits in.
func resourceRoot() string {
	if r := os.Getenv("POINTY_ROOT"); r != "" {
		return r
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exe, _ = filepath.EvalSymlinks(exe)
	bundled := filepath.Join(filepath.Dir(exe), "..", "Resources", "build")
	if isDir(filepath.Join(bundled, "app")) {
		return bundled
	}
	for dir := filepath.Dir(exe); ; {
		if isDir(filepath.Join(dir, "build", "app", "card")) {
			return filepath.Join(dir, "build")
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

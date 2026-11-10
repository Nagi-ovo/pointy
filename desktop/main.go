// Command Pointy is the desktop runtime: the local server the DSH plugin
// and the browser extension connect to, the menu bar icon, and the windows
// of cards, pills and notices.
package main

import (
	"encoding/json/v2"
	"errors"
	"io/fs"
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
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/desktop"
	"github.com/pointylab/pointy/desktop/internal/i18n"
	"github.com/pointylab/pointy/desktop/internal/pick"
	"github.com/pointylab/pointy/desktop/internal/server"
	"github.com/pointylab/pointy/desktop/internal/ui"
)

const fullscreenPoll = 500 * time.Millisecond

// windows is every window Pointy shows; its services are bound before
// mygo runs.
var windows = ui.New()

func main() {
	if out := os.Getenv("POINTY_SELFCHECK"); out != "" {
		selfCheck(out)
		return
	}
	home := config.Home()
	logError := func(kind string, err any) { config.LogError(home, kind, err) }
	root := resourceRoot()
	mygo.App.SetName("Pointy")
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {})
	pages := os.DirFS(filepath.Join(root, "app"))
	mygo.SetFrontend(pages)
	mygo.Bind(windows.Services()...)
	var dsh *agent.DSH
	var picker *pick.Picker
	sys := newDesktop(root)
	mygo.App.WhenReady(func() { dsh, picker = start(home, root, pages, sys, logError) })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		if picker != nil {
			picker.Cancel()
		}
		sys.RestoreCursor()
		if dsh != nil {
			dsh.WillQuit()
		}
	})
	if err := mygo.App.Run(); err != nil {
		logError("run", err)
		os.Exit(1)
	}
}

func start(home, root string, pages fs.FS, sys desktop.Desktop, logError func(string, any)) (*agent.DSH, *pick.Picker) {
	// The port is the single-instance lock: a second Pointy on it exits.
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(config.Port())))
	if err != nil {
		if !errors.Is(err, syscall.EADDRINUSE) {
			logError("server", err)
		}
		mygo.App.Exit(0)
		return nil, nil
	}
	token, err := config.Token(home)
	if err != nil {
		logError("token", err)
		mygo.App.Exit(1)
		return nil, nil
	}
	settings := config.LoadSettings(home)
	vis := ui.NewVisibility(settings)
	applyLocale := func() { i18n.Use(i18n.Resolve(settings.Get().Locale, mygo.App.PreferredLanguages())) }
	applyLocale()

	var tray *ui.Tray
	changed := func() { tray.Update() }
	exts := browser.New(browser.Deps{
		Home: home, BundledDir: filepath.Join(root, "extension"), OnChange: changed, Log: logError,
		ShowNotice:  windows.ShowNotice,
		OnSelection: func(g contract.Grab) { windows.OpenGrab(g, nil) },
		ShowHint:    windows.ShowHint,
	})
	exts.SyncUserExtension()

	exe, _ := os.Executable()
	userData, _ := mygo.App.Path(mygo.PathUserData)
	hostPID, _ := strconv.Atoi(os.Getenv("POINTY_HOST_PID"))
	dsh := agent.New(agent.Deps{
		ToCards:         windows.ToCards,
		OnTask:          windows.OnTask,
		ShowHint:        windows.ShowHint,
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

	err = windows.Start(ui.Deps{
		Agent:         dsh,
		AgentName:     agent.Name,
		Desktop:       sys,
		Visibility:    vis,
		Settings:      settings,
		Pages:         pages,
		Version:       installedVersion(root),
		ExtensionDir:  exts.UserDir,
		SyncExtension: exts.SyncUserExtension,
		Log:           logError,
	})
	if err != nil {
		logError("pages", err)
	}

	go func() {
		err := server.Serve(ln, server.Routes{
			Token:     token,
			Plugin:    dsh.Attach,
			Extension: exts.Authenticate,
			Pair:      exts.Pair,
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
		ShowExtensionGuide: windows.ShowExtensionGuide,
		ShowWelcome:        windows.ShowWelcome,
		LocaleChanged:      func() { applyLocale(); tray.Update() },
		Quit:               mygo.App.Quit,
		Log:                logError,
	}, icon)
	if err != nil {
		logError("tray", err)
	}
	vis.OnChange(func(bool) { tray.Update() })

	go func() {
		for range time.Tick(fullscreenPoll) {
			on, err := sys.FullscreenActive(windows.OwnWindows())
			vis.SetFullscreen(err == nil && on)
		}
	}()
	picker := pick.New(pick.Deps{
		Desktop:     sys,
		Settings:    settings,
		Fullscreen:  vis.Fullscreen,
		Suppressed:  vis.Suppressed,
		Browser:     exts,
		OpenOverlay: func(b mygo.Rectangle) pick.Overlay { return windows.OpenOverlay(b) },
		DisplayAt:   displayAt(sys),
		Keys:        globalKeys(logError),
		OpenGrab:    func(g contract.Grab, c pick.Card) { windows.OpenGrab(g, c) },
		ShowHint:    windows.ShowHint,
		CardFocused: windows.CardFocused,
		Log:         logError,
	})
	vis.OnChange(func(hidden bool) {
		if hidden {
			picker.Cancel()
		}
	})
	go picker.Watch(nil)
	windows.GreetOnStart()
	return dsh, picker
}

func displayAt(sys desktop.Desktop) func(desktop.Point) mygo.Display {
	return func(p desktop.Point) mygo.Display {
		q := sys.ToDIP(p)
		return mygo.Screen.DisplayNearestPoint(mygo.Point{X: int(q.X), Y: int(q.Y)})
	}
}

// globalKeys registers shortcuts that work while another app has the
// keyboard, and returns what unregisters them.
func globalKeys(logError func(string, any)) func(map[string]func()) func() {
	return func(keys map[string]func()) func() {
		var done []string
		for acc, fn := range keys {
			if err := mygo.GlobalShortcut.Register(acc, fn); err != nil {
				logError("shortcut", err)
				continue
			}
			done = append(done, acc)
		}
		return func() {
			for _, acc := range done {
				mygo.GlobalShortcut.Unregister(acc)
			}
		}
	}
}

// installedVersion is the version of the plugin Pointy came with, or the
// app's own.
func installedVersion(root string) string {
	var pkg struct {
		Version string `json:"version"`
	}
	if b, err := os.ReadFile(filepath.Join(root, "..", "package.json")); err == nil && json.Unmarshal(b, &pkg) == nil && pkg.Version != "" {
		return pkg.Version
	}
	return mygo.App.Version()
}

// resourceRoot is the directory holding app/, extension/ and assets/:
// POINTY_ROOT, the app bundle's Resources, the plugin's pet/ directory
// above pet/win32-<arch>/Pointy.exe, or the build/ directory of the
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
	if pet := filepath.Dir(filepath.Dir(exe)); isDir(filepath.Join(pet, "app", "card")) {
		return pet
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

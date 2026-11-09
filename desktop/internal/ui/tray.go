package ui

import (
	"strings"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

// TrayDeps are what the menu bar icon shows and does.
type TrayDeps struct {
	Settings           *config.Store
	Visibility         *Visibility
	Agent              func() agent.Status
	Extensions         func() int
	ShowExtensionGuide func()
	ShowWelcome        func()
	// LocaleChanged follows the language the user chose in Settings.
	LocaleChanged func()
	Quit          func()
	Log           func(kind string, err any)
}

// Tray is the whale in the menu bar.
type Tray struct {
	deps TrayDeps
	tray *mygo.Tray
}

// NewTray adds the icon; icon is a PNG.
func NewTray(d TrayDeps, icon []byte) (*Tray, error) {
	t := &Tray{deps: d}
	tray, err := mygo.NewTray(mygo.TrayOptions{ID: "pointy", Icon: icon, ToolTip: "Pointy"})
	if err != nil {
		return nil, err
	}
	t.tray = tray
	t.Update()
	return t, nil
}

// Update redraws the tooltip and the menu from the current state.
func (t *Tray) Update() {
	if t == nil {
		return
	}
	tip, items := trayContent(t.deps)
	t.tray.SetToolTip(tip)
	t.tray.SetMenu(mygo.NewMenu(items))
}

func trayContent(d TrayDeps) (string, []*mygo.MenuItem) {
	st := d.Agent()
	s := d.Settings.Get()
	ext := d.Extensions()
	var status []string
	if st.PendingApprovals > 0 {
		status = append(status, i18n.T(i18n.TrayApprovals, "count", st.PendingApprovals))
	}
	if s.DND {
		status = append(status, i18n.T(i18n.TrayDNDOn))
	}
	if !st.Connected {
		status = append(status, i18n.T(i18n.TrayAgentOffline, "agent", agent.Name))
	}
	if ext == 0 {
		status = append(status, i18n.T(i18n.TrayExtensionOffline))
	}
	tip := "Pointy"
	if len(status) > 0 {
		tip += "\n" + strings.Join(status, "\n")
	}

	save := func(change func(*config.Settings)) {
		if err := d.Settings.Update(change); err != nil && d.Log != nil {
			d.Log("settings", err)
		}
	}
	shake := []*mygo.MenuItem{{Label: i18n.T(i18n.TrayShakeOff), Type: mygo.MenuItemRadio, Checked: !s.Shake, Click: func(*mygo.MenuItem, *mygo.Window) {
		save(func(s *config.Settings) { s.Shake = false })
		d.Visibility.Changed()
	}}}
	for _, l := range []struct {
		level config.ShakeLevel
		label i18n.Key
	}{{config.ShakeLow, i18n.TrayShakeLow}, {config.ShakeMedium, i18n.TrayShakeMedium}, {config.ShakeHigh, i18n.TrayShakeHigh}} {
		shake = append(shake, &mygo.MenuItem{Label: i18n.T(l.label), Type: mygo.MenuItemRadio, Checked: s.Shake && s.ShakeLevel == l.level, Click: func(*mygo.MenuItem, *mygo.Window) {
			save(func(s *config.Settings) { s.Shake, s.ShakeLevel = true, l.level })
			d.Visibility.Changed()
		}})
	}
	languages := []*mygo.MenuItem{{Label: i18n.T(i18n.LanguageSystem), Type: mygo.MenuItemRadio, Checked: s.Locale == "", Click: func(*mygo.MenuItem, *mygo.Window) {
		save(func(s *config.Settings) { s.Locale = "" })
		d.LocaleChanged()
	}}}
	for _, lang := range i18n.Languages {
		languages = append(languages, &mygo.MenuItem{Label: i18n.In(lang, i18n.LanguageSelf), Type: mygo.MenuItemRadio, Checked: s.Locale == lang, Click: func(*mygo.MenuItem, *mygo.Window) {
			save(func(s *config.Settings) { s.Locale = lang })
			d.LocaleChanged()
		}})
	}
	extItem := &mygo.MenuItem{Label: i18n.T(i18n.TrayExtensionConnected, "count", ext), Disabled: true}
	if ext == 0 {
		extItem = &mygo.MenuItem{Label: i18n.T(i18n.TrayExtensionInstall), Click: func(*mygo.MenuItem, *mygo.Window) { go d.ShowExtensionGuide() }}
	}
	return tip, []*mygo.MenuItem{
		{Label: i18n.T(i18n.TrayShake), Submenu: shake},
		extItem,
		mygo.Separator(),
		{Label: i18n.T(i18n.TrayGuide), Click: func(*mygo.MenuItem, *mygo.Window) { go d.ShowWelcome() }},
		{Label: i18n.T(i18n.TrayDND), Type: mygo.MenuItemCheckbox, Checked: s.DND, Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			save(func(s *config.Settings) { s.DND = item.Checked })
			d.Visibility.Changed()
		}},
		{Label: i18n.T(i18n.LanguageMenu), Submenu: languages},
		mygo.Separator(),
		{Label: i18n.T(i18n.TrayQuit), Click: func(*mygo.MenuItem, *mygo.Window) { d.Quit() }},
	}
}

// Notify shows a system notification, unless Pointy keeps out of sight.
// macOS shows them only for a packaged app.
func (t *Tray) Notify(title, body string, onClick func()) {
	if t == nil || t.deps.Visibility.Suppressed() {
		return
	}
	go func() {
		if !mygo.NotificationsSupported() {
			t.log("notify", "notifications need a packaged app: "+title)
			return
		}
		n := mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body, Silent: true})
		if onClick != nil {
			n.OnClick(onClick)
		}
		if err := n.Show(); err != nil {
			t.log("notify", err)
		}
	}()
}

func (t *Tray) log(kind string, err any) {
	if t.deps.Log != nil {
		t.deps.Log(kind, err)
	}
}

package ui

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
)

// TrayDeps are what the menu bar icon shows and does.
type TrayDeps struct {
	Settings           *config.Store
	Visibility         *Visibility
	Agent              func() agent.Status
	Extensions         func() int
	ShowExtensionGuide func()
	ShowWelcome        func()
	Quit               func()
	Log                func(kind string, err any)
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
		status = append(status, fmt.Sprintf("%d 个操作等你批准", st.PendingApprovals))
	}
	if s.DND {
		status = append(status, "勿扰中")
	}
	if !st.Connected {
		status = append(status, agent.Name+" 未连接")
	}
	if ext == 0 {
		status = append(status, "浏览器扩展未连接")
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
	shake := []*mygo.MenuItem{{Label: "关", Type: mygo.MenuItemRadio, Checked: !s.Shake, Click: func(*mygo.MenuItem, *mygo.Window) {
		save(func(s *config.Settings) { s.Shake = false })
		d.Visibility.Changed()
	}}}
	for _, l := range []struct {
		level config.ShakeLevel
		label string
	}{{config.ShakeLow, "低：要晃得明显"}, {config.ShakeMedium, "中"}, {config.ShakeHigh, "高：轻晃就行"}} {
		shake = append(shake, &mygo.MenuItem{Label: l.label, Type: mygo.MenuItemRadio, Checked: s.Shake && s.ShakeLevel == l.level, Click: func(*mygo.MenuItem, *mygo.Window) {
			save(func(s *config.Settings) { s.Shake, s.ShakeLevel = true, l.level })
			d.Visibility.Changed()
		}})
	}
	extItem := &mygo.MenuItem{Label: fmt.Sprintf("浏览器扩展已连接（%d）", ext), Disabled: true}
	if ext == 0 {
		extItem = &mygo.MenuItem{Label: "浏览器扩展未连接，点这里安装…", Click: func(*mygo.MenuItem, *mygo.Window) { go d.ShowExtensionGuide() }}
	}
	return tip, []*mygo.MenuItem{
		{Label: "晃一下鼠标指认", Submenu: shake},
		extItem,
		mygo.Separator(),
		{Label: "使用说明…", Click: func(*mygo.MenuItem, *mygo.Window) { go d.ShowWelcome() }},
		{Label: "勿扰模式", Type: mygo.MenuItemCheckbox, Checked: s.DND, Click: func(item *mygo.MenuItem, _ *mygo.Window) {
			save(func(s *config.Settings) { s.DND = item.Checked })
			d.Visibility.Changed()
		}},
		mygo.Separator(),
		{Label: "退出 Pointy", Click: func(*mygo.MenuItem, *mygo.Window) { d.Quit() }},
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

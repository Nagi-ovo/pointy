package ui

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/i18n"
)

func find(items []*mygo.MenuItem, label string) *mygo.MenuItem {
	for _, it := range items {
		if it.Label == label {
			return it
		}
		if sub := find(it.Submenu, label); sub != nil {
			return sub
		}
	}
	return nil
}

func click(it *mygo.MenuItem) {
	if it.Type == mygo.MenuItemCheckbox {
		it.Checked = !it.Checked
	}
	it.Click(it, nil)
}

func TestTrayMenu(t *testing.T) {
	settings := config.LoadSettings(t.TempDir())
	vis := NewVisibility(settings)
	changes := 0
	vis.OnChange(func(bool) { changes++ })
	status := agent.Status{}
	exts := 0
	d := TrayDeps{Settings: settings, Visibility: vis, Agent: func() agent.Status { return status }, Extensions: func() int { return exts }}

	tip, items := trayContent(d)
	if tip != "Pointy\nDSH 未连接\n浏览器扩展未连接" {
		t.Fatalf("tooltip %q", tip)
	}
	if it := find(items, "中"); it == nil || !it.Checked {
		t.Fatal("medium shake not checked by default")
	}
	if find(items, "浏览器扩展未连接，点这里安装…") == nil {
		t.Fatal("no install entry without an extension")
	}

	click(find(items, "高：轻晃就行"))
	if s := settings.Get(); !s.Shake || s.ShakeLevel != config.ShakeHigh {
		t.Fatalf("after high: %+v", s)
	}
	click(find(items, "关"))
	if settings.Get().Shake {
		t.Fatal("shake still on after off")
	}
	click(find(items, "勿扰模式"))
	if !settings.Get().DND || !vis.Suppressed() {
		t.Fatal("do-not-disturb not on")
	}
	if changes != 3 {
		t.Fatalf("visibility listeners ran %d times", changes)
	}

	status = agent.Status{Connected: true, PendingApprovals: 2}
	exts = 1
	tip, items = trayContent(d)
	if tip != "Pointy\n2 个操作等你批准\n勿扰中" {
		t.Fatalf("tooltip %q", tip)
	}
	if it := find(items, "浏览器扩展已连接（1）"); it == nil || !it.Disabled {
		t.Fatal("connected extension not shown")
	}
	if it := find(items, "关"); !it.Checked {
		t.Fatal("off not checked after turning shake off")
	}
}

func TestTraySaysTheLanguageChosenInIt(t *testing.T) {
	settings := config.LoadSettings(t.TempDir())
	system := []string{"zh-Hans-CN"}
	t.Cleanup(func() { i18n.Use(i18n.Resolve("", system)) })
	d := TrayDeps{Settings: settings, Visibility: NewVisibility(settings), Agent: func() agent.Status { return agent.Status{} }, Extensions: func() int { return 0 },
		LocaleChanged: func() { i18n.Use(i18n.Resolve(settings.Get().Locale, system)) }}

	_, items := trayContent(d)
	if it := find(items, "跟随系统"); it == nil || !it.Checked {
		t.Fatal("the system language is not the default")
	}
	click(find(items, "English"))
	if settings.Get().Locale != "en" {
		t.Fatalf("locale saved as %q", settings.Get().Locale)
	}
	tip, items := trayContent(d)
	if tip != "Pointy\nDSH is not connected\nBrowser extension not connected" {
		t.Fatalf("tooltip %q", tip)
	}
	if find(items, "Quit Pointy") == nil || find(items, "简体中文") == nil {
		t.Fatal("menu not in English, or a language not named in itself")
	}
	click(find(items, "Same as System"))
	if tip, _ := trayContent(d); settings.Get().Locale != "" || tip != "Pointy\nDSH 未连接\n浏览器扩展未连接" {
		t.Fatalf("back to the system: %q %q", settings.Get().Locale, tip)
	}
}

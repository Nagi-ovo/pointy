package ui

import (
	"testing"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
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

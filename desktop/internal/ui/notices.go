package ui

import (
	"fmt"
	"html"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
)

const (
	noticeW      = 380
	hintW        = 520
	hintH        = 64
	hintFor      = 2600 * time.Millisecond
	introFor     = 8 * time.Second
	greetAfter   = 2500 * time.Millisecond
	noticeMinH   = 80
	noticeMaxH   = 600
	noticeMargin = 12
)

// notice is the one notice on screen, waiting for the user's choice.
type notice struct {
	win    *mygo.Window
	init   contract.NoticeInit
	choice chan *string
	timer  *time.Timer
	done   bool
}

// ShowNotice shows a notice in the corner, replacing any other, and
// returns the id of the button the user pressed, nil when they closed it,
// it timed out or cancel was called.
func (u *UI) ShowNotice(init contract.NoticeInit, timeout time.Duration) (choice <-chan *string, cancel func()) {
	var n *notice
	mygo.RunOnMain(func() {
		if u.notice != nil {
			u.finishNotice(u.notice, nil)
		}
		wa := mygo.Screen.PrimaryDisplay().WorkArea
		n = &notice{init: init, choice: make(chan *string, 1)}
		n.win = u.open(kindNotice, mygo.Rectangle{X: wa.X + wa.Width - noticeW - noticeMargin, Y: wa.Y + wa.Height - 212, Width: noticeW, Height: 200})
		u.notice = n
		n.win.OnClosed(func() { u.finishNotice(n, nil) })
		// The page reports its height from an animation frame, which WebKit
		// runs only for windows on screen.
		n.win.OnReadyToShow(func() { show(n.win, kindNotice) })
		if timeout > 0 {
			n.timer = time.AfterFunc(timeout, func() { mygo.RunOnMain(func() { u.finishNotice(n, nil) }) })
		}
	})
	return n.choice, func() { mygo.RunOnMain(func() { u.finishNotice(n, nil) }) }
}

func (u *UI) finishNotice(n *notice, choice *string) {
	if n.done {
		return
	}
	n.done = true
	if n.timer != nil {
		n.timer.Stop()
	}
	if !n.win.IsDestroyed() {
		n.win.Close()
	}
	if u.notice == n {
		u.notice = nil
	}
	n.choice <- choice
}

// ask shows a notice and waits for the choice, "" for none. Never call it
// on the main thread.
func (u *UI) ask(init contract.NoticeInit) string {
	ch, _ := u.ShowNotice(init, 0)
	if c := <-ch; c != nil {
		return *c
	}
	return ""
}

func (u *UI) noticeOf(w *mygo.Window) *notice {
	if u.notice != nil && u.notice.win == w {
		return u.notice
	}
	return nil
}

func (u *UI) resizeNotice(n *notice, height int) {
	h := min(max(height, noticeMinH), noticeMaxH)
	wa := mygo.Screen.PrimaryDisplay().WorkArea
	n.win.SetBounds(mygo.Rectangle{X: wa.X + wa.Width - noticeW - noticeMargin, Y: wa.Y + wa.Height - h - noticeMargin, Width: noticeW, Height: h})
	if !n.win.IsVisible() {
		show(n.win, kindNotice)
	}
}

type hint struct {
	win   *mygo.Window
	timer *time.Timer
}

// ShowHint shows a line of text at the bottom of the screen for a moment.
// Clicks go through it.
func (u *UI) ShowHint(text string) {
	mygo.RunOnMain(func() {
		cursor := mygo.Screen.CursorScreenPoint()
		wa := mygo.Screen.DisplayNearestPoint(cursor).WorkArea
		if u.hint == nil || u.hint.win.IsDestroyed() {
			u.hint = &hint{win: u.open(kindHint, mygo.Rectangle{Width: hintW, Height: hintH})}
		}
		h := u.hint
		h.win.SetBounds(mygo.Rectangle{X: wa.X + (wa.Width-hintW)/2, Y: wa.Y + wa.Height - hintH - 40, Width: hintW, Height: hintH})
		h.win.Page().LoadHTML(hintHTML(text), "")
		show(h.win, kindHint)
		if h.timer != nil {
			h.timer.Stop()
		}
		h.timer = time.AfterFunc(hintFor, func() {
			mygo.RunOnMain(func() {
				if !h.win.IsDestroyed() {
					h.win.Hide()
				}
			})
		})
	})
}

func hintHTML(text string) string {
	return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden">
    <div style="padding:10px 22px;border-radius:999px;background:rgba(28,32,51,.92);color:#fff;font:16px 'Segoe UI','Microsoft YaHei UI',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18)">` + html.EscapeString(text) + `</div></body>`
}

type intro struct {
	win  *mygo.Window
	done chan struct{}
	shut bool
}

// ShowIntro plays the intro over the primary display and returns once it
// ended. Never call it on the main thread.
func (u *UI) ShowIntro() {
	var in *intro
	mygo.RunOnMain(func() {
		in = &intro{done: make(chan struct{})}
		in.win = u.open(kindIntro, mygo.Screen.PrimaryDisplay().Bounds)
		u.intro = in
		in.win.OnClosed(func() { u.finishIntro(in) })
		in.win.OnReadyToShow(func() { show(in.win, kindIntro) })
	})
	select {
	case <-in.done:
	case <-time.After(introFor):
		mygo.RunOnMain(func() { u.finishIntro(in) })
	}
}

func (u *UI) finishIntro(in *intro) {
	if in.shut {
		return
	}
	in.shut = true
	if !in.win.IsDestroyed() {
		in.win.Close()
	}
	if u.intro == in {
		u.intro = nil
	}
	close(in.done)
}

// GreetOnStart plays the intro once per installed version, then welcomes a
// first-time user.
func (u *UI) GreetOnStart() {
	time.AfterFunc(greetAfter, func() {
		s := u.deps.Settings.Get()
		if s.Welcomed && s.WelcomedVersion == u.deps.Version {
			return
		}
		if u.deps.Visibility.Fullscreen() || s.DND {
			return
		}
		first := !s.Welcomed
		u.saveSettings(func(s *config.Settings) { s.WelcomedVersion = u.deps.Version })
		u.ShowIntro()
		if first {
			u.ShowWelcome()
		}
	})
}

func (u *UI) saveSettings(change func(*config.Settings)) {
	if err := u.deps.Settings.Update(change); err != nil {
		u.log("settings", err)
	}
}

func trayPlace() string {
	if runtime.GOOS == "darwin" {
		return "菜单栏"
	}
	return "托盘"
}

// ShowWelcome says how to use Pointy, and offers the extension guide.
func (u *UI) ShowWelcome() {
	u.saveSettings(func(s *config.Settings) { s.Welcomed, s.WelcomedVersion = true, u.deps.Version })
	choice := u.ask(contract.NoticeInit{
		Title: "Pointy 已就位",
		Body: []contract.NoticeParagraph{
			{Text: fmt.Sprintf("**晃一下鼠标**进入指认，指到网页、文档、聊天窗口里的任意内容，点一下就能问 %s。", agent.Name)},
			{Text: trayPlace() + "里的鲸鱼图标可以调晃动灵敏度、开勿扰。"},
			{Text: "在浏览器里用的话，推荐装上 Pointy 的浏览器扩展，能指认到网页里具体的段落。"},
		},
		Buttons: []contract.NoticeButton{{ID: "later", Label: "以后再说"}, {ID: "ext", Label: "安装浏览器扩展", Primary: true}},
	})
	if choice == "ext" {
		u.ShowExtensionGuide()
	}
}

// ShowExtensionGuide walks the user through loading the extension.
func (u *UI) ShowExtensionGuide() {
	u.deps.SyncExtension()
	u.ask(contract.NoticeInit{
		Title: "安装浏览器扩展（推荐）",
		Body: []contract.NoticeParagraph{
			{Text: "装了扩展，在网页里能指认到具体的段落、图片，还能右键「问 Pointy」。没装也能用，只是网页按整窗截图处理。"},
			{Text: "1. 在浏览器地址栏打开扩展页，打开右上角的「开发者模式」。", Copy: []string{"chrome://extensions", "edge://extensions"}},
			{Text: "2. 点「加载已解压的扩展程序」，把这个路径粘贴到选文件夹窗口的地址栏，再点「选择文件夹」。", Copy: []string{u.deps.ExtensionDir()}},
			{Text: "3. 装好后 Pointy 会弹窗问要不要让它连接，点「允许」就行。"},
		},
		Buttons: []contract.NoticeButton{{ID: "ok", Label: "知道了", Primary: true}},
	})
}

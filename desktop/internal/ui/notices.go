package ui

import (
	"html"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/pointylab/pointy/desktop/internal/agent"
	"github.com/pointylab/pointy/desktop/internal/config"
	"github.com/pointylab/pointy/desktop/internal/contract"
	"github.com/pointylab/pointy/desktop/internal/i18n"
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

func trayTip() i18n.Key {
	if runtime.GOOS == "darwin" {
		return i18n.WelcomeTrayMac
	}
	return i18n.WelcomeTrayWin
}

// ShowWelcome says how to use Pointy, and offers the extension guide.
func (u *UI) ShowWelcome() {
	u.saveSettings(func(s *config.Settings) { s.Welcomed, s.WelcomedVersion = true, u.deps.Version })
	choice := u.ask(contract.NoticeInit{
		Title: i18n.Msg(i18n.WelcomeTitle),
		Body: []contract.NoticeParagraph{
			{Text: i18n.Msg(i18n.WelcomeShake, "agent", agent.Name)},
			{Text: i18n.Msg(trayTip())},
			{Text: i18n.Msg(i18n.WelcomeExtension)},
		},
		Buttons: []contract.NoticeButton{{ID: "later", Label: i18n.Msg(i18n.WelcomeLater)}, {ID: "ext", Label: i18n.Msg(i18n.WelcomeInstall), Primary: true}},
	})
	if choice == "ext" {
		u.ShowExtensionGuide()
	}
}

// ShowExtensionGuide walks the user through loading the extension.
func (u *UI) ShowExtensionGuide() {
	u.deps.SyncExtension()
	u.ask(contract.NoticeInit{
		Title: i18n.Msg(i18n.GuideTitle),
		Body: []contract.NoticeParagraph{
			{Text: i18n.Msg(i18n.GuideWhy)},
			{Text: i18n.Msg(i18n.GuideStep1), Copy: []string{"chrome://extensions", "edge://extensions"}},
			{Text: i18n.Msg(i18n.GuideStep2), Copy: []string{u.deps.ExtensionDir()}},
			{Text: i18n.Msg(i18n.GuideStep3)},
		},
		Buttons: []contract.NoticeButton{{ID: "ok", Label: i18n.Msg(i18n.GuideOK), Primary: true}},
	})
}

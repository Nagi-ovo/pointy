// 卡片以外的小窗：右下角提示窗（首次引导、扩展配对、装扩展的步骤）、屏幕下方一句话提示、开场动画
const { BrowserWindow, clipboard, ipcMain, screen } = require('electron')
const path = require('node:path')
const { APP_DIR, TEST_HIDDEN, settings, saveSettings, installedVersion } = require('../core/env')
const { isFullscreen } = require('../core/state')

let deps = {} // { agentName(), extensionDir(), syncExtension() }
const init = (d) => { deps = d }

// ---------- 右下角提示窗 ----------
let noticeWin
let noticeDone // 当前提示窗的回调：点了按钮 / 关掉 / 超时 / 被新的顶掉都走这里
const NOTICE_W = 380

/** 右下角弹一个小窗，返回用户点的按钮 id；关掉或超时是 null。返回的 Promise 带 cancel()，只关这一个 */
function showNotice({ title, body, buttons, timeoutMs }) {
  noticeDone?.(null)
  let cancel
  const asked = new Promise((resolve) => {
    const { workArea } = screen.getPrimaryDisplay()
    const w = new BrowserWindow({
      width: NOTICE_W, height: 200, x: workArea.x + workArea.width - NOTICE_W - 12, y: workArea.y + workArea.height - 212,
      show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(APP_DIR, 'notice', 'preload.js'), contextIsolation: true },
    })
    w.setAlwaysOnTop(true, 'floating')
    noticeWin = w
    let timer
    const done = (choice) => {
      if (noticeDone !== done) return
      noticeDone = undefined
      clearTimeout(timer)
      if (!w.isDestroyed()) w.close()
      if (noticeWin === w) noticeWin = undefined
      resolve(choice)
    }
    noticeDone = done
    cancel = () => done(null)
    if (timeoutMs) timer = setTimeout(() => done(null), timeoutMs)
    w.on('closed', () => done(null))
    w.loadFile(path.join(APP_DIR, 'notice', 'notice.html'))
    w.webContents.once('did-finish-load', () => w.webContents.send('notice-init', { title, body, buttons }))
  })
  asked.cancel = cancel
  return asked
}
ipcMain.on('notice-copy', (e, text) => { if (noticeWin && e.sender === noticeWin.webContents) clipboard.writeText(String(text ?? '')) })
ipcMain.on('notice-choose', (e, id) => { if (noticeWin && e.sender === noticeWin.webContents) noticeDone?.(typeof id === 'string' ? id : null) })
ipcMain.on('notice-resize', (e, height) => {
  const w = noticeWin
  if (!w || e.sender !== w.webContents || !Number.isFinite(height)) return
  const h = Math.min(Math.max(Math.round(height), 80), 600)
  const { workArea } = screen.getPrimaryDisplay()
  w.setBounds({ x: workArea.x + workArea.width - NOTICE_W - 12, y: workArea.y + workArea.height - h - 12, width: NOTICE_W, height: h })
  if (TEST_HIDDEN) { w.setPosition(-20000, -20000); w.showInactive() } else if (!w.isVisible()) w.showInactive()
})

/** 关掉当前提示窗（choice 当作用户点的）；没有提示窗时什么也不做 */
const closeNotice = (choice = null) => noticeDone?.(choice)
const noticeOpen = () => !!noticeWin

// ---------- 屏幕正下方一句话 ----------
// 样子同指认时的操作提示，几秒后自己消失
let hintWin
let hintTimer
function showHint(text) {
  if (TEST_HIDDEN) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 520
  const height = 64
  if (!hintWin || hintWin.isDestroyed()) {
    hintWin = new BrowserWindow({
      width, height, show: false, frame: false, transparent: true, resizable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
    })
    hintWin.setIgnoreMouseEvents(true)
    hintWin.setAlwaysOnTop(true, 'screen-saver')
  }
  hintWin.setBounds({ x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 40, width, height })
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden">
    <div style="padding:10px 22px;border-radius:999px;background:rgba(28,32,51,.92);color:#fff;font:16px 'Segoe UI','Microsoft YaHei UI',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18)">${esc(text)}</div></body>`
  hintWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => hintWin?.showInactive()).catch(() => {})
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { if (hintWin && !hintWin.isDestroyed()) hintWin.hide() }, 2600)
}

// ---------- 引导 ----------
/**
 * 浏览器扩展还不在商店里：一张卡片说完怎么"加载已解压的扩展程序"。
 * 地址和文件夹路径点了就复制，卡片不关；用户去浏览器操作时它一直留在右下角，
 * 扩展装好连上来时，配对的弹窗会顶掉它
 */
async function showExtensionGuide() {
  deps.syncExtension?.()
  const dir = deps.extensionDir?.()
  await showNotice({
    title: '安装浏览器扩展（推荐）',
    body: [
      '装了扩展，在网页里能指认到具体的段落、图片，还能右键「问 Pointy」。没装也能用，只是网页按整窗截图处理。',
      { text: '1. 在浏览器地址栏打开扩展页，打开右上角的「开发者模式」。', copy: ['chrome://extensions', 'edge://extensions'] },
      { text: '2. 点「加载已解压的扩展程序」，把这个路径粘贴到选文件夹窗口的地址栏，再点「选择文件夹」。', copy: [dir] },
      '3. 装好后 Pointy 会弹窗问要不要让它连接，点「允许」就行。',
    ],
    buttons: [{ id: 'ok', label: '知道了', primary: true }],
  })
}

/**
 * 屏幕正中的开场动画（app/intro/）：鲸鱼光标晃几下，指认光环套住"晃一下鼠标，指哪问哪"。
 * 全屏透明、点击穿透、不抢焦点，放完自己关。返回放完的 Promise。
 */
function showIntro(version) {
  return new Promise((resolve) => {
    const { bounds } = screen.getPrimaryDisplay()
    const w = new BrowserWindow({
      ...bounds, show: false, frame: false, transparent: true, resizable: false, focusable: false, skipTaskbar: true,
      hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(APP_DIR, 'intro', 'preload.js'), contextIsolation: true },
    })
    w.setIgnoreMouseEvents(true)
    w.setAlwaysOnTop(true, 'screen-saver')
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      ipcMain.removeListener('intro-done', onDone)
      if (!w.isDestroyed()) w.close()
      resolve()
    }
    const onDone = (e) => { if (!w.isDestroyed() && e.sender === w.webContents) finish() }
    ipcMain.on('intro-done', onDone)
    w.on('closed', finish)
    setTimeout(finish, 8000)
    w.loadFile(path.join(APP_DIR, 'intro', 'intro.html'))
    w.webContents.once('did-finish-load', () => {
      w.webContents.send('intro-init', { version })
      if (TEST_HIDDEN) { w.setPosition(-20000, -20000); w.showInactive() } else w.showInactive()
    })
  })
}

/** 装好（第一次）或换了版本后第一次启动：放开场动画；第一次装接着弹完整说明。全屏、勿扰时不放 */
async function greetOnStart() {
  const version = installedVersion()
  if (settings.welcomed && settings.welcomedVersion === version) return
  if (isFullscreen() || settings.dnd) return
  const first = !settings.welcomed
  saveSettings({ welcomedVersion: version })
  await showIntro(version)
  if (first) await showWelcome()
}

/** 第一次运行：告诉用户怎么用，顺便推荐装扩展 */
async function showWelcome() {
  saveSettings({ welcomed: true, welcomedVersion: installedVersion() })
  const choice = await showNotice({
    title: 'Pointy 已就位',
    body: [
      `**晃一下鼠标**进入指认，指到网页、文档、聊天窗口里的任意内容，点一下就能问 ${deps.agentName?.() ?? 'AI'}。`,
      '托盘里的鲸鱼图标可以调晃动灵敏度、开勿扰。',
      '在浏览器里用的话，推荐装上 Pointy 的浏览器扩展，能指认到网页里具体的段落。',
    ],
    buttons: [{ id: 'later', label: '以后再说' }, { id: 'ext', label: '安装浏览器扩展', primary: true }],
  })
  if (choice === 'ext') showExtensionGuide()
}

module.exports = { init, showNotice, closeNotice, noticeOpen, showHint, showExtensionGuide, showIntro, greetOnStart, showWelcome }

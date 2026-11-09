// 卡片窗口（app/card/）和收起后的胶囊（app/pill/）。卡片只跟当前 agent 的通用接口说话，不认识具体是哪家
const { BrowserWindow, clipboard, ipcMain, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { APP_DIR, CAPTURE_DIR, TEST_HIDDEN, logError } = require('../core/env')
const { suppressed, onVisibilityChange } = require('../core/state')
const os = require('../core/os')
const agents = require('../agents')

// 卡片本身 520 宽，四周各留 18px 给阴影；左边多留看板娘的位置，和 card.css 的 --card-left 对应（68 - 18）
const MASCOT_ROOM = 50
const CARD_W = 520 + MASCOT_ROOM
const CARD_MIN_W = 360 + MASCOT_ROOM
const CARD_MIN_H = 200
const CARD_H_ASK = 300
const CARD_H_ANSWER = 560

let card // 眼前这张
// 所有活着的卡片（包括收起到后台继续跑的）；每张卡片自己按 askId / reqId 认领消息
const cards = new Set()
// 卡片宽度：用户在右下角拖过就沿用拖出来的宽度（只记在内存里，Pointy 重启回到默认）
let cardWidth = CARD_W
// 测试钩子可以打开：卡片放到屏幕外面渲染，不显示、不抢焦点（用户在玩全屏游戏时也能测）
let offscreenCards = false
const offscreen = () => TEST_HIDDEN || offscreenCards

/** agent 的消息发给所有卡片 */
const broadcast = (msg) => { for (const c of cards) c.webContents.send('agent', msg) }

/** 卡片出现在光标附近（尽量在右下，放不下就往回挪） */
function cardBounds(height, width = cardWidth) {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const x = Math.min(Math.max(cursor.x + 12, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(cursor.y + 16, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

/**
 * 打开一张卡片。grab 是指认 / 选区拿到的东西（pick/ 产出的格式）
 * @param releasePick 指认留着的高亮框，卡片关掉或收起时撤掉
 */
function openCard(init, releasePick) {
  if (suppressed() && !TEST_HIDDEN && !offscreenCards) return releasePick?.()
  // 眼前这张卡片让位：问过问题的缩成胶囊，没问过的关掉；收起的卡片不动
  setAsideCard()
  // 卡片跟着叫出它的那个程序：在它上面，切到别的程序就被盖住（配对卡片和找不到来源时照旧置顶）
  const fg = init.mode === 'pair' ? 0n : os.foregroundId()
  const mine = ownHandles()
  const owner = fg && !mine.includes(fg) ? fg : 0n
  card = new BrowserWindow({
    ...cardBounds(init.mode === 'pair' ? 230 : CARD_H_ASK),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: !owner,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(APP_DIR, 'card', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  const self = card
  // 宽度只由这里和右下角拖拽决定；150% 缩放下用 getBounds 的宽度回写会一点点变宽
  self.cardW = cardWidth
  self.releasePick = releasePick
  cards.add(self)
  self.on('closed', () => {
    self.releasePick?.()
    cards.delete(self)
  })
  let attached = false
  try { attached = !!owner && os.attachToOwner(self, owner) } catch (err) { logError('card-owner', err) }
  if (owner) followOwner(self, owner)
  if (!attached) self.setAlwaysOnTop(true, 'floating')
  card.loadFile(path.join(APP_DIR, 'card', 'card.html'))
  card.webContents.once('did-finish-load', () => {
    card.webContents.send('card-init', init.mode === 'pair' ? init : { grab: init, agent: { name: agents.current().name } })
    // 晃鼠标是用户主动的，这里给卡片焦点好直接打字；全屏/勿扰时根本不会走到这里
    // 测试：放到所有屏幕外面再显示，窗口照常重绘（截图才是新的），人看不到
    if (offscreen()) { card.setPosition(-20000, -20000); card.showInactive(); return }
    card.show()
    card.focus()
  })
  card.on('closed', () => { if (card === self) card = undefined })
}

/** 我们自己的窗口句柄（判断全屏、找卡片的来源窗口时排除掉） */
function ownHandles() {
  return [...cards].filter(w => !w.isDestroyed()).map(os.windowId)
}

/** 来源程序的窗口挪了，卡片跟着挪同样的距离（拖动卡片自己的位置不受影响，下次按新位置算） */
// 每帧看一次，拖窗口时才跟得顺；位置自己记小数，不从 getBounds 读回来（150% 缩放下取整会抖）
const FOLLOW_POLL_MS = 16
function followOwner(c, owner) {
  let last = os.windowOrigin(owner)
  if (!last) return
  let pos // 卡片左上角（DIP，小数）
  let placed // 上次我们放到的位置；用户自己拖了卡片就以那边为准
  const timer = setInterval(() => {
    if (c.isDestroyed()) return clearInterval(timer)
    const now = os.windowOrigin(owner)
    if (!now) return clearInterval(timer)
    if (now.x === last.x && now.y === last.y) return
    const a = os.toDipPoint(last)
    const b = os.toDipPoint(now)
    last = now
    const dx = b.x - a.x
    const dy = b.y - a.y
    c.releasePick?.shift?.(dx, dy)
    if (!c.isVisible()) return
    const r = c.getBounds()
    if (!pos || !placed || Math.abs(r.x - placed.x) > 2 || Math.abs(r.y - placed.y) > 2) pos = { x: r.x, y: r.y }
    pos = { x: pos.x + dx, y: pos.y + dy }
    placed = { x: Math.round(pos.x), y: Math.round(pos.y) }
    c.setBounds({ ...placed, width: c.cardW ?? r.width, height: r.height })
  }, FOLLOW_POLL_MS)
  c.once('closed', () => clearInterval(timer))
}

/** 眼前这张卡片要让位（新指认、放回别的卡片）：问过问题的缩成胶囊，没问过的直接关 */
function setAsideCard() {
  if (!card || card.isDestroyed()) return
  const old = card
  card = undefined
  old.webContents.send('card-set-aside')
  // 还没加载完、收不到消息的卡片（刚弹出就又指认）直接关
  setTimeout(() => { if (!old.isDestroyed() && !old.kept && old !== card) old.destroy() }, 1500)
}

// 全屏或勿扰：卡片先藏起来，退出后再拿出来；指认留着的高亮框直接撤掉，免得盖在游戏上
onVisibilityChange((hidden) => {
  if (hidden) {
    if (card?.isVisible()) { card.hide(); card.hiddenBySuppress = true }
    card?.releasePick?.()
    if (card) card.releasePick = undefined
    if (pillWin?.isVisible()) pillWin.hide()
    return
  }
  if (card && !card.isDestroyed() && card.hiddenBySuppress) {
    card.hiddenBySuppress = false
    card.showInactive()
  }
  if (pillWin && !pillWin.isDestroyed() && !pillWin.isVisible()) pillWin.showInactive()
})

// ---------- 卡片发来的 ----------
ipcMain.handle('card-to-agent', (_e, msg) => agents.current().request(msg ?? {}))
ipcMain.on('card-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
// 关卡片 → 把 agent 提到前台并切到这张卡片对应的会话
ipcMain.on('card-open-agent', (e, sessionId) => {
  logError('card-open-agent-diag', `from card, sessionId=${sessionId}`)
  BrowserWindow.fromWebContents(e.sender)?.close()
  agents.current().open(sessionId)
})
// 只认 http(s) 和本机绝对路径；本机文件只在资源管理器 / 访达里定位，不直接运行
ipcMain.on('card-open-link', (_e, href) => {
  const s = String(href ?? '')
  if (/^https?:\/\//i.test(s)) shell.openExternal(s)
  else if (path.isAbsolute(s) && fs.existsSync(s)) shell.showItemInFolder(s)
})
// 回答里的本机图片：用系统默认的看图程序打开（只认图片文件）
ipcMain.on('card-open-image', (_e, file) => {
  const s = String(file ?? '')
  if (path.isAbsolute(s) && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(s) && fs.existsSync(s)) shell.openPath(s)
})
// 卡片上「装扩展」：打开装浏览器扩展的引导卡（notices 不依赖这里，按需取）
ipcMain.on('card-extension-guide', () => require('./notices').showExtensionGuide())
ipcMain.on('card-copy', (_e, text) => clipboard.writeText(String(text ?? '')))
ipcMain.on('card-asked', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  c?.releasePick?.()
  if (c) c.releasePick = undefined
})
// 内容变高时跟着变高；用户拖过大小之后就不再自动改
ipcMain.on('card-resize', (e, height) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c || c.manualSize) return
  const b = c.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  const h = Math.min(Number(height) || CARD_H_ANSWER, workArea.height)
  // 下拉开着、窗口被临时撑高时只记下来，关菜单时还原到这个高度
  if (c.menuBaseH) { c.menuBaseH = h; return }
  c.setBounds({ x: b.x, y: Math.min(b.y, workArea.y + workArea.height - h), width: c.cardW ?? cardWidth, height: h })
})
// 卡片的下拉比窗口长：临时把窗口往下撑高（手动调过大小也撑），0 = 还原
ipcMain.on('card-menu-room', (e, height) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c) return
  const b = c.getBounds()
  if (!height) {
    if (c.menuBaseH) c.setBounds({ ...b, height: c.menuBaseH })
    c.menuBaseH = undefined
    return
  }
  if (height <= b.height) return
  const { workArea } = screen.getDisplayMatching(b)
  c.menuBaseH ??= b.height
  c.setBounds({ ...b, height: Math.min(Math.ceil(height), workArea.y + workArea.height - b.y) })
})
// 右下角拖拽：按下时记住窗口和光标，拖动时用主进程拿到的光标位置算（不用渲染进程的坐标，缩放下不准）
let gripDrag
ipcMain.on('card-grip-start', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (c) gripDrag = { c, b: c.getBounds(), p: screen.getCursorScreenPoint() }
})
ipcMain.on('card-grip-move', (e) => {
  const { c, b, p } = gripDrag ?? {}
  if (!c || c.isDestroyed() || c !== BrowserWindow.fromWebContents(e.sender)) return
  const now = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayMatching(b)
  const width = Math.round(Math.min(Math.max(CARD_MIN_W, b.width + now.x - p.x), workArea.x + workArea.width - b.x))
  const height = Math.round(Math.min(Math.max(CARD_MIN_H, b.height + now.y - p.y), workArea.y + workArea.height - b.y))
  c.manualSize = true
  c.cardW = width
  cardWidth = width
  c.setBounds({ x: b.x, y: b.y, width, height })
})
ipcMain.on('card-grip-end', () => { gripDrag = undefined })

// 调试：POINTY_CAPTURE 设了目录时，卡片到关键状态就截一张
let captureSeq = 0
ipcMain.on('card-rendered', async (_e, name) => {
  if (!CAPTURE_DIR || !card) return
  await new Promise(r => setTimeout(r, 400))
  const image = await card.webContents.capturePage()
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CAPTURE_DIR, `${String(++captureSeq).padStart(2, '0')}-card-${name}.png`), image.toPNG())
})

// ---------- 收起的任务：右下角托盘上方一叠胶囊 ----------
let pills = [] // { id: 'card<窗口 id>', sessionId, win, title, fixedTitle, state: 'run' | 'done' | 'error' }
let pillWin
const PILL_W = 300

function updatePills() {
  if (!pills.length) {
    if (pillWin && !pillWin.isDestroyed()) pillWin.destroy()
    pillWin = undefined
    return
  }
  if (!pillWin || pillWin.isDestroyed()) {
    pillWin = new BrowserWindow({
      width: PILL_W, height: 60, show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
      // 不节流：被别的窗口盖住时动画和量高度照常走
      webPreferences: { preload: path.join(APP_DIR, 'pill', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
    })
    pillWin.setAlwaysOnTop(true, 'floating')
    pillWin.loadFile(path.join(APP_DIR, 'pill', 'pill.html'))
    pillWin.webContents.once('did-finish-load', () => sendPills())
    return
  }
  sendPills()
}
const sendPills = () => pillWin?.webContents.send('pills', pills.map(p => ({ id: p.id, title: p.title, state: p.state })))

/** 按内容高度贴在主屏右下角，托盘上方 */
function placePills(height) {
  if (!pillWin || pillWin.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const h = Math.max(1, Math.min(Math.ceil(height), workArea.height))
  // 测试：放到屏幕外面，照常渲染、人看不到
  const off = offscreen()
  pillWin.setBounds({ x: off ? -20000 : workArea.x + workArea.width - PILL_W, y: off ? -20000 : workArea.y + workArea.height - h, width: PILL_W, height: h })
  if (!pillWin.isVisible() && (off || !suppressed())) pillWin.showInactive()
}

// 收起：卡片藏起来（窗口留着，agent 接着往里写），右下角托盘上方多一条胶囊；点胶囊在原位置放回卡片
ipcMain.on('card-keep', (e, info) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c) return
  const sessionId = typeof info?.sessionId === 'string' ? info.sessionId : undefined
  if (!sessionId) return c.close()
  c.kept = true
  c.keptBounds = c.getBounds()
  // 往右下角托盘那边滑过去（卡片里同时缩小淡出），到了再藏
  if (offscreen() || !c.isVisible()) c.hide()
  else glide(c, c.keptBounds, trayCorner(c.keptBounds), 220, () => { if (c.kept && !c.isDestroyed()) c.hide() })
  c.releasePick?.()
  c.releasePick = undefined
  if (card === c) card = undefined
  // 一张卡片一条胶囊（两张卡片可能问的是同一个会话）
  const id = `card${c.id}`
  pills = pills.filter(p => p.id !== id)
  pills.push({ id, sessionId, win: c, fixedTitle: !!info.fixedTitle, title: String(info.title || '新任务'), state: info.state === 'done' || info.state === 'error' ? info.state : 'run' })
  c.once('closed', () => { pills = pills.filter(p => p.win !== c); updatePills() })
  updatePills()
})

/** agent 报的任务进度：胶囊跟着变（起好标题就换掉问题原话） */
function onTask(msg) {
  const mine = pills.filter(x => x.sessionId === msg.sessionId)
  if (!mine.length) return
  let changed = false
  for (const p of mine) {
    if (msg.title && !p.fixedTitle && msg.title !== p.title) { p.title = msg.title; changed = true }
    if (p.state !== 'run') continue
    if (msg.type === 'ask-done') { p.state = msg.reason === 'completed' ? 'done' : 'error'; changed = true }
    else if (msg.type === 'ask-error') { p.state = 'error'; changed = true }
  }
  if (changed) updatePills()
}

// 点胶囊：卡片回到收起前的位置（那块屏幕不在了才放到光标旁边），从胶囊那边放大出来
ipcMain.on('pill-open', (_e, id) => {
  const p = pills.find(x => x.id === id)
  logError('pill-open-diag', `click ${id} found=${!!p} win=${p?.win ? (p.win.isDestroyed() ? 'destroyed' : 'alive') : 'none'}`)
  pills = pills.filter(x => x.id !== id)
  updatePills()
  const c = p?.win
  if (!c || c.isDestroyed()) return
  if (card !== c) setAsideCard()
  c.kept = false
  card = c
  const k = c.keptBounds
  const onScreen = k && screen.getAllDisplays().some(({ workArea: w }) => k.x < w.x + w.width && k.x + k.width > w.x && k.y < w.y + w.height && k.y + k.height > w.y)
  const off = offscreen()
  const to = off ? { ...c.getBounds(), x: -20000, y: -20000 } : onScreen ? { ...k, height: c.getBounds().height } : cardBounds(c.getBounds().height, c.cardW)
  c.webContents.send('card-restore')
  if (off) { c.setBounds(to); return c.showInactive() }
  // 从右下角托盘那边滑回原位（卡片里同时放大）
  const from = trayCorner(to)
  c.setBounds(from)
  c.show()
  c.focus()
  glide(c, from, to, 240)
  // 排查：放回后卡片到底看不看得见（出过点胶囊后直接跳 agent 的问题）
  setTimeout(() => {
    if (c.isDestroyed()) return logError('pill-open-diag', 'card destroyed')
    c.webContents.executeJavaScript(`JSON.stringify({ op: getComputedStyle(document.getElementById('card')).opacity, cls: document.getElementById('card').className, anim: document.getElementById('card').style.animation })`)
      .then(r => logError('pill-open-diag', `visible=${c.isVisible()} bounds=${JSON.stringify(c.getBounds())} ${r}`), err => logError('pill-open-diag', err))
  }, 600)
})

/** 卡片窗口右下角贴到主屏右下角（胶囊那里）时的位置，大小不变 */
function trayCorner(b) {
  const { workArea: w } = screen.getPrimaryDisplay()
  return { ...b, x: w.x + w.width - b.width, y: w.y + w.height - b.height }
}

/** 窗口从 from 滑到 to（只动位置），先快后慢 */
function glide(c, from, to, ms, done) {
  clearInterval(c.glideTimer)
  const t0 = Date.now()
  c.glideTimer = setInterval(() => {
    if (c.isDestroyed()) return clearInterval(c.glideTimer)
    const t = Math.min(1, (Date.now() - t0) / ms)
    const e = 1 - (1 - t) ** 3
    c.setBounds({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), width: to.width, height: to.height })
    if (t < 1) return
    clearInterval(c.glideTimer)
    done?.()
  }, 16)
}
// ×：不看了，卡片也一起关掉（agent 那边不受影响）
ipcMain.on('pill-dismiss', (_e, id) => {
  const p = pills.find(x => x.id === id)
  pills = pills.filter(x => x.id !== id)
  updatePills()
  if (p?.win && !p.win.isDestroyed()) p.win.destroy()
})
ipcMain.on('pill-resize', (_e, height) => placePills(Number(height) || 0))

module.exports = {
  openCard, broadcast, onTask, ownHandles,
  current: () => card,
  all: () => [...cards],
  focused: () => !!card?.isFocused(),
  setOffscreen: (on) => { offscreenCards = on },
  pills: () => pills.map(({ win, ...p }) => p),
  pillBounds: () => pillWin?.getBounds(),
}

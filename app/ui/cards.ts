import { BrowserWindow, clipboard, ipcMain, screen, shell } from 'electron'
import type { Rectangle } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, CAPTURE_DIR, TEST_HIDDEN, logError } from '../core/env.ts'
import { suppressed, onVisibilityChange } from '../core/state.ts'
import os from '../core/os/index.ts'
import * as agents from '../agents/index.ts'
import type { TaskEvent } from '../agents/index.ts'
import type { PickRelease } from '../pick/uipick.ts'

declare global {
  namespace Electron {
    interface BrowserWindow {
      cardW?: number
      releasePick?: PickRelease
      kept?: boolean
      keptBounds?: Rectangle
      hiddenBySuppress?: boolean
      manualSize?: boolean
      menuBaseH?: number
      glideTimer?: NodeJS.Timeout
    }
  }
}

const MASCOT_ROOM = 50
const CARD_W = 520 + MASCOT_ROOM
const CARD_MIN_W = 360 + MASCOT_ROOM
const CARD_MIN_H = 200
const CARD_H_ASK = 300
const CARD_H_ANSWER = 560

let card: BrowserWindow | undefined
const cards = new Set<BrowserWindow>()
let cardWidth = CARD_W
let offscreenCards = false
const offscreen = () => TEST_HIDDEN || offscreenCards

export const broadcast = (msg: AgentEvent) => { for (const c of cards) c.webContents.send('agent', msg) }

function cardBounds(height: number, width = cardWidth) {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const x = Math.min(Math.max(cursor.x + 12, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(cursor.y + 16, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

export function openCard(init: Grab | PairCard, releasePick?: PickRelease) {
  if (suppressed() && !TEST_HIDDEN && !offscreenCards) return releasePick?.()
  setAsideCard()
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
  self.loadFile(path.join(APP_DIR, 'card', 'card.html'))
  self.webContents.once('did-finish-load', () => {
    card!.webContents.send('card-init', (init.mode === 'pair' ? init : { grab: init, agent: { name: agents.current().name } }) satisfies CardInit)
    if (offscreen()) { card!.setPosition(-20000, -20000); card!.showInactive(); return }
    card!.show()
    card!.focus()
  })
  self.on('closed', () => { if (card === self) card = undefined })
}

export function ownHandles() {
  return [...cards].filter(w => !w.isDestroyed()).map(os.windowId)
}

// 位置自己记小数，不从 getBounds 读回来（150% 缩放下取整会抖）
const FOLLOW_POLL_MS = 16
function followOwner(c: BrowserWindow, owner: bigint) {
  const start = os.windowOrigin(owner)
  if (!start) return
  let last = start
  let pos: { x: number; y: number } | undefined
  let placed: { x: number; y: number } | undefined
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

function setAsideCard() {
  if (!card || card.isDestroyed()) return
  const old = card
  card = undefined
  old.webContents.send('card-set-aside')
  setTimeout(() => { if (!old.isDestroyed() && !old.kept && old !== card) old.destroy() }, 1500)
}

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

ipcMain.handle('card-to-agent', (_e, msg) => agents.current().request(msg ?? {}))
ipcMain.on('card-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.on('card-open-agent', (e, sessionId: string | undefined) => {
  BrowserWindow.fromWebContents(e.sender)?.close()
  agents.current().open(sessionId)
})
ipcMain.on('card-open-link', (_e, href) => {
  const s = String(href ?? '')
  if (/^https?:\/\//i.test(s)) shell.openExternal(s)
  else if (path.isAbsolute(s) && fs.existsSync(s)) shell.showItemInFolder(s)
})
ipcMain.on('card-open-image', (_e, file) => {
  const s = String(file ?? '')
  if (path.isAbsolute(s) && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(s) && fs.existsSync(s)) shell.openPath(s)
})
ipcMain.on('card-extension-guide', () => (require('./notices') as typeof import('./notices.ts')).showExtensionGuide())
ipcMain.on('card-copy', (_e, text) => clipboard.writeText(String(text ?? '')))
ipcMain.on('card-asked', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  c?.releasePick?.()
  if (c) c.releasePick = undefined
})
ipcMain.on('card-resize', (e, height) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c || c.manualSize) return
  const b = c.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  const h = Math.min(Number(height) || CARD_H_ANSWER, workArea.height)
  if (c.menuBaseH) { c.menuBaseH = h; return }
  c.setBounds({ x: b.x, y: Math.min(b.y, workArea.y + workArea.height - h), width: c.cardW ?? cardWidth, height: h })
})
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
// 拖动时用主进程拿到的光标位置算（渲染进程的坐标在缩放下不准）
let gripDrag: { c: BrowserWindow; b: Rectangle; p: { x: number; y: number } } | undefined
ipcMain.on('card-grip-start', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (c) gripDrag = { c, b: c.getBounds(), p: screen.getCursorScreenPoint() }
})
ipcMain.on('card-grip-move', (e) => {
  if (!gripDrag) return
  const { c, b, p } = gripDrag
  if (c.isDestroyed() || c !== BrowserWindow.fromWebContents(e.sender)) return
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

let captureSeq = 0
ipcMain.on('card-rendered', async (_e, name: string) => {
  if (!CAPTURE_DIR || !card) return
  await new Promise(r => setTimeout(r, 400))
  const image = await card.webContents.capturePage()
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CAPTURE_DIR, `${String(++captureSeq).padStart(2, '0')}-card-${name}.png`), image.toPNG())
})

interface Pill extends PillItem {
  id: string
  sessionId: string
  win: BrowserWindow
  fixedTitle: boolean
}
let pills: Pill[] = []
let pillWin: BrowserWindow | undefined
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
      webPreferences: { preload: path.join(APP_DIR, 'pill', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
    })
    pillWin.setAlwaysOnTop(true, 'floating')
    pillWin.loadFile(path.join(APP_DIR, 'pill', 'pill.html'))
    pillWin.webContents.once('did-finish-load', () => sendPills())
    return
  }
  sendPills()
}
const sendPills = () => pillWin?.webContents.send('pills', pills.map((p): PillItem => ({ id: p.id, title: p.title, state: p.state })))

function placePills(height: number) {
  if (!pillWin || pillWin.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const h = Math.max(1, Math.min(Math.ceil(height), workArea.height))
  const off = offscreen()
  pillWin.setBounds({ x: off ? -20000 : workArea.x + workArea.width - PILL_W, y: off ? -20000 : workArea.y + workArea.height - h, width: PILL_W, height: h })
  if (!pillWin.isVisible() && (off || !suppressed())) pillWin.showInactive()
}

ipcMain.on('card-keep', (e, info: KeepInfo | undefined) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c) return
  const sessionId = typeof info?.sessionId === 'string' ? info.sessionId : undefined
  if (!sessionId) return c.close()
  c.kept = true
  c.keptBounds = c.getBounds()
  if (offscreen() || !c.isVisible()) c.hide()
  else glide(c, c.keptBounds, trayCorner(c.keptBounds), 220, () => { if (c.kept && !c.isDestroyed()) c.hide() })
  c.releasePick?.()
  c.releasePick = undefined
  if (card === c) card = undefined
  const id = `card${c.id}`
  pills = pills.filter(p => p.id !== id)
  pills.push({ id, sessionId, win: c, fixedTitle: !!info?.fixedTitle, title: info?.title || undefined, state: info?.state === 'done' || info?.state === 'error' ? info.state : 'run' })
  c.once('closed', () => { pills = pills.filter(p => p.win !== c); updatePills() })
  updatePills()
})

export function onTask(msg: TaskEvent) {
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

ipcMain.on('pill-open', (_e, id: string) => {
  const p = pills.find(x => x.id === id)
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
  const from = trayCorner(to)
  c.setBounds(from)
  c.show()
  c.focus()
  glide(c, from, to, 240)
})

function trayCorner(b: Rectangle) {
  const { workArea: w } = screen.getPrimaryDisplay()
  return { ...b, x: w.x + w.width - b.width, y: w.y + w.height - b.height }
}

function glide(c: BrowserWindow, from: Rectangle, to: Rectangle, ms: number, done?: () => void) {
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
ipcMain.on('pill-dismiss', (_e, id: string) => {
  const p = pills.find(x => x.id === id)
  pills = pills.filter(x => x.id !== id)
  updatePills()
  if (p?.win && !p.win.isDestroyed()) p.win.destroy()
})
ipcMain.on('pill-resize', (_e, height) => placePills(Number(height) || 0))

export const current = () => card
export const all = () => [...cards]
export const focused = () => !!card?.isFocused()
export const setOffscreen = (on: boolean) => { offscreenCards = on }
const listPills = () => pills.map(({ win, ...p }) => p)
export { listPills as pills }
export const pillBounds = () => pillWin?.getBounds()

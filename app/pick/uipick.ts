import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron'
import type { Display, Rectangle } from 'electron'
import path from 'node:path'
import { uiaRequest } from './selection.ts'
import os from '../core/os/index.ts'
import { coverage, focusRect, isOpaque, isWholeWindow } from './opaque.ts'

const POLL_MS = 70
const HOLD_MAX_MS = 5 * 60 * 1000
const RIGHT_POLL_MS = 15
const TIMEOUT_MS = 30_000

const CONTROL_LABEL = {
  'ControlType.Document': '文档', 'ControlType.Edit': '输入框', 'ControlType.Text': '文字', 'ControlType.List': '列表',
  'ControlType.ListItem': '列表项', 'ControlType.Button': '按钮', 'ControlType.Pane': '面板', 'ControlType.Window': '窗口',
  'ControlType.Group': '分组', 'ControlType.DataItem': '数据行', 'ControlType.TreeItem': '树节点', 'ControlType.Hyperlink': '链接',
  'ControlType.Image': '图片', 'ControlType.Table': '表格', 'ControlType.Custom': '控件', 'ControlType.MenuItem': '菜单项',
}

const label = (c: { control?: string } | undefined) => CONTROL_LABEL[c?.control as keyof typeof CONTROL_LABEL] ?? '控件'

async function captureRect(display: Display, rect: number[]) {
  const scale = display.scaleFactor
  const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  // 截图按物理像素；rect 是屏幕坐标（Windows 已是物理像素，macOS 是点要乘缩放）
  const k = scale / os.unitsPerDip(display)
  rect = rect.map(v => Math.round(v * k))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find(s => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!source) return undefined
  const o = os.toScreenPoint({ x: display.bounds.x, y: display.bounds.y })
  const origin = { x: Math.round(o.x * k), y: Math.round(o.y * k) }
  const pad = 6
  const crop = {
    x: Math.max(0, rect[0] - origin.x - pad),
    y: Math.max(0, rect[1] - origin.y - pad),
    width: Math.min(size.width, rect[2] + pad * 2),
    height: Math.min(size.height, rect[3] + pad * 2),
  }
  crop.width = Math.min(crop.width, size.width - crop.x)
  crop.height = Math.min(crop.height, size.height - crop.y)
  if (crop.width < 4 || crop.height < 4) return undefined
  let img = source.thumbnail.crop(crop)
  if (img.getSize().width > 1600) img = img.resize({ width: 1600 })
  return `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`
}

const FOCUS_STEP = 1.15
const FOCUS_MIN = 0.35
const FOCUS_MAX = 4

export type PickRelease = (() => void) & { shift?: (dx: number, dy: number) => void }

export type NativePick =
  | { blocked: '指的是密码框'; release?: PickRelease }
  | {
    blocked?: undefined
    release: PickRelease
    element: GrabElement
    image: string | undefined
    wide: string | undefined
    focused: boolean
    opaque: boolean
    diag: { cls: string; control: string; kids: boolean; readable: boolean; cover: number | null; text: number; opaque: boolean }
  }

type DrawnControl = A11yChainItem & { rect: ScreenRect }

export function pickNative({ note }: { note?: string } = {}): Promise<NativePick | null> {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const overlay = new BrowserWindow({
    ...display.bounds,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'overlay', 'preload.js'), contextIsolation: true, sandbox: false },
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'))
  overlay.once('ready-to-show', () => overlay.showInactive())
  if (note) overlay.webContents.once('did-finish-load', () => { if (!overlay.isDestroyed()) overlay.webContents.send('note', note) })
  os.swapCursor(display.scaleFactor)

  let levelUp = 0
  let zoom = 1
  let chain: DrawnControl[] = []
  let point = os.toScreenPoint(cursor)
  let busy = false

  return new Promise((resolve) => {
    let finished = false
    const keys = ['Space', 'Escape', '[', ']']

    const poll = setInterval(async () => {
      if (busy || overlay.isDestroyed()) return
      busy = true
      try {
        point = os.toScreenPoint(screen.getCursorScreenPoint())
        const r = await uiaRequest(`point ${point.x} ${point.y}`, 1000)
        chain = (r?.chain ?? []).filter((c): c is DrawnControl => !!c.rect && c.rect[2] > 4 && c.rect[3] > 4)
        if (chain[0] && r?.chain?.[0] && chain[0].rect === r.chain[0].rect) chain[0].opaque = isOpaque({ ...chain[0], kids: r.leafKids, readable: r.leafReadable, win: r.win })
        draw()
      } finally {
        busy = false
      }
    }, POLL_MS)

    let drawn = ''
    function draw() {
      if (finished || overlay.isDestroyed()) return
      const c = chain[Math.min(levelUp, chain.length - 1)]
      const key = c ? `${c.rect.join(',')}|${c.name ?? ''}|${c.opaque ? `${point.x},${point.y},${zoom}` : ''}` : ''
      if (key === drawn) return
      drawn = key
      if (!c) return overlay.webContents.send('highlight', null)
      const toLocal = (r: ScreenRect): LocalRect => {
        const dip: Rectangle = os.toDipRect({ x: r[0], y: r[1], width: r[2], height: r[3] })
        return { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y, width: dip.width, height: dip.height }
      }
      const f = c.opaque ? focusRect(c.rect, point, os.unitsPerDip(display), zoom) : undefined
      overlay.webContents.send('highlight', {
        ...toLocal(c.rect),
        label: `${label(c)}${c.name ? `：${c.name}` : ''}`,
        focus: f ? toLocal(f) : null,
      } satisfies OverlayHighlight)
    }

    const focusShown = () => { const c = chain[Math.min(levelUp, chain.length - 1)]; return !!c?.opaque && !!focusRect(c.rect, point, os.unitsPerDip(display)) }
    const onWheel = (dir: number) => {
      zoom = Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, zoom * (dir > 0 ? FOCUS_STEP : 1 / FOCUS_STEP)))
      draw()
    }
    const unhook = os.hookButtons({ onLeftUp: () => finish(true), onRightUp: () => finish(false), onWheel, wantWheel: () => !finished && focusShown() })
    let rightDown = false
    const rightPoll = unhook ? undefined : setInterval(() => {
      const down = os.rightButtonDown()
      if (down && !rightDown) {
        rightDown = true
        if (!overlay.isDestroyed()) overlay.setIgnoreMouseEvents(false)
      } else if (!down && rightDown) {
        finish(false)
      }
    }, RIGHT_POLL_MS)

    async function finish(confirm: boolean) {
      if (finished) return
      finished = true
      os.restoreCursor()
      clearInterval(poll)
      clearInterval(rightPoll)
      unhook?.()
      clearTimeout(timer)
      for (const k of keys) globalShortcut.unregister(k)
      const release: PickRelease = () => { clearTimeout(expire); if (!overlay.isDestroyed()) overlay.destroy() }
      release.shift = (dx, dy) => { if (!overlay.isDestroyed()) overlay.webContents.send('shift', { dx, dy }) }
      const expire = setTimeout(release, HOLD_MAX_MS)
      if (!confirm || !chain.length) { release(); return resolve(null) }
      if (!overlay.isDestroyed()) overlay.hide()
      const level = Math.min(levelUp, chain.length - 1)
      await new Promise(r => setTimeout(r, 150))
      const detail = await uiaRequest(`element ${point.x} ${point.y} ${level}`, 3000)
      if (!detail?.ok) { release(); return resolve(detail?.isPassword ? { blocked: '指的是密码框' } : null) }
      const whole = isWholeWindow({ rect: detail.rect, win: detail.win, control: detail.control })
      const opaque = isOpaque({ cls: detail.className, rect: detail.rect, kids: detail.kids, readable: detail.readable, win: detail.win, control: detail.control }) && (whole || !(detail.text ?? '').trim())
      const focus = detail.rect && opaque ? focusRect(detail.rect, point, os.unitsPerDip(display), zoom) : undefined
      const image = detail.rect ? await captureRect(display, focus ?? detail.rect).catch(() => undefined) : undefined
      const wideRect = focus ? detail.rect : detail.win && detail.win.join(',') !== (detail.rect ?? []).join(',') ? detail.win : undefined
      const wide = wideRect ? await captureRect(display, wideRect).catch(() => undefined) : undefined
      if (!overlay.isDestroyed()) {
        overlay.webContents.send('hold')
        const owner = os.foregroundId()
        overlay.setAlwaysOnTop(false)
        let attached = false
        try { attached = !!owner && os.attachToOwner(overlay, owner) } catch {}
        if (!attached) overlay.setAlwaysOnTop(true, 'floating')
        overlay.setIgnoreMouseEvents(true)
        overlay.showInactive()
      }
      resolve({
        release,
        element: {
          kind: 'ui-element',
          site: '',
          tag: detail.control,
          fields: { 控件: label(detail), 名称: (detail.name ?? '').slice(0, 120), 类名: detail.className ?? '', ...(detail.href ? { 链接: detail.href } : {}) },
          page: {},
          text: detail.text ?? '',
          links: [],
          images: [],
        },
        image,
        wide,
        focused: !!focus,
        opaque,
        diag: { cls: detail.className ?? '', control: detail.control ?? '', kids: !!detail.kids, readable: !!detail.readable, cover: detail.rect && detail.win ? Math.round(coverage(detail.rect, detail.win) * 100) : null, text: (detail.text ?? '').trim().length, opaque },
      })
    }

    const timer = setTimeout(() => finish(false), TIMEOUT_MS)
    globalShortcut.register('Space', () => finish(true))
    globalShortcut.register('Escape', () => finish(false))
    globalShortcut.register('[', () => { levelUp = Math.max(0, levelUp - 1); draw() })
    globalShortcut.register(']', () => { levelUp = Math.min(chain.length - 1, levelUp + 1); draw() })
  })
}

// 普通程序里的指认：一层鼠标穿透的透明遮罩画高亮框，读控件的小进程查光标下的控件。
// 遮罩让鼠标穿过去（不然查到的是遮罩自己），点击靠指认期间的系统级拦截接住（core/os 的 hookButtons）：左键选中、右键退出；
// 空格确认、Esc、[ ] 调范围这几个键只在指认期间注册，空格留着给钩子装不上时用。
const { BrowserWindow, desktopCapturer, globalShortcut, screen } = require('electron')
const path = require('node:path')
const { uiaRequest } = require('./selection')
const os = require('../core/os')

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

const label = (c) => CONTROL_LABEL[c?.control] ?? '控件'

/** 截一块屏幕区域（屏幕坐标），返回 JPEG data URL */
async function captureRect(display, rect) {
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
  // JPEG 比 PNG 小得多，截图只在内存里传
  return `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`
}

// QQ、网易云这类 Electron 程序关了无障碍，整个窗口只露出一个空壳控件
const CHROMIUM_SHELL = /^Chrome_(RenderWidgetHostHWND|WidgetWin_\d+)$|^Intermediate D3D Window$/
/**
 * 读不到里面东西的程序：要么是 Chromium 空壳类名；要么这个控件没有子控件、没有文字接口、还几乎占满整个窗口
 * （游戏、Qt、自绘界面）。普通程序里晃到的大面板一般有子控件，编辑区有文字接口，不会算进来
 */
function isOpaque({ cls, rect, kids, readable, win, control }) {
  if (CHROMIUM_SHELL.test(cls ?? '')) return true
  if (isWholeWindow({ rect, win, control })) return true
  if (kids || readable || !rect || !win) return false
  return coverage(rect, win) >= 0.9
}
const coverage = (r, w) => (r[2] * r[3]) / Math.max(1, w[2] * w[3])
/** 指到的就是整个程序窗口本身（系统只给了一个框，比如 Windows Terminal）：也给虚线小框 */
const isWholeWindow = ({ rect, win, control }) => control === 'ControlType.Window' && !!rect && !!win && coverage(rect, win) >= 0.98
// 空壳里再加一个跟着鼠标的小框（DIP），截图只截它；滚轮按档缩放
const FOCUS_W = 720
const FOCUS_H = 320
const FOCUS_STEP = 1.15
const FOCUS_MIN = 0.35
const FOCUS_MAX = 4
/** 鼠标为中心、不超出大框的小框（屏幕坐标 [x, y, w, h]，scale 是每个 DIP 几个单位）；大框本来就不大时 undefined */
function focusRect(rect, point, scale, zoom = 1) {
  if (rect[2] <= FOCUS_W * scale * 1.4 && rect[3] <= FOCUS_H * scale * 1.4) return undefined
  const w = Math.round(FOCUS_W * scale * zoom)
  const h = Math.round(FOCUS_H * scale * zoom)
  const cw = Math.min(w, rect[2])
  const ch = Math.min(h, rect[3])
  const x = Math.min(Math.max(point.x - cw / 2, rect[0]), rect[0] + rect[2] - cw)
  const y = Math.min(Math.max(point.y - ch / 2, rect[1]), rect[1] + rect[3] - ch)
  return [Math.round(x), Math.round(y), cw, ch]
}

/**
 * 进入指认，直到左键或空格确认 / Esc 或右键 / 超时。
 * @param note 提示条后面补的一句（比如浏览器扩展没连上）
 * @returns {Promise<{ element, image } | null>}
 */
function pickNative({ note } = {}) {
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
  let zoom = 1 // 虚线小框的缩放，滚轮调
  let chain = []
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
        chain = (r?.chain ?? []).filter(c => c.rect && c.rect[2] > 4 && c.rect[3] > 4)
        // 只给最深那个控件标空壳（往上调范围的祖先都当普通控件）
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
      // 没变就不重发，免得过渡动画一直被打断
      const key = c ? `${c.rect.join(',')}|${c.name ?? ''}|${c.opaque ? `${point.x},${point.y},${zoom}` : ''}` : ''
      if (key === drawn) return
      drawn = key
      if (!c) return overlay.webContents.send('highlight', null)
      const toLocal = (r) => {
        const dip = os.toDipRect({ x: r[0], y: r[1], width: r[2], height: r[3] })
        return { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y, width: dip.width, height: dip.height }
      }
      const f = c.opaque ? focusRect(c.rect, point, os.unitsPerDip(display), zoom) : undefined
      overlay.webContents.send('highlight', {
        ...toLocal(c.rect),
        label: `${label(c)}${c.name ? `：${c.name}` : ''}`,
        focus: f ? toLocal(f) : null,
      })
    }

    // 左键选中、右键退出。优先用钩子把左右键整个吃掉；钩子装不上时退回老办法（空格选中）：
    // 看到右键按下就让遮罩接住鼠标（下面的程序已经收到按下，有的程序还是会弹菜单）
    // 有虚线小框时滚轮调它的大小（往上滚变大），指认期间本来就接管了鼠标
    const focusShown = () => { const c = chain[Math.min(levelUp, chain.length - 1)]; return !!c?.opaque && !!focusRect(c.rect, point, os.unitsPerDip(display)) }
    const onWheel = (dir) => {
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

    async function finish(confirm) {
      if (finished) return
      finished = true
      os.restoreCursor()
      clearInterval(poll)
      clearInterval(rightPoll)
      unhook?.()
      clearTimeout(timer)
      for (const k of keys) globalShortcut.unregister(k)
      const release = () => { clearTimeout(expire); if (!overlay.isDestroyed()) overlay.destroy() }
      // 来源程序的窗口挪了，留着的高亮框跟着挪（DIP）
      release.shift = (dx, dy) => { if (!overlay.isDestroyed()) overlay.webContents.send('shift', { dx, dy }) }
      // 万一没人来撤，几分钟后自己撤掉，免得框一直挂在屏幕上
      const expire = setTimeout(release, HOLD_MAX_MS)
      if (!confirm || !chain.length) { release(); return resolve(null) }
      // 遮罩先藏起来再查再截，免得把高亮框截进去；截完再拿出来，只留高亮框，卡片关掉时撤掉
      if (!overlay.isDestroyed()) overlay.hide()
      const level = Math.min(levelUp, chain.length - 1)
      await new Promise(r => setTimeout(r, 150))
      const detail = await uiaRequest(`element ${point.x} ${point.y} ${level}`, 3000)
      if (!detail?.ok) { release(); return resolve(detail?.isPassword ? { blocked: '指的是密码框' } : null) }
      // 空壳程序（QQ、网易云）：截图只截跟着鼠标的小框，能读到元素的程序照旧截整块
      const whole = isWholeWindow({ rect: detail.rect, win: detail.win, control: detail.control })
      const opaque = isOpaque({ cls: detail.className, rect: detail.rect, kids: detail.kids, readable: detail.readable, win: detail.win, control: detail.control }) && (whole || !(detail.text ?? '').trim())
      const focus = detail.rect && opaque ? focusRect(detail.rect, point, os.unitsPerDip(display), zoom) : undefined
      const image = detail.rect ? await captureRect(display, focus ?? detail.rect).catch(() => undefined) : undefined
      // 第二张：空壳程序是整个大框；能读到元素的程序是整个窗口，让模型看到周围还有什么（比如文件夹里别的文件）
      const wideRect = focus ? detail.rect : detail.win && detail.win.join(',') !== (detail.rect ?? []).join(',') ? detail.win : undefined
      const wide = wideRect ? await captureRect(display, wideRect).catch(() => undefined) : undefined
      if (!overlay.isDestroyed()) {
        overlay.webContents.send('hold')
        // 和卡片一样挂到来源程序下面：在那个程序上面，别的程序切到前面就把它盖住；
        // 来源程序找不到时才退回置顶。后弹出的卡片挂在同一个程序下，会在它上面
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
        // 调试开关打开时主进程写进日志，看各个程序被归成哪类
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

module.exports = { pickNative }

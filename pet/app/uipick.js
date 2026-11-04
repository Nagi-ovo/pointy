// 普通程序里的指认：一层鼠标穿透的透明遮罩画高亮框，UI Automation 查光标下的控件。
// 遮罩让鼠标穿过去（不然查到的是遮罩自己），点击靠指认期间的低级鼠标钩子接住：左键选中、右键退出；
// 空格确认、Esc、[ ] 调范围这几个键只在指认期间注册，空格留着给钩子装不上时用。
const { BrowserWindow, desktopCapturer, globalShortcut, screen } = require('electron')
const koffi = require('koffi')
const path = require('node:path')
const { uiaRequest } = require('./selection')
const { foregroundAddress, setOwner } = require('./fullscreen')

const user32 = koffi.load('user32.dll')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)')
const VK_RBUTTON = 2

// 指认期间装一个低级鼠标钩子，把右键按下和抬起都吃掉：下面的程序完全收不到，也就不会弹它的右键菜单
const LowLevelMouseProc = koffi.proto('intptr __stdcall LowLevelMouseProc(int nCode, uintptr wParam, void *lParam)')
const SetWindowsHookExW = user32.func('intptr __stdcall SetWindowsHookExW(int idHook, LowLevelMouseProc *proc, intptr hmod, uint32 threadId)')
const CallNextHookEx = user32.func('intptr __stdcall CallNextHookEx(intptr hhk, int nCode, uintptr wParam, void *lParam)')
const UnhookWindowsHookEx = user32.func('int __stdcall UnhookWindowsHookEx(intptr hhk)')
const GetModuleHandleW = koffi.load('kernel32.dll').func('intptr __stdcall GetModuleHandleW(intptr name)')
const WH_MOUSE_LL = 14
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_MOUSEWHEEL = 0x020A

/**
 * 吃掉左右键：左键抬起 = 选中，右键抬起 = 取消；下面的程序都收不到。装不上返回 undefined（退回轮询 + 空格）
 * wantWheel() 为真时滚轮也吃掉，交给 onWheel（+1 往上滚 / -1 往下滚）
 */
function hookButtons({ onLeftUp, onRightUp, onWheel, wantWheel }) {
  let hook = 0
  const proc = koffi.register((nCode, wParam, lParam) => {
    const msg = Number(wParam)
    if (nCode >= 0 && msg === WM_MOUSEWHEEL && wantWheel?.()) {
      // MSLLHOOKSTRUCT.mouseData 在第 8 字节，高 16 位是滚动量
      let delta = 0
      try { delta = koffi.decode(lParam, 8, 'int32') >> 16 } catch {}
      if (delta) setImmediate(() => onWheel(Math.sign(delta)))
      return 1
    }
    if (nCode >= 0 && (msg === WM_RBUTTONDOWN || msg === WM_RBUTTONUP || msg === WM_LBUTTONDOWN || msg === WM_LBUTTONUP)) {
      // 钩子里要马上返回，收尾放到下一轮
      if (msg === WM_RBUTTONUP) setImmediate(onRightUp)
      if (msg === WM_LBUTTONUP) setImmediate(onLeftUp)
      return 1
    }
    return CallNextHookEx(0, nCode, wParam, lParam)
  }, koffi.pointer(LowLevelMouseProc))
  try {
    hook = SetWindowsHookExW(WH_MOUSE_LL, proc, GetModuleHandleW(0), 0)
  } catch {}
  if (!hook) { koffi.unregister(proc); return undefined }
  return () => { UnhookWindowsHookEx(hook); koffi.unregister(proc) }
}

// 指认期间把系统光标换成鲸鱼娘扒着箭头（箭头、文字 I 形、小手、十字都换，指到哪都是她）；
// 结束时让系统从注册表重新加载用户自己的光标方案，不改注册表
const LoadImageW = user32.func('intptr __stdcall LoadImageW(intptr hinst, const char16_t *name, uint32 type, int cx, int cy, uint32 flags)')
const SetSystemCursor = user32.func('bool __stdcall SetSystemCursor(intptr hcur, uint32 id)')
const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, intptr pv, uint32 winini)')
const IMAGE_CURSOR = 2
const LR_LOADFROMFILE = 0x10
const SPI_SETCURSORS = 0x57
const SWAPPED_CURSORS = [32512, 32513, 32649, 32515]
const CURSOR_SIZES = [32, 48, 64]
let cursorSwapped = false

function swapCursor(scaleFactor) {
  const want = 32 * scaleFactor
  const size = CURSOR_SIZES.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best))
  const file = path.join(__dirname, '..', 'assets', 'cursor', `cursor-${size}.cur`)
  try {
    // SetSystemCursor 会接管并销毁传进去的句柄，所以每种光标单独加载一份
    for (const id of SWAPPED_CURSORS) {
      const h = LoadImageW(0, file, IMAGE_CURSOR, 0, 0, LR_LOADFROMFILE)
      if (h) { SetSystemCursor(h, id); cursorSwapped = true }
    }
  } catch {}
}

/** 恢复用户自己的光标；force 用在启动时，防止上次崩溃留下鲸鱼娘光标 */
function restoreCursor(force) {
  if (!cursorSwapped && !force) return
  try { SystemParametersInfoW(SPI_SETCURSORS, 0, 0, 0) } catch {}
  cursorSwapped = false
}

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

/** 截一块屏幕区域（物理像素），返回 PNG data URL */
async function captureRect(display, rect) {
  const scale = display.scaleFactor
  const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find(s => String(s.display_id) === String(display.id)) ?? sources[0]
  if (!source) return undefined
  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
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
/** 鼠标为中心、不超出大框的小框（物理像素 [x, y, w, h]）；大框本来就不大时 undefined */
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
 * @returns {Promise<{ element, image } | null>}
 */
function pickNative() {
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
  swapCursor(display.scaleFactor)

  let levelUp = 0
  let zoom = 1 // 虚线小框的缩放，滚轮调
  let chain = []
  let point = screen.dipToScreenPoint(cursor)
  let busy = false

  return new Promise((resolve) => {
    let finished = false
    const keys = ['Space', 'Escape', '[', ']']

    const poll = setInterval(async () => {
      if (busy || overlay.isDestroyed()) return
      busy = true
      try {
        point = screen.dipToScreenPoint(screen.getCursorScreenPoint())
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
        const dip = screen.screenToDipRect(null, { x: r[0], y: r[1], width: r[2], height: r[3] })
        return { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y, width: dip.width, height: dip.height }
      }
      const f = c.opaque ? focusRect(c.rect, point, display.scaleFactor, zoom) : undefined
      overlay.webContents.send('highlight', {
        ...toLocal(c.rect),
        label: `${label(c)}${c.name ? `：${c.name}` : ''}`,
        focus: f ? toLocal(f) : null,
      })
    }

    // 左键选中、右键退出。优先用钩子把左右键整个吃掉；钩子装不上时退回老办法（空格选中）：
    // 看到右键按下就让遮罩接住鼠标（下面的程序已经收到按下，有的程序还是会弹菜单）
    // 有虚线小框时滚轮调它的大小（往上滚变大），指认期间本来就接管了鼠标
    const focusShown = () => { const c = chain[Math.min(levelUp, chain.length - 1)]; return !!c?.opaque && !!focusRect(c.rect, point, display.scaleFactor) }
    const onWheel = (dir) => {
      zoom = Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, zoom * (dir > 0 ? FOCUS_STEP : 1 / FOCUS_STEP)))
      draw()
    }
    const unhook = hookButtons({ onLeftUp: () => finish(true), onRightUp: () => finish(false), onWheel, wantWheel: () => !finished && focusShown() })
    let rightDown = false
    const rightPoll = unhook ? undefined : setInterval(() => {
      const down = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) !== 0
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
      restoreCursor()
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
      const focus = detail.rect && opaque ? focusRect(detail.rect, point, display.scaleFactor, zoom) : undefined
      const image = detail.rect ? await captureRect(display, focus ?? detail.rect).catch(() => undefined) : undefined
      // 第二张：空壳程序是整个大框；能读到元素的程序是整个窗口，让模型看到周围还有什么（比如文件夹里别的文件）
      const wideRect = focus ? detail.rect : detail.win && detail.win.join(',') !== (detail.rect ?? []).join(',') ? detail.win : undefined
      const wide = wideRect ? await captureRect(display, wideRect).catch(() => undefined) : undefined
      if (!overlay.isDestroyed()) {
        overlay.webContents.send('hold')
        // 和卡片一样挂到来源程序下面：在那个程序上面，别的程序切到前面就把它盖住；
        // 来源程序找不到时才退回置顶。后弹出的卡片挂在同一个程序下，会在它上面
        const owner = foregroundAddress()
        overlay.setAlwaysOnTop(false)
        try { if (owner) setOwner(overlay.getNativeWindowHandle().readBigUInt64LE(0), owner); else overlay.setAlwaysOnTop(true, 'floating') } catch { overlay.setAlwaysOnTop(true, 'floating') }
        overlay.setIgnoreMouseEvents(true)
        overlay.showInactive()
      }
      resolve({
        release,
        element: {
          kind: 'ui-element',
          site: '',
          tag: detail.control,
          fields: { 控件: label(detail), 名称: (detail.name ?? '').slice(0, 120), 类名: detail.className ?? '' },
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

module.exports = { pickNative, restoreCursor }

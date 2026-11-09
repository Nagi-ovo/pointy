// macOS：全屏检测、前台程序、模拟复制、指认期间拦截点击、读控件的小进程、卸载后清理。
// 屏幕坐标一律是点（左上角是主显示器左上角），和 Electron 的 DIP 相同，所以坐标换算都是原样
const { screen, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { koffi, CF, CG, libSystem, CGRect, constant, cfstr, toString, toNumber, toArray, dictGet, CFRelease, send, sendInt, orderAbove, objc, objc_getClass, sel_registerName, msgPtr } = require('./mac/cf')

// ---------- 窗口列表 ----------
const CGWindowListCopyWindowInfo = CG.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeTo)')
const CGRectMakeWithDictionaryRepresentation = CG.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CGRect *rect)')
const kCGWindowListOptionOnScreenOnly = 1
const kCGWindowListOptionIncludingWindow = 8
const kCGWindowListExcludeDesktopElements = 16

/** 屏幕上的窗口，从前往后：{ id, pid, layer, title, bounds: { x, y, width, height } } */
function windows(option = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, relativeTo = 0) {
  const list = CGWindowListCopyWindowInfo(option, relativeTo)
  if (!list) return []
  try {
    return toArray(list).map((info) => {
      const r = {}
      const bounds = CGRectMakeWithDictionaryRepresentation(dictGet(info, 'kCGWindowBounds'), r)
        ? { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height }
        : undefined
      return {
        id: BigInt(toNumber(dictGet(info, 'kCGWindowNumber')) ?? 0),
        pid: toNumber(dictGet(info, 'kCGWindowOwnerPID')) ?? 0,
        layer: toNumber(dictGet(info, 'kCGWindowLayer')) ?? 0,
        // 窗口标题要有屏幕录制权限才给
        title: toString(dictGet(info, 'kCGWindowName')) ?? '',
        bounds,
      }
    })
  } finally {
    CFRelease(list)
  }
}

const frontmostPid = () => sendInt(send(send('NSWorkspace', 'sharedWorkspace'), 'frontmostApplication'), 'processIdentifier')

/** 前台程序最上面的那个普通窗口 */
function frontWindow() {
  const pid = frontmostPid()
  return windows().find((w) => w.pid === pid && w.layer === 0)
}

/** @param ownIds 本程序自己的窗口（windowId 的结果），自己不算 */
function isFullscreenActive(ownIds = []) {
  const w = frontWindow()
  if (!w?.bounds || w.pid === process.pid || ownIds.includes(w.id)) return false
  const b = w.bounds
  return screen.getAllDisplays().some(({ bounds: d }) => b.x <= d.x && b.y <= d.y && b.x + b.width >= d.x + d.width && b.y + b.height >= d.y + d.height)
}

// ---------- 窗口 ----------
/** 自己的窗口在系统里的编号（和 foregroundId 可比）：getMediaSourceId 是 "window:<编号>:0" */
const windowId = (win) => BigInt(win.getMediaSourceId().split(':')[1] ?? 0)
const foregroundId = () => frontWindow()?.id ?? 0n
// Mac 上被唤起的程序自己能到前台，不用放行
const allowAnyForeground = () => {}
// 别的程序的窗口当不了 Pointy 窗口的父窗口，改成模仿 Windows 的效果：窗口留在普通层，
// 来源程序在前台时把挂在它上面的窗口按出现顺序排到它正上方；切到别的程序，那个程序的窗口自然盖住它们
const STACK_POLL_MS = 100
/** 来源窗口编号 → 挂在它上面的 Pointy 窗口，先挂的在下面 */
const attached = new Map()
let stackTimer

function restack() {
  const pid = frontmostPid()
  const onScreen = windows()
  const index = new Map(onScreen.map((w, i) => [w.id, i]))
  for (const [owner, list] of attached) {
    const live = list.filter((w) => !w.isDestroyed())
    if (!live.length || !index.has(owner)) { attached.delete(owner); continue }
    attached.set(owner, live)
    if (onScreen[index.get(owner)].pid !== pid) continue
    const shown = live.filter((w) => w.isVisible())
    // 越靠前编号越小；有一个落到来源窗口后面了才重排，平时不动
    if (!shown.some((w) => (index.get(windowId(w)) ?? Infinity) > index.get(owner))) continue
    let below = owner
    for (const w of shown) { orderAbove(w, below); below = windowId(w) }
  }
  if (!attached.size) { clearInterval(stackTimer); stackTimer = undefined }
}

function attachToOwner(win, owner) {
  win.setAlwaysOnTop(false)
  attached.set(owner, [...(attached.get(owner) ?? []), win])
  stackTimer ??= setInterval(restack, STACK_POLL_MS)
  return true
}

function windowOrigin(id) {
  const b = windows(kCGWindowListOptionIncludingWindow, Number(id))[0]?.bounds
  return b ? { x: b.x, y: b.y } : undefined
}

// ---------- 坐标：点就是 DIP ----------
const cursor = () => screen.getCursorScreenPoint()
const toScreenPoint = (dip) => ({ x: Math.round(dip.x), y: Math.round(dip.y) })
const toDipPoint = (p) => p
const toDipRect = (r) => r
const unitsPerDip = () => 1

// ---------- 鼠标、按键 ----------
const CGEventSourceButtonState = CG.func('bool CGEventSourceButtonState(int32 state, uint32 button)')
const CGEventSourceFlagsState = CG.func('uint64 CGEventSourceFlagsState(int32 state)')
const CGEventSourceKeyState = CG.func('bool CGEventSourceKeyState(int32 state, uint16 key)')
const kCGEventSourceStateCombinedSessionState = 0
const MOUSE_LEFT = 0
const MOUSE_RIGHT = 1
const MOUSE_CENTER = 2
const MODIFIER_MASK = 0x20000n | 0x40000n | 0x80000n | 0x100000n // Shift、Control、Option、Command
const KEY_SPACE = 49

const button = (b) => CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, b)
const buttonDown = () => [MOUSE_LEFT, MOUSE_RIGHT, MOUSE_CENTER].some(button)
const rightButtonDown = () => button(MOUSE_RIGHT)
// 光标藏起来（打字时、看视频时）系统不给普通程序查，按看得见算
const cursorVisible = () => true
const modifiersDown = () => (BigInt(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)) & MODIFIER_MASK) !== 0n ||
  CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, KEY_SPACE)

// ---------- 前台程序 ----------
const proc_pidpath = libSystem.func('int proc_pidpath(int pid, _Out_ uint8 *buf, uint32 size)')
function processPath(pid) {
  const buf = Buffer.alloc(4096)
  const n = proc_pidpath(pid, buf, buf.length)
  return n > 0 ? buf.toString('utf8', 0, n) : ''
}

/** 前台程序：窗口标题、可执行文件名（小写，例如 google chrome） */
function foreground() {
  const pid = frontmostPid()
  if (!pid) return { title: '', exe: '', exePath: '' }
  const w = windows().find((x) => x.pid === pid && x.layer === 0)
  const exePath = processPath(pid)
  return { hwnd: w?.id ?? 0n, title: w?.title ?? '', pid, exePath, exe: path.basename(exePath).toLowerCase() }
}

// Mac 上没有"以管理员身份运行"的窗口程序
const elevatedUnderCursor = () => false

const BROWSERS = new Set(['google chrome', 'google chrome beta', 'google chrome canary', 'microsoft edge', 'brave browser', 'vivaldi', 'chromium', 'arc'])
const browserKind = (exe) => (exe.startsWith('microsoft edge') ? 'edge' : 'chrome')
const BLOCKED_APPS = new Set([
  '1password', '1password 7', 'bitwarden', 'keepassxc', 'enpass', 'dashlane', 'lastpass', 'keychain access', 'passwords',
  'securityagent', 'loginwindow', 'coreautha', 'screensaverengine',
])
// Mac 的终端里 ⌘C 只是复制，这里只防着 ⌘C 有别的意思的程序
const NO_COPY_APPS = new Set(['vim', 'emacs'])

// ---------- 模拟复制 ----------
const CGEventCreateKeyboardEvent = CG.func('void *CGEventCreateKeyboardEvent(void *source, uint16 key, bool down)')
const CGEventSetFlags = CG.func('void CGEventSetFlags(void *event, uint64 flags)')
const CGEventPost = CG.func('void CGEventPost(uint32 tap, void *event)')
const kCGHIDEventTap = 0
const KEY_C = 8
const kCGEventFlagMaskCommand = 0x100000

const clipboardSeq = () => sendInt(send('NSPasteboard', 'generalPasteboard'), 'changeCount')
function sendCopy() {
  for (const down of [true, false]) {
    const e = CGEventCreateKeyboardEvent(null, KEY_C, down)
    CGEventSetFlags(e, kCGEventFlagMaskCommand)
    CGEventPost(kCGHIDEventTap, e)
    CFRelease(e)
  }
}

// ---------- 指认期间：拦下点击和滚轮 ----------
const CGEventTapCallBack = koffi.proto('void *CGEventTapCallBack(void *proxy, uint32 type, void *event, void *refcon)')
const CGEventTapCreate = CG.func('void *CGEventTapCreate(uint32 tap, uint32 place, uint32 options, uint64 mask, CGEventTapCallBack *callback, void *refcon)')
const CGEventTapEnable = CG.func('void CGEventTapEnable(void *tap, bool enable)')
const CGEventGetIntegerValueField = CG.func('int64 CGEventGetIntegerValueField(void *event, uint32 field)')
const CFMachPortCreateRunLoopSource = CF.func('void *CFMachPortCreateRunLoopSource(void *alloc, void *port, long order)')
const CFMachPortInvalidate = CF.func('void CFMachPortInvalidate(void *port)')
const CFRunLoopGetMain = CF.func('void *CFRunLoopGetMain()')
const CFRunLoopAddSource = CF.func('void CFRunLoopAddSource(void *loop, void *source, void *mode)')
const CFRunLoopRemoveSource = CF.func('void CFRunLoopRemoveSource(void *loop, void *source, void *mode)')
const kCGSessionEventTap = 1
const kCGHeadInsertEventTap = 0
const kCGEventTapOptionDefault = 0
const EVENT = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, scroll: 22, tapDisabledByTimeout: 0xFFFFFFFE, tapDisabledByUser: 0xFFFFFFFF }
const kCGScrollWheelEventDeltaAxis1 = 11
const TAP_MASK = [EVENT.leftDown, EVENT.leftUp, EVENT.rightDown, EVENT.rightUp, EVENT.scroll].reduce((m, t) => m | (1n << BigInt(t)), 0n)

/**
 * 吃掉左右键：左键抬起 = 选中，右键抬起 = 取消；下面的程序都收不到。没有辅助功能权限时装不上，返回 undefined（退回轮询 + 空格）
 * wantWheel() 为真时滚轮也吃掉，交给 onWheel（+1 往上滚 / -1 往下滚）
 */
function hookButtons({ onLeftUp, onRightUp, onWheel, wantWheel }) {
  let tap
  const callback = koffi.register((_proxy, type, event) => {
    if (type === EVENT.tapDisabledByTimeout || type === EVENT.tapDisabledByUser) { if (tap) CGEventTapEnable(tap, true); return event }
    if (type === EVENT.scroll) {
      if (!wantWheel?.()) return event
      const delta = Number(CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1))
      if (delta) setImmediate(() => onWheel(Math.sign(delta)))
      return null
    }
    // 回调里要马上返回，收尾放到下一轮
    if (type === EVENT.rightUp) setImmediate(onRightUp)
    if (type === EVENT.leftUp) setImmediate(onLeftUp)
    return null
  }, koffi.pointer(CGEventTapCallBack))
  tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, TAP_MASK, callback, null)
  if (!tap) { koffi.unregister(callback); return undefined }
  const source = CFMachPortCreateRunLoopSource(null, tap, 0)
  const loop = CFRunLoopGetMain()
  const mode = constant('kCFRunLoopCommonModes')
  CFRunLoopAddSource(loop, source, mode)
  CGEventTapEnable(tap, true)
  return () => {
    CGEventTapEnable(tap, false)
    CFRunLoopRemoveSource(loop, source, mode)
    CFMachPortInvalidate(tap)
    CFRelease(source)
    CFRelease(tap)
    tap = undefined
    koffi.unregister(callback)
  }
}

// 指认期间光标换成鲸鱼娘。后台程序本来不能设光标，要先打开窗口服务器的 SetsCursorInBackground（私有接口，
// 拿不到就照旧用系统光标）；鼠标下面的程序移动时会把光标设回自己的，所以每 16ms 再设一次（实测 99% 的时间是鲸鱼娘）
const CURSOR_PT = 32
const CURSOR_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'cursor')
const CURSOR_RESET_MS = 16
const msgCursor = objc.func('void *objc_msgSend(void *self, void *sel, void *image, CGPoint hotSpot)')
const msgObj = objc.func('void *objc_msgSend(void *self, void *sel, void *arg)')
const msgSize = objc.func('void objc_msgSend(void *self, void *sel, CGSize size)')
let whale
let cursorTimer

function whaleCursor() {
  const conn = CG.func('int32 _CGSDefaultConnection()')()
  CG.func('int32 CGSSetConnectionProperty(int32 a, int32 b, void *key, void *value)')(conn, conn, cfstr('SetsCursorInBackground'), constant('kCFBooleanTrue'))
  const alloc = (name) => msgPtr(objc_getClass(name), sel_registerName('alloc'))
  const image = msgObj(alloc('NSImage'), sel_registerName('initWithContentsOfFile:'), cfstr(path.join(CURSOR_DIR, 'cursor-64.png')))
  msgSize(image, sel_registerName('setSize:'), { width: CURSOR_PT, height: CURSOR_PT })
  // 热点和 Windows 用的同一个：cursor-32.cur 文件头里记着
  const cur = fs.readFileSync(path.join(CURSOR_DIR, `cursor-${CURSOR_PT}.cur`))
  return msgCursor(alloc('NSCursor'), sel_registerName('initWithImage:hotSpot:'), image, { x: cur.readUInt16LE(10), y: cur.readUInt16LE(12) })
}

function swapCursor() {
  try { whale ??= whaleCursor() } catch { return }
  const set = sel_registerName('set')
  clearInterval(cursorTimer)
  cursorTimer = setInterval(() => msgPtr(whale, set), CURSOR_RESET_MS)
}

function restoreCursor() {
  if (!cursorTimer) return
  clearInterval(cursorTimer)
  cursorTimer = undefined
  msgPtr(msgPtr(objc_getClass('NSCursor'), sel_registerName('arrowCursor')), sel_registerName('set'))
}

// ---------- 读控件：常驻的小进程（ax-helper.js），用 Pointy 自己的 Electron 当 Node 跑 ----------
const spawnA11yHelper = () => spawn(process.execPath, [path.join(__dirname, '..', '..', 'pick', 'native', 'ax-helper.js')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'ignore'],
})

let accessPrompted = false
/** 读控件、拦点击、模拟复制都要辅助功能权限；没给就弹一次系统的授权框，返回给用户看的一句话 */
function accessHint() {
  if (systemPreferences.isTrustedAccessibilityClient(false)) return undefined
  if (!accessPrompted) { accessPrompted = true; systemPreferences.isTrustedAccessibilityClient(true) }
  return '要先允许 Pointy 使用辅助功能：系统设置 → 隐私与安全性 → 辅助功能'
}

/** Pointy 退出后删掉 targets；最多等 30 秒 */
function removeAfterExit(targets) {
  const quote = (p) => `'${p.replace(/'/g, `'\\''`)}'`
  const script = `i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; rm -rf ${targets.map(quote).join(' ')}`
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
}

module.exports = {
  isFullscreenActive, windowId, foregroundId, allowAnyForeground, attachToOwner, windowOrigin,
  cursor, toScreenPoint, toDipPoint, toDipRect, unitsPerDip,
  cursorVisible, buttonDown, rightButtonDown, modifiersDown,
  foreground, elevatedUnderCursor, BROWSERS, browserKind, BLOCKED_APPS, NO_COPY_APPS,
  clipboardSeq, sendCopy, hookButtons, swapCursor, restoreCursor,
  spawnA11yHelper, accessHint, removeAfterExit,
}

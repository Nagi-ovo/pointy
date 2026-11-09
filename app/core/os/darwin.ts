// 屏幕坐标一律是点（左上角是主显示器左上角），和 Electron 的 DIP 相同，所以坐标换算都是原样
import { screen, systemPreferences } from 'electron'
import type { BrowserWindow, Point, Rectangle } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { koffi, CF, CG, libSystem, constant, cfstr, toString, toNumber, toArray, dictGet, CFRelease, send, sendInt, orderAbove, objc, objc_getClass, sel_registerName, msgPtr } from './mac/cf.ts'
import type { CGPointValue, CGRectValue, CGSizeValue } from './mac/cf.ts'
import type { A11yHelperProcess, ButtonHooks, Foreground, Pointer } from './types.ts'

const CGWindowListCopyWindowInfo: (option: number, relativeTo: number) => Pointer | null = CG.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeTo)')
const CGRectMakeWithDictionaryRepresentation: (dict: Pointer | null, rect: CGRectValue) => boolean = CG.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CGRect *rect)')
const kCGWindowListOptionOnScreenOnly = 1
const kCGWindowListOptionIncludingWindow = 8
const kCGWindowListExcludeDesktopElements = 16

interface WindowInfo { id: bigint; pid: number; layer: number; title: string; bounds: Rectangle | undefined }

/** 屏幕上的窗口，从前往后 */
function windows(option = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, relativeTo = 0): WindowInfo[] {
  const list = CGWindowListCopyWindowInfo(option, relativeTo)
  if (!list) return []
  try {
    return toArray(list).map((info) => {
      // koffi 把 _Out_ 结构体写进这个对象
      const r = {} as CGRectValue
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

function frontWindow() {
  const pid = frontmostPid()
  return windows().find((w) => w.pid === pid && w.layer === 0)
}

export function isFullscreenActive(ownIds: bigint[] = []) {
  const w = frontWindow()
  if (!w?.bounds || w.pid === process.pid || ownIds.includes(w.id)) return false
  const b = w.bounds
  return screen.getAllDisplays().some(({ bounds: d }) => b.x <= d.x && b.y <= d.y && b.x + b.width >= d.x + d.width && b.y + b.height >= d.y + d.height)
}

// getMediaSourceId 是 "window:<编号>:0"
export const windowId = (win: BrowserWindow) => BigInt(win.getMediaSourceId().split(':')[1] ?? 0)
export const foregroundId = () => frontWindow()?.id ?? 0n
// Mac 上被唤起的程序自己能到前台，不用放行
export const allowAnyForeground = () => {}
// 别的程序的窗口当不了 Pointy 窗口的父窗口
const STACK_POLL_MS = 100
const attached = new Map<bigint, BrowserWindow[]>()
let stackTimer: NodeJS.Timeout | undefined

function restack() {
  const pid = frontmostPid()
  const onScreen = windows()
  const index = new Map(onScreen.map((w, i) => [w.id, i]))
  for (const [owner, list] of attached) {
    const live = list.filter((w) => !w.isDestroyed())
    const ownerIndex = index.get(owner)
    if (!live.length || ownerIndex === undefined) { attached.delete(owner); continue }
    attached.set(owner, live)
    if (onScreen[ownerIndex].pid !== pid) continue
    const shown = live.filter((w) => w.isVisible())
    if (!shown.some((w) => (index.get(windowId(w)) ?? Infinity) > ownerIndex)) continue
    let below = owner
    for (const w of shown) { orderAbove(w, below); below = windowId(w) }
  }
  if (!attached.size) { clearInterval(stackTimer); stackTimer = undefined }
}

export function attachToOwner(win: BrowserWindow, owner: bigint) {
  win.setAlwaysOnTop(false)
  attached.set(owner, [...(attached.get(owner) ?? []), win])
  stackTimer ??= setInterval(restack, STACK_POLL_MS)
  return true
}

export function windowOrigin(id: bigint) {
  const b = windows(kCGWindowListOptionIncludingWindow, Number(id))[0]?.bounds
  return b ? { x: b.x, y: b.y } : undefined
}

export const cursor = () => screen.getCursorScreenPoint()
export const toScreenPoint = (dip: Point) => ({ x: Math.round(dip.x), y: Math.round(dip.y) })
export const toDipPoint = (p: Point) => p
export const toDipRect = (r: Rectangle) => r
export const unitsPerDip = () => 1

const CGEventSourceButtonState: (state: number, button: number) => boolean = CG.func('bool CGEventSourceButtonState(int32 state, uint32 button)')
const kCGEventSourceStateCombinedSessionState = 0
const MOUSE_LEFT = 0
const MOUSE_RIGHT = 1
const MOUSE_CENTER = 2

const button = (b: number) => CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, b)
export const buttonDown = () => [MOUSE_LEFT, MOUSE_RIGHT, MOUSE_CENTER].some(button)
export const rightButtonDown = () => button(MOUSE_RIGHT)
// 光标藏起来（打字时、看视频时）系统不给普通程序查，按看得见算
export const cursorVisible = () => true
const proc_pidpath: (pid: number, buf: Buffer, size: number) => number = libSystem.func('int proc_pidpath(int pid, _Out_ uint8 *buf, uint32 size)')
function processPath(pid: number) {
  const buf = Buffer.alloc(4096)
  const n = proc_pidpath(pid, buf, buf.length)
  return n > 0 ? buf.toString('utf8', 0, n) : ''
}

export function foreground(): Foreground {
  const pid = frontmostPid()
  if (!pid) return { title: '', exe: '', exePath: '' }
  const w = windows().find((x) => x.pid === pid && x.layer === 0)
  const exePath = processPath(pid)
  return { hwnd: w?.id ?? 0n, title: w?.title ?? '', pid, exePath, exe: path.basename(exePath).toLowerCase() }
}

// Mac 上没有"以管理员身份运行"的窗口程序
export const elevatedUnderCursor = () => false

export const BROWSERS = new Set(['google chrome', 'google chrome beta', 'google chrome canary', 'microsoft edge', 'brave browser', 'vivaldi', 'chromium', 'arc'])
export const browserKind = (exe: string) => (exe.startsWith('microsoft edge') ? 'edge' : 'chrome')
export const BLOCKED_APPS = new Set([
  '1password', '1password 7', 'bitwarden', 'keepassxc', 'enpass', 'dashlane', 'lastpass', 'keychain access', 'passwords',
  'securityagent', 'loginwindow', 'coreautha', 'screensaverengine',
])
const CGEventTapCallBack = koffi.proto('void *CGEventTapCallBack(void *proxy, uint32 type, void *event, void *refcon)')
const CGEventTapCreate: (tap: number, place: number, options: number, mask: bigint, callback: koffi.IKoffiRegisteredCallback, refcon: null) => Pointer | null = CG.func('void *CGEventTapCreate(uint32 tap, uint32 place, uint32 options, uint64 mask, CGEventTapCallBack *callback, void *refcon)')
const CGEventTapEnable: (tap: Pointer, enable: boolean) => void = CG.func('void CGEventTapEnable(void *tap, bool enable)')
const CGEventGetIntegerValueField: (event: Pointer, field: number) => number | bigint = CG.func('int64 CGEventGetIntegerValueField(void *event, uint32 field)')
const CFMachPortCreateRunLoopSource: (alloc: null, port: Pointer, order: number) => Pointer = CF.func('void *CFMachPortCreateRunLoopSource(void *alloc, void *port, long order)')
const CFMachPortInvalidate: (port: Pointer) => void = CF.func('void CFMachPortInvalidate(void *port)')
const CFRunLoopGetMain: () => Pointer = CF.func('void *CFRunLoopGetMain()')
const CFRunLoopAddSource: (loop: Pointer, source: Pointer, mode: Pointer) => void = CF.func('void CFRunLoopAddSource(void *loop, void *source, void *mode)')
const CFRunLoopRemoveSource: (loop: Pointer, source: Pointer, mode: Pointer) => void = CF.func('void CFRunLoopRemoveSource(void *loop, void *source, void *mode)')
const kCGSessionEventTap = 1
const kCGHeadInsertEventTap = 0
const kCGEventTapOptionDefault = 0
const EVENT = { leftDown: 1, leftUp: 2, rightDown: 3, rightUp: 4, scroll: 22, tapDisabledByTimeout: 0xFFFFFFFE, tapDisabledByUser: 0xFFFFFFFF }
const kCGScrollWheelEventDeltaAxis1 = 11
const TAP_MASK = [EVENT.leftDown, EVENT.leftUp, EVENT.rightDown, EVENT.rightUp, EVENT.scroll].reduce((m, t) => m | (1n << BigInt(t)), 0n)

// 没有辅助功能权限时 event tap 装不上
export function hookButtons({ onLeftUp, onRightUp, onWheel, wantWheel }: ButtonHooks) {
  let tap: Pointer | null | undefined
  const callback = koffi.register((_proxy: Pointer, type: number, event: Pointer) => {
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
  const installed = tap
  const source = CFMachPortCreateRunLoopSource(null, installed, 0)
  const loop = CFRunLoopGetMain()
  const mode = constant('kCFRunLoopCommonModes')
  CFRunLoopAddSource(loop, source, mode)
  CGEventTapEnable(installed, true)
  return () => {
    CGEventTapEnable(installed, false)
    CFRunLoopRemoveSource(loop, source, mode)
    CFMachPortInvalidate(installed)
    CFRelease(source)
    CFRelease(installed)
    tap = undefined
    koffi.unregister(callback)
  }
}

// 后台程序本来不能设光标，要先打开窗口服务器的 SetsCursorInBackground（私有接口，
// 拿不到就照旧用系统光标）；鼠标下面的程序移动时会把光标设回自己的，所以每 16ms 再设一次（实测 99% 的时间是鲸鱼娘）
const CURSOR_PT = 32
const CURSOR_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'cursor')
const CURSOR_RESET_MS = 16
const msgCursor: (self: Pointer, sel: Pointer, image: Pointer, hotSpot: CGPointValue) => Pointer = objc.func('void *objc_msgSend(void *self, void *sel, void *image, CGPoint hotSpot)')
const msgObj: (self: Pointer, sel: Pointer, arg: Pointer) => Pointer = objc.func('void *objc_msgSend(void *self, void *sel, void *arg)')
const msgSize: (self: Pointer, sel: Pointer, size: CGSizeValue) => void = objc.func('void objc_msgSend(void *self, void *sel, CGSize size)')
let whale: Pointer | undefined
let cursorTimer: NodeJS.Timeout | undefined

function whaleCursor() {
  const conn: number = CG.func('int32 _CGSDefaultConnection()')()
  CG.func('int32 CGSSetConnectionProperty(int32 a, int32 b, void *key, void *value)')(conn, conn, cfstr('SetsCursorInBackground'), constant('kCFBooleanTrue'))
  const alloc = (name: string) => msgPtr(objc_getClass(name), sel_registerName('alloc'))
  const image = msgObj(alloc('NSImage'), sel_registerName('initWithContentsOfFile:'), cfstr(path.join(CURSOR_DIR, 'cursor-64.png')))
  msgSize(image, sel_registerName('setSize:'), { width: CURSOR_PT, height: CURSOR_PT })
  // 热点和 Windows 用的同一个：cursor-32.cur 文件头里记着
  const cur = fs.readFileSync(path.join(CURSOR_DIR, `cursor-${CURSOR_PT}.cur`))
  return msgCursor(alloc('NSCursor'), sel_registerName('initWithImage:hotSpot:'), image, { x: cur.readUInt16LE(10), y: cur.readUInt16LE(12) })
}

export function swapCursor() {
  try { whale ??= whaleCursor() } catch { return }
  const cursorRef = whale
  const set = sel_registerName('set')
  clearInterval(cursorTimer)
  cursorTimer = setInterval(() => msgPtr(cursorRef, set), CURSOR_RESET_MS)
}

export function restoreCursor() {
  if (!cursorTimer) return
  clearInterval(cursorTimer)
  cursorTimer = undefined
  msgPtr(msgPtr(objc_getClass('NSCursor'), sel_registerName('arrowCursor')), sel_registerName('set'))
}

export const spawnA11yHelper = (): A11yHelperProcess => spawn(process.execPath, [path.join(__dirname, '..', '..', 'pick', 'native', 'ax-helper.js')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'ignore'],
})

let accessPrompted = false
/** 读控件、拦点击、模拟复制都要辅助功能权限；没给就弹一次系统的授权框，返回给用户看的一句话 */
export function accessHint() {
  if (systemPreferences.isTrustedAccessibilityClient(false)) return undefined
  if (!accessPrompted) { accessPrompted = true; systemPreferences.isTrustedAccessibilityClient(true) }
  return '要先允许 Pointy 使用辅助功能：系统设置 → 隐私与安全性 → 辅助功能'
}

export function removeAfterExit(targets: string[]) {
  const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`
  const script = `i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; rm -rf ${targets.map(quote).join(' ')}`
  spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
}

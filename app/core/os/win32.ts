import * as koffi from 'koffi'
import { screen } from 'electron'
import type { BrowserWindow, Display, Point, Rectangle } from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { A11yHelperProcess, ButtonHooks, Foreground, Pointer } from './types.ts'

// koffi 按 struct 定义读写的 JS 对象；intptr / uintptr 按值大小给 number 或 bigint
interface WinRect { left: number; top: number; right: number; bottom: number }
interface WinMonitorInfo { cbSize: number; rcMonitor: WinRect; rcWork: WinRect; dwFlags: number }
interface WinCursorInfo { cbSize: number; flags: number; hCursor: number; ptScreenPos: Point }
type IntPtr = number | bigint

const shell32 = koffi.load('shell32.dll')
const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' })
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const CURSORINFO = koffi.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'intptr', ptScreenPos: POINT })

const GetForegroundWindow: () => Pointer | null = user32.func('void * __stdcall GetForegroundWindow()')
const GetAsyncKeyState: (key: number) => number = user32.func('int16 __stdcall GetAsyncKeyState(int key)')
const GetClassNameW: (hwnd: Pointer, name: Buffer, max: number) => number = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16 *name, int max)')

const QUNS_RUNNING_D3D_FULL_SCREEN = 3
const QUNS_PRESENTATION_MODE = 4
// 桌面和任务栏本身也是"铺满屏幕的前台窗口"，不算全屏应用
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
const MONITOR_DEFAULTTONEAREST = 2

const SHQueryUserNotificationState: (state: [number]) => number = shell32.func('int32 __stdcall SHQueryUserNotificationState(_Out_ int32 *state)')
const GetWindowRect: (hwnd: Pointer, rect: WinRect) => boolean = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)')
const MonitorFromWindow: (hwnd: Pointer, flags: number) => Pointer | null = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)')
const GetMonitorInfoW: (monitor: Pointer | null, info: WinMonitorInfo) => boolean = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)')

function notificationState() {
  const out: [number] = [0]
  return SHQueryUserNotificationState(out) === 0 ? out[0] : 0
}

function className(hwnd: Pointer) {
  const buf = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, buf, 256)
  return buf.toString('utf16le', 0, n * 2)
}

/** 前台窗口是否盖满它所在的整块显示器（无边框全屏游戏常常不报 D3D 全屏状态） */
function foregroundCoversMonitor(ownIds: bigint[]) {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return false
  const addr = koffi.address(hwnd)
  if (ownIds.some(h => h === addr)) return false
  if (SHELL_CLASSES.has(className(hwnd))) return false
  const rect = {} as WinRect
  if (!GetWindowRect(hwnd, rect)) return false
  const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {} as WinRect, rcWork: {} as WinRect, dwFlags: 0 }
  if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), info)) return false
  const m = info.rcMonitor
  return rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
}

export function isFullscreenActive(ownIds: bigint[] = []) {
  const state = notificationState()
  if (state === QUNS_RUNNING_D3D_FULL_SCREEN || state === QUNS_PRESENTATION_MODE) return true
  // QUNS_BUSY 不算数：它只说明"有个置顶窗口铺满了屏幕"，Claude 的 computer use 覆盖层、录屏工具的遮罩都会触发，
  // 不一定是用户在看的东西。真正的全屏应用会是前台窗口，下面这条会抓到
  return foregroundCoversMonitor(ownIds)
}

export const windowId = (win: BrowserWindow) => win.getNativeWindowHandle().readBigUInt64LE(0)

export const foregroundId = () => {
  const hwnd = GetForegroundWindow()
  return hwnd ? koffi.address(hwnd) : 0n
}

// 让别的进程（这里是被 dsh:// 唤起的 DSH）能把自己提到前台；只有前台进程才有资格放行
const AllowSetForegroundWindow: (pid: number) => boolean = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 pid)')
const ASFW_ANY = 0xFFFFFFFF
export const allowAnyForeground = () => AllowSetForegroundWindow(ASFW_ANY)

// 把卡片挂到来源程序下面当"被拥有的窗口"：Windows 保证它在那个程序之上，
// 切到别的程序时跟着那个程序一起被盖住，回到那个程序时又跟着出来
const SetWindowLongPtrW: (hwnd: IntPtr, index: number, value: IntPtr) => IntPtr = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)')
const GA_ROOT = 2
const GetAncestorPtr: (hwnd: IntPtr, flags: number) => IntPtr = user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32 flags)')
const GWLP_HWNDPARENT = -8
export function attachToOwner(win: BrowserWindow, owner: bigint) {
  SetWindowLongPtrW(windowId(win), GWLP_HWNDPARENT, owner ? GetAncestorPtr(owner, GA_ROOT) : 0n)
  return true
}

const GetWindowRectAt: (hwnd: IntPtr, rect: WinRect) => boolean = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)')
const IsWindow: (hwnd: IntPtr) => boolean = user32.func('bool __stdcall IsWindow(intptr hwnd)')
export function windowOrigin(hwnd: bigint) {
  const root = GetAncestorPtr(hwnd, GA_ROOT)
  if (!root || !IsWindow(root)) return undefined
  const r = {} as WinRect
  return GetWindowRectAt(root, r) ? { x: r.left, y: r.top } : undefined
}

export const cursor = () => {
  const p = {} as Point
  return GetCursorPos(p) ? p : screen.dipToScreenPoint(screen.getCursorScreenPoint())
}
export const toScreenPoint = (dip: Point) => screen.dipToScreenPoint(dip)
export const toDipPoint = (p: Point) => screen.screenToDipPoint(p)
export const toDipRect = (r: Rectangle) => screen.screenToDipRect(null, r)
export const unitsPerDip = (display: Display) => display.scaleFactor

const GetCursorPos: (p: Point) => boolean = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
const GetCursorInfo: (info: WinCursorInfo) => boolean = user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *info)')
const CURSOR_SHOWING = 1
const VK_LBUTTON = 1
const VK_RBUTTON = 2
const VK_MBUTTON = 4

export function cursorVisible() {
  const info = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0, ptScreenPos: { x: 0, y: 0 } }
  return GetCursorInfo(info) && (info.flags & CURSOR_SHOWING) !== 0
}

const keyDown = (vk: number) => (GetAsyncKeyState(vk) & 0x8000) !== 0
export const buttonDown = () => [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].some(keyDown)
export const rightButtonDown = () => keyDown(VK_RBUTTON)

const GetWindowTextW: (hwnd: Pointer, text: Buffer, max: number) => number = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16 *text, int max)')
const GetWindowThreadProcessId: (hwnd: Pointer, pid: [number]) => number = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const OpenProcess: (access: number, inherit: boolean, pid: number) => Pointer | null = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW: (process: Pointer, flags: number, name: Buffer, size: [number]) => boolean = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *size)')
const CloseHandle: (handle: Pointer | null) => boolean = kernel32.func('bool __stdcall CloseHandle(void *handle)')
const WindowFromPoint: (p: Point) => Pointer | null = user32.func('void * __stdcall WindowFromPoint(POINT p)')
const GetAncestor: (hwnd: Pointer, flags: number) => Pointer | null = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)')
const OpenProcessToken: (process: Pointer, access: number, token: [Pointer | null]) => boolean = advapi32.func('bool __stdcall OpenProcessToken(void *process, uint32 access, _Out_ void **token)')
const GetTokenInformation: (token: Pointer | null, cls: number, info: [number], len: number, ret: [number]) => boolean = advapi32.func('bool __stdcall GetTokenInformation(void *token, int cls, _Out_ uint32 *info, uint32 len, _Out_ uint32 *ret)')
const TOKEN_QUERY = 8
const TokenElevation = 20
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

const utf16 = (buf: Buffer, chars: number) => buf.toString('utf16le', 0, chars * 2)

function processPath(pid: number) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const buf = Buffer.alloc(2048)
    const size: [number] = [1024]
    return QueryFullProcessImageNameW(handle, 0, buf, size) ? utf16(buf, size[0]) : ''
  } finally {
    CloseHandle(handle)
  }
}

function isElevated(pid: number) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return false
  try {
    const token: [Pointer | null] = [null]
    if (!OpenProcessToken(handle, TOKEN_QUERY, token)) return false
    try {
      const info: [number] = [0]
      return GetTokenInformation(token[0], TokenElevation, info, 4, [0]) && info[0] !== 0
    } finally {
      CloseHandle(token[0])
    }
  } finally {
    CloseHandle(handle)
  }
}

/**
 * 鼠标下面那个窗口是不是管理员程序。Pointy 是普通权限，Windows 不让它读管理员程序里的控件，
 * 鼠标钩子在那上面也收不到点击（确认、取消都失效），所以这种窗口不进指认
 */
export function elevatedUnderCursor() {
  const pt = {} as Point
  if (!GetCursorPos(pt)) return false
  const hwnd = WindowFromPoint(pt)
  if (!hwnd) return false
  const root = GetAncestor(hwnd, GA_ROOT) ?? hwnd
  const pid: [number] = [0]
  GetWindowThreadProcessId(root, pid)
  return pid[0] ? isElevated(pid[0]) : false
}

export function foreground(): Foreground {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return { title: '', exe: '', exePath: '' }
  const buf = Buffer.alloc(1024)
  const title = utf16(buf, GetWindowTextW(hwnd, buf, 512))
  const pid: [number] = [0]
  GetWindowThreadProcessId(hwnd, pid)
  const exePath = processPath(pid[0])
  return { hwnd: koffi.address(hwnd), title, pid: pid[0], exePath, exe: path.basename(exePath).toLowerCase() }
}

export const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe'])
export const browserKind = (exe: string) => (exe === 'msedge.exe' ? 'edge' : 'chrome')
export const BLOCKED_APPS = new Set([
  'keepass.exe', 'keepassxc.exe', '1password.exe', 'bitwarden.exe', 'lastpass.exe', 'enpass.exe', 'dashlane.exe',
  'roboform.exe', 'credentialuibroker.exe', 'consent.exe', 'logonui.exe', 'lockapp.exe',
])
const LowLevelMouseProc = koffi.proto('intptr __stdcall LowLevelMouseProc(int nCode, uintptr wParam, void *lParam)')
const SetWindowsHookExW: (idHook: number, proc: koffi.IKoffiRegisteredCallback, hmod: IntPtr, threadId: number) => IntPtr = user32.func('intptr __stdcall SetWindowsHookExW(int idHook, LowLevelMouseProc *proc, intptr hmod, uint32 threadId)')
const CallNextHookEx: (hhk: IntPtr, nCode: number, wParam: IntPtr, lParam: Pointer) => IntPtr = user32.func('intptr __stdcall CallNextHookEx(intptr hhk, int nCode, uintptr wParam, void *lParam)')
const UnhookWindowsHookEx: (hhk: IntPtr) => number = user32.func('int __stdcall UnhookWindowsHookEx(intptr hhk)')
const GetModuleHandleW: (name: IntPtr) => IntPtr = kernel32.func('intptr __stdcall GetModuleHandleW(intptr name)')
const WH_MOUSE_LL = 14
const WM_RBUTTONDOWN = 0x0204
const WM_RBUTTONUP = 0x0205
const WM_LBUTTONDOWN = 0x0201
const WM_LBUTTONUP = 0x0202
const WM_MOUSEWHEEL = 0x020A

export function hookButtons({ onLeftUp, onRightUp, onWheel, wantWheel }: ButtonHooks) {
  let hook: IntPtr = 0
  const proc = koffi.register((nCode: number, wParam: IntPtr, lParam: Pointer) => {
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

// SPI_SETCURSORS 让系统从注册表重新加载用户自己的光标方案，不改注册表
const LoadImageW: (hinst: IntPtr, name: string, type: number, cx: number, cy: number, flags: number) => IntPtr = user32.func('intptr __stdcall LoadImageW(intptr hinst, const char16_t *name, uint32 type, int cx, int cy, uint32 flags)')
const SetSystemCursor: (hcur: IntPtr, id: number) => boolean = user32.func('bool __stdcall SetSystemCursor(intptr hcur, uint32 id)')
const SystemParametersInfoW: (action: number, param: number, pv: IntPtr, winini: number) => boolean = user32.func('bool __stdcall SystemParametersInfoW(uint32 action, uint32 param, intptr pv, uint32 winini)')
const IMAGE_CURSOR = 2
const LR_LOADFROMFILE = 0x10
const SPI_SETCURSORS = 0x57
const SWAPPED_CURSORS = [32512, 32513, 32649, 32515]
const CURSOR_SIZES = [32, 48, 64]
const CURSOR_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'cursor')
let cursorSwapped = false

export function swapCursor(scaleFactor: number) {
  const want = 32 * scaleFactor
  const size = CURSOR_SIZES.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best))
  const file = path.join(CURSOR_DIR, `cursor-${size}.cur`)
  try {
    // SetSystemCursor 会接管并销毁传进去的句柄，所以每种光标单独加载一份
    for (const id of SWAPPED_CURSORS) {
      const h = LoadImageW(0, file, IMAGE_CURSOR, 0, 0, LR_LOADFROMFILE)
      if (h) { SetSystemCursor(h, id); cursorSwapped = true }
    }
  } catch {}
}

export function restoreCursor(force?: boolean) {
  if (!cursorSwapped && !force) return
  try { SystemParametersInfoW(SPI_SETCURSORS, 0, 0, 0) } catch {}
  cursorSwapped = false
}

export const spawnA11yHelper = (): A11yHelperProcess => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', '..', 'pick', 'native', 'uia-selection.ps1')], { windowsHide: true })

/** 读控件需要的系统权限：Windows 不用另外授权 */
export const accessHint = () => undefined

// exe 和 koffi.node 要等 Pointy 和它的子进程退干净才解锁
export function removeAfterExit(targets: string[]) {
  const quote = (p: string) => `'${p.replace(/'/g, "''")}'`
  const script = [
    `$exe = ${quote(process.execPath)}`,
    '$t0 = Get-Date',
    'while ((Get-Process | Where-Object { $_.Path -eq $exe }) -and ((Get-Date) - $t0).TotalSeconds -lt 30) { Start-Sleep -Milliseconds 500 }',
    ...targets.map((p) => `Remove-Item -LiteralPath ${quote(p)} -Recurse -Force -ErrorAction SilentlyContinue`),
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // 经 cmd 的 start 起：直接 spawn 的控制台子进程会跟着 Pointy 退出被关掉（实测），start 出来的那个能活下来
  spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

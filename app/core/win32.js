// 判断前台是不是全屏应用（游戏、演示、全屏视频），Pointy在这期间要藏起来
const koffi = require('koffi')

const QUNS_RUNNING_D3D_FULL_SCREEN = 3
const QUNS_PRESENTATION_MODE = 4
// 桌面和任务栏本身也是"铺满屏幕的前台窗口"，不算全屏应用
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])
const MONITOR_DEFAULTTONEAREST = 2

const shell32 = koffi.load('shell32.dll')
const user32 = koffi.load('user32.dll')
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' })

const SHQueryUserNotificationState = shell32.func('int32 __stdcall SHQueryUserNotificationState(_Out_ int32 *state)')
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)')
const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)')
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16 *name, int max)')
const IsZoomed = user32.func('bool __stdcall IsZoomed(void *hwnd)')

function notificationState() {
  const out = [0]
  return SHQueryUserNotificationState(out) === 0 ? out[0] : 0
}

function className(hwnd) {
  const buf = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, buf, 256)
  return buf.toString('utf16le', 0, n * 2)
}

/** 前台窗口是否盖满它所在的整块显示器（无边框全屏游戏常常不报 D3D 全屏状态） */
function foregroundCoversMonitor(ownHwnds) {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return false
  const addr = koffi.address(hwnd)
  if (ownHwnds.some(h => h === addr)) return false
  if (SHELL_CLASSES.has(className(hwnd))) return false
  // 最大化窗口四周有看不见的边框，矩形会超出屏幕几像素；任务栏自动隐藏时工作区就是整块屏，会被误判成全屏（issue #3）。
  // 全屏游戏、F11 都不是"最大化"状态，不受影响
  if (IsZoomed(hwnd)) return false
  const rect = {}
  if (!GetWindowRect(hwnd, rect)) return false
  const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 }
  if (!GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), info)) return false
  const m = info.rcMonitor
  return rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
}

/** @param ownHwnds 本程序自己的窗口句柄地址（BigInt），自己不算 */
function isFullscreenActive(ownHwnds = []) {
  const state = notificationState()
  if (state === QUNS_RUNNING_D3D_FULL_SCREEN || state === QUNS_PRESENTATION_MODE) return true
  // QUNS_BUSY 不算数：它只说明"有个置顶窗口铺满了屏幕"，Claude 的 computer use 覆盖层、录屏工具的遮罩都会触发，
  // 不一定是用户在看的东西。真正的全屏应用会是前台窗口，下面这条会抓到
  return foregroundCoversMonitor(ownHwnds)
}

// 置顶维护：Electron 窗口 hide/showInactive 或别的窗口激活后，Windows 上的 TOPMOST 会掉
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)')
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)')
const HWND_TOPMOST = -1n
const HWND_NOTOPMOST = -2n
const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x8n
const SWP_NOSIZE = 0x1
const SWP_NOMOVE = 0x2
const SWP_NOACTIVATE = 0x10
const SWP_NOOWNERZORDER = 0x200

const isTopmost = (hwnd) => (BigInt(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0n

/** 把窗口重新压到所有普通窗口上面，不激活、不移动 */
function assertTopmost(hwnd) {
  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}

/** 退到所有置顶窗口下面（仍在普通窗口上面），不激活、不移动 */
function yieldTopmost(hwnd) {
  SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}

// 系统弹出层：右键菜单、托盘溢出面板、Win11 的 XAML 弹出层、Alt+Tab、输入法切换。
// 开着的时候Pointy要让到它们下面，不然会挡住托盘图标和菜单
const SHELL_POPUP_CLASSES = ['#32768', 'TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow', 'Xaml_WindowedPopupClass', 'XamlExplorerHostIslandWindow', 'MultitaskingViewFrame', 'Shell_InputSwitchTopLevelWindow']
// 开始菜单、搜索、通知中心、快速设置在前台时是顶层 CoreWindow（普通 UWP 应用的顶层是 ApplicationFrameWindow）
const SHELL_FOREGROUND_CLASSES = new Set([...SHELL_POPUP_CLASSES, 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'ForegroundStaging', 'Windows.UI.Core.CoreWindow', 'ControlCenterWindow'])
const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)')

function anyVisible(cls) {
  for (let h = FindWindowExW(null, null, cls, null); h; h = FindWindowExW(null, h, cls, null)) {
    if (IsWindowVisible(h)) return true
  }
  return false
}

/** 前台是任务栏/系统弹出层，或者屏幕上开着一个系统弹出层 */
function shellPopupOpen() {
  const fg = GetForegroundWindow()
  if (fg && SHELL_FOREGROUND_CLASSES.has(className(fg))) return true
  return SHELL_POPUP_CLASSES.some(anyVisible)
}

const foregroundAddress = () => {
  const hwnd = GetForegroundWindow()
  return hwnd ? koffi.address(hwnd) : 0n
}

// 让别的进程（这里是被 dsh:// 唤起的 DSH）能把自己提到前台；只有前台进程才有资格放行
const AllowSetForegroundWindow = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 pid)')
const ASFW_ANY = 0xFFFFFFFF
const allowAnyForeground = () => AllowSetForegroundWindow(ASFW_ANY)

// 把卡片挂到来源程序下面当"被拥有的窗口"：Windows 保证它在那个程序之上，
// 切到别的程序时跟着那个程序一起被盖住，回到那个程序时又跟着出来
const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)')
const GA_ROOT = 2
const GetAncestor = user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32 flags)')
const GWLP_HWNDPARENT = -8
const setOwner = (hwnd, owner) => SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, owner ? GetAncestor(owner, GA_ROOT) : 0n)

// 来源程序窗口的左上角（物理像素），窗口没了返回 undefined；卡片跟着它挪
const GetWindowRectAt = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *rect)')
const IsWindow = user32.func('bool __stdcall IsWindow(intptr hwnd)')
function windowOrigin(hwnd) {
  const root = GetAncestor(hwnd, GA_ROOT)
  if (!root || !IsWindow(root)) return undefined
  const r = {}
  return GetWindowRectAt(root, r) ? { x: r.left, y: r.top } : undefined
}

module.exports = { isFullscreenActive, isTopmost, assertTopmost, yieldTopmost, shellPopupOpen, foregroundAddress, allowAnyForeground, setOwner, windowOrigin }

// 按下快捷键的那一刻取"用户选中了什么"：先认前台程序，浏览器问扩展，
// 其他程序用 UI Automation，再不行就模拟一次 Ctrl+C 并把剪贴板还原。只在被调用时读，不做任何监听。
const koffi = require('koffi')
const { clipboard } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16 *text, int max)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)')
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)')
const GetClipboardSequenceNumber = user32.func('uint32 __stdcall GetClipboardSequenceNumber()')
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *size)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)')
// koffi 的类型名是全局的，shake.js 已经注册过 POINT
koffi.struct('SEL_POINT', { x: 'int32', y: 'int32' })
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ SEL_POINT *p)')
const WindowFromPoint = user32.func('void * __stdcall WindowFromPoint(SEL_POINT p)')
const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32 flags)')
const advapi32 = koffi.load('advapi32.dll')
const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(void *process, uint32 access, _Out_ void **token)')
const GetTokenInformation = advapi32.func('bool __stdcall GetTokenInformation(void *token, int cls, _Out_ uint32 *info, uint32 len, _Out_ uint32 *ret)')
const GA_ROOT = 2
const TOKEN_QUERY = 8
const TokenElevation = 20

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const VK_SHIFT = 0x10
const VK_CONTROL = 0x11
const VK_MENU = 0x12
const VK_SPACE = 0x20
const VK_LWIN = 0x5b
const VK_RWIN = 0x5c
const VK_C = 0x43
const SC_CONTROL = 0x1d
const SC_C = 0x2e
const KEYEVENTF_KEYUP = 2

const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe'])
// 密码管理器、系统凭据框：碰都不碰
const BLOCKED_EXES = new Set([
  'keepass.exe', 'keepassxc.exe', '1password.exe', 'bitwarden.exe', 'lastpass.exe', 'enpass.exe', 'dashlane.exe',
  'roboform.exe', 'credentialuibroker.exe', 'consent.exe', 'logonui.exe', 'lockapp.exe',
])
const BLOCKED_TITLE = /密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay/i
// 终端里 Ctrl+C 是中断；带内置终端的编辑器焦点可能就在终端里。这些程序只用 UI Automation，绝不模拟 Ctrl+C
const NO_COPY_EXES = new Set([
  'windowsterminal.exe', 'wezterm-gui.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'openconsole.exe',
  'alacritty.exe', 'mintty.exe', 'wsl.exe', 'putty.exe', 'kitty.exe', 'tabby.exe', 'hyper.exe', 'warp.exe',
  'code.exe', 'cursor.exe', 'antigravity.exe', 'windsurf.exe', 'idea64.exe', 'pycharm64.exe', 'webstorm64.exe',
])

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function utf16(buf, chars) {
  return buf.toString('utf16le', 0, chars * 2)
}

function processPath(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const buf = Buffer.alloc(2048)
    const size = [1024]
    return QueryFullProcessImageNameW(handle, 0, buf, size) ? utf16(buf, size[0]) : ''
  } finally {
    CloseHandle(handle)
  }
}

/** 进程是不是以管理员身份运行（查不了就当不是） */
function isElevated(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return false
  try {
    const token = [null]
    if (!OpenProcessToken(handle, TOKEN_QUERY, token)) return false
    try {
      const info = [0]
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
function elevatedUnderCursor() {
  const pt = {}
  if (!GetCursorPos(pt)) return false
  const hwnd = WindowFromPoint(pt)
  if (!hwnd) return false
  const root = GetAncestor(hwnd, GA_ROOT) ?? hwnd
  const pid = [0]
  GetWindowThreadProcessId(root, pid)
  return pid[0] ? isElevated(pid[0]) : false
}

/** 前台窗口：标题、进程名 */
function foreground() {
  const hwnd = GetForegroundWindow()
  if (!hwnd) return { title: '', exe: '', exePath: '' }
  const buf = Buffer.alloc(1024)
  const title = utf16(buf, GetWindowTextW(hwnd, buf, 512))
  const pid = [0]
  GetWindowThreadProcessId(hwnd, pid)
  const exePath = processPath(pid[0])
  return { hwnd: koffi.address(hwnd), title, pid: pid[0], exePath, exe: path.basename(exePath).toLowerCase() }
}

function blockedReason(fg) {
  if (BLOCKED_EXES.has(fg.exe)) return `${fg.exe} 在黑名单里`
  if (BLOCKED_TITLE.test(fg.title)) return '窗口像是登录或密码页面'
  return undefined
}

/** UI Automation 走一个常驻的 PowerShell 小进程，省掉每次 .NET 启动的时间 */
class UiaHelper {
  start() {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native', 'uia-selection.ps1')], { windowsHide: true })
    this.proc.stdout.setEncoding('utf8')
    this.buffer = ''
    this.waiters = []
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        let parsed
        try { parsed = JSON.parse(line) } catch { continue }
        this.waiters.shift()?.(parsed)
      }
    })
    this.proc.on('exit', () => {
      this.proc = undefined
      for (const w of this.waiters.splice(0)) w(undefined)
    })
  }

  grab(timeoutMs = 1500) {
    return this.request('grab', timeoutMs)
  }

  /** 发一行命令（grab / point X Y / element X Y UP），等一行 JSON 回来 */
  request(command, timeoutMs = 1500) {
    if (!this.proc) this.start()
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      this.waiters.push(finish)
      this.proc.stdin.write(`${command}\n`)
      setTimeout(() => {
        if (done) return
        // 超时的那次回答以后会错位，干脆重启
        this.stop()
        finish(undefined)
      }, timeoutMs)
    })
  }

  stop() {
    this.proc?.kill()
    this.proc = undefined
  }
}

const uia = new UiaHelper()

/** 等用户松开快捷键里的修饰键，否则模拟的 Ctrl+C 会变成 Ctrl+Alt+C */
async function waitKeysReleased(timeoutMs = 800) {
  const keys = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_SPACE, VK_LWIN, VK_RWIN]
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (keys.every(k => (GetAsyncKeyState(k) & 0x8000) === 0)) return true
    await sleep(20)
  }
  return false
}

/** 模拟 Ctrl+C 拿选区，拿完把剪贴板原样放回（文本、HTML、RTF、图片） */
async function copySelection() {
  if (!await waitKeysReleased()) return ''
  const snapshot = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }
  const before = GetClipboardSequenceNumber()
  // 带上扫描码：Chromium/Electron 程序（QQNT 等）对扫描码为 0 的模拟按键不一定认
  keybd_event(VK_CONTROL, SC_CONTROL, 0, 0)
  keybd_event(VK_C, SC_C, 0, 0)
  keybd_event(VK_C, SC_C, KEYEVENTF_KEYUP, 0)
  keybd_event(VK_CONTROL, SC_CONTROL, KEYEVENTF_KEYUP, 0)
  // Electron 程序复制是异步的，多等一会儿
  const end = Date.now() + 1200
  while (Date.now() < end && GetClipboardSequenceNumber() === before) await sleep(15)
  if (GetClipboardSequenceNumber() === before) return ''
  await sleep(30)
  const text = clipboard.readText()
  const restore = {}
  if (snapshot.text) restore.text = snapshot.text
  if (snapshot.html) restore.html = snapshot.html
  if (snapshot.rtf) restore.rtf = snapshot.rtf
  if (!snapshot.image.isEmpty()) restore.image = snapshot.image
  if (Object.keys(restore).length) clipboard.write(restore)
  else clipboard.clear()
  return text
}

/**
 * @param extensionGrabFor (exe) => 向该浏览器里的扩展要选区的函数；没有可用扩展时返回 undefined
 * @returns {{ source, text?, url?, pageTitle?, before?, after?, method, blocked? }}
 */
async function grabSelection(extensionGrabFor, { allowCopy = true } = {}) {
  const fg = foreground()
  const source = { app: fg.exe, title: fg.title }
  const blocked = blockedReason(fg)
  if (blocked) return { source, blocked, method: 'none' }
  const extensionGrab = extensionGrabFor?.(fg.exe)
  if (extensionGrab) {
    const r = await extensionGrab().catch(() => undefined)
    if (r?.blocked) return { source, blocked: r.blocked, method: 'extension' }
    if (r && (r.text || r.url)) {
      if (BLOCKED_TITLE.test(r.pageTitle ?? '')) return { source, blocked: '页面像是登录或密码页面', method: 'extension' }
      return { source, method: 'extension', ...r }
    }
  }
  const u = await uia.grab()
  if (u?.isPassword) return { source, blocked: '焦点在密码框里', method: 'uia' }
  if (u?.ok && u.text?.trim()) return { source, method: 'uia', text: u.text }
  if (!allowCopy || NO_COPY_EXES.has(fg.exe)) return { source, method: 'none', text: '' }
  const text = await copySelection()
  return { source, method: text ? 'clipboard' : 'none', text }
}

module.exports = {
  grabSelection, foreground, blockedReason, elevatedUnderCursor, isElevated, copySelection, NO_COPY_EXES, BROWSERS,
  uiaRequest: (command, timeoutMs) => uia.request(command, timeoutMs),
  stopSelectionHelper: () => uia.stop(),
}

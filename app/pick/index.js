// 晃一下鼠标 → 指认 / 取选区 → 交出"抓到的东西"（grab）。不认识卡片也不认识 agent，结果交给 onGrab
//
// grab 的样子（卡片按它显示、拼给 agent 的内容）：
//   { source: { app, title }, method, text?, url?, pageTitle?, element?, image?, wideImage?, shotKind?, before?, after? }
// onGrab(grab, release?)：release 撤掉指认后留在屏幕上的高亮框
const { foreground, underCursor, blockedReason, elevatedUnderCursor, grabSelection, BROWSERS } = require('./selection')
const { startShakeDetector } = require('./shake')
const { pickNative } = require('./uipick')
const { settings, TEST_HIDDEN, logError } = require('../core/env')
const { isFullscreen, suppressed } = require('../core/state')

const PICK_TIMEOUT_MS = 60_000

let deps = {} // { onGrab(grab, release, owner?), showHint(text), browser: { count(), pickInBrowser(exe, cursor, urlHint) }, cardFocused() }
let busySince // 正在指认（浏览器里或系统层面）
let busyMode // 'browser' | 'native'
let busyToken // 这一轮指认的标记：被当成卡死清掉后，旧的那轮收尾时不能把新一轮的状态也清了
let busyDone // 这一轮指认结束时 resolve
let fallbackNoted = false // 浏览器里退回系统指认这件事，卡片上只提一次

/** 正在指认就不响应新的晃动；卡了太久（哪条路没收尾）就当它结束了，记一笔 */
function pickBusy() {
  if (!busySince) return false
  if (Date.now() - busySince < PICK_TIMEOUT_MS + 10_000) return true
  logError('pick-stuck', `cleared a stale ${busyMode} pick`)
  // 浏览器里那一轮可能还挂着，让扩展把页面上的指认层撤掉
  if (busyMode === 'browser') deps.browser?.abortPick?.()
  busySince = busyMode = busyToken = undefined
  return false
}

const busyAge = () => busySince ? `${busyMode} ${Math.round((Date.now() - busySince) / 1000)}s` : ''

async function busy(mode, fn) {
  const token = {}
  let done
  busyToken = token
  busySince = Date.now()
  busyMode = mode
  busyDone = new Promise(r => { done = r })
  try {
    return await fn()
  } finally {
    if (busyToken === token) busySince = busyMode = busyToken = undefined
    done()
  }
}

/**
 * 浏览器里的指认还在等点击时又晃了一下：多半是鼠标已经挪到别处、或者之前那次没注意到。
 * 撤掉旧的，接着按这次晃动重新来，不用干等它超时（issue #4）
 */
async function replaceBrowserPick() {
  logError('pick-restart', `replaced a browser pick after ${busyAge()}`)
  const wait = busyDone
  deps.browser.abortPick?.()
  await Promise.race([wait, new Promise(r => setTimeout(r, 1000))])
  return !pickBusy()
}

/** 浏览器里指认一块内容；返回扩展的结果类型 */
async function pickAndOpen(fg, cursor, urlHint) {
  const r = await busy('browser', () => deps.browser.pickInBrowser(fg.exe, cursor, urlHint))
  if (r.type === 'picked') {
    // 指到图片、视频、画布时扩展会附一张那块的截图（只在内存里）
    deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'pick', url: r.url, pageTitle: r.pageTitle, element: r.element, text: r.element?.text, image: r.image }, r.release)
  }
  return r.type
}

/**
 * 浏览器里没走扩展时，卡片上提一句（每次运行只提一次），用户才知道这次指得没那么准
 * @param fallback 'no-extension' 没有扩展连着 | 'no-response' 扩展连着但没接这次指认
 */
function fallbackNote(fallback) {
  if (!fallback || fallbackNoted) return {}
  fallbackNoted = true
  return { note: { text: fallback === 'no-extension' ? '浏览器扩展没连上，这次按普通程序指认，网页里指不到具体段落。' : '浏览器扩展这次没响应，按普通程序指认的。', install: fallback === 'no-extension' } }
}

/** 系统层面的指认：指一块、确认后交出去（读不到字的附截图） */
async function pickNativeAndOpen(fg, fallback) {
  // 高亮框和卡片挂在被指的那个程序下面（它不一定是前台程序）
  const r = await busy('native', () => pickNative({ owner: fg.hwnd, ...(fallback ? { note: '浏览器扩展未连接' } : {}) }))
  if (!r) return
  if (r.blocked) { r.release?.(); return logError('shake-ignored', `blocked: ${r.blocked}`) }
  // 读不到内容的（QQ 这类关了无障碍的 Electron 程序只露出一个空壳窗口）就附截图
  if (settings.debugPick) logError('pick-diag', JSON.stringify({ exe: fg.exe, ...r.diag }))
  const shell = !!r.opaque
  const element = shell ? { ...r.element, text: '', fields: { 控件: '程序界面' } } : r.element
  // 读不到字、或者框太大只截了鼠标附近一块，都带上截图
  const thin = shell || r.focused || (r.element.text ?? '').trim().length < 30
  deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'uia-pick', element: { ...element, site: fg.exe }, text: element.text, image: thin ? r.image : undefined, wideImage: r.wide, shotKind: r.focused ? 'focus' : 'element', ...fallbackNote(fallback) }, r.release, fg.hwnd)
}

/**
 * 晃一下鼠标：认鼠标下面的那个窗口，不是前台窗口（浏览器在前台、鼠标却在别的程序上时，要指的是那个程序，issue #5）。
 * 鼠标就在前台浏览器上才走扩展的指认（扩展只能在浏览器当前标签页里指）；
 * 鼠标就在前台程序上、而且已经选中了文字就用选区；其他情况进系统层面的指认
 */
async function onShake(x, y) {
  if (suppressed()) return
  if (pickBusy() && !(busyMode === 'browser' && await replaceBrowserPick())) return
  const fg = foreground()
  // 鼠标在 Pointy 自己的卡片、胶囊上时，按前台程序算
  const under = underCursor()
  const target = under.hwnd && under.pid !== process.pid ? under : fg
  const onForeground = target.hwnd === fg.hwnd
  // 密码管理器、登录页这类不碰；按鼠标指着的那个窗口查
  const blocked = blockedReason(target) ?? (onForeground ? undefined : blockedReason(fg))
  if (blocked) return logError('shake-ignored', `blocked: ${target.exe}: ${blocked}`)
  // 管理员程序：读不到控件、点击也拦不住，进了指认会卡住，直接提示
  if (elevatedUnderCursor()) return deps.showHint('这个程序以管理员身份运行，Pointy 读不到')
  // 浏览器里没走成扩展：记下原因（没连上 / 连着但没响应），后面的提示条和卡片都提一句
  let fallback
  if (BROWSERS.has(target.exe) && onForeground) {
    if (deps.browser.count()) {
      const r = await pickAndOpen(target, { x, y })
      if (r !== 'pick-unavailable') return
      fallback = 'no-response'
    } else {
      fallback = 'no-extension'
    }
    logError('pick-fallback', `${target.exe}: ${fallback}`)
  }
  if (onForeground) {
    // 晃动可能是误触，这条路绝不模拟按键
    const grab = await grabSelection(undefined, { allowCopy: false })
    if (grab.blocked) return logError('shake-ignored', `blocked: ${grab.blocked}`)
    if (grab.text?.trim()) return deps.onGrab({ ...grab, ...fallbackNote(fallback) })
  }
  return pickNativeAndOpen(target, fallback)
}

// 晃动被识别出来却没响应时记一笔原因（30 秒最多一条），"晃了没反应"时查 error.log 就知道是哪条拦的
let lastIgnoreLog = 0
function shakeIgnored() {
  const reason = !settings.shake ? '' : isFullscreen() ? 'fullscreen' : settings.dnd ? 'dnd' : pickBusy() && busyMode !== 'browser' ? `picking (${busyAge()})` : deps.cardFocused?.() ? 'card-focused' : TEST_HIDDEN ? 'test-hidden' : undefined
  if (reason && Date.now() - lastIgnoreLog > 30_000) { lastIgnoreLog = Date.now(); logError('shake-ignored', reason) }
  return reason !== undefined
}

function start(d) {
  deps = d
  if (TEST_HIDDEN) return
  startShakeDetector({
    onShake: (x, y) => { if (settings.shake) onShake(x, y).catch(() => {}) },
    shouldIgnore: () => shakeIgnored(),
    level: () => settings.shakeLevel,
  })
}

module.exports = { start, onShake, pickAndOpen, pickNative }

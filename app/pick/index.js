// 晃一下鼠标 → 指认 / 取选区 → 交出"抓到的东西"（grab）。不认识卡片也不认识 agent，结果交给 onGrab
//
// grab 的样子（卡片按它显示、拼给 agent 的内容）：
//   { source: { app, title }, method, text?, url?, pageTitle?, element?, image?, wideImage?, shotKind?, before?, after? }
// onGrab(grab, release?)：release 撤掉指认后留在屏幕上的高亮框
const { foreground, blockedReason, elevatedUnderCursor, grabSelection, BROWSERS } = require('./selection')
const { startShakeDetector } = require('./shake')
const { pickNative } = require('./uipick')
const { settings, TEST_HIDDEN, logError } = require('../core/env')
const { isFullscreen, suppressed } = require('../core/state')

const PICK_TIMEOUT_MS = 60_000

let deps = {} // { onGrab(grab, release), showHint(text), browser: { count(), pickInBrowser(exe, cursor, urlHint) }, cardFocused() }
let busySince // 正在指认（浏览器里或系统层面）

/** 正在指认就不响应新的晃动；卡了太久（哪条路没收尾）就当它结束了，记一笔 */
function pickBusy() {
  if (!busySince) return false
  if (Date.now() - busySince < PICK_TIMEOUT_MS + 10_000) return true
  logError('pick-stuck', 'cleared a stale pick')
  busySince = undefined
  return false
}

async function busy(fn) {
  busySince = Date.now()
  try { return await fn() } finally { busySince = undefined }
}

/** 浏览器里指认一块内容；返回扩展的结果类型 */
async function pickAndOpen(fg, cursor, urlHint) {
  const r = await busy(() => deps.browser.pickInBrowser(fg.exe, cursor, urlHint))
  if (r.type === 'picked') {
    // 指到图片、视频、画布时扩展会附一张那块的截图（只在内存里）
    deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'pick', url: r.url, pageTitle: r.pageTitle, element: r.element, text: r.element?.text, image: r.image }, r.release)
  }
  return r.type
}

/** 系统层面的指认：指一块、确认后交出去（读不到字的附截图） */
async function pickNativeAndOpen(fg) {
  const r = await busy(() => pickNative())
  if (!r) return
  if (r.blocked) { r.release?.(); return }
  // 读不到内容的（QQ 这类关了无障碍的 Electron 程序只露出一个空壳窗口）就附截图
  if (settings.debugPick) logError('pick-diag', JSON.stringify({ exe: fg.exe, ...r.diag }))
  const shell = !!r.opaque
  const element = shell ? { ...r.element, text: '', fields: { 控件: '程序界面' } } : r.element
  // 读不到字、或者框太大只截了鼠标附近一块，都带上截图
  const thin = shell || r.focused || (r.element.text ?? '').trim().length < 30
  deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'uia-pick', element: { ...element, site: fg.exe }, text: element.text, image: thin ? r.image : undefined, wideImage: r.wide, shotKind: r.focused ? 'focus' : 'element' }, r.release)
}

/** 晃一下鼠标：浏览器里走扩展的指认；其他地方已经选中文字就用选区，没有就进系统层面的指认 */
async function onShake(x, y) {
  if (suppressed() || pickBusy()) return
  const fg = foreground()
  // 密码管理器、终端这类不碰
  if (blockedReason(fg)) return
  // 管理员程序：读不到控件、点击也拦不住，进了指认会卡住，直接提示
  if (elevatedUnderCursor()) return deps.showHint('这个程序以管理员身份运行，Pointy 读不到')
  if (BROWSERS.has(fg.exe) && deps.browser.count()) {
    const r = await pickAndOpen(fg, { x, y })
    if (r !== 'pick-unavailable') return
  }
  // 晃动可能是误触，这条路绝不模拟按键
  const grab = await grabSelection(undefined, { allowCopy: false })
  if (grab.blocked) return
  if (grab.text?.trim()) return deps.onGrab(grab)
  return pickNativeAndOpen(fg)
}

// 晃动被识别出来却没响应时记一笔原因（30 秒最多一条），"晃了没反应"时查 error.log 就知道是哪条拦的
let lastIgnoreLog = 0
function shakeIgnored() {
  const reason = !settings.shake ? '' : isFullscreen() ? 'fullscreen' : settings.dnd ? 'dnd' : pickBusy() ? 'picking' : deps.cardFocused?.() ? 'card-focused' : TEST_HIDDEN ? 'test-hidden' : undefined
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

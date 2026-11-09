// 晃一下鼠标 → 指认 / 取选区 → 交出"抓到的东西"（grab，样子见 types.d.ts 的 Grab）。不认识卡片也不认识 agent，结果交给 onGrab
// onGrab(grab, release?)：release 撤掉指认后留在屏幕上的高亮框
import { foreground, blockedReason, elevatedUnderCursor, grabSelection, BROWSERS } from './selection.ts'
import { screen } from 'electron'
import os from '../core/os/index.ts'
import type { Foreground } from '../core/os/types.ts'
import { startShakeDetector } from './shake.ts'
import { pickNative } from './uipick.ts'
import type { PickRelease } from './uipick.ts'
import { settings, TEST_HIDDEN, logError } from '../core/env.ts'
import { isFullscreen, suppressed } from '../core/state.ts'
import type { BrowserPick } from '../browser/extensions.ts'

const PICK_TIMEOUT_MS = 60_000

export interface PickDeps {
  onGrab(grab: Grab, release?: PickRelease): void
  showHint(text: string): void
  browser: { count(): number; pickInBrowser(exe: string, cursor: { x: number; y: number }, urlHint?: string): Promise<BrowserPick> }
  cardFocused?(): boolean
}

// start() 之前是空的
let deps = {} as PickDeps
let busySince: number | undefined // 正在指认（浏览器里或系统层面）
let fallbackNoted = false // 浏览器里退回系统指认这件事，卡片上只提一次

/** 正在指认就不响应新的晃动；卡了太久（哪条路没收尾）就当它结束了，记一笔 */
function pickBusy() {
  if (!busySince) return false
  if (Date.now() - busySince < PICK_TIMEOUT_MS + 10_000) return true
  logError('pick-stuck', 'cleared a stale pick')
  busySince = undefined
  return false
}

async function busy<T>(fn: () => Promise<T>) {
  busySince = Date.now()
  try { return await fn() } finally { busySince = undefined }
}

/** 扩展要的光标是显示器的像素，网页拿它除以 devicePixelRatio：Mac 的点、Windows 的物理像素都先换成 DIP 再乘缩放比 */
function devicePixels(p: { x: number; y: number }) {
  const dip = os.toDipPoint(p)
  const { scaleFactor } = screen.getDisplayNearestPoint(dip)
  return { x: dip.x * scaleFactor, y: dip.y * scaleFactor }
}

/** 浏览器里指认一块内容；返回扩展的结果类型 */
export async function pickAndOpen(fg: Foreground, cursor: { x: number; y: number }, urlHint?: string) {
  const r = await busy(() => deps.browser.pickInBrowser(fg.exe, devicePixels(cursor), urlHint))
  if (r.type === 'picked') {
    // 指到图片、视频、画布时扩展会附一张那块的截图（只在内存里）
    deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'pick', url: r.url, pageTitle: r.pageTitle, element: r.element, text: r.element?.text, image: r.image }, r.release)
  }
  return r.type
}

type Fallback = 'no-extension' | 'no-response'

/**
 * 浏览器里没走扩展时，卡片上提一句（每次运行只提一次），用户才知道这次指得没那么准
 * @param fallback 'no-extension' 没有扩展连着 | 'no-response' 扩展连着但没接这次指认
 */
function fallbackNote(fallback: Fallback | undefined): { note?: GrabNote } {
  if (!fallback || fallbackNoted) return {}
  fallbackNoted = true
  return { note: { text: fallback === 'no-extension' ? '浏览器扩展没连上，这次按普通程序指认，网页里指不到具体段落。' : '浏览器扩展这次没响应，按普通程序指认的。', install: fallback === 'no-extension' } }
}

/** 系统层面的指认：指一块、确认后交出去（读不到字的附截图） */
async function pickNativeAndOpen(fg: Foreground, fallback: Fallback | undefined) {
  const r = await busy(() => pickNative(fallback ? { note: '浏览器扩展未连接' } : {}))
  if (!r) return
  if (r.blocked) { r.release?.(); return }
  // 读不到内容的（QQ 这类关了无障碍的 Electron 程序只露出一个空壳窗口）就附截图
  if (settings.debugPick) logError('pick-diag', JSON.stringify({ exe: fg.exe, ...r.diag }))
  const shell = !!r.opaque
  const element = shell ? { ...r.element, text: '', fields: { 控件: '程序界面' } } : r.element
  // 读不到字、或者框太大只截了鼠标附近一块，都带上截图
  const thin = shell || r.focused || (r.element.text ?? '').trim().length < 30
  deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'uia-pick', element: { ...element, site: fg.exe }, text: element.text, image: thin ? r.image : undefined, wideImage: r.wide, shotKind: r.focused ? 'focus' : 'element', ...fallbackNote(fallback) }, r.release)
}

/** 晃一下鼠标：浏览器里走扩展的指认；其他地方已经选中文字就用选区，没有就进系统层面的指认 */
export async function onShake(x: number, y: number) {
  if (suppressed() || pickBusy()) return
  const fg = foreground()
  // 密码管理器、终端这类不碰
  if (blockedReason(fg)) return
  // macOS 没给辅助功能权限：读不到控件、拦不住点击，先请用户去授权
  const needAccess = os.accessHint()
  if (needAccess) return deps.showHint(needAccess)
  // 管理员程序：读不到控件、点击也拦不住，进了指认会卡住，直接提示
  if (elevatedUnderCursor()) return deps.showHint('这个程序以管理员身份运行，Pointy 读不到')
  // 浏览器里没走成扩展：记下原因（没连上 / 连着但没响应），后面的提示条和卡片都提一句
  let fallback: Fallback | undefined
  if (BROWSERS.has(fg.exe)) {
    if (deps.browser.count()) {
      const r = await pickAndOpen(fg, { x, y })
      if (r !== 'pick-unavailable') return
      fallback = 'no-response'
    } else {
      fallback = 'no-extension'
    }
    logError('pick-fallback', `${fg.exe}: ${fallback}`)
  }
  // 晃动可能是误触，这条路绝不模拟按键
  const grab = await grabSelection(undefined, { allowCopy: false })
  if (grab.blocked) return
  if (grab.text?.trim()) return deps.onGrab({ ...grab, ...fallbackNote(fallback) })
  return pickNativeAndOpen(fg, fallback)
}

// 晃动被识别出来却没响应时记一笔原因（30 秒最多一条），"晃了没反应"时查 error.log 就知道是哪条拦的
let lastIgnoreLog = 0
function shakeIgnored() {
  const reason = !settings.shake ? '' : isFullscreen() ? 'fullscreen' : settings.dnd ? 'dnd' : pickBusy() ? 'picking' : deps.cardFocused?.() ? 'card-focused' : TEST_HIDDEN ? 'test-hidden' : undefined
  if (reason && Date.now() - lastIgnoreLog > 30_000) { lastIgnoreLog = Date.now(); logError('shake-ignored', reason) }
  return reason !== undefined
}

export function start(d: PickDeps) {
  deps = d
  if (TEST_HIDDEN) return
  startShakeDetector({
    onShake: (x, y) => { if (settings.shake) onShake(x, y).catch(() => {}) },
    shouldIgnore: () => shakeIgnored(),
    level: () => settings.shakeLevel,
  })
}

export { pickNative }

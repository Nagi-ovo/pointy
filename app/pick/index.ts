import { foreground, blockedReason, elevatedUnderCursor, grabSelection, BROWSERS } from './selection.ts'
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

let deps = {} as PickDeps
let busySince: number | undefined
let fallbackNoted = false

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

export async function pickAndOpen(fg: Foreground, cursor: { x: number; y: number }, urlHint?: string) {
  const r = await busy(() => deps.browser.pickInBrowser(fg.exe, cursor, urlHint))
  if (r.type === 'picked') {
    deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'pick', url: r.url, pageTitle: r.pageTitle, element: r.element, text: r.element?.text, image: r.image }, r.release)
  }
  return r.type
}

type Fallback = 'no-extension' | 'no-response'

function fallbackNote(fallback: Fallback | undefined): { note?: GrabNote } {
  if (!fallback || fallbackNoted) return {}
  fallbackNoted = true
  return { note: { text: { key: fallback === 'no-extension' ? 'note.extensionOffline' : 'note.extensionSilent' }, install: fallback === 'no-extension' } }
}

async function pickNativeAndOpen(fg: Foreground, fallback: Fallback | undefined) {
  const r = await busy(() => pickNative(fallback ? { note: { key: 'overlay.extensionOffline' } } : {}))
  if (!r) return
  if (r.blocked) { r.release?.(); return }
  if (settings.debugPick) logError('pick-diag', JSON.stringify({ exe: fg.exe, ...r.diag }))
  const shell = !!r.opaque
  const element = shell ? { ...r.element, text: '', fields: { 控件: '程序界面' } } : r.element
  const thin = shell || r.focused || (r.element.text ?? '').trim().length < 30
  deps.onGrab({ source: { app: fg.exe, title: fg.title }, method: 'uia-pick', element: { ...element, site: fg.exe }, text: element.text, image: thin ? r.image : undefined, wideImage: r.wide, shotKind: r.focused ? 'focus' : 'element', ...fallbackNote(fallback) }, r.release)
}

export async function onShake(x: number, y: number) {
  if (suppressed() || pickBusy()) return
  const fg = foreground()
  if (blockedReason(fg)) return
  const needAccess = os.accessHint()
  if (needAccess) return deps.showHint(needAccess)
  if (elevatedUnderCursor()) return deps.showHint('这个程序以管理员身份运行，Pointy 读不到')
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
  const grab = await grabSelection()
  if (grab.blocked) return
  if (grab.text?.trim()) return deps.onGrab({ ...grab, ...fallbackNote(fallback) })
  return pickNativeAndOpen(fg, fallback)
}

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

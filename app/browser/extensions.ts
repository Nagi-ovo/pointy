import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { HOME_DIR, ROOT_DIR, TEST_HIDDEN, logError } from '../core/env.ts'
import os from '../core/os/index.ts'
import type { ExtensionSelection } from '../pick/selection.ts'
import type { showNotice as ShowNotice } from '../ui/notices.ts'

const { browserKind } = os

const EXTENSIONS_FILE = path.join(HOME_DIR, 'extensions.json')
// 给用户"加载已解压的扩展程序"用的固定位置；插件升级换目录也不影响已装的扩展
export const USER_EXTENSION_DIR = path.join(HOME_DIR, 'extension')
const BUNDLED_EXTENSION_DIR = path.join(ROOT_DIR, 'extension')
const PAIR_ASK_TIMEOUT_MS = 60_000
const PICK_TIMEOUT_MS = 60_000
const PICK_START_TIMEOUT_MS = 4000

export interface ExtensionMessage extends ExtensionSelection {
  type: string
  reqId?: string
  id?: string
  nonce?: string
  proof?: string
  browser?: string
  version?: string
  manual?: boolean
  tabTitle?: string
  tabUrl?: string
  element?: GrabElement
  image?: string
}

export type BrowserPick =
  | { type: 'picked'; url?: string; pageTitle?: string; element?: GrabElement; image?: string; release: () => void }
  | { type: 'pick-cancel' | 'pick-unavailable'; release?: () => void }

interface Picking {
  reqId: string
  started?: boolean
  resolve: (msg: ExtensionMessage | { type: 'pick-cancel' }) => void
  abort: () => void
}

const extensions = new Map<string, { ws: WebSocket; browser: string }>()
const deniedOrigins = new Set<string>()
let pairAsking = false
let picking: Picking | undefined
let lastPickTab: { title?: string; url?: string } | undefined

export interface ExtensionDeps {
  showNotice: typeof ShowNotice
  onSelection(grab: Grab): void
  onChange(): void
}
let deps = {} as ExtensionDeps
export const init = (d: ExtensionDeps) => { deps = d }

const hmac = (token: string, data: string) => crypto.createHmac('sha256', token).update(data).digest('hex')
const safeEqual = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
const send = (ws: WebSocket, msg: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)) }

function loadTokens(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(EXTENSIONS_FILE, 'utf8')) } catch { return {} }
}

function saveToken(id: string, token: string) {
  const all = loadTokens()
  all[id] = token
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(EXTENSIONS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 })
}

const manifestVersion = (dir: string): string | undefined => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version } catch { return undefined } }

export function syncUserExtension() {
  const bundled = manifestVersion(BUNDLED_EXTENSION_DIR)
  if (!bundled || path.resolve(BUNDLED_EXTENSION_DIR) === path.resolve(USER_EXTENSION_DIR)) return
  if (manifestVersion(USER_EXTENSION_DIR) === bundled) return
  try { fs.cpSync(BUNDLED_EXTENSION_DIR, USER_EXTENSION_DIR, { recursive: true, force: true }) } catch (err) { logError('extension-copy', err) }
}

// 只认浏览器扩展发起的连接（网页的 Origin 是 http(s)，伪造不了）
export function handlePairRequest(ws: WebSocket, req: IncomingMessage, msg: ExtensionMessage, stopKick: () => void) {
  const origin = String(req.headers.origin ?? '')
  if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) { ws.close(); return true }
  if (deniedOrigins.has(origin) && !msg.manual) { send(ws, { type: 'pair-denied' }); ws.close(); return true }
  if (pairAsking || TEST_HIDDEN && !global.pointyTest?.allowPairAsk) { send(ws, { type: 'pair-busy' }); ws.close(); return true }
  stopKick()
  pairAsking = true
  // 等用户点的时候隔一会儿发一条，扩展的 service worker 收到消息才不会被浏览器停掉
  const keep = setInterval(() => send(ws, { type: 'pair-wait' }), 10_000)
  const browser = msg.browser === 'edge' ? 'Edge' : 'Chrome'
  const asked = deps.showNotice({
    title: `${browser} 里的 Pointy 扩展想连接`,
    body: ['允许后，在浏览器里晃一下鼠标就能指认网页上的具体内容，右键菜单也能「问 Pointy」。'],
    buttons: [{ id: 'deny', label: '不允许' }, { id: 'allow', label: '允许', primary: true }],
    timeoutMs: PAIR_ASK_TIMEOUT_MS,
  })
  ws.once('close', () => asked.cancel?.())
  asked.then((choice) => {
    clearInterval(keep)
    pairAsking = false
    if (choice !== 'allow') {
      if (choice === 'deny') deniedOrigins.add(origin)
      send(ws, { type: 'pair-denied' })
      return ws.close()
    }
    deniedOrigins.delete(origin)
    const id = crypto.randomUUID()
    const token = crypto.randomBytes(32).toString('hex')
    saveToken(id, token)
    send(ws, { type: 'paired', id, token })
    ws.close()
  })
  return true
}

export function authenticate(ws: WebSocket, msg: ExtensionMessage, nonce: string) {
  const id = msg.id as string
  const token = loadTokens()[id]
  if (!token || !safeEqual(msg.proof, hmac(token, `ext|${nonce}`))) return undefined
  send(ws, { type: 'hello-ok', proof: hmac(token, `pet|${msg.nonce}`) })
  extensions.get(id)?.ws.close()
  extensions.set(id, { ws, browser: String(msg.browser ?? '') })
  deps.onChange?.()
  const onDisk = manifestVersion(BUNDLED_EXTENSION_DIR)
  if (onDisk && msg.version && msg.version !== onDisk) send(ws, { type: 'reload' })
  return id
}

export function onClosed(id: string, ws: WebSocket) {
  if (extensions.get(id)?.ws !== ws) return
  extensions.delete(id)
  deps.onChange?.()
}

export function onMessage(msg: ExtensionMessage) {
  if (msg.type === 'pick-started') {
    lastPickTab = { title: msg.tabTitle, url: msg.tabUrl }
    if (picking?.reqId === msg.reqId) picking!.started = true
  } else if (msg.type === 'picked' || msg.type === 'pick-cancel' || msg.type === 'pick-unavailable') {
    if (picking?.reqId === msg.reqId) picking!.resolve(msg)
  } else if (msg.type === 'selection') {
    deps.onSelection?.({ source: { app: msg.browser ?? 'browser', title: msg.pageTitle ?? '' }, method: 'extension', ...msg })
  }
}

function extensionFor(exe: string) {
  const want = browserKind(exe)
  return [...extensions.values()].find(e => e.browser === want) ?? [...extensions.values()][0]
}

export function pickInBrowser(exe: string, cursor: { x: number; y: number }, urlHint?: string): Promise<BrowserPick> {
  const ext = extensionFor(exe)
  if (!ext || ext.ws.readyState !== ext.ws.OPEN) return Promise.resolve({ type: 'pick-unavailable' })
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => {
      picking = undefined
      send(ext.ws, { type: 'pick-abort', reqId })
      resolve({ type: 'pick-cancel' })
    }, PICK_TIMEOUT_MS)
    const startTimer = setTimeout(() => {
      if (picking?.reqId !== reqId || picking.started) return
      logError('pick-no-start', `extension did not start pick ${reqId}`)
      clearTimeout(timer)
      picking = undefined
      resolve({ type: 'pick-unavailable' })
    }, PICK_START_TIMEOUT_MS)
    picking = {
      reqId,
      resolve: (msg) => {
        clearTimeout(timer)
        clearTimeout(startTimer)
        picking = undefined
        resolve({ ...msg, release: () => send(ext.ws, { type: 'pick-release', reqId }) } as BrowserPick)
      },
      abort: () => { send(ext.ws, { type: 'pick-abort', reqId }); picking?.resolve({ type: 'pick-cancel' }) },
    }
    send(ext.ws, { type: 'pick-start', reqId, cursor, urlHint })
  })
}

export function focusTab(origin: string | undefined) {
  const ext = [...extensions.values()][0]
  if (!ext || !origin) return false
  send(ext.ws, { type: 'focus-tab', origin })
  return true
}

export const count = () => extensions.size
export const abortPick = () => picking?.abort?.()
const readLastPickTab = () => lastPickTab
export { readLastPickTab as lastPickTab }

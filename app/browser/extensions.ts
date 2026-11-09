// 浏览器扩展这一侧：配对、认证后的连接表、向扩展要选区 / 进指认 / 切标签页。
// 不认识任何 agent；扩展发来的东西交给回调（onSelection），要切哪个标签页由调用方给 origin
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { HOME_DIR, ROOT_DIR, TEST_HIDDEN, logError } from '../core/env.ts'
import os from '../core/os/index.ts'
import type { ExtensionSelection } from '../pick/selection.ts'
import type { showNotice as ShowNotice } from '../ui/notices.ts'

const { BROWSERS, browserKind } = os

// 配对过的浏览器扩展：id -> token
const EXTENSIONS_FILE = path.join(HOME_DIR, 'extensions.json')
// 给用户"加载已解压的扩展程序"用的固定位置；插件升级换目录也不影响已装的扩展
export const USER_EXTENSION_DIR = path.join(HOME_DIR, 'extension')
const BUNDLED_EXTENSION_DIR = path.join(ROOT_DIR, 'extension')
const PAIR_ASK_TIMEOUT_MS = 60_000
const GRAB_TIMEOUT_MS = 900
const PICK_TIMEOUT_MS = 60_000
const PICK_START_TIMEOUT_MS = 4000

/**
 * 扩展发来的消息（JSON 解析出来的，字段按 type 有不同）。
 * 只列这里用到的字段，扩展那边的完整形状见 extension/
 */
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

/** 浏览器里指认的结果；picked 带 release()，撤掉留在网页上的高亮框 */
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
const deniedOrigins = new Set<string>() // 这次运行里用户点过"不允许"的扩展（按 origin），不再自动弹
let pairAsking = false // 正在问用户要不要让某个扩展连进来
const pendingGrabs = new Map<string | undefined, (msg: ExtensionMessage) => void>()
let picking: Picking | undefined // 浏览器里的指认进行中
let lastPickTab: { title?: string; url?: string } | undefined // 扩展回报的：上一次指认脚本注入到了哪个标签页

export interface ExtensionDeps {
  showNotice: typeof ShowNotice
  onSelection(grab: Grab): void
  onChange(): void
}
// init() 之前是空的
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

/** 自带的扩展抄一份到 ~/.pointy/extension，用户从这里加载；版本号变了才覆盖 */
export function syncUserExtension() {
  const bundled = manifestVersion(BUNDLED_EXTENSION_DIR)
  if (!bundled || path.resolve(BUNDLED_EXTENSION_DIR) === path.resolve(USER_EXTENSION_DIR)) return
  if (manifestVersion(USER_EXTENSION_DIR) === bundled) return
  try { fs.cpSync(BUNDLED_EXTENSION_DIR, USER_EXTENSION_DIR, { recursive: true, force: true }) } catch (err) { logError('extension-copy', err) }
}

/**
 * 配对：还没配过的扩展连上来要一个自己的 token，Pointy 弹窗问用户允不允许。
 * 只认浏览器扩展发起的连接（网页的 Origin 是 http(s)，伪造不了）。返回 true 表示这条连接归配对流程管了
 */
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
  // 扩展那边先断了（浏览器关了、扩展被停了）：弹窗也收掉
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

/** 扩展的 hello：认证通过就登记这条连接，返回扩展 id；不通过返回 undefined（调用方关连接） */
export function authenticate(ws: WebSocket, msg: ExtensionMessage, nonce: string) {
  // hello 一定带 id；没带的话下面查不到 token，照样不通过
  const id = msg.id as string
  const token = loadTokens()[id]
  if (!token || !safeEqual(msg.proof, hmac(token, `ext|${nonce}`))) return undefined
  send(ws, { type: 'hello-ok', proof: hmac(token, `pet|${msg.nonce}`) })
  extensions.get(id)?.ws.close()
  extensions.set(id, { ws, browser: String(msg.browser ?? '') })
  deps.onChange?.()
  // 扩展是从 extension/ 文件夹直接加载的：磁盘上的版本号变了就让它自己重载（只对会处理 reload 的版本有效）
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
  if (msg.type === 'grab-result') {
    pendingGrabs.get(msg.reqId)?.(msg)
    pendingGrabs.delete(msg.reqId)
  } else if (msg.type === 'pick-started') {
    lastPickTab = { title: msg.tabTitle, url: msg.tabUrl }
    if (picking?.reqId === msg.reqId) picking!.started = true
  } else if (msg.type === 'picked' || msg.type === 'pick-cancel' || msg.type === 'pick-unavailable') {
    if (picking?.reqId === msg.reqId) picking!.resolve(msg)
  } else if (msg.type === 'selection') {
    // 扩展右键菜单直接发来的选区
    deps.onSelection?.({ source: { app: msg.browser ?? 'browser', title: msg.pageTitle ?? '' }, method: 'extension', ...msg })
  }
}

/** 前台程序（exe）对应的那个浏览器里的扩展；没有就随便一个 */
function extensionFor(exe: string) {
  const want = browserKind(exe)
  return [...extensions.values()].find(e => e.browser === want) ?? [...extensions.values()][0]
}

/** 前台是浏览器时，向对应浏览器里配对过的扩展要选区 */
export function grabFor(exe: string) {
  if (!BROWSERS.has(exe) || extensions.size === 0) return undefined
  const ext = extensionFor(exe)
  return () => new Promise<ExtensionMessage>((resolve, reject) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => { pendingGrabs.delete(reqId); reject(new Error('timeout')) }, GRAB_TIMEOUT_MS)
    pendingGrabs.set(reqId, (msg) => { clearTimeout(timer); resolve(msg) })
    ext.ws.send(JSON.stringify({ type: 'grab', reqId }))
  })
}

/** 浏览器里：让扩展进入指认模式，等用户点一下（或 Esc）。结果带 release()，撤掉留在网页上的高亮框 */
export function pickInBrowser(exe: string, cursor: { x: number; y: number }, urlHint?: string): Promise<BrowserPick> {
  const ext = extensionFor(exe)
  if (!ext || ext.ws.readyState !== ext.ws.OPEN) return Promise.resolve({ type: 'pick-unavailable' })
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => {
      picking = undefined
      // 让扩展把页面上的高亮层撤掉
      send(ext.ws, { type: 'pick-abort', reqId })
      resolve({ type: 'pick-cancel' })
    }, PICK_TIMEOUT_MS)
    // 扩展几秒内没回"开始了"（service worker 卡住、连接半死），别干等一分钟，改走系统层面的指认
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
        // msg.type 是 picked / pick-cancel / pick-unavailable（onMessage 只把这三种交过来）
        resolve({ ...msg, release: () => send(ext.ws, { type: 'pick-release', reqId }) } as BrowserPick)
      },
      abort: () => { send(ext.ws, { type: 'pick-abort', reqId }); picking?.resolve({ type: 'pick-cancel' }) },
    }
    send(ext.ws, { type: 'pick-start', reqId, cursor, urlHint })
  })
}

/** 把开着这个 origin 的标签页切到前面；没有扩展连着返回 false */
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

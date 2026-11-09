const DEFAULT_PORT = 47321
interface Stored { port?: number, id?: string, token?: string }
const petUrl = async () => `ws://127.0.0.1:${(await chrome.storage.local.get<Stored>('port')).port ?? DEFAULT_PORT}`
const BROWSER = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome'
const KEEPALIVE_MS = 20_000

type PetMessage =
  | { type: 'challenge', nonce: string }
  | { type: 'hello-ok', proof: string }
  | { type: 'pick-abort', reqId: string }
  | { type: 'focus-tab', origin: unknown }
  | { type: 'reload' }
  | { type: 'pick-release', reqId: string }
  | { type: 'pick-start', reqId: string, cursor?: PointyCursor, urlHint?: string }
  | { type: 'paired', id: string, token: string }
  | { type: 'pair-denied' }
  | { type: 'pair-busy' }

interface PageSelection { blocked?: 'password-field', text?: string, before?: string, after?: string }
interface GrabResult extends PageSelection { url?: string, pageTitle?: string, browser?: string }
type PairResult = { ok: true } | { ok: false, error: string }
type RuntimeMessage = PickResultMessage | { type: 'pair' } | { type: 'status' } | { type: 'unpair' }

let ws: WebSocket | undefined
let authed = false
let keepalive: ReturnType<typeof setInterval> | undefined

const enc = new TextEncoder()
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

async function hmac(token: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

const randomHex = () => hex(crypto.getRandomValues(new Uint8Array(16)))

async function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return
  const { id, token } = await chrome.storage.local.get<Stored>(['id', 'token'])
  if (!id || !token) { if (Date.now() >= pairQuietUntil) await pair(false); return }
  const nonce = randomHex()
  const sock = new WebSocket(await petUrl())
  ws = sock
  authed = false
  sock.onmessage = async (ev) => {
    const msg: PetMessage = JSON.parse(ev.data)
    if (msg.type === 'challenge') {
      sock.send(JSON.stringify({ type: 'hello', role: 'extension', id, browser: BROWSER, version: chrome.runtime.getManifest().version, nonce, proof: await hmac(token, `ext|${msg.nonce}`) }))
    } else if (msg.type === 'hello-ok') {
      if (msg.proof !== await hmac(token, `pet|${nonce}`)) return sock.close()
      authed = true
      clearInterval(keepalive)
      // 有流量的 WebSocket 会让 MV3 service worker 一直活着
      keepalive = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), KEEPALIVE_MS)
    } else if (authed && msg.type === 'pick-abort') {
      if (pickTab) chrome.tabs.sendMessage<PickControlMessage>(pickTab.id!, { type: 'pick-abort' }).catch(() => {})
      pickReq = undefined
    } else if (authed && msg.type === 'focus-tab') {
      focusTab(msg.origin)
    } else if (authed && msg.type === 'reload') {
      chrome.runtime.reload()
    } else if (authed && msg.type === 'pick-release') {
      const tabId = heldTabs.get(msg.reqId)
      heldTabs.delete(msg.reqId)
      if (tabId !== undefined) chrome.tabs.sendMessage<PickControlMessage>(tabId, { type: 'pick-release', reqId: msg.reqId }).catch(() => {})
    } else if (authed && msg.type === 'pick-start') {
      const ok = await startPick(msg.cursor, msg.urlHint)
      if (!ok) sock.send(JSON.stringify({ type: 'pick-unavailable', reqId: msg.reqId }))
      else {
        pickReq = msg.reqId
        sock.send(JSON.stringify({ type: 'pick-started', reqId: msg.reqId, tabTitle: pickTab?.title, tabUrl: pickTab?.url }))
      }
    }
  }
  sock.onclose = () => {
    if (ws === sock) { ws = undefined; authed = false }
    clearInterval(keepalive)
  }
}

function extractSelection(): PageSelection {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  if (active && active.tagName === 'INPUT' && active.type === 'password') return { blocked: 'password-field' }
  const editable = active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|search|url|email|)$/.test(active.type)))
  if (editable && active.selectionStart !== active.selectionEnd) {
    const { value, selectionStart: s, selectionEnd: e } = active as { value: string, selectionStart: number, selectionEnd: number }
    return { text: value.slice(s, e).slice(0, 20000), before: value.slice(Math.max(0, s - 400), s).trim(), after: value.slice(e, e + 400).trim() }
  }
  const sel = window.getSelection()
  const text = sel ? sel.toString() : ''
  let before = ''
  let after = ''
  if (text && sel?.rangeCount) {
    let block = sel.getRangeAt(0).commonAncestorContainer as HTMLElement
    if (block.nodeType !== 1) block = block.parentElement as HTMLElement
    block = block.closest<HTMLElement>('p,li,td,blockquote,pre,article,section,div') || block
    const full = block.innerText || ''
    const needle = text.trim().slice(0, 60)
    const at = needle ? full.indexOf(needle) : -1
    if (at >= 0) {
      before = full.slice(Math.max(0, at - 400), at).trim()
      after = full.slice(at + text.trim().length, at + text.trim().length + 400).trim()
    }
    if (!before) before = ((block.previousElementSibling as HTMLElement | null)?.innerText || '').slice(-400).trim()
    if (!after) after = ((block.nextElementSibling as HTMLElement | null)?.innerText || '').slice(0, 400).trim()
  }
  return { text: text.slice(0, 20000), before, after }
}

async function grabActiveTab(tab?: chrome.tabs.Tab): Promise<GrabResult> {
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (!tab) return {}
  const base = { url: tab.url, pageTitle: tab.title, browser: BROWSER }
  // chrome:// 之类的页面不让注入脚本，只带网址和标题
  if (!/^(https?|file):/.test(tab.url ?? '')) return base
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, func: extractSelection })
    const blocked = frames.find(f => f.result?.blocked)
    if (blocked) return { ...base, blocked: blocked.result!.blocked }
    const hit = frames.find(f => f.result?.text) ?? frames.find(f => f.frameId === 0)
    return { ...base, ...(hit?.result ?? {}) }
  } catch {
    return base
  }
}

let pickReq: string | undefined
let pickTab: chrome.tabs.Tab | undefined
const heldTabs = new Map<string, number>()

async function startPick(cursor: PointyCursor | undefined, urlHint: string | undefined) {
  const [tab] = urlHint
    ? (await chrome.tabs.query({})).filter(t => t.url === urlHint || t.url?.startsWith(urlHint))
    : await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || !/^(https?|file):/.test(tab.url ?? '')) return false
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: (c: PointyCursor | null) => { window.__pointyStart = c }, args: [cursor ?? null] })
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['pick.js'] })
    pickTab = tab
    return true
  } catch {
    return false
  }
}

async function cropElement(tab: chrome.tabs.Tab, rect: PointyRect, viewport: PickedElement['viewport']) {
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const bitmap = await createImageBitmap(await (await fetch(shot)).blob())
  const scale = bitmap.width / viewport.width
  const pad = 8
  const sx = Math.max(0, Math.floor((rect.x - pad) * scale))
  const sy = Math.max(0, Math.floor((rect.y - pad) * scale))
  const sw = Math.min(bitmap.width - sx, Math.ceil((rect.width + pad * 2) * scale))
  const sh = Math.min(bitmap.height - sy, Math.ceil((rect.height + pad * 2) * scale))
  if (sw < 4 || sh < 4) return undefined
  const k = Math.min(1, 1600 / sw)
  const canvas = new OffscreenCanvas(Math.round(sw * k), Math.round(sh * k))
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/jpeg;base64,${btoa(bin)}`
}

async function onPickResult(msg: PickResultMessage, sender: chrome.runtime.MessageSender) {
  const reqId = pickReq
  pickReq = undefined
  if (!authed || reqId === undefined) return
  if (msg.cancelled || !msg.result) return ws!.send(JSON.stringify({ type: 'pick-cancel', reqId }))
  const tab = (sender.tab ?? pickTab)!
  const r = msg.result
  const visual = r.kind === 'image' || r.kind === 'video' || r.tag === 'canvas' || ((r.text ?? '').trim().length < 30 && r.images?.length > 0)
  const image = visual ? await cropElement(tab, r.rect, r.viewport).catch(() => undefined) : undefined
  heldTabs.set(reqId, tab.id!)
  chrome.tabs.sendMessage<PickControlMessage>(tab.id!, { type: 'pick-hold', reqId }).catch(() => {})
  ws!.send(JSON.stringify({ type: 'picked', reqId, url: tab.url, pageTitle: tab.title, browser: BROWSER, element: r, image }))
}

async function focusTab(origin: unknown) {
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) return
  const tabs = await chrome.tabs.query({})
  const tab = tabs.find((t) => t.url?.startsWith(origin + '/'))
  // 没开着就不新开：web 版首次打开要带 token 的地址，扩展拿不到
  if (!tab) return
  await chrome.tabs.update(tab.id!, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
}

const PAIR_QUIET_MS = 10 * 60_000
let pairQuietUntil = 0
let pairing: Promise<PairResult> | undefined

function pair(manual: boolean) {
  if (pairing) return pairing
  pairing = (async () => {
    const url = await petUrl()
    return new Promise<PairResult>((resolve) => {
      const sock = new WebSocket(url)
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (result: PairResult) => { if (settled) return; settled = true; clearTimeout(timer); pairing = undefined; resolve(result); try { sock.close() } catch {} }
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish({ ok: false, error: 'Pointy 没响应' }), 20_000) }
      arm()
      sock.onerror = () => finish({ ok: false, error: '连不上 Pointy：确认 DSH 开着、Pointy 插件已启用' })
      sock.onclose = () => finish({ ok: false, error: '连接断了' })
      sock.onmessage = async (ev) => {
        const msg: PetMessage = JSON.parse(ev.data)
        arm()
        if (msg.type === 'challenge') sock.send(JSON.stringify({ type: 'pair-request', browser: BROWSER, manual }))
        else if (msg.type === 'paired') {
          await chrome.storage.local.set({ id: msg.id, token: msg.token })
          finish({ ok: true })
          connect()
        } else if (msg.type === 'pair-denied' || msg.type === 'pair-busy') {
          pairQuietUntil = Date.now() + PAIR_QUIET_MS
          finish({ ok: false, error: msg.type === 'pair-busy' ? 'Pointy 正在问别的，稍后再试' : '在 Pointy 那边没有允许' })
        }
      }
    })
  })()
  return pairing
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ask-pet', title: '问 Pointy：“%s”', contexts: ['selection'] })
  chrome.contextMenus.create({ id: 'ask-pet-page', title: '问 Pointy 这个页面', contexts: ['page'] })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await connect()
  const result = await grabActiveTab(tab)
  if (!result.text && info.selectionText) result.text = info.selectionText
  if (authed) ws!.send(JSON.stringify({ type: 'selection', ...result }))
})

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, reply) => {
  if (msg.type === 'pick-result') { onPickResult(msg, sender); return }
  if (msg.type === 'pair') { pair(true).then(reply); return true }
  if (msg.type === 'status') {
    chrome.storage.local.get<Stored>(['id']).then(({ id }) => reply({ paired: !!id, connected: authed }))
    return true
  }
  if (msg.type === 'unpair') { chrome.storage.local.remove(['id', 'token']).then(() => { ws?.close(); reply({ ok: true }) }); return true }
})

chrome.alarms.create('reconnect', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(() => connect())
chrome.runtime.onStartup.addListener(() => connect())
connect()

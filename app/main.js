// pointy 主进程：透明置顶窗口 + 托盘 + 划词卡片 + 本地 WebSocket 服务（DSH 插件和浏览器扩展都连这里）
const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, Tray, nativeImage, screen, shell } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { isFullscreenActive, isTopmost, assertTopmost, yieldTopmost, shellPopupOpen, foregroundAddress, allowAnyForeground, setOwner, windowOrigin } = require('./fullscreen')
const { grabSelection, foreground, blockedReason, elevatedUnderCursor, BROWSERS, stopSelectionHelper } = require('./selection')
const { startShakeDetector } = require('./shake')
const { pickNative, restoreCursor } = require('./uipick')

const PORT = Number(process.env.POINTY_PORT) || 47321
// POINTY_HOME 只给测试用（卸载清理的测试不能碰真的 ~/.pointy）
const TOKEN_DIR = process.env.POINTY_HOME || path.join(os.homedir(), '.pointy')
const TOKEN_FILE = path.join(TOKEN_DIR, 'token')
const SETTINGS_FILE = path.join(TOKEN_DIR, 'settings.json')
// 旧版插件按它拉起Pointy；现在插件自带Pointy，这个文件启动时删掉
const LAUNCH_FILE = path.join(TOKEN_DIR, 'launch.json')
// 由 DSH 插件拉起（插件形态）：DSH 关了Pointy也跟着退
const MANAGED = process.env.POINTY_MANAGED === '1'
// 给用户"加载已解压的扩展程序"用的固定位置；插件升级换目录也不影响已装的扩展
const USER_EXTENSION_DIR = path.join(TOKEN_DIR, 'extension')
const BUNDLED_EXTENSION_DIR = path.join(__dirname, '..', 'extension')
// 配对过的浏览器扩展：id -> token
const EXTENSIONS_FILE = path.join(TOKEN_DIR, 'extensions.json')
const SPRITES = path.join(__dirname, '..', 'assets', 'sprites')
// 右下角的Pointy窗口不再显示：卡片左边的看板娘取代了它。窗口对象还留着（很多地方拿它的句柄），只是不加载、不显示
const SHOW_PET = false
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png')
// 人物原始尺寸（100%）。窗口 = 人物 + 头顶给气泡留的地方；人物在窗口底部正中，
// 宽度按"气泡贴着屏幕边往回挪"留足两倍气泡宽，再加阴影余量。透明处点击穿透，宽一点不碍事
const CHAR_W = 200
const CHAR_H = 240
const BUBBLE_MAX_W = 260
const BUBBLE_ROOM_H = 210
const BUBBLE_PAD = 24
const SCALE_MIN = 0.5
const SCALE_MAX = 1.2
const SIZE_PRESETS = [['小', 0.6], ['中', 0.8], ['大', 1]]
// 卡片本身 420 宽，四周各留 18px 给阴影
// 卡片窗口左边多留的看板娘位置，和 card.css 的 --card-left 对应（68 - 18）
const MASCOT_ROOM = 50
const CARD_W = 520 + MASCOT_ROOM
const CARD_MIN_W = 360 + MASCOT_ROOM
const CARD_MIN_H = 200
const CARD_H_ASK = 300
const CARD_H_ANSWER = 560
// 主进程出错只记到这里，不弹 Electron 的系统错误框（用户可能正在玩全屏游戏）
const ERROR_LOG = path.join(TOKEN_DIR, 'error.log')
const ERROR_LOG_MAX = 256 * 1024
function logError(kind, err) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true })
    if ((fs.statSync(ERROR_LOG, { throwIfNoEntry: false })?.size ?? 0) > ERROR_LOG_MAX) fs.rmSync(ERROR_LOG)
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} [${kind}] ${err?.stack ?? err}\n`)
  } catch {}
}
process.on('uncaughtException', (err) => logError('uncaught', err))
process.on('unhandledRejection', (err) => logError('unhandled-rejection', err))
// 卡片和Pointy窗口里的报错、渲染进程崩掉，也只记日志
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => { if (e.level === 'error') logError('renderer', `${e.message} (${e.sourceId}:${e.lineNumber})`) })
  wc.on('render-process-gone', (_e, details) => logError('render-process-gone', JSON.stringify(details)))
  wc.on('preload-error', (_e, preloadPath, err) => logError('preload', `${preloadPath}: ${err?.stack ?? err}`))
})
const FULLSCREEN_POLL_MS = 500
// 置顶维护单独跑快一点：系统弹出层一出来就得让开
const TOPMOST_POLL_MS = 150
const CLICK_POLL_MS = 40
const HOME_MARGIN_X = 16
const HOME_MARGIN_Y = 24
// 点击穿透：alpha 超过这个才算立绘本体，轮廓再外扩几个 DIP
const MASK_ALPHA = 24
const MASK_GROW = 3
// DSH 断开这么久没回来，就当 DSH 退出了
const QUIT_WITH_DSH_GRACE_MS = 10_000
const PAIR_ASK_TIMEOUT_MS = 60_000
const EXTENSION_GRAB_TIMEOUT_MS = 900
// 调试用：设了这个目录，每次状态变化都把窗口截一张图存进去
const CAPTURE_DIR = process.env.POINTY_CAPTURE
// 测试用：卡片照常渲染但从不显示（全屏游戏时也能测），并把 openCard 挂到 global 上给调试器调用
const TEST_HIDDEN = process.env.POINTY_TEST_HIDDEN === '1'

// Pointy由 DSH 插件拉起、随 DSH 退出，没有开机自启
const DEFAULT_SETTINGS = { dnd: false, onTop: true, shake: true, shakeLevel: 'medium', scale: 0.6, welcomed: false }
const PICK_TIMEOUT_MS = 60_000
const PICK_START_TIMEOUT_MS = 4000

/** 正在指认就不响应新的晃动；卡了太久（哪条路没收尾）就当它结束了，记一笔 */
function pickBusy() {
  if (!picking) return false
  if (Date.now() - (picking.at ?? 0) < PICK_TIMEOUT_MS + 10_000) return true
  logError('pick-stuck', `cleared a stale pick ${picking.reqId}`)
  picking = undefined
  return false
}
// 全屏时窗口整个藏起来，所以这里可以用比 floating 高的级别，不会压到全屏游戏上
const TOP_LEVEL = 'pop-up-menu'

let win
let card
let tray
let plugin // 已通过认证的插件连接
const extensions = new Map() // 扩展 id -> { ws, browser }
let everConnected = false
let quitTimer
let homePos // 跑到前面之前的位置（人物左上角）
let petPos // 人物左上角的屏幕坐标（DIP）
let sentLayout = ''
let fullscreen = false
let pendingApprovals = 0
let wantFront = false
let dshUi = { kind: 'desktop' } // 插件报来的：DSH 是桌面版，还是浏览器里的 web 版（origin 是它的地址）
let pairAsking = false // 正在问用户要不要让某个扩展连进来
const deniedExtensions = new Set() // 这次运行里用户点过"不允许"的扩展（按 origin），不再自动弹
let settings = loadSettings()

// 测试实例：Pointy窗口、托盘、快捷键都不出来，只留服务和隐藏的卡片
const suppressed = () => fullscreen || settings.dnd || TEST_HIDDEN

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch }
  fs.mkdirSync(TOKEN_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

/** extension/manifest.json 里的版本号；和正在跑的扩展报上来的不一样，说明磁盘上改过了 */
function extensionVersionOnDisk() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8')).version } catch { return undefined }
}

function loadExtensionTokens() {
  try { return JSON.parse(fs.readFileSync(EXTENSIONS_FILE, 'utf8')) } catch { return {} }
}

function saveExtensionToken(id, token) {
  const all = loadExtensionTokens()
  all[id] = token
  fs.mkdirSync(TOKEN_DIR, { recursive: true })
  fs.writeFileSync(EXTENSIONS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 })
}

/** 旧版留下的：开机自启项和 launch.json。现在只由 DSH 插件拉起，这两样清掉 */
function dropOldAutostart() {
  try {
    const item = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
    if (app.getLoginItemSettings(item).openAtLogin) app.setLoginItemSettings({ ...item, openAtLogin: false })
  } catch (err) { logError('login-item', err) }
  fs.rmSync(LAUNCH_FILE, { force: true })
}

/** 自带的扩展抄一份到 ~/.pointy/extension，用户从这里加载；版本号变了才覆盖 */
function syncUserExtension() {
  const version = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version } catch { return undefined } }
  const bundled = version(BUNDLED_EXTENSION_DIR)
  if (!bundled || path.resolve(BUNDLED_EXTENSION_DIR) === path.resolve(USER_EXTENSION_DIR)) return
  if (version(USER_EXTENSION_DIR) === bundled) return
  try { fs.cpSync(BUNDLED_EXTENSION_DIR, USER_EXTENSION_DIR, { recursive: true, force: true }) } catch (err) { logError('extension-copy', err) }
}

function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
  fs.mkdirSync(TOKEN_DIR, { recursive: true })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

const hmac = (token, data) => crypto.createHmac('sha256', token).update(data).digest('hex')
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
const toRenderer = (msg) => win?.webContents.send('dsh', msg)
// 所有活着的卡片（包括收起到后台继续跑的）；每张卡片自己按 askId / reqId 认领消息
const cards = new Set()
const toCard = (msg) => { for (const c of cards) c.webContents.send('dsh', msg) }

// 插件发来的消息：划词相关的给卡片，其余给Pointy
let pluginVersion // 插件连上时报的版本，托盘里显示，方便看出 DSH 加载的是不是新版

function routePluginMessage(msg) {
  if (msg.type === 'ready') { pluginVersion = msg.plugin; updateTray() }
  if (msg.type === 'ui') { dshUi = { kind: msg.kind === 'web' ? 'web' : 'desktop', origin: typeof msg.origin === 'string' ? msg.origin : undefined }; logError('dsh-ui', JSON.stringify(dshUi)) }
  if (msg.type === 'ask-done' || msg.type === 'ask-error' || msg.type === 'state' || msg.type === 'title') pillFromPlugin(msg)
  if (typeof msg.type === 'string' && (msg.type.startsWith('ask-') || msg.type === 'sessions' || msg.type === 'suggestions' || msg.type === 'title')) toCard(msg)
  else toRenderer(msg)
  if (!SHOW_PET) {
    if (msg.type === 'approval') {
      pendingApprovals++
      notify('DSH 有个操作等你批准', '点这里打开 DSH', () => openDsh(msg.sessionId))
      updateTray()
    } else if (msg.type === 'approval-closed') {
      pendingApprovals = Math.max(0, pendingApprovals - 1)
      updateTray()
    }
  }
}

/** 托盘气泡通知（Pointy不显示以后，收起的任务做完、DSH 要批准都靠它） */
let notifyClick
function notify(title, content, onClick) {
  if (!tray || suppressed()) return
  notifyClick = onClick
  try { tray.displayBalloon({ title, content, iconType: 'none', icon: nativeImage.createFromPath(TRAY_ICON), noSound: true }) } catch (err) { logError('balloon', err) }
}

function onPluginAuthed(ws) {
  if (plugin && plugin !== ws) plugin.close()
  plugin = ws
  everConnected = true
  clearTimeout(quitTimer)
  toRenderer({ type: 'link', connected: true })
  updateTray()
}

function onPluginClosed(ws) {
  if (plugin !== ws) return
  plugin = undefined
  pluginVersion = undefined
  toRenderer({ type: 'link', connected: false })
  updateTray()
  // 插件重载会马上重连；过了宽限期还没回来，就是 DSH 关了
  clearTimeout(quitTimer)
  if (everConnected && MANAGED) quitTimer = setTimeout(() => { if (!plugin) app.quit() }, QUIT_WITH_DSH_GRACE_MS)
}

const pendingGrabs = new Map()
let picking // { reqId, resolve } 指认进行中
let lastPickTab // 扩展回报的：上一次指认脚本注入到了哪个标签页

function onExtensionMessage(msg) {
  if (msg.type === 'grab-result') {
    pendingGrabs.get(msg.reqId)?.(msg)
    pendingGrabs.delete(msg.reqId)
  } else if (msg.type === 'pick-started') {
    lastPickTab = { title: msg.tabTitle, url: msg.tabUrl }
    if (picking?.reqId === msg.reqId) picking.started = true
  } else if (msg.type === 'picked' || msg.type === 'pick-cancel' || msg.type === 'pick-unavailable') {
    if (picking?.reqId === msg.reqId) picking.resolve(msg)
  } else if (msg.type === 'selection') {
    // 扩展右键菜单直接发来的选区
    openCard({ source: { app: msg.browser ?? 'browser', title: msg.pageTitle ?? '' }, method: 'extension', ...msg })
  }
}

function startServer(token) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 8 << 20 })
  wss.on('error', (err) => toRenderer({ type: 'server-error', error: String(err.message) }))
  wss.on('connection', (ws, req) => {
    const nonce = crypto.randomBytes(16).toString('hex')
    let role // 'plugin' | 'extension'
    let extId
    ws.send(JSON.stringify({ type: 'challenge', nonce }))
    const kick = setTimeout(() => { if (!role) ws.close() }, 10_000)
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (role === 'plugin') return routePluginMessage(msg)
      if (role === 'extension') return onExtensionMessage(msg)
      // 配对：还没配过的扩展连上来要一个自己的 token，Pointy 弹窗问用户允不允许。
      // 只认浏览器扩展发起的连接（网页的 Origin 是 http(s)，伪造不了）
      if (msg.type === 'pair-request') {
        const origin = String(req.headers.origin ?? '')
        const send = (m) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
        if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return ws.close()
        if (deniedExtensions.has(origin) && !msg.manual) { send({ type: 'pair-denied' }); return ws.close() }
        if (pairAsking || TEST_HIDDEN && !global.pointyTest?.allowPairAsk) { send({ type: 'pair-busy' }); return ws.close() }
        clearTimeout(kick)
        pairAsking = true
        // 等用户点的时候隔一会儿发一条，扩展的 service worker 收到消息才不会被浏览器停掉
        const keep = setInterval(() => send({ type: 'pair-wait' }), 10_000)
        const browser = msg.browser === 'edge' ? 'Edge' : 'Chrome'
        const asked = showNotice({
          title: `${browser} 里的 Pointy 扩展想连接`,
          body: ['允许后，在浏览器里晃一下鼠标就能指认网页上的具体内容，右键菜单也能「问 Pointy」。'],
          buttons: [{ id: 'deny', label: '不允许' }, { id: 'allow', label: '允许', primary: true }],
          timeoutMs: PAIR_ASK_TIMEOUT_MS,
        })
        // 扩展那边先断了（浏览器关了、扩展被停了）：弹窗也收掉
        const cancel = noticeDone
        ws.once('close', () => cancel?.(null))
        asked.then((choice) => {
          clearInterval(keep)
          pairAsking = false
          if (choice !== 'allow') {
            if (choice === 'deny') deniedExtensions.add(origin)
            send({ type: 'pair-denied' })
            return ws.close()
          }
          deniedExtensions.delete(origin)
          const id = crypto.randomUUID()
          const extToken = crypto.randomBytes(32).toString('hex')
          saveExtensionToken(id, extToken)
          send({ type: 'paired', id, token: extToken })
          ws.close()
        })
        return
      }
      if (msg.type !== 'hello' || typeof msg.nonce !== 'string') return ws.close()
      if (msg.role === 'extension') {
        const extToken = loadExtensionTokens()[msg.id]
        if (!extToken || !safeEqual(msg.proof, hmac(extToken, `ext|${nonce}`))) return ws.close()
        role = 'extension'
        extId = msg.id
        clearTimeout(kick)
        ws.send(JSON.stringify({ type: 'hello-ok', proof: hmac(extToken, `pet|${msg.nonce}`) }))
        extensions.get(extId)?.ws.close()
        extensions.set(extId, { ws, browser: String(msg.browser ?? '') })
        updateTray()
        // 扩展是从 extension/ 文件夹直接加载的：磁盘上的版本号变了就让它自己重载（只对会处理 reload 的版本有效）
        const onDisk = extensionVersionOnDisk()
        if (onDisk && msg.version && msg.version !== onDisk) ws.send(JSON.stringify({ type: 'reload' }))
        return
      }
      if (!safeEqual(msg.proof, hmac(token, `plugin|${nonce}`))) return ws.close()
      role = 'plugin'
      clearTimeout(kick)
      ws.send(JSON.stringify({ type: 'hello-ok', proof: hmac(token, `pet|${msg.nonce}`) }))
      onPluginAuthed(ws)
    })
    ws.on('close', () => {
      clearTimeout(kick)
      if (role === 'plugin') onPluginClosed(ws)
      if (role === 'extension' && extensions.get(extId)?.ws === ws) { extensions.delete(extId); updateTray() }
    })
  })
}

/** 前台是浏览器时，向对应浏览器里配对过的扩展要选区 */
function extensionGrabFor(exe) {
  if (!BROWSERS.has(exe) || extensions.size === 0) return undefined
  const want = exe === 'msedge.exe' ? 'edge' : 'chrome'
  const ext = [...extensions.values()].find(e => e.browser === want) ?? [...extensions.values()][0]
  return () => new Promise((resolve, reject) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => { pendingGrabs.delete(reqId); reject(new Error('timeout')) }, EXTENSION_GRAB_TIMEOUT_MS)
    pendingGrabs.set(reqId, (msg) => { clearTimeout(timer); resolve(msg) })
    ext.ws.send(JSON.stringify({ type: 'grab', reqId }))
  })
}

const petScale = () => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(settings.scale) || DEFAULT_SETTINGS.scale))

function petGeometry() {
  const s = petScale()
  const cw = Math.round(CHAR_W * s)
  const ch = Math.round(CHAR_H * s)
  return { cw, ch, w: 2 * (BUBBLE_MAX_W + BUBBLE_PAD), h: ch + BUBBLE_ROOM_H }
}

// 右下角，但离任务栏留一段；离屏幕右边留到最宽的气泡也能在头顶正中放下。返回人物左上角
function homePosition() {
  const { workArea } = screen.getPrimaryDisplay()
  const { cw, ch } = petGeometry()
  const marginX = Math.max(HOME_MARGIN_X, Math.ceil((BUBBLE_MAX_W - cw) / 2) + HOME_MARGIN_X)
  return [workArea.x + workArea.width - cw - marginX, workArea.y + workArea.height - ch - HOME_MARGIN_Y]
}

// 按人物位置摆窗口（人物在窗口底部正中）。
// 只用 setBounds 带上尺寸：Windows 缩放 150% 时反复 setPosition 会让窗口一点点变大
function placePet(x, y) {
  petPos = [Math.round(x), Math.round(y)]
  const g = petGeometry()
  win.setBounds({ x: petPos[0] - Math.round((g.w - g.cw) / 2), y: petPos[1] - (g.h - g.ch), width: g.w, height: g.h })
  sendLayout()
}

function sendLayout(force = false) {
  const layout = { type: 'layout', scale: petScale() }
  const key = JSON.stringify(layout)
  if (!force && key === sentLayout) return
  sentLayout = key
  toRenderer(layout)
}

// 换大小时人物脚底中点不动
let saveScaleTimer
function setScale(scale, { persist = 'now' } = {}) {
  const before = petGeometry()
  settings.scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) * 100) / 100
  const after = petGeometry()
  placePet(petPos[0] + (before.cw - after.cw) / 2, petPos[1] + (before.ch - after.ch))
  clearTimeout(saveScaleTimer)
  if (persist === 'now') saveSettings({ scale: settings.scale })
  else saveScaleTimer = setTimeout(() => saveSettings({ scale: settings.scale }), 600)
  updateTray()
}

function moveToFront() {
  if (!homePos) homePos = petPos
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { cw, ch } = petGeometry()
  placePet(workArea.x + (workArea.width - cw) / 2, workArea.y + workArea.height - ch - 60)
  win.moveTop()
}

// 全屏或勿扰时整个窗口藏起来；恢复时只 showInactive，从不抢焦点
function applyVisibility() {
  if (!win) return
  toRenderer({ type: 'suppressed', on: suppressed() })
  if (suppressed()) {
    if (win.isVisible()) win.hide()
    // 卡片先藏起来，退出全屏再拿出来；指认留着的高亮框直接撤掉，免得盖在游戏上
    if (card?.isVisible()) { card.hide(); card.hiddenBySuppress = true }
    card?.releasePick?.()
    if (card) card.releasePick = undefined
    if (pillWin?.isVisible()) pillWin.hide()
  } else if (SHOW_PET && !win.isVisible()) {
    win.showInactive()
    applyOnTop()
    if (wantFront) moveToFront()
    // 全屏期间到点的待办，回来再说
  }
  if (!suppressed() && card && !card.isDestroyed() && card.hiddenBySuppress) {
    card.hiddenBySuppress = false
    card.showInactive()
  }
  if (!suppressed() && pillWin && !pillWin.isDestroyed() && !pillWin.isVisible()) pillWin.showInactive()
  updateTray()
}

function applyOnTop() {
  win.setAlwaysOnTop(settings.onTop, TOP_LEVEL)
  if (settings.onTop) win.moveTop()
}

const winHandle = () => win.getNativeWindowHandle().readBigUInt64LE(0)
let lastForeground = 0n

let yielded = false // 正让位给系统弹出层

// 每次轮询：TOPMOST 掉了，或者前台换了窗口，就重新压到最上层（SWP_NOACTIVATE，不抢焦点）。
// 托盘溢出面板、右键菜单、开始菜单这些系统弹出层开着时反过来，退到它们下面，关掉后再回来
function keepOnTop() {
  if (!win || !settings.onTop || suppressed() || !win.isVisible()) return
  const hwnd = winHandle()
  if (shellPopupOpen()) {
    if (!yielded) yieldTopmost(hwnd)
    yielded = true
    return
  }
  const fg = foregroundAddress()
  if (yielded || !isTopmost(hwnd) || fg !== lastForeground) assertTopmost(hwnd)
  yielded = false
  lastForeground = fg
}

// ---------- 点击穿透 ----------
// 窗口里透明的地方不接鼠标，点下去直接落到后面的窗口；只有立绘不透明的地方、气泡、角标接。
// 光标由主进程轮询（拖文件进来时渲染进程收不到鼠标事件），各元素的位置由渲染进程报上来
let petLayout // { character, bubble, badge }：窗口内坐标（DIP），不显示的是 null
let petDragging = false
let clickable = true
let petMask // { w, h, bits }：立绘框里每个 DIP 算不算"人"

const inRect = (r, x, y) => !!r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height

/** 所有帧的轮廓取并集（按 object-fit: contain 缩放到立绘框），再外扩几像素，边缘好点中 */
function buildPetMask(w, h) {
  const raw = new Uint8Array(w * h)
  const frames = fs.existsSync(SPRITES) ? fs.readdirSync(SPRITES).filter(f => f.endsWith('.png')) : []
  for (const f of frames) {
    const img = nativeImage.createFromPath(path.join(SPRITES, f))
    const { width: nw, height: nh } = img.getSize()
    const bmp = img.toBitmap()
    const s = Math.min(w / nw, h / nh)
    const ox = (w - nw * s) / 2
    const oy = (h - nh * s) / 2
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.floor((x + 0.5 - ox) / s)
        const sy = Math.floor((y + 0.5 - oy) / s)
        if (sx >= 0 && sy >= 0 && sx < nw && sy < nh && bmp[(sy * nw + sx) * 4 + 3] > MASK_ALPHA) raw[y * w + x] = 1
      }
    }
  }
  const bits = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue
      for (let dy = -MASK_GROW; dy <= MASK_GROW; dy++) {
        for (let dx = -MASK_GROW; dx <= MASK_GROW; dx++) {
          const X = x + dx
          const Y = y + dy
          if (X >= 0 && Y >= 0 && X < w && Y < h) bits[Y * w + X] = 1
        }
      }
    }
  }
  return { w, h, bits }
}

function cursorOnPet() {
  if (!petLayout) return true // 布局还没报上来，先整块接鼠标
  const c = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const x = c.x - b.x
  const y = c.y - b.y
  if (inRect(petLayout.bubble, x, y) || inRect(petLayout.badge, x, y)) return true
  const r = petLayout.character
  if (!inRect(r, x, y)) return false
  const w = Math.round(r.width)
  const h = Math.round(r.height)
  if (petMask?.w !== w || petMask?.h !== h) petMask = buildPetMask(w, h)
  const px = Math.min(w - 1, Math.floor(x - r.x))
  const py = Math.min(h - 1, Math.floor(y - r.y))
  return petMask.bits[py * w + px] === 1
}

function updateClickThrough() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const want = petDragging || cursorOnPet()
  if (want === clickable) return
  clickable = want
  win.setIgnoreMouseEvents(!want)
}

ipcMain.on('pet-layout', (_e, layout) => {
  if (layout && typeof layout === 'object' && layout.character) petLayout = layout
})
ipcMain.on('pet-scale-by', (_e, delta) => {
  if (win && Number.isFinite(delta)) setScale(petScale() + delta, { persist: 'later' })
})
ipcMain.on('pet-dragging', (_e, on) => {
  petDragging = !!on
  updateClickThrough()
})

function createWindow() {
  const [x, y] = homePosition()
  const g = petGeometry()
  win = new BrowserWindow({
    x, y, width: g.w, height: g.h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  win.setAlwaysOnTop(settings.onTop, TOP_LEVEL)
  placePet(x, y)
  win.webContents.setVisualZoomLevelLimits(1, 1)
  if (!SHOW_PET) return
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    sendLayout(true)
    toRenderer({ type: 'link', connected: !!plugin })
    applyVisibility()
  })
}

// 卡片宽度：用户在右下角拖过就沿用拖出来的宽度（只记在内存里，Pointy重启回到默认）
let cardWidth = CARD_W

/** 卡片出现在光标附近（尽量在右下，放不下就往回挪） */
function cardBounds(height, width = cardWidth) {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const x = Math.min(Math.max(cursor.x + 12, workArea.x), workArea.x + workArea.width - width)
  const y = Math.min(Math.max(cursor.y + 16, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

// 测试钩子可以打开：卡片放到屏幕外面渲染，不显示、不抢焦点（用户在玩全屏游戏时也能测）
let offscreenCards = false

/** @param releasePick 指认留着的高亮框，卡片关掉或收起时撤掉 */
function openCard(init, releasePick) {
  if (suppressed() && !TEST_HIDDEN && !offscreenCards) return releasePick?.()
  // 眼前这张卡片让位：问过问题的缩成胶囊，没问过的关掉；收起的卡片不动
  setAsideCard()
  // 卡片跟着叫出它的那个程序：在它上面，切到别的程序就被盖住（配对卡片和找不到来源时照旧置顶）
  const fg = init.mode === 'pair' ? 0n : foregroundAddress()
  const mine = [win, ...cards].filter(w => w && !w.isDestroyed()).map(w => w.getNativeWindowHandle().readBigUInt64LE(0))
  const owner = fg && !mine.includes(fg) ? fg : 0n
  card = new BrowserWindow({
    ...cardBounds(init.mode === 'pair' ? 230 : CARD_H_ASK),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: !owner,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'card', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  const self = card
  // 宽度只由这里和右下角拖拽决定；150% 缩放下用 getBounds 的宽度回写会一点点变宽
  self.cardW = cardWidth
  self.releasePick = releasePick
  cards.add(self)
  self.on('closed', () => {
    self.releasePick?.()
    cards.delete(self)
  })
  if (owner) {
    try { setOwner(self.getNativeWindowHandle().readBigUInt64LE(0), owner); followOwner(self, owner) } catch (err) { logError('card-owner', err); self.setAlwaysOnTop(true, 'floating') }
  } else {
    card.setAlwaysOnTop(true, 'floating')
  }
  card.loadFile(path.join(__dirname, 'card', 'card.html'))
  card.webContents.once('did-finish-load', () => {
    card.webContents.send('card-init', init.mode === 'pair' ? init : { grab: init })
    // 快捷键是用户主动按的，这里给卡片焦点好直接打字；全屏/勿扰时根本不会走到这里
    // 测试：放到所有屏幕外面再显示，窗口照常重绘（截图才是新的），人看不到
    if (TEST_HIDDEN || offscreenCards) { card.setPosition(-20000, -20000); card.showInactive(); return }
    card.show()
    card.focus()
  })
  card.on('closed', () => { if (card === self) card = undefined })
}

// ---------- 收起的任务：右下角托盘上方一叠胶囊 ----------
let pills = [] // { id: 'card<窗口 id>', sessionId, win, title, state: 'run' | 'done' | 'error' }
let pillWin
const PILL_W = 300

function updatePills() {
  if (!pills.length) {
    if (pillWin && !pillWin.isDestroyed()) pillWin.destroy()
    pillWin = undefined
    return
  }
  if (!pillWin || pillWin.isDestroyed()) {
    pillWin = new BrowserWindow({
      width: PILL_W, height: 60, show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
      // 不节流：被别的窗口盖住时动画和量高度照常走
      webPreferences: { preload: path.join(__dirname, 'pill', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
    })
    pillWin.setAlwaysOnTop(true, 'floating')
    pillWin.loadFile(path.join(__dirname, 'pill', 'pill.html'))
    pillWin.webContents.once('did-finish-load', () => sendPills())
    return
  }
  sendPills()
}
const sendPills = () => pillWin?.webContents.send('pills', pills.map(p => ({ id: p.id, title: p.title, state: p.state })))

/** 按内容高度贴在主屏右下角，托盘上方 */
function placePills(height) {
  if (!pillWin || pillWin.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  const h = Math.max(1, Math.min(Math.ceil(height), workArea.height))
  // 测试：放到屏幕外面，照常渲染、人看不到
  const off = TEST_HIDDEN || offscreenCards
  pillWin.setBounds({ x: off ? -20000 : workArea.x + workArea.width - PILL_W, y: off ? -20000 : workArea.y + workArea.height - h, width: PILL_W, height: h })
  if (!pillWin.isVisible() && (off || !suppressed())) pillWin.showInactive()
}

/** 来源程序的窗口挪了，卡片跟着挪同样的距离（拖动卡片自己的位置不受影响，下次按新位置算） */
// 每帧看一次，拖窗口时才跟得顺；位置自己记小数，不从 getBounds 读回来（150% 缩放下取整会抖）
const FOLLOW_POLL_MS = 16
function followOwner(c, owner) {
  let last = windowOrigin(owner)
  if (!last) return
  let pos // 卡片左上角（DIP，小数）
  let placed // 上次我们放到的位置；用户自己拖了卡片就以那边为准
  const timer = setInterval(() => {
    if (c.isDestroyed()) return clearInterval(timer)
    const now = windowOrigin(owner)
    if (!now) return clearInterval(timer)
    if (now.x === last.x && now.y === last.y) return
    const a = screen.screenToDipPoint(last)
    const b = screen.screenToDipPoint(now)
    last = now
    const dx = b.x - a.x
    const dy = b.y - a.y
    c.releasePick?.shift?.(dx, dy)
    if (!c.isVisible()) return
    const r = c.getBounds()
    if (!pos || !placed || Math.abs(r.x - placed.x) > 2 || Math.abs(r.y - placed.y) > 2) pos = { x: r.x, y: r.y }
    pos = { x: pos.x + dx, y: pos.y + dy }
    placed = { x: Math.round(pos.x), y: Math.round(pos.y) }
    c.setBounds({ ...placed, width: c.cardW ?? r.width, height: r.height })
  }, FOLLOW_POLL_MS)
  c.once('closed', () => clearInterval(timer))
}

ipcMain.on('card-asked', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  c?.releasePick?.()
  if (c) c.releasePick = undefined
})

// 收起：卡片藏起来（窗口留着，DSH 接着往里写），右下角托盘上方多一条胶囊；点胶囊在原位置放回卡片
ipcMain.on('card-keep', (e, info) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c) return
  const sessionId = typeof info?.sessionId === 'string' ? info.sessionId : undefined
  if (!sessionId) return c.close()
  c.kept = true
  c.keptBounds = c.getBounds()
  // 往右下角托盘那边滑过去（卡片里同时缩小淡出），到了再藏
  const off = TEST_HIDDEN || offscreenCards
  if (off || !c.isVisible()) c.hide()
  else glide(c, c.keptBounds, trayCorner(c.keptBounds), 220, () => { if (c.kept && !c.isDestroyed()) c.hide() })
  c.releasePick?.()
  c.releasePick = undefined
  if (card === c) card = undefined
  // 一张卡片一条胶囊（两张卡片可能问的是同一个会话）
  const id = `card${c.id}`
  pills = pills.filter(p => p.id !== id)
  pills.push({ id, sessionId, win: c, fixedTitle: !!info.fixedTitle, title: String(info.title || '新任务'), state: info.state === 'done' || info.state === 'error' ? info.state : 'run' })
  c.once('closed', () => { pills = pills.filter(p => p.win !== c); updatePills() })
  updatePills()
})

/** 眼前这张卡片要让位（新指认、放回别的卡片）：问过问题的缩成胶囊，没问过的直接关 */
function setAsideCard() {
  if (!card || card.isDestroyed()) return
  const old = card
  card = undefined
  old.webContents.send('card-set-aside')
  // 还没加载完、收不到消息的卡片（刚弹出就又指认）直接关
  setTimeout(() => { if (!old.isDestroyed() && !old.kept && old !== card) old.destroy() }, 1500)
}

// 插件报的会话状态：胶囊跟着变（DSH 起好标题就换掉问题原话；state 消息只换标题）
function pillFromPlugin(msg) {
  const mine = pills.filter(x => x.sessionId === msg.sessionId)
  if (!mine.length) return
  // DSH 起正式标题前的临时标题就是我们发的消息开头（"<抓取内容>…"），不要
  const draft = /^(<抓取内容>|回答要求：)/.test(String(msg.title ?? '').trim())
  let changed = false
  for (const p of mine) {
    if (msg.title && !draft && !p.fixedTitle && msg.title !== p.title) { p.title = msg.title; changed = true }
    if (p.state !== 'run') continue
    if (msg.type === 'ask-done') { p.state = msg.reason === 'completed' ? 'done' : 'error'; changed = true }
    else if (msg.type === 'ask-error') { p.state = 'error'; changed = true }
  }
  if (changed) updatePills()
}

// 点胶囊：卡片回到收起前的位置（那块屏幕不在了才放到光标旁边），从胶囊那边放大出来
ipcMain.on('pill-open', (_e, id) => {
  const p = pills.find(x => x.id === id)
  logError('pill-open-diag', `click ${id} found=${!!p} win=${p?.win ? (p.win.isDestroyed() ? 'destroyed' : 'alive') : 'none'}`)
  pills = pills.filter(x => x.id !== id)
  updatePills()
  const c = p?.win
  if (!c || c.isDestroyed()) return
  if (card !== c) setAsideCard()
  c.kept = false
  card = c
  const k = c.keptBounds
  const onScreen = k && screen.getAllDisplays().some(({ workArea: w }) => k.x < w.x + w.width && k.x + k.width > w.x && k.y < w.y + w.height && k.y + k.height > w.y)
  const off = TEST_HIDDEN || offscreenCards
  const to = off ? { ...c.getBounds(), x: -20000, y: -20000 } : onScreen ? { ...k, height: c.getBounds().height } : cardBounds(c.getBounds().height, c.cardW)
  c.webContents.send('card-restore')
  if (off) { c.setBounds(to); return c.showInactive() }
  // 从右下角托盘那边滑回原位（卡片里同时放大）
  const from = trayCorner(to)
  c.setBounds(from)
  c.show()
  c.focus()
  glide(c, from, to, 240)
  // 排查：放回后卡片到底看不看得见（出过点胶囊后直接跳 DSH 的问题）
  setTimeout(() => {
    if (c.isDestroyed()) return logError('pill-open-diag', 'card destroyed')
    c.webContents.executeJavaScript(`JSON.stringify({ op: getComputedStyle(document.getElementById('card')).opacity, cls: document.getElementById('card').className, anim: document.getElementById('card').style.animation })`)
      .then(r => logError('pill-open-diag', `visible=${c.isVisible()} bounds=${JSON.stringify(c.getBounds())} ${r}`), err => logError('pill-open-diag', err))
  }, 600)
})

/** 卡片窗口右下角贴到主屏右下角（胶囊那里）时的位置，大小不变 */
function trayCorner(b) {
  const { workArea: w } = screen.getPrimaryDisplay()
  return { ...b, x: w.x + w.width - b.width, y: w.y + w.height - b.height }
}

/** 窗口从 from 滑到 to（只动位置），先快后慢 */
function glide(c, from, to, ms, done) {
  clearInterval(c.glideTimer)
  const t0 = Date.now()
  c.glideTimer = setInterval(() => {
    if (c.isDestroyed()) return clearInterval(c.glideTimer)
    const t = Math.min(1, (Date.now() - t0) / ms)
    const e = 1 - (1 - t) ** 3
    c.setBounds({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), width: to.width, height: to.height })
    if (t < 1) return
    clearInterval(c.glideTimer)
    done?.()
  }, 16)
}
// ×：不看了，卡片也一起关掉（DSH 那边不受影响）
ipcMain.on('pill-dismiss', (_e, id) => {
  const p = pills.find(x => x.id === id)
  pills = pills.filter(x => x.id !== id)
  updatePills()
  if (p?.win && !p.win.isDestroyed()) p.win.destroy()
})
ipcMain.on('pill-resize', (_e, height) => placePills(Number(height) || 0))

let lastGrab // 测试钩子用：上一次快捷键取到的东西（含 method）

/** 浏览器里：让扩展进入指认模式，等用户点一下（或 Esc） */
function pickInBrowser(exe, cursor, urlHint) {
  const want = exe === 'msedge.exe' ? 'edge' : 'chrome'
  const ext = [...extensions.values()].find(e => e.browser === want) ?? [...extensions.values()][0]
  if (!ext || ext.ws.readyState !== ext.ws.OPEN) return Promise.resolve({ type: 'pick-unavailable' })
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID()
    const timer = setTimeout(() => {
      picking = undefined
      // 让扩展把页面上的高亮层撤掉
      if (ext.ws.readyState === ext.ws.OPEN) ext.ws.send(JSON.stringify({ type: 'pick-abort', reqId }))
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
      at: Date.now(),
      // 选中后网页上的高亮框留着，卡片关掉时用 release 让扩展撤掉
      resolve: (msg) => {
        clearTimeout(timer)
        clearTimeout(startTimer)
        picking = undefined
        resolve({ ...msg, release: () => { if (ext.ws.readyState === ext.ws.OPEN) ext.ws.send(JSON.stringify({ type: 'pick-release', reqId })) } })
      },
      abort: () => { ext.ws.send(JSON.stringify({ type: 'pick-abort', reqId })); picking?.resolve({ type: 'pick-cancel' }) },
    }
    ext.ws.send(JSON.stringify({ type: 'pick-start', reqId, cursor, urlHint }))
  })
}

/** 浏览器里指认一块内容并打开卡片；返回扩展的结果类型 */
async function pickAndOpen(fg, cursor, urlHint) {
  const r = await pickInBrowser(fg.exe, cursor, urlHint)
  if (r.type === 'picked') {
    // 指到图片、视频、画布时扩展会附一张那块的截图（只在内存里）
    openCard({ source: { app: fg.exe, title: fg.title }, method: 'pick', url: r.url, pageTitle: r.pageTitle, element: r.element, text: r.element?.text, image: r.image }, r.release)
  }
  return r.type
}

// 晃动被识别出来却没响应时记一笔原因（30 秒最多一条），"晃了没反应"时查 error.log 就知道是哪条拦的
let lastIgnoreLog = 0
function shakeIgnored() {
  const reason = !settings.shake ? '' : fullscreen ? 'fullscreen' : settings.dnd ? 'dnd' : pickBusy() ? 'picking' : card?.isFocused() ? 'card-focused' : TEST_HIDDEN ? 'test-hidden' : undefined
  if (reason && Date.now() - lastIgnoreLog > 30_000) { lastIgnoreLog = Date.now(); logError('shake-ignored', reason) }
  return reason !== undefined
}

/** 晃一下鼠标：浏览器里走扩展的指认，其他地方先退回取选区（系统层面的指认在后面一步） */
/** 屏幕正下方一句提示，样子同指认时的操作提示，几秒后自己消失（桌宠不显示了，气泡看不到） */
let hintWin
let hintTimer
function showHint(text) {
  if (TEST_HIDDEN) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 520
  const height = 64
  if (!hintWin || hintWin.isDestroyed()) {
    hintWin = new BrowserWindow({
      width, height, show: false, frame: false, transparent: true, resizable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#00000000',
    })
    hintWin.setIgnoreMouseEvents(true)
    hintWin.setAlwaysOnTop(true, 'screen-saver')
  }
  hintWin.setBounds({ x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + workArea.height - height - 40, width, height })
  const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden">
    <div style="padding:10px 22px;border-radius:999px;background:rgba(32,33,36,.92);color:#fff;font:16px 'Segoe UI','Microsoft YaHei UI',sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.18)">${esc(text)}</div></body>`
  hintWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => hintWin?.showInactive()).catch(() => {})
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { if (hintWin && !hintWin.isDestroyed()) hintWin.hide() }, 2600)
}

async function onShake(x, y) {
  if (suppressed() || pickBusy()) return
  const fg = foreground()
  const blocked = blockedReason(fg)
  if (blocked) return toRenderer({ type: 'notice', text: `这里我不碰：${blocked}`, kind: 'error' })
  // 管理员程序：读不到控件、点击也拦不住，进了指认会卡住，直接提示
  if (elevatedUnderCursor()) return showHint('这个程序以管理员身份运行，Pointy 读不到')
  toRenderer({ type: 'notice', text: '指给我看~' })
  if (BROWSERS.has(fg.exe) && extensions.size) {
    const r = await pickAndOpen(fg, { x, y })
    if (r !== 'pick-unavailable') return
  }
  // 晃动可能是误触，这条路绝不模拟按键。已经选中文字就用选区，没有就进系统层面的指认
  const grab = await grabSelection(undefined, { allowCopy: false })
  if (grab.blocked) return toRenderer({ type: 'notice', text: `这里我不碰：${grab.blocked}`, kind: 'error' })
  if (grab.text?.trim()) return openCard(grab)
  return pickNativeAndOpen(fg)
}

/** 系统层面的指认：指一块、确认后开卡片（读不到字的附截图） */
async function pickNativeAndOpen(fg) {
  picking = { reqId: 'native', at: Date.now(), resolve: () => {} }
  let r
  try { r = await pickNative() } finally { picking = undefined }
  if (!r) return
  if (r.blocked) { r.release?.(); return toRenderer({ type: 'notice', text: `这里我不碰：${r.blocked}`, kind: 'error' }) }
  // 读不到内容的（QQ 这类关了无障碍的 Electron 程序只露出一个空壳窗口）就附截图
  if (settings.debugPick) logError('pick-diag', JSON.stringify({ exe: fg.exe, ...r.diag }))
  const shell = !!r.opaque
  const element = shell ? { ...r.element, text: '', fields: { 控件: '程序界面' } } : r.element
  // 读不到字、或者框太大只截了鼠标附近一块，都带上截图
  const thin = shell || r.focused || (r.element.text ?? '').trim().length < 30
  openCard({ source: { app: fg.exe, title: fg.title }, method: 'uia-pick', element: { ...element, site: fg.exe }, text: element.text, image: thin ? r.image : undefined, wideImage: r.wide, shotKind: r.focused ? 'focus' : 'element' }, r.release)
}

// ---------- 提示窗：首次引导、扩展配对、装扩展的步骤 ----------
let noticeWin
let noticeDone // 当前提示窗的回调：点了按钮 / 关掉 / 超时 / 被新的顶掉都走这里
const NOTICE_W = 380

/** 右下角弹一个小窗，返回用户点的按钮 id；关掉或超时是 null */
function showNotice({ title, body, buttons, timeoutMs }) {
  noticeDone?.(null)
  return new Promise((resolve) => {
    const { workArea } = screen.getPrimaryDisplay()
    const w = new BrowserWindow({
      width: NOTICE_W, height: 200, x: workArea.x + workArea.width - NOTICE_W - 12, y: workArea.y + workArea.height - 212,
      show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'notice', 'preload.js'), contextIsolation: true },
    })
    w.setAlwaysOnTop(true, 'floating')
    noticeWin = w
    let timer
    const done = (choice) => {
      if (noticeDone !== done) return
      noticeDone = undefined
      clearTimeout(timer)
      if (!w.isDestroyed()) w.close()
      if (noticeWin === w) noticeWin = undefined
      resolve(choice)
    }
    noticeDone = done
    if (timeoutMs) timer = setTimeout(() => done(null), timeoutMs)
    w.on('closed', () => done(null))
    w.loadFile(path.join(__dirname, 'notice', 'notice.html'))
    w.webContents.once('did-finish-load', () => w.webContents.send('notice-init', { title, body, buttons }))
  })
}
ipcMain.on('notice-choose', (e, id) => { if (noticeWin && e.sender === noticeWin.webContents) noticeDone?.(typeof id === 'string' ? id : null) })
ipcMain.on('notice-resize', (e, height) => {
  const w = noticeWin
  if (!w || e.sender !== w.webContents || !Number.isFinite(height)) return
  const h = Math.min(Math.max(Math.round(height), 80), 600)
  const { workArea } = screen.getPrimaryDisplay()
  w.setBounds({ x: workArea.x + workArea.width - NOTICE_W - 12, y: workArea.y + workArea.height - h - 12, width: NOTICE_W, height: h })
  if (TEST_HIDDEN) { w.setPosition(-20000, -20000); w.showInactive() } else if (!w.isVisible()) w.showInactive()
})

/** 浏览器扩展还不在商店里：打开 ~/.pointy/extension，告诉用户怎么"加载已解压的扩展程序" */
async function showExtensionGuide() {
  syncUserExtension()
  if (!TEST_HIDDEN) shell.openPath(USER_EXTENSION_DIR)
  const choice = await showNotice({
    title: '安装浏览器扩展（推荐）',
    body: [
      '装了扩展，在网页里能指认到具体的段落、图片，还能右键「问 Pointy」。没装也能用，只是网页按整窗截图处理。',
      '1. 在 Chrome 或 Edge 地址栏打开 **chrome://extensions**（Edge 是 edge://extensions），打开右上角的「开发者模式」。',
      '2. 点「加载已解压的扩展程序」，选刚才打开的文件夹：**' + USER_EXTENSION_DIR + '**',
      '3. 装好后 Pointy 会弹窗问要不要让它连接，点「允许」就行。',
    ],
    buttons: [{ id: 'copy', label: '复制 chrome://extensions' }, { id: 'ok', label: '知道了', primary: true }],
  })
  if (choice === 'copy') clipboard.writeText('chrome://extensions')
}

/** 第一次运行：告诉用户怎么用，顺便推荐装扩展 */
async function showWelcome() {
  saveSettings({ welcomed: true })
  const choice = await showNotice({
    title: 'Pointy 已就位',
    body: [
      '**晃一下鼠标**进入指认，指到网页、文档、聊天窗口里的任意内容，点一下就能问 DSH。',
      '托盘里的鲸鱼图标可以调晃动灵敏度、开勿扰。',
      '在浏览器里用的话，推荐装上 Pointy 的浏览器扩展，能指认到网页里具体的段落。',
    ],
    buttons: [{ id: 'later', label: '以后再说' }, { id: 'ext', label: '安装浏览器扩展', primary: true }],
  })
  if (choice === 'ext') showExtensionGuide()
}

const trayIcon = (frame) => SHOW_PET
  ? nativeImage.createFromPath(path.join(SPRITES, `${frame}.png`)).resize({ width: 32, height: 32 })
  : nativeImage.createFromPath(TRAY_ICON)

function updateTray() {
  if (!tray) return
  const hiddenWaiting = pendingApprovals > 0 && suppressed()
  tray.setImage(trayIcon(hiddenWaiting ? 'waiting' : 'idle'))
  // 悬停就能看出现在是什么模式
  const modes = [
    settings.dnd ? '勿扰中' : fullscreen ? '全屏中已隐藏' : (settings.onTop ? '置顶' : '不置顶'),
    plugin ? `已连DSH${pluginVersion ? `(插件${pluginVersion})` : ''}` : 'DSH未连接',
  ].filter(Boolean).join('·')
  const waiting = [
    pendingApprovals > 0 ? `${pendingApprovals} 个操作等你批准` : '',
  ].filter(Boolean).join('，')
  tray.setToolTip(waiting ? `Pointy：${waiting}\n${modes}` : `Pointy：${modes}`)
  if (!SHOW_PET) {
    const status = [
      pendingApprovals > 0 ? `${pendingApprovals} 个操作等你批准` : '',
      settings.dnd ? '勿扰中' : '',
      plugin ? '' : 'DSH 未连接',
    ].filter(Boolean).join('\n')
    tray.setToolTip(status ? `Pointy\n${status}` : 'Pointy')
  }
  // 设置只留常用的几项；置顶、开机自启等不在菜单里（settings.json 和系统启动项照样生效）
  tray.setContextMenu(Menu.buildFromTemplate(SHOW_PET ? petMenu() : [
    {
      label: '晃一下鼠标指认',
      submenu: [
        { label: '关', type: 'radio', checked: !settings.shake, click: () => { saveSettings({ shake: false }); updateTray() } },
        ...[['low', '低：要晃得明显'], ['medium', '中'], ['high', '高：轻晃就行']].map(([value, label]) => ({
          label, type: 'radio', checked: settings.shake && settings.shakeLevel === value, click: () => { saveSettings({ shake: true, shakeLevel: value }); updateTray() },
        })),
      ],
    },
    extensions.size
      ? { label: `浏览器扩展已连接（${extensions.size}）`, enabled: false }
      : { label: '安装浏览器扩展（推荐）…', click: () => showExtensionGuide() },
    { type: 'separator' },
    { label: '勿扰模式', type: 'checkbox', checked: settings.dnd, click: (item) => { saveSettings({ dnd: item.checked }); applyVisibility() } },
    { type: 'separator' },
    { label: '退出 Pointy', click: () => app.quit() },
  ]))
}

/** 旧的Pointy菜单（SHOW_PET 打开时用） */
function petMenu() {
  return [
    { label: '晃一下鼠标触发', type: 'checkbox', checked: settings.shake, click: (item) => { saveSettings({ shake: item.checked }); updateTray() } },
    {
      label: '晃动灵敏度',
      submenu: [['low', '低（要晃得明显）'], ['medium', '中'], ['high', '高（轻晃就行）']].map(([value, label]) => ({
        label, type: 'radio', checked: settings.shakeLevel === value, click: () => { saveSettings({ shakeLevel: value }); updateTray() },
      })),
    },
    { label: `浏览器扩展：${extensions.size ? `已连接 ${extensions.size} 个` : '未连接'}`, enabled: false },
    { label: '安装浏览器扩展…', click: () => showExtensionGuide() },
    { type: 'separator' },
    { label: '勿扰模式', type: 'checkbox', checked: settings.dnd, click: (item) => { saveSettings({ dnd: item.checked }); applyVisibility() } },
    { label: '置顶', type: 'checkbox', checked: settings.onTop, click: (item) => { saveSettings({ onTop: item.checked }); applyOnTop(); updateTray() } },
    {
      label: '人物大小',
      submenu: [
        ...SIZE_PRESETS.map(([label, value]) => ({
          label: `${label}（${Math.round(value * 100)}%）`, type: 'radio', checked: Math.abs(petScale() - value) < 0.01, click: () => setScale(value),
        })),
        { label: `当前 ${Math.round(petScale() * 100)}% · 在人物上 Ctrl+滚轮可微调`, enabled: false },
      ],
    },
    { label: '回到右下角', click: () => { homePos = undefined; placePet(...homePosition()) } },
    { type: 'separator' },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
    ]
}

function createTray() {
  tray = new Tray(trayIcon('idle'))
  updateTray()
  if (!SHOW_PET) {
    tray.on('balloon-click', () => { const f = notifyClick; notifyClick = undefined; f?.() })
  }
}

function ownHandles() {
  return [win, card].filter(Boolean).map(w => w.getNativeWindowHandle().readBigUInt64LE(0))
}

function pollFullscreen() {
  let now = false
  try { now = isFullscreenActive(ownHandles()) } catch {}
  if (now !== fullscreen) {
    fullscreen = now
    applyVisibility()
  }
}

ipcMain.on('move-by', (_e, dx, dy) => {
  if (!win || !Number.isFinite(dx) || !Number.isFinite(dy)) return
  placePet(petPos[0] + dx, petPos[1] + dy)
})

// 等批准时跑到屏幕中下方，处理完回原位；被压住时只记下来，恢复显示时再跑
ipcMain.on('front', (_e, on) => {
  if (!win) return
  wantFront = on
  if (on) {
    if (!suppressed()) moveToFront()
  } else if (homePos) {
    placePet(...homePos)
    homePos = undefined
  }
})

ipcMain.on('approvals', (_e, count) => {
  pendingApprovals = Number(count) || 0
  updateTray()
})

const sendToPlugin = (msg) => {
  if (!plugin) return false
  plugin.send(JSON.stringify(msg))
  return true
}
ipcMain.handle('to-plugin', (_e, msg) => sendToPlugin(msg))
ipcMain.handle('card-to-plugin', (_e, msg) => sendToPlugin(msg))
ipcMain.on('card-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
// 关卡片 → 把 DSH 提到前台 → 让插件在 DSH 里切到这张卡片对应的会话
ipcMain.on('card-open-dsh', (e, sessionId) => {
  logError('card-open-dsh-diag', `from card, sessionId=${sessionId}`)
  BrowserWindow.fromWebContents(e.sender)?.close()
  openDsh(sessionId)
})

/**
 * 把 DSH 叫到前台并切到这个会话。桌面版走 dsh://open；web 版没有窗口可拉，
 * 有浏览器扩展就让它把开着 DSH 的标签页切到前面，没扩展只能在原标签页里切会话。
 */
function openDsh(sessionId) {
  allowAnyForeground()
  if (dshUi.kind === 'web') {
    const ext = [...extensions.values()][0]
    if (ext && dshUi.origin) ext.ws.send(JSON.stringify({ type: 'focus-tab', origin: dshUi.origin }))
    else showHint('已在浏览器里的 DSH 切到这个会话')
  } else {
    shell.openExternal('dsh://open')
  }
  if (typeof sessionId === 'string' && sessionId) sendToPlugin({ type: 'focus', sessionId })
}
// 只认 http(s) 和本机绝对路径；本机文件只在资源管理器里定位，不直接运行
ipcMain.on('card-open-link', (_e, href) => {
  const s = String(href ?? '')
  if (/^https?:\/\//i.test(s)) shell.openExternal(s)
  else if (/^[a-z]:[\\/]/i.test(s) && fs.existsSync(s)) shell.showItemInFolder(s)
})
ipcMain.on('card-copy', (_e, text) => clipboard.writeText(String(text ?? '')))
// 内容变高时跟着变高；用户拖过大小之后就不再自动改
ipcMain.on('card-resize', (e, height) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c || c.manualSize) return
  const b = c.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  const h = Math.min(Number(height) || CARD_H_ANSWER, workArea.height)
  // 下拉开着、窗口被临时撑高时只记下来，关菜单时还原到这个高度
  if (c.menuBaseH) { c.menuBaseH = h; return }
  c.setBounds({ x: b.x, y: Math.min(b.y, workArea.y + workArea.height - h), width: c.cardW ?? cardWidth, height: h })
})
// 卡片的下拉比窗口长：临时把窗口往下撑高（手动调过大小也撑），0 = 还原
ipcMain.on('card-menu-room', (e, height) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (!c) return
  const b = c.getBounds()
  if (!height) {
    if (c.menuBaseH) c.setBounds({ ...b, height: c.menuBaseH })
    c.menuBaseH = undefined
    return
  }
  if (height <= b.height) return
  const { workArea } = screen.getDisplayMatching(b)
  c.menuBaseH ??= b.height
  c.setBounds({ ...b, height: Math.min(Math.ceil(height), workArea.y + workArea.height - b.y) })
})
// 右下角拖拽：按下时记住窗口和光标，拖动时用主进程拿到的光标位置算（不用渲染进程的坐标，缩放下不准）
let gripDrag
ipcMain.on('card-grip-start', (e) => {
  const c = BrowserWindow.fromWebContents(e.sender)
  if (c) gripDrag = { c, b: c.getBounds(), p: screen.getCursorScreenPoint() }
})
ipcMain.on('card-grip-move', (e) => {
  const { c, b, p } = gripDrag ?? {}
  if (!c || c.isDestroyed() || c !== BrowserWindow.fromWebContents(e.sender)) return
  const now = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayMatching(b)
  const width = Math.round(Math.min(Math.max(CARD_MIN_W, b.width + now.x - p.x), workArea.x + workArea.width - b.x))
  const height = Math.round(Math.min(Math.max(CARD_MIN_H, b.height + now.y - p.y), workArea.y + workArea.height - b.y))
  c.manualSize = true
  c.cardW = width
  cardWidth = width
  c.setBounds({ x: b.x, y: b.y, width, height })
})
ipcMain.on('card-grip-end', () => { gripDrag = undefined })

ipcMain.on('menu', () => tray.popUpContextMenu())

let captureSeq = 0
async function capture(target, name) {
  if (!CAPTURE_DIR || !target) return
  await new Promise(r => setTimeout(r, 400))
  const image = await target.webContents.capturePage()
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  fs.writeFileSync(path.join(CAPTURE_DIR, `${String(++captureSeq).padStart(2, '0')}-${name}.png`), image.toPNG())
}
ipcMain.on('rendered', (_e, state) => capture(win, state))
ipcMain.on('card-rendered', (_e, name) => capture(card, `card-${name}`))

// 换了端口的实例（测试用）各用各的 userData，单实例锁才不会互相挡住
if (process.env.POINTY_PORT) app.setPath('userData', `${app.getPath('userData')}-${PORT}`)
// 开机自启和 DSH 拉起可能同时发生，只留一个
if (!app.requestSingleInstanceLock()) app.exit(0)

app.whenReady().then(() => {
  // 上次指认中途崩溃的话系统光标还是鲸鱼娘，启动时先恢复成用户自己的
  if (!TEST_HIDDEN) restoreCursor(true)
  if (!TEST_HIDDEN) { dropOldAutostart(); syncUserExtension() }
  startServer(loadToken())
  createWindow()
  if (!TEST_HIDDEN) {
    createTray()
    startShakeDetector({
      onShake: (x, y) => { if (settings.shake) onShake(x, y).catch(() => {}) },
      shouldIgnore: () => shakeIgnored(),
      level: () => settings.shakeLevel,
    })
  }
  if (!TEST_HIDDEN && !settings.welcomed) setTimeout(() => showWelcome().catch((err) => logError('welcome', err)), 2500)
  pollFullscreen()
  setInterval(pollFullscreen, FULLSCREEN_POLL_MS)
  setInterval(() => { try { keepOnTop() } catch {} }, TOPMOST_POLL_MS)
  setInterval(updateClickThrough, CLICK_POLL_MS)
  if (TEST_HIDDEN || process.env.POINTY_TEST_HOOKS === '1') global.pointyTest = { openCard, openDsh, dshUi: () => dshUi, showNotice, showWelcome, showExtensionGuide, noticeChoose: (id) => noticeDone?.(id), noticeOpen: () => !!noticeWin, extensionGrabFor, onShake, getCard: () => card, petBounds: () => win.getBounds(), allCards: () => [...cards], lastGrab: () => lastGrab, selection: require('./selection'), pickAndOpen, pickNative, extensionCount: () => extensions.size, lastPickTab: () => lastPickTab, abortPick: () => picking?.abort?.(), setOffscreenCards: (on) => { offscreenCards = on }, pills: () => pills.map(({ win, ...p }) => p), pillBounds: () => pillWin?.getBounds() }
})
app.on('window-all-closed', () => {})
app.on('will-quit', () => {
  restoreCursor()
  globalShortcut.unregisterAll()
  stopSelectionHelper()
  if (MANAGED && (!TEST_HIDDEN || process.env.POINTY_TEST_UNINSTALL === '1') && pluginUninstalled()) cleanUpAfterUninstall()
})

// ---------- 插件被卸载后清理自己 ----------
// Pointy 从插件目录里的 pet/ 运行。DSH 卸载插件时（pnpm remove）删掉了包根目录的 package.json、src、lib，
// pet/ 因为 Pointy 还开着、koffi.node 被占着删不干净。等 DSH 退出、Pointy 跟着退出时，看到包已经没了，
// 就把运行时、设置和插件残留一起删掉。DSH 没开时用命令行卸载的话 Pointy 不在运行，这条路走不到。
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')

function pluginUninstalled() {
  // 只在确实是从 node_modules/@pointylab/dsh 里跑的时候才判断，开发版不碰
  if (!/[\\/]node_modules[\\/]@pointylab[\\/]dsh$/i.test(PLUGIN_ROOT)) return false
  return !fs.existsSync(path.join(PLUGIN_ROOT, 'package.json'))
}

function cleanUpAfterUninstall() {
  const targets = [TOKEN_DIR, app.getPath('userData'), PLUGIN_ROOT].filter((p) => fs.existsSync(p))
  logError('uninstall', `plugin removed; cleaning ${targets.join(', ')}`)
  // Pointy 和它的子进程退干净（exe 和 koffi.node 解锁）后再删；最多等 30 秒
  const quote = (p) => `'${p.replace(/'/g, "''")}'`
  const script = [
    `$exe = ${quote(process.execPath)}`,
    '$t0 = Get-Date',
    'while ((Get-Process | Where-Object { $_.Path -eq $exe }) -and ((Get-Date) - $t0).TotalSeconds -lt 30) { Start-Sleep -Milliseconds 500 }',
    ...targets.map((p) => `Remove-Item -LiteralPath ${quote(p)} -Recurse -Force -ErrorAction SilentlyContinue`),
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  try {
    // 经 cmd 的 start 起：直接 spawn 的控制台子进程会跟着 Pointy 退出被关掉（实测），start 出来的那个能活下来
    require('node:child_process').spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (err) { logError('uninstall', err) }
}

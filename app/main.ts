// Pointy 主进程：把几块接起来，自己不做具体的事
//   pick/       晃一下鼠标 → 指认 / 取选区，交出"抓到的东西"
//   ui/cards    卡片和胶囊：显示抓到的东西，问当前 agent，流式显示回答
//   agents/     卡片背后的 agent（现在只有 DSH），把通用请求翻译成各家的样子
//   browser/    浏览器扩展：配对、网页里的指认、切标签页
//   server.js   本机 WebSocket 服务，agent 桥和扩展都连这里
//   ui/tray、ui/notices  托盘、提示窗、开场动画
import { app, globalShortcut } from 'electron'
import { PORT, TEST_HIDDEN, logError } from './core/env.ts'
import * as state from './core/state.ts'
import os from './core/os/index.ts'
import * as selection from './pick/selection.ts'
import * as pick from './pick/index.ts'
import * as extensions from './browser/extensions.ts'
import * as agents from './agents/index.ts'
import * as cards from './ui/cards.ts'
import * as notices from './ui/notices.ts'
import * as tray from './ui/tray.ts'
import { startServer } from './server.ts'

process.on('uncaughtException', (err) => logError('uncaught', err))
process.on('unhandledRejection', (err) => logError('unhandled-rejection', err))
// 卡片和其他窗口里的报错、渲染进程崩掉，也只记日志
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (e) => { if (e.level === 'error') logError('renderer', `${e.message} (${e.sourceId}:${e.lineNumber})`) })
  wc.on('render-process-gone', (_e, details) => logError('render-process-gone', JSON.stringify(details)))
  wc.on('preload-error', (_e, preloadPath, err) => logError('preload', `${preloadPath}: ${(err as Error | undefined)?.stack ?? err}`))
})

/** 测试钩子：POINTY_TEST_HIDDEN / POINTY_TEST_HOOKS 时挂在 global 上，经 --inspect 调用 */
declare global {
  var pointyTest: (Record<string, unknown> & { allowPairAsk?: boolean }) | undefined
}

const FULLSCREEN_POLL_MS = 500

function pollFullscreen() {
  let now = false
  try { now = os.isFullscreenActive(cards.ownHandles()) } catch {}
  state.setFullscreen(now)
}

// 换了端口的实例（测试用）各用各的 userData，单实例锁才不会互相挡住
if (process.env.POINTY_PORT) app.setPath('userData', `${app.getPath('userData')}-${PORT}`)
if (!app.requestSingleInstanceLock()) app.exit(0)

app.whenReady().then(() => {
  // 只在菜单栏放图标，不占程序坞
  app.dock?.hide()
  // 上次指认中途崩溃的话系统光标还是鲸鱼娘，启动时先恢复成用户自己的
  if (!TEST_HIDDEN) os.restoreCursor(true)
  if (!TEST_HIDDEN) extensions.syncUserExtension()

  const agent = agents.current()
  notices.init({ agentName: () => agents.current().name, extensionDir: () => extensions.USER_EXTENSION_DIR, syncExtension: extensions.syncUserExtension })
  extensions.init({ showNotice: notices.showNotice, onSelection: (grab) => cards.openCard(grab), onChange: () => tray.update() })
  agent.init({
    toCards: cards.broadcast,
    onTask: cards.onTask,
    notify: tray.notify,
    showHint: notices.showHint,
    focusTab: extensions.focusTab,
    onChange: () => tray.update(),
  })
  startServer({ onAgent: (ws) => agents.current().attach(ws) })
  state.onVisibilityChange(() => tray.update())

  if (!TEST_HIDDEN) {
    tray.create({ agent: agents.current, extensionCount: extensions.count, showExtensionGuide: notices.showExtensionGuide, showWelcome: notices.showWelcome })
  }
  pick.start({
    onGrab: (grab, release) => cards.openCard(grab, release),
    showHint: notices.showHint,
    browser: extensions,
    cardFocused: cards.focused,
  })
  if (!TEST_HIDDEN) setTimeout(() => Promise.resolve(notices.greetOnStart()).catch((err) => logError('welcome', err)), 2500)
  pollFullscreen()
  setInterval(pollFullscreen, FULLSCREEN_POLL_MS)

  if (TEST_HIDDEN || process.env.POINTY_TEST_HOOKS === '1') {
    global.pointyTest = {
      openCard: cards.openCard,
      openAgent: (sessionId?: string) => agents.current().open(sessionId),
      agentUi: () => agents.current().ui?.(),
      getCard: cards.current,
      allCards: cards.all,
      setOffscreenCards: cards.setOffscreen,
      pills: cards.pills,
      pillBounds: cards.pillBounds,
      showNotice: notices.showNotice,
      noticeChoose: (id: string | null) => notices.closeNotice(id),
      noticeOpen: notices.noticeOpen,
      showWelcome: notices.showWelcome,
      greetOnStart: notices.greetOnStart,
      showIntro: notices.showIntro,
      showExtensionGuide: notices.showExtensionGuide,
      extensionGrabFor: extensions.grabFor,
      extensionCount: extensions.count,
      lastPickTab: extensions.lastPickTab,
      abortPick: extensions.abortPick,
      onShake: pick.onShake,
      pickAndOpen: pick.pickAndOpen,
      pickNative: pick.pickNative,
      selection,
    }
  }
})
app.on('window-all-closed', () => {})
app.on('will-quit', () => {
  os.restoreCursor()
  globalShortcut.unregisterAll()
  selection.stopSelectionHelper()
  agents.current().willQuit()
})

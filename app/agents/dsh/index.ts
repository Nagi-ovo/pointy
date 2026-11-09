// DSH（DeepSeek Harness）适配：DSH 里装的插件（plugin/）连上 Pointy 的本机服务，这里把它翻译成卡片认识的通用 agent 接口。
// 跟 DSH 有关的事都在这个目录：消息格式、临时标题、工具名、怎么把 DSH 叫到前台、随 DSH 启停
import { shell } from 'electron'
import type { WebSocket } from 'ws'
import { logError } from '../../core/env.ts'
import os from '../../core/os/index.ts'
import { composeFirst, composeFollowUp, isOurPreamble } from '../compose.ts'
import { activityText } from './activity.ts'
import * as host from './host.ts'
import type { AgentDeps, AgentUi } from '../index.ts'
import type { ConnectionHandler } from '../../server.ts'

/** 插件发来的消息：要转给卡片的那些（AgentEvent），加上只有这里关心的几种 */
type PluginMessage =
  | AgentEvent
  | { type: 'ready'; plugin?: string }
  | { type: 'ui'; kind?: unknown; origin?: unknown }
  | { type: 'approval'; sessionId?: string }
  | { type: 'approval-closed' }
  | { type: 'state'; sessionId?: string; title?: string }

export const name = 'DSH'

// init() 之前是空的
let deps = {} as AgentDeps
let plugin: WebSocket | undefined // 已认证的插件连接
let pluginVersion: string | undefined // 插件连上时报的版本，托盘里显示，方便看出 DSH 加载的是不是新版
let everConnected = false
let pendingApprovals = 0
let ui: AgentUi = { kind: 'desktop' } // 插件报来的：DSH 是桌面版，还是浏览器里的 web 版（origin 是它的地址）

export function init(d: AgentDeps) {
  deps = d
  host.start(() => !!plugin)
}

const sendToPlugin = (msg: object) => {
  if (!plugin) return false
  plugin.send(JSON.stringify(msg))
  return true
}

// ---------- 插件 → 卡片 ----------
// DSH 起正式标题前拿第一条消息开头当临时标题，那就是我们拼的内容块，不往外报
const realTitle = (t: string | undefined) => (t && !isOurPreamble(t) ? t : undefined)

const forCards = (msg: PluginMessage): msg is AgentEvent => msg.type.startsWith('ask-') || msg.type === 'sessions' || msg.type === 'suggestions' || msg.type === 'title'

function onPluginMessage(raw: PluginMessage) {
  const msg = { ...raw }
  if ('title' in msg) msg.title = realTitle(msg.title)
  if (msg.type === 'sessions' && Array.isArray(msg.items)) msg.items = msg.items.map(s => ({ ...s, title: realTitle(s.title) }))
  if (msg.type === 'ask-activity') msg.text = activityText(String(msg.tool ?? ''), String(msg.detail ?? ''))

  if (msg.type === 'ready') { pluginVersion = msg.plugin; deps.onChange?.() }
  if (msg.type === 'ui') { ui = { kind: msg.kind === 'web' ? 'web' : 'desktop', origin: typeof msg.origin === 'string' ? msg.origin : undefined }; logError('dsh-ui', JSON.stringify(ui)) }
  if (msg.type === 'approval') {
    pendingApprovals++
    deps.notify?.('DSH 有个操作等你批准', '点这里打开 DSH', () => open(msg.sessionId))
    deps.onChange?.()
  } else if (msg.type === 'approval-closed') {
    pendingApprovals = Math.max(0, pendingApprovals - 1)
    deps.onChange?.()
  }
  // 任务进度（胶囊用）：做完、出错、标题变了
  if (msg.type === 'ask-done' || msg.type === 'ask-error' || msg.type === 'state' || msg.type === 'title') deps.onTask?.(msg)
  if (forCards(msg)) deps.toCards?.(msg)
}

/** 服务认证通过一条插件连接时调用；返回这条连接的处理器 */
export function attach(ws: WebSocket): ConnectionHandler {
  if (plugin && plugin !== ws) plugin.close()
  plugin = ws
  everConnected = true
  host.linked()
  deps.onChange?.()
  return {
    onMessage: (msg) => { if (typeof msg?.type === 'string') onPluginMessage(msg) },
    onClose: () => {
      if (plugin !== ws) return
      plugin = undefined
      pluginVersion = undefined
      deps.onChange?.()
      host.unlinked(everConnected)
    },
  }
}

// ---------- 卡片 → 插件 ----------
/** 卡片发来的请求。返回 false 表示没连上 */
export function request(msg: CardRequest) {
  if (msg.type === 'ask') {
    const text = msg.followUp ? composeFollowUp(msg) : composeFirst(msg)
    const images = Array.isArray(msg.images) ? msg.images : []
    return sendToPlugin({
      type: 'ask', askId: msg.askId, target: msg.target, text,
      ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(images.length ? { image: images[0], images } : {}),
    })
  }
  if (msg.type === 'suggest-request') return sendToPlugin({ type: 'suggest-request', reqId: msg.reqId, context: composeFirst({ material: msg.material }) })
  if (msg.type === 'sessions-request' || msg.type === 'sessions-search') return sendToPlugin(msg)
  return false
}

/**
 * 把 DSH 叫到前台并切到这个会话。桌面版走 dsh://open；web 版没有窗口可拉，
 * 有浏览器扩展就让它把开着 DSH 的标签页切到前面，没扩展只能在原标签页里切会话。
 */
export function open(sessionId?: string) {
  os.allowAnyForeground()
  if (ui.kind === 'web') {
    if (!deps.focusTab?.(ui.origin)) deps.showHint?.('已在浏览器里的 DSH 切到这个会话')
  } else {
    shell.openExternal('dsh://open')
  }
  if (typeof sessionId === 'string' && sessionId) sendToPlugin({ type: 'focus', sessionId })
}

/** 托盘用：连上没有、几个操作等批准 */
export const status = () => ({ connected: !!plugin, version: pluginVersion, pendingApprovals })

export const willQuit = host.willQuit
const currentUi = () => ui
export { currentUi as ui }

import { shell } from 'electron'
import type { WebSocket } from 'ws'
import { logError } from '../../core/env.ts'
import os from '../../core/os/index.ts'
import { composeFirst, composeFollowUp, isOurPreamble } from '../compose.ts'
import { activityText } from './activity.ts'
import * as host from './host.ts'
import type { AgentDeps, AgentUi } from '../index.ts'
import type { ConnectionHandler } from '../../server.ts'

type PluginMessage =
  | AgentEvent
  | { type: 'ready'; plugin?: string }
  | { type: 'ui'; kind?: unknown; origin?: unknown }
  | { type: 'approval'; sessionId?: string }
  | { type: 'approval-closed' }
  | { type: 'state'; sessionId?: string; title?: string }

export const name = 'DSH'

let deps = {} as AgentDeps
let plugin: WebSocket | undefined
let pluginVersion: string | undefined
let everConnected = false
let pendingApprovals = 0
let ui: AgentUi = { kind: 'desktop' }

export function init(d: AgentDeps) {
  deps = d
  host.start(() => !!plugin)
}

const sendToPlugin = (msg: object) => {
  if (!plugin) return false
  plugin.send(JSON.stringify(msg))
  return true
}

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
  if (msg.type === 'ask-done' || msg.type === 'ask-error' || msg.type === 'state' || msg.type === 'title') deps.onTask?.(msg)
  if (forCards(msg)) deps.toCards?.(msg)
}

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

export function open(sessionId?: string) {
  os.allowAnyForeground()
  if (ui.kind === 'web') {
    if (!deps.focusTab?.(ui.origin)) deps.showHint?.('已在浏览器里的 DSH 切到这个会话')
  } else {
    shell.openExternal('dsh://open')
  }
  if (typeof sessionId === 'string' && sessionId) sendToPlugin({ type: 'focus', sessionId })
}

export const status = () => ({ connected: !!plugin, version: pluginVersion, pendingApprovals })

export const willQuit = host.willQuit
const currentUi = () => ui
export { currentUi as ui }

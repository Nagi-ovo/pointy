// DSH（DeepSeek Harness）适配：DSH 里装的插件（plugin/）连上 Pointy 的本机服务，这里把它翻译成卡片认识的通用 agent 接口。
// 跟 DSH 有关的事都在这个目录：消息格式、临时标题、工具名、怎么把 DSH 叫到前台、随 DSH 启停
const { shell } = require('electron')
const { logError } = require('../../core/env')
const { allowAnyForeground } = require('../../core/win32')
const { composeFirst, composeFollowUp, isOurPreamble } = require('../compose')
const host = require('./host')

const name = 'DSH'

let deps = {} // { toCards(msg), onTask(msg), notify(title, content, onClick), showHint(text), focusTab(origin), onChange() }
let plugin // 已认证的插件连接
let pluginVersion // 插件连上时报的版本，托盘里显示，方便看出 DSH 加载的是不是新版
let everConnected = false
let pendingApprovals = 0
let ui = { kind: 'desktop' } // 插件报来的：DSH 是桌面版，还是浏览器里的 web 版（origin 是它的地址）

function init(d) {
  deps = d
  host.start(() => !!plugin)
}

const sendToPlugin = (msg) => {
  if (!plugin) return false
  plugin.send(JSON.stringify(msg))
  return true
}

// ---------- 插件 → 卡片 ----------
// DSH 起正式标题前拿第一条消息开头当临时标题，那就是我们拼的内容块，不往外报
const realTitle = (t) => (t && !isOurPreamble(t) ? t : undefined)

const short = (s, n = 36) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** 网址说成"issue #5075""B 站视频 BV…"，认不出就是域名加路径 */
function describeUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return short(raw) }
  const parts = u.pathname.split('/').filter(Boolean)
  if (/(^|\.)github\.com$/.test(u.hostname)) {
    if (parts[2] === 'issues' && parts[3]) return `issue #${parts[3]}`
    if (parts[2] === 'pull' && parts[3]) return `PR #${parts[3]}`
    if (parts[2] === 'blob') return baseName(u.pathname)
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  }
  const bv = u.pathname.match(/BV\w+/)?.[0]
  if (/bilibili\.com$/.test(u.hostname) && bv) return `B 站视频 ${bv}`
  return short(`${u.hostname.replace(/^www\./, '')}${parts.length ? `/${parts.join('/')}` : ''}`)
}

/** DSH 的工具调用说成人话（等待时卡片上显示） */
function activityText(tool, detail) {
  const t = tool.toLowerCase()
  const d = detail.trim()
  if (/search/.test(t) && /^web|search_web|google/.test(t)) return d ? `正在搜索「${short(d, 24)}」…` : '正在搜索…'
  if (/^(web|fetch)/.test(t)) return /^https?:/.test(d) ? `正在读取 ${describeUrl(d)}…` : d ? `正在搜索「${short(d, 24)}」…` : '正在上网查…'
  if (/^(pwsh|bash|terminal|shell|run_code|job_|ptc)/.test(t)) return d ? `正在运行：${short(d)}` : '正在运行命令…'
  if (/^(read|view|open)/.test(t)) return d ? `正在看 ${baseName(d)}…` : '正在看文件…'
  if (/^(grep|glob|search|find|list|ls)/.test(t)) return d ? `正在找「${short(d, 24)}」…` : '正在找文件…'
  if (/^(write|edit|str_replace|apply_patch|multi_edit)/.test(t)) return d ? `正在改 ${baseName(d)}…` : '正在改文件…'
  if (/subagent|task|agent/.test(t)) return '正在分派子任务…'
  if (/todo|plan/.test(t)) return '正在列计划…'
  if (/skill/.test(t)) return '正在用技能…'
  return '正在处理…'
}

function onPluginMessage(raw) {
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
  if (msg.type.startsWith('ask-') || msg.type === 'sessions' || msg.type === 'suggestions' || msg.type === 'title') deps.toCards?.(msg)
}

/** 服务认证通过一条插件连接时调用；返回这条连接的处理器 */
function attach(ws) {
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
function request(msg) {
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
function open(sessionId) {
  allowAnyForeground()
  if (ui.kind === 'web') {
    if (!deps.focusTab?.(ui.origin)) deps.showHint?.('已在浏览器里的 DSH 切到这个会话')
  } else {
    shell.openExternal('dsh://open')
  }
  if (typeof sessionId === 'string' && sessionId) sendToPlugin({ type: 'focus', sessionId })
}

/** 托盘用：连上没有、几个操作等批准 */
const status = () => ({ connected: !!plugin, version: pluginVersion, pendingApprovals })

module.exports = { name, init, attach, request, open, status, willQuit: host.willQuit, ui: () => ui }

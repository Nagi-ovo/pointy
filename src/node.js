/**
 * @pointylab/dsh host half (Pointy).
 *
 * - Carries Pointy itself in ../pet and starts it on the first DSH run where it
 *   is not already running, after downloading its Electron runtime once
 *   (see runtime.js). Pointy quits on its own when DSH goes away.
 *
 * - Listens to `session/event`, `agent/status` and `agent/error` and pushes a
 *   compact pet state (thinking / running / editing / ... / done / error) to
 *   the pet over ws://127.0.0.1:<port>.
 * - Registers a prepended `approval/request` waterfall listener: the request
 *   still goes to the DSH UI through `next()`, and the pet may answer first.
 *   When the pet wins, an AbortController merged into `request.signal` makes
 *   the gateway withdraw the UI prompt.
 * - Delivers files dropped on the pet to the most recently active root session
 *   with `agent.followup()`.
 * - Generates short pet lines through `ctx.llm`, reusing DSH's own model route
 *   and credentials; no key ever passes through this plugin.
 *
 * Both ends prove knowledge of the token in %USERPROFILE%\.pointy\token with
 * an HMAC challenge before the plugin accepts approvals or files.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { PET_APP_DIR, ensureRuntime } from './runtime.js'

export const name = 'pointy'

export const inject = ['llm', 'agents']

const PORT = Number(process.env.POINTY_PORT) || 47321
const PET_DIR = path.join(os.homedir(), '.pointy')
const TOKEN_FILE = path.join(PET_DIR, 'token')
const PET_LOG = path.join(PET_DIR, 'pet.log')
const PET_LOG_MAX = 256 * 1024
const RECONNECT_MS = 3000
/** Events older than this are replays (session load), not live activity. */
const STALE_EVENT_MS = 30_000
const LINE_MIN_INTERVAL_MS = 15_000
const LINE_TIMEOUT_MS = 15_000
const DEFAULT_ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' }
/** Private RPC channel the browser half (lib/client.js) polls for sessions to open. */
const RPC_CHANNEL = '/pointy'
const FOCUS_POLL_MS = 20_000
const FOCUS_PENDING_MS = 8_000
const MAX_DROPPED_FILES = 20
/** Desktop DSH runs plugins through dsh-desktop-host/lib/index.js; the web UI (`dsh <profile>`) goes through lib/cli.js. */
const DESKTOP = process.argv.some((a) => /dsh-desktop-host[\\/]lib[\\/]index\.js$/.test(a))
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PET_APP_DIR, '..', 'package.json'), 'utf8')).version } catch { return '?' }
})()

const PERSONA = [
  '你是桌面助手 Pointy，一个穿女仆装的 Q 版鲸鱼娘。',
  '她陪主人用 DeepSeek Harness 写代码。性格：认真、有点小傲娇、会吐槽但很贴心。',
  '只输出一句中文台词，15 字以内，口语，不要引号、不要表情符号、不要解释。',
].join('\n')

const STATE_HINT = {
  idle: '主人没在让你干活，你在发呆',
  thinking: '你正在想下一步怎么做',
  running: '你在终端里执行命令',
  editing: '你在改文件',
  reading: '你在翻文件、搜代码',
  web: '你在上网查资料',
  waiting: '你在等主人批准一个操作',
  error: '刚刚出错了',
  done: '这一轮任务刚做完',
  sleep: '太久没事干，你困了',
  poke: '主人戳了你一下',
  files: '主人把文件拖给了你',
}

/** Map a DSH tool name to the pet's activity state. */
function classifyTool(toolName) {
  const n = toolName.toLowerCase()
  if (/^(pwsh|bash|terminal|shell|run_code|job_|ptc)/.test(n)) return 'running'
  if (/^(write|edit|str_replace|apply_patch|multi_edit)/.test(n)) return 'editing'
  if (/^(web|fetch)/.test(n)) return 'web'
  if (/^(read|glob|grep|list|search|find|ls)/.test(n)) return 'reading'
  return 'thinking'
}

/** A one-line, display-only summary of a tool call; never the full arguments. */
function summarizeCall(toolName, rawArgs) {
  let args
  try { args = JSON.parse(rawArgs) } catch { return '' }
  if (args === null || typeof args !== 'object') return ''
  const pick = args.description ?? args.command ?? args.path ?? args.file_path ?? args.url ?? args.query ?? args.pattern
  return typeof pick === 'string' ? pick.replace(/\s+/g, ' ').slice(0, 160) : ''
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(c => c?.type === 'text').map(c => c.text).join('\n')
}

function hmac(token, data) {
  return crypto.createHmac('sha256', token).update(data).digest('hex')
}

function safeEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** The pet's console output, started fresh once it grows past PET_LOG_MAX. */
function openPetLog() {
  fs.mkdirSync(PET_DIR, { recursive: true })
  const size = fs.statSync(PET_LOG, { throwIfNoEntry: false })?.size ?? 0
  return fs.openSync(PET_LOG, size > PET_LOG_MAX ? 'w' : 'a')
}

/** Spawn the bundled pet detached on the downloaded Electron runtime. */
async function launchPet(logger) {
  let exe
  try {
    exe = await ensureRuntime(logger)
  } catch (error) {
    return logger.warn(`pointy: cannot start Pointy: ${error.message}`)
  }
  logger.info(`pointy: starting Pointy: ${exe} ${PET_APP_DIR}`)
  // The DSH host runs Electron in node mode; the pet must not inherit that.
  // POINTY_HOST_PID：拉起它的 DSH 插件宿主；宿主没了、插件又没连着，Pointy 就自己退
  const env = { ...process.env, POINTY_MANAGED: '1', POINTY_HOST_PID: String(process.pid) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  try {
    // stdout/stderr must not be the NUL device: koffi flushes stderr at exit, FlushFileBuffers
    // fails on NUL, and koffi's error path re-locks the stream mutex and aborts (0xC0000409).
    const out = openPetLog()
    const child = spawn(exe, [PET_APP_DIR], { cwd: PET_APP_DIR, env, detached: true, stdio: ['ignore', out, out] })
    fs.closeSync(out)
    child.on('error', (error) => logger.warn(`pointy: failed to start Pointy: ${error.message}`))
    child.unref()
  } catch (error) {
    logger.warn(`pointy: failed to start Pointy: ${error.message}`)
  }
}

/** Reconnecting, HMAC-authenticated WebSocket client to the pet. */
class PetLink {
  constructor(logger, onMessage) {
    this.logger = logger
    this.onMessage = onMessage
    this.ws = undefined
    this.authed = false
    this.stopped = false
    this.timer = undefined
    this.onReady = () => {}
    this.onLost = () => {}
    /** Called when nothing is listening on the port, i.e. the pet is not running. */
    this.onUnreachable = () => {}
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.ws?.close()
  }

  connect() {
    if (this.stopped) return
    let token
    try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {
      this.onUnreachable()
      return this.retry()
    }
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const nonce = crypto.randomBytes(16).toString('hex')
    let opened = false
    this.ws = ws
    ws.addEventListener('open', () => { opened = true })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.type === 'challenge') {
        ws.send(JSON.stringify({ type: 'hello', v: 1, nonce, proof: hmac(token, `plugin|${msg.nonce}`) }))
      } else if (msg.type === 'hello-ok') {
        if (!safeEqual(msg.proof, hmac(token, `pet|${nonce}`))) {
          this.logger.warn('pointy: pet failed authentication, closing')
          ws.close()
          return
        }
        this.authed = true
        this.onReady()
      } else if (this.authed) {
        this.onMessage(msg)
      }
    })
    ws.addEventListener('close', () => {
      const wasAuthed = this.authed
      this.authed = false
      if (this.ws === ws) this.ws = undefined
      if (wasAuthed) this.onLost()
      if (!opened) this.onUnreachable()
      this.retry()
    })
    ws.addEventListener('error', () => {})
  }

  retry() {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), RECONNECT_MS)
  }

  send(msg) {
    if (!this.authed || this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  /** Most recent route seen in a `request/header`, reused for pet lines. */
  let route
  /** Most recently active root session id: target for dropped files. */
  let activeRoot
  const titles = new Map()
  /** callId -> summary, bounded; lets the approval card show what will run. */
  const callSummaries = new Map()
  /** approval id -> answer(decision) */
  const pendingApprovals = new Map()
  /** Last state per session, replayed to a pet that connects mid-task. */
  const lastState = new Map()
  /** sessionId -> askId of the card currently following that session */
  const asks = new Map()
  let lastLineAt = 0
  let lineBusy = false

  const link = new PetLink(logger, handlePetMessage)
  link.onReady = () => {
    link.send({ type: 'ready', plugin: PLUGIN_VERSION })
    link.send(uiInfo())
    for (const msg of lastState.values()) link.send(msg)
  }
  // Start the pet once per DSH run if it is not already running.
  let launchTried = false
  link.onUnreachable = () => {
    if (launchTried) return
    launchTried = true
    launchPet(logger).catch((error) => logger.warn(`pointy: ${error.message}`))
  }
  link.onLost = () => {
    // A pet that vanished cannot answer; leave pending approvals to the UI.
    for (const answer of pendingApprovals.values()) answer('detach')
  }

  // Where "open in DSH" should go: the desktop window, or the browser tab serving the web UI.
  let webOrigin
  const uiInfo = () => ({ type: 'ui', kind: DESKTOP ? 'desktop' : 'web', origin: DESKTOP ? undefined : webOrigin })
  function noteOrigin(origin) {
    if (DESKTOP || typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin) || origin === webOrigin) return
    webOrigin = origin
    link.send(uiInfo())
  }

  function push(sessionId, state, extra = {}) {
    const msg = { type: 'state', sessionId, title: titles.get(sessionId), state, at: Date.now(), ...extra }
    lastState.set(sessionId, msg)
    if (lastState.size > 20) lastState.delete(lastState.keys().next().value)
    link.send(msg)
  }

  function isRoot(session) {
    const depth = session?.header?.delegationDepth ?? session?.delegationDepth
    return depth === undefined || depth === 0
  }

  ctx.on('session/event', (session, event) => {
    if (typeof event?.time === 'number' && Date.now() - event.time > STALE_EVENT_MS) return
    const sid = session.id
    const data = event.data ?? {}
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string') {
          titles.set(sid, data.title)
          // DSH often names the session after the answer is done; the card and its pill want the real name too.
          link.send({ type: 'title', sessionId: sid, title: data.title })
        }
        break
      case 'request/header': {
        const config = data.header?.config
        if (config?.provider && config?.model) route = { provider: config.provider, model: config.model }
        break
      }
      case 'turn/start':
        if (isRoot(session)) activeRoot = sid
        push(sid, 'thinking')
        break
      case 'step/start':
        push(sid, 'thinking')
        break
      case 'tool/call': {
        const detail = summarizeCall(data.name, data.arguments)
        callSummaries.set(data.callId, detail)
        if (callSummaries.size > 200) callSummaries.delete(callSummaries.keys().next().value)
        push(sid, classifyTool(String(data.name)), { tool: data.name, detail })
        if (asks.has(sid)) link.send({ type: 'ask-activity', askId: asks.get(sid), sessionId: sid, tool: data.name, detail })
        break
      }
      case 'tool/result':
        if (data.message?.isError) push(sid, 'error', { detail: textOf(data.message.content).slice(0, 2000) })
        break
      case 'turn/end': {
        const kind = data.reason?.kind
        if (kind === 'completed' || kind === 'max-tokens') push(sid, 'done', { detail: kind })
        else if (kind === 'error') push(sid, 'error', { detail: String(data.reason?.message ?? data.reason?.error ?? 'turn ended with an error').slice(0, 2000) })
        else push(sid, 'idle', { detail: kind })
        if (asks.has(sid)) link.send({ type: 'ask-done', askId: asks.get(sid), sessionId: sid, title: titles.get(sid), reason: kind })
        break
      }
    }
  })

  ctx.on('agent/status', ({ agent, status }) => {
    link.send({ type: 'status', sessionId: agent.id, running: status === 'running' })
  }, { global: true })

  ctx.on('agent/error', ({ agent, error }) => {
    const detail = String(error?.message ?? error).slice(0, 2000)
    push(agent.id, 'error', { detail })
    if (asks.has(agent.id)) link.send({ type: 'ask-error', askId: asks.get(agent.id), sessionId: agent.id, error: detail })
  }, { global: true })

  // Live text of sessions started or continued from the ask card.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const askId = asks.get(agent.session.id)
    if (askId === undefined) return
    if (frame.type === 'start') link.send({ type: 'ask-step', askId, sessionId: agent.session.id })
    else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && frame.chunk.text) {
      link.send({ type: 'ask-delta', askId, sessionId: agent.session.id, text: frame.chunk.text })
    }
  }, { global: true })

  // Prepended so the pet sees the request before the UI forwarder, which only
  // calls next() when every UI client declines.
  ctx.on('approval/request', function (request, next) {
    if (!link.authed) return next()
    const id = crypto.randomUUID()
    const sid = request.agent?.id
    const original = request.signal
    const withdraw = new AbortController()
    try {
      request.signal = original ? AbortSignal.any([original, withdraw.signal]) : withdraw.signal
    } catch {
      // A frozen request still works; the UI prompt just stays until answered.
    }
    return new Promise((resolve) => {
      let settled = false
      let uiDeclined = false
      const finish = (outcome, by) => {
        if (settled) return
        settled = true
        pendingApprovals.delete(id)
        original?.removeEventListener('abort', onAbort)
        link.send({ type: 'approval-closed', id, sessionId: sid, outcome, by })
        resolve(outcome)
      }
      const onAbort = () => finish('cancelled', 'dsh')
      original?.addEventListener('abort', onAbort, { once: true })
      pendingApprovals.set(id, (decision) => {
        if (decision === 'detach') {
          if (uiDeclined) finish('unavailable', 'dsh')
          return
        }
        finish(decision === 'allow' ? 'allowed-once' : 'rejected', 'pet')
        withdraw.abort(new Error('answered on Pointy'))
      })
      Promise.resolve().then(next).then((outcome) => {
        // No UI answered: keep the question open for the pet alone.
        if (outcome === 'unavailable' && link.authed && !settled) { uiDeclined = true; return }
        finish(outcome, 'dsh')
      }, () => {
        if (!withdraw.signal.aborted) finish('unavailable', 'dsh')
      })
      push(sid, 'waiting')
      link.send({
        type: 'approval',
        id,
        sessionId: sid,
        title: titles.get(sid),
        toolName: request.toolName,
        // displayReason is a locale descriptor only the DSH client can render
        reason: typeof request.reason === 'string' ? request.reason : '',
        detail: request.callId === undefined ? '' : (callSummaries.get(request.callId) ?? ''),
      })
    })
  }, true)

  ctx.on('user-questions/request', function (request, next) {
    if (request?.agent?.id) push(request.agent.id, 'waiting', { detail: 'question' })
    return next()
  }, true)

  function handlePetMessage(msg) {
    if (msg.type === 'approve') {
      const answer = pendingApprovals.get(msg.id)
      if (answer && (msg.decision === 'allow' || msg.decision === 'reject')) answer(msg.decision)
    } else if (msg.type === 'files') {
      link.send({ type: 'files-result', ...deliverFiles(msg.paths) })
    } else if (msg.type === 'line-request') {
      generateLine(msg).then(
        text => link.send({ type: 'line', reqId: msg.reqId, text }),
        error => link.send({ type: 'line', reqId: msg.reqId, error: String(error?.message ?? error) }),
      )
    } else if (msg.type === 'sessions-request') {
      Promise.all([listSessions().catch(() => []), modelCatalog().catch(() => ({}))]).then(([items, catalog]) => link.send({
        type: 'sessions',
        reqId: msg.reqId,
        // 这次 DSH 运行里还没跑过会话时，最近更新的那个就算"当前会话"
        activeRoot: activeRoot ?? items[0]?.sessionId,
        items: items.slice(0, 15),
        model: (route ?? DEFAULT_ROUTE).model,
        workspaces: workspaceList(),
        defaultWorkspaceId: defaultWorkspace()?.id,
        ...catalog,
      }))
    } else if (msg.type === 'sessions-search') {
      searchSessions(String(msg.query ?? '')).then(
        items => link.send({ type: 'sessions', reqId: msg.reqId, items }),
        error => link.send({ type: 'sessions', reqId: msg.reqId, items: [], error: String(error?.message ?? error) }),
      )
    } else if (msg.type === 'focus') {
      if (typeof msg.sessionId === 'string') requestFocus(msg.sessionId)
    } else if (msg.type === 'suggest-request') {
      suggest(msg).then(
        suggestions => link.send({ type: 'suggestions', reqId: msg.reqId, suggestions }),
        error => link.send({ type: 'suggestions', reqId: msg.reqId, suggestions: [], error: String(error?.message ?? error) }),
      )
    } else if (msg.type === 'ask') {
      ask(msg).then(
        sessionId => link.send({ type: 'ask-accepted', askId: msg.askId, sessionId, title: titles.get(sessionId) }),
        error => link.send({ type: 'ask-error', askId: msg.askId, error: String(error?.message ?? error) }),
      )
    }
  }

  /** Root sessions for the card's target picker, newest first. */
  async function listSessions() {
    const controller = ctx.get('sessionController')
    const seen = new Map([...titles].map(([id, title]) => [id, { sessionId: id, title }]))
    const workspaceOf = new Map(workspaceList().flatMap(w => w.sessionIds.map(id => [id, w.title])))
    if (controller) {
      const { items } = await controller.list({}, AbortSignal.timeout(5000))
      for (const item of items) {
        if (item.archived || item.blank) continue
        const title = item.projections?.values?.title ?? item.title ?? titles.get(item.sessionId)
        const selection = item.projections?.values?.modelSelection?.next
        const model = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}) } : undefined
        seen.set(item.sessionId, { sessionId: item.sessionId, title, updatedAt: item.updatedAt, running: item.running, model, workspace: workspaceOf.get(item.sessionId) })
      }
    }
    return [...seen.values()]
      .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  /**
   * Sessions matching the card's search box: title matches first, then
   * sessions whose messages contain the text (DSH's own session search).
   */
  async function searchSessions(query) {
    const q = query.trim()
    if (!q) return []
    const all = await listSessions()
    const byId = new Map(all.map(s => [s.sessionId, s]))
    const lower = q.toLowerCase()
    const hits = all.filter(s => String(s.title ?? '').toLowerCase().includes(lower))
    const controller = ctx.get('sessionController')
    if (controller?.search) {
      try {
        const { items } = await controller.search({ query: q.slice(0, 200) }, AbortSignal.timeout(5000))
        for (const item of items) {
          const s = byId.get(item.sessionId)
          if (s && !hits.includes(s)) hits.push({ ...s, snippet: item.snippet })
        }
      } catch (error) {
        logger.warn(`pointy: session search failed: ${error.message}`)
      }
    }
    return hits.slice(0, 20)
  }

  /** Workspaces a new task can go to, as the DSH sidebar names them. */
  function workspaceList() {
    const registry = ctx.get('workspaceRegistry')
    return (registry?.list() ?? []).map(w => ({
      id: w.id,
      title: w.title || String(w.path ?? '').split(/[\\/]/).filter(Boolean).pop() || w.id,
      sessionIds: w.sessionIds ?? [],
    }))
  }

  /** Models the card's picker offers: the same catalog DSH's own model picker uses. */
  async function modelCatalog() {
    const controller = ctx.get('sessionController')
    if (!controller?.modelCatalog) return {}
    const catalog = await controller.modelCatalog()
    const models = (catalog?.groups ?? []).flatMap(g => g.models.map(m => ({
      provider: g.id,
      providerName: g.name,
      model: m.id,
      name: m.name || m.id,
      // Thinking efforts the model offers, as DSH's own picker names them.
      ...(m.reasoning?.efforts?.length ? { efforts: m.reasoning.efforts.map(e => ({ id: e.id, name: e.name || e.id })), defaultEffort: m.reasoning.defaultEffort } : {}),
    })))
    const d = catalog?.default
    return { models, defaultModel: d?.provider && d?.model ? { provider: d.provider, model: d.model, ...(d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}) } : undefined }
  }

  /**
   * Two next steps the user likely wants for what they pointed at, in their
   * own voice. Clicking one sends it as the question; nothing here asks the
   * agent to save or file anything. Recent session titles used to be passed
   * in and pulled the model toward "is this related to my project?", so the
   * prompt sees only the pointed content.
   */
  async function suggest({ context }) {
    const system = [
      '用户在屏幕上指着一块内容（网页评论、帖子、issue、代码、报错、图片等），准备交给他的 AI 助手。你替他想 2 个下一步最想让助手做的事。',
      '',
      '先判断这块内容是什么，再挑最有用的动作：',
      '- issue、技术讨论里的提问：起草回复、查原因',
      '- 帖子、评论里的说法：查证真假、补背景',
      '- 报错、日志：查原因、给修法',
      '- 代码、命令：讲清楚它在做什么、找问题',
      '- 提到的产品、工具、项目、人、术语：这是什么、怎么用、和同类比',
      '- 图片、截图：看懂图里的内容',
      '',
      '要求：',
      '- label 里要带上这块内容里的具体名字或说法（比如"OpenShell 支持 cgroup v1 吗"），不要"起草回复问细节"这种换个内容也成立的话。',
      '- 两个要是不同方向的动作。',
      '- 只围绕这块内容本身，不要问它和用户的项目、工作有没有关系，不要问怎么抓取或保存它。',
      '- 不要泛泛的"解释一下""总结一下""这是什么意思"。',
      '- 会发到外面的（回复、评论、消息、issue），只能是"起草"，不能直接发；只有用户确实可能去回的讨论才给起草回复。',
      '- 用用户自己的口吻，中文。',
      '',
      '只输出 JSON 数组，每项 {"label": "按钮上的字，一个完整的短语，不超过 12 个字（英文名算 1 个字），宁可短也别写半句", "prompt": "实际发给助手的话，一两句"}。',
    ].join('\n')
    const user = `用户指着的内容：\n${String(context ?? '').slice(0, 3000)}`
    const signal = AbortSignal.timeout(LINE_TIMEOUT_MS)
    const call = await ctx.llm.prepareCall({ ...(route ?? DEFAULT_ROUTE), maxTokens: 600 }, signal, (controls, model) => {
      const efforts = model.reasoning?.efforts?.map(e => e.id) ?? []
      return efforts.includes('off') ? { ...controls, reasoningEffort: 'off' } : controls
    })
    const messages = [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'pointy-suggest' } })]
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream({ ...call.config, messages, system, purpose: 'pointy-suggest', signal })) assembler.push(chunk)
    const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
    const items = JSON.parse(json)
    return items
      .filter(i => typeof i?.label === 'string' && typeof i?.prompt === 'string')
      .slice(0, 2)
      // 不按字数硬切（会切成"stream uploads 的"这种半句），太长的由卡片按宽度显示省略号
      .map(i => ({ label: i.label.trim().slice(0, 60), prompt: i.prompt.slice(0, 600) }))
  }

  /** New tasks go to the default workspace (unless the card picked another) so they show up in the DSH sidebar. */
  function defaultWorkspace() {
    const registry = ctx.get('workspaceRegistry')
    const all = registry?.list() ?? []
    return all.find(w => /default-workspace$/i.test(w.path)) ??
      all.find(w => activeRoot !== undefined && w.sessionIds.includes(activeRoot)) ??
      all[0]
  }

  /**
   * 0.2.0–0.2.2 registered the pet's notebook folder as a workspace named
   * "桌宠小本本". The notebook is gone; drop that one registration. Removing a
   * workspace keeps its folder and sessions (they become ungrouped).
   */
  async function removeNotebookWorkspace() {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return
    for (const w of registry.list()) {
      if (w.title === '桌宠小本本' && /[\\/]dsh-pet-notebook$/i.test(w.path)) {
        try {
          await registry.delete(w.id)
          logger.info(`pointy: removed the old notebook workspace registration ${w.path}`)
        } catch (error) {
          logger.warn(`pointy: could not remove the notebook workspace: ${error.message}`)
        }
      }
    }
  }

  async function ask({ askId, target, text, model, image, images, workspaceId }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('没有内容')
    const controller = ctx.get('sessionController')
    let sessionId = target
    if (target === 'new') {
      if (!controller) throw new Error('这个 DSH 版本没有会话服务，没法新建任务')
      const chosen = ctx.get('workspaceRegistry')?.list().find(w => w.id === workspaceId)
      const workspace = chosen ?? defaultWorkspace()
      sessionId = (await controller.create(workspace ? { workspaceId: workspace.id } : {})).sessionId
    }
    let agent = ctx.agents.get(sessionId)
    if (agent === undefined && controller?.agents?.resolveAgent) {
      // Not loaded yet (an older session): activate it the way the DSH UI does.
      const resolved = await controller.agents.resolveAgent(sessionId)
      if ('agent' in resolved) agent = resolved.agent
    }
    if (agent === undefined) throw new Error('这个会话打不开，先在 DSH 里点开它')
    // Switching works like DSH's own picker: the session uses it from the next request on.
    if (model?.provider && model?.model) {
      if (!controller?.selectModel) throw new Error('这个 DSH 版本不能从外面换模型')
      await controller.selectModel({ sessionId, provider: String(model.provider), model: String(model.model), ...(model.reasoningEffort ? { reasoningEffort: String(model.reasoningEffort) } : {}) })
    }
    const content = await promptContent(text, Array.isArray(images) ? images : [image])
    asks.set(sessionId, askId)
    if (asks.size > 20) asks.delete(asks.keys().next().value)
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    return sessionId
  }

  /**
   * Text plus optional screenshots of what the user pointed at (in QQ-like apps:
   * the strip around the mouse and the whole area). The images go through DSH's
   * own attachment admission, the same path as images pasted into the DSH
   * composer, so they are stored with the session like those.
   */
  async function promptContent(text, images) {
    const parts = images
      .map(image => typeof image === 'string' ? image.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/) : null)
      .filter(Boolean)
      .slice(0, 4)
      .map(match => ({ type: 'image', mediaType: match[1], data: match[2] }))
    if (!parts.length) return [{ type: 'text', text }]
    const attachments = ctx.get('attachments')
    if (!attachments?.admitPromptContent) throw new Error('这个 DSH 版本收不了图片')
    return attachments.admitPromptContent([{ type: 'text', text }, ...parts])
  }

  function deliverFiles(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: '没收到文件' }
    const files = paths
      .filter(p => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p))
      .slice(0, MAX_DROPPED_FILES)
    if (files.length === 0) return { ok: false, error: '这些文件找不到' }
    const agent = activeRoot === undefined ? undefined : ctx.agents.get(activeRoot)
    if (agent === undefined) return { ok: false, error: '还没有正在用的会话，先在 DSH 里说句话吧' }
    const text = ['用户把这些文件拖给了 Pointy，请先查看：', ...files.map(f => `- ${f}`)].join('\n')
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return { ok: true, sessionId: activeRoot, count: files.length }
  }

  async function generateLine(req) {
    const now = Date.now()
    if (lineBusy || now - lastLineAt < LINE_MIN_INTERVAL_MS) throw new Error('rate limited')
    lineBusy = true
    lastLineAt = now
    try {
      const hint = STATE_HINT[req.state] ?? STATE_HINT.idle
      const detail = typeof req.detail === 'string' && req.detail ? `（${req.detail.slice(0, 80)}）` : ''
      const signal = AbortSignal.timeout(LINE_TIMEOUT_MS)
      const call = await ctx.llm.prepareCall({ ...(route ?? DEFAULT_ROUTE), maxTokens: 200 }, signal, (controls, model) => {
        const efforts = model.reasoning?.efforts?.map(e => e.id) ?? []
        return efforts.includes('off') ? { ...controls, reasoningEffort: 'off' } : controls
      })
      const messages = [createUserMessage({
        content: [{ type: 'text', text: `现在的情况：${hint}${detail}。说一句话。` }],
        source: { kind: 'pointy-line' },
      })]
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream({ ...call.config, messages, system: PERSONA, purpose: 'pointy-line', signal })) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
      const text = assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('').trim()
      return text.replace(/^["“「]|["”」]$/g, '').split('\n')[0].slice(0, 30)
    } finally {
      lineBusy = false
    }
  }

  ctx.effect(() => {
    link.start()
    return () => link.stop()
  }, 'pointy: pet link')

  // "在 DSH 中打开"：Pointy发来会话 id，交给 DSH 页面里的插件界面那一半去 openSession。
  // 页面那边长轮询 next-focus；没人在等时先存着，几秒内来问的还能拿到。
  const focusWaiters = new Set()
  let pendingFocus // { sessionId, at }
  function requestFocus(sessionId) {
    if (focusWaiters.size) {
      for (const resolve of focusWaiters) resolve(sessionId)
      focusWaiters.clear()
    } else {
      pendingFocus = { sessionId, at: Date.now() }
    }
  }
  function nextFocus() {
    if (pendingFocus && Date.now() - pendingFocus.at < FOCUS_PENDING_MS) {
      const { sessionId } = pendingFocus
      pendingFocus = undefined
      return Promise.resolve(sessionId)
    }
    return new Promise((resolve) => {
      const done = (value) => { clearTimeout(timer); focusWaiters.delete(done); resolve(value) }
      const timer = setTimeout(() => done(null), FOCUS_POLL_MS)
      focusWaiters.add(done)
    })
  }
  ctx.inject(['connection'], (connectionCtx) => {
    const dispose = connectionCtx.connection.rpc.handle(RPC_CHANNEL, async (endpoint, params) => {
      if (endpoint === 'next-focus') {
        noteOrigin(params?.origin)
        return { ok: true, value: await nextFocus() }
      }
      return { ok: false, error: { code: 'unknown-endpoint', message: `unknown endpoint ${endpoint}` } }
    })
    return async () => {
      for (const resolve of focusWaiters) resolve(null)
      await dispose()
    }
  })

  Promise.resolve(ctx.get('loader')?.await?.()).then(removeNotebookWorkspace).catch(() => {})
}

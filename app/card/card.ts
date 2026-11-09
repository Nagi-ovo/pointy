import { activityLabel } from './activity.ts'
import { renderMarkdown } from './markdown.ts'

interface CardElements {
  input: HTMLTextAreaElement
  send: HTMLButtonElement
  target: HTMLButtonElement
  model: HTMLButtonElement
}
const $ = <K extends string>(id: K) => document.getElementById(id) as K extends keyof CardElements ? CardElements[K] : HTMLElement
const quote = $('quote')
const input = $('input')
const thread = $('thread')
const activity = $('activity')
const status = $('status')
const suggestBox = $('suggest')

const MAX_WINDOW_HEIGHT = 640

let ctxItems: CtxItem[] = []
let selection = ''
let image: string | undefined
let wideImage: string | undefined
let shotKind: 'focus' | 'element' = 'element'
let element: GrabElement | undefined
let askId: string | undefined
let finished = false
let sessionId: string | undefined
// A new task has no name until the agent gives it one; a session picked
// from the list may have none either.
type SessionName = { kind: 'new' } | { kind: 'unnamed' } | { kind: 'named'; title: string }
let sessionName: SessionName = { kind: 'new' }
let asked = false
let reply: { el: HTMLElement; text: string } | undefined
let allText = ''

let agentName = 'AI'

const newId = () => crypto.randomUUID()

const KEEP_AS_IS = new Set(['code', 'code-line', 'selection'])
const STAT_LINE = /^[\d.,]+\s*[KkMmWw万亿]?$/
const SENTENCE_END = /[。！？.!?：:；;，,]$/

function cleanText(text: string) {
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !STAT_LINE.test(l))
  const out: string[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    const short = (l: string) => l.length <= 16 && !l.startsWith('[图:') && !SENTENCE_END.test(l)
    if (prev !== undefined && short(line) && prev.length + line.length < 32 && short(prev.split(' ').pop()!) && !prev.startsWith('[图:')) out[out.length - 1] = `${prev} ${line}`
    else out.push(line)
  }
  return out.join('\n')
}

const NOISE_IMAGE = /profile_images|avatar|emoji|icon|face|badge/i
const OWN_LINK = /\/status\/|\/post|\/comment|\/issues?\/|\/pull\/|\/video\/|\/p\/|\/answer\/|#/i

function usefulImages(images: GrabImage[] = []) {
  return images.filter(i => i.alt && !NOISE_IMAGE.test(i.src)).slice(0, 3)
}

function usefulLinks(links: GrabLink[] = []) {
  const seen = new Set<string>()
  const list = links.filter(l => l.text && !seen.has(l.href) && seen.add(l.href))
  return [...list.filter(l => OWN_LINK.test(l.href)), ...list.filter(l => !OWN_LINK.test(l.href))].slice(0, 2)
}

function material(): Material {
  return {
    site: element?.site,
    kind: element?.kind,
    ctx: ctxItems,
    images: usefulImages(element?.images),
    links: usefulLinks(element?.links),
    selection,
    shots: { image: !!image, wide: !!wideImage, kind: shotKind },
  }
}

const MODE_KEY = 'pointy.answerMode'
let mode: AnswerMode = (() => { try { return localStorage.getItem(MODE_KEY) === 'deep' ? 'deep' : 'quick' } catch { return 'quick' } })()
let sentMode: AnswerMode | undefined

function renderMode() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode button')) b.classList.toggle('on', b.dataset.mode === mode)
}
for (const b of document.querySelectorAll<HTMLButtonElement>('#mode button')) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode as AnswerMode
    try { localStorage.setItem(MODE_KEY, mode) } catch {}
    renderMode()
    renderModel()
    input.focus()
  })
}
renderMode()

function contentHeight(el: HTMLElement) {
  let h = 0
  for (const c of el.children as HTMLCollectionOf<HTMLElement>) {
    const m = getComputedStyle(c)
    if (m.display === 'none') continue
    h += c.offsetHeight + Math.max(0, parseFloat(m.marginTop)) + parseFloat(m.marginBottom)
  }
  return h
}

function fitHeight() {
  const card = $('card')
  const style = getComputedStyle(card)
  const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  let h = pad
  for (const el of card.children as HTMLCollectionOf<HTMLElement>) {
    const m = getComputedStyle(el)
    if (el.hidden || m.display === 'none' || m.position === 'absolute') continue
    h += (el === thread ? contentHeight(el) : el.offsetHeight) + parseFloat(m.marginTop) + parseFloat(m.marginBottom)
  }
  window.card.resize(Math.min(MAX_WINDOW_HEIGHT, Math.ceil(h) + 36))
}

function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
  const empty = !input.value.trim()
  $('send').disabled = empty
  suggestBox.hidden = !empty || asked || !suggestBox.children.length
  fitHeight()
}

function setStatus(kind: string, title: string) {
  status.className = kind
  status.title = title
  $('close').title = kind === 'running' ? `关掉，${agentName} 在后台接着做（Esc）` : '关闭（Esc）'
  setMascot(({ running: 'think', done: 'done', error: 'error' } as Record<string, string>)[kind] ?? 'idle')
}

const MASCOT: Record<string, string> = { idle: 'idle.png', blink: 'blink.png', think: 'think.png', done: 'done.png', error: 'error.png', peek: 'peek.png' }
const mascot = $('mascot')
const mascotImg = mascot.querySelector('img')!
let mood = ''
let blinkTimer: number | undefined
function mascotFrame(name: string) { mascotImg.src = `mascot/${MASCOT[name] ?? MASCOT.idle}` }
function setMascot(next: string) {
  if (next === mood) return
  if (!mood && next === 'idle') {
    mood = next
    mascotFrame('peek')
    blinkTimer = setTimeout(() => { if (mood === 'idle') { mascotFrame('idle'); scheduleBlink() } }, 420)
    return
  }
  mood = next
  mascot.className = next
  mascotFrame(next)
  clearTimeout(blinkTimer)
  if (next === 'idle' || next === 'think') scheduleBlink()
}
function scheduleBlink() {
  blinkTimer = setTimeout(() => {
    if (mood !== 'idle' && mood !== 'think') return
    mascotFrame('blink')
    blinkTimer = setTimeout(() => { mascotFrame(mood); scheduleBlink() }, 140)
  }, 2600 + Math.random() * 3200)
}

const pendingSuggest = new Map<string, (msg: { suggestions?: Suggestion[] }) => void>()

function showSuggestions(list: Suggestion[]) {
  suggestBox.replaceChildren(...list.slice(0, 2).map((s) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = s.label
    b.addEventListener('click', () => send(s.prompt, s.label))
    return b
  }))
  autoGrow()
}

async function loadSuggestions() {
  suggestBox.replaceChildren(...[0, 1].map(() => Object.assign(document.createElement('div'), { className: 'skeleton' })))
  suggestBox.hidden = false
  fitHeight()
  const reqId = newId()
  const result = await new Promise<{ suggestions?: Suggestion[] }>((resolve) => {
    const timer = setTimeout(() => resolve({ suggestions: [] }), 12_000)
    pendingSuggest.set(reqId, (msg) => { clearTimeout(timer); resolve(msg) })
    window.card.send({ type: 'suggest-request', reqId, material: material() }).then((ok) => { if (!ok) { clearTimeout(timer); resolve({ suggestions: [] }) } })
  })
  if (asked) return
  showSuggestions(result.suggestions ?? [])
  window.card.rendered('suggested')
}

const SAME_PAGE_MS = 5 * 60 * 1000
const LAST_ASK_KEY = 'pointy.lastAsk'
const pendingSessions = new Map<string, (res: SessionsReply) => void>()
const targetLabel = $('target-label')
const menu = $('target-menu')
document.body.append(menu)

let sessions: SessionInfo[] = []
const known = new Map<string, SessionInfo>()
let workspaces: Workspace[] = []
let defaultWorkspaceId: string | undefined
let workspaceId: string | null | undefined
const WORKSPACE_KEY = 'pointy.workspace'
let currentId: string | undefined
let targetValue = 'new'
let pageKey = ''

const UNNAMED = '还没起标题的会话'
const titleOf = (s: SessionInfo) => s.title || UNNAMED
const nameOf = (s: SessionInfo | undefined): SessionName => (!s ? { kind: 'new' } : s.title ? { kind: 'named', title: s.title } : { kind: 'unnamed' })
const nameLabel = (n: SessionName) => (n.kind === 'named' ? n.title : n.kind === 'unnamed' ? UNNAMED : undefined)
function rename(title: string | undefined) {
  if (!title || (sessionName.kind === 'named' && sessionName.title === title)) return false
  sessionName = { kind: 'named', title }
  return true
}
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
function ago(ms: number | undefined) {
  const d = Date.now() - Number(ms)
  if (!Number.isFinite(d) || d < 0) return ''
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}
const metaOf = (s: SessionInfo) => (s.running ? '运行中' : ago(s.updatedAt))
const workspaceTitle = () => workspaces.find(w => w.id === workspaceId)?.title ?? '默认工作区'

function defaultTarget() {
  let last: { page: string; sessionId: string; at: number } | null | undefined
  try { last = JSON.parse(localStorage.getItem(LAST_ASK_KEY) ?? 'null') } catch {}
  if (!last || !pageKey || last.page !== pageKey || Date.now() - Number(last.at) > SAME_PAGE_MS) return 'new'
  const s = known.get(last.sessionId)
  return s && !s.running ? s.sessionId : 'new'
}

function rememberAsk(id: string | undefined) {
  if (!pageKey || !id) return
  try { localStorage.setItem(LAST_ASK_KEY, JSON.stringify({ page: pageKey, sessionId: id, at: Date.now() })) } catch {}
}

function renderTarget() {
  const s = known.get(targetValue)
  const otherWs = workspaces.length > 1 && workspaceId !== defaultWorkspaceId
  targetLabel.textContent = s ? `接着：${trunc(titleOf(s), 16)}` : '新任务'
  $('target-meta').textContent = s ? `· ${metaOf(s)}` : otherWs ? `· ${trunc(workspaceTitle(), 12)}` : ''
  $('target-meta').classList.toggle('running', !!s?.running)
  $('target').classList.toggle('continuing', !!s)
  $('target').title = s ? `${titleOf(s)}\n最后活动：${ago(s.updatedAt)}${s.running ? '（运行中，消息会排在这一轮之后）' : ''}\nTab 切换当前会话 / 新任务` : `开一个新的 ${agentName} 任务（${workspaceTitle()}）\nTab 切换当前会话 / 新任务`
  $('new-task').hidden = !s || $('target').disabled
}
$('new-task').addEventListener('click', () => { setTarget('new'); input.focus() })

function setTarget(value: string) {
  targetValue = value
  renderTarget()
  syncModelBase()
}

function opt(value: string, name: string, meta: string, running?: boolean, sub?: string) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'opt'
  b.innerHTML = '<span class="tick"></span><span class="body"><span class="name"></span><span class="sub"></span></span><span class="meta"></span>'
  b.querySelector('.tick')!.textContent = value === targetValue ? '✓' : ''
  b.querySelector('.name')!.textContent = name
  b.querySelector('.sub')!.textContent = sub ?? ''
  b.querySelector('.meta')!.textContent = meta
  if (running) b.querySelector('.meta')!.classList.add('running')
  b.addEventListener('click', () => { setTarget(value); closeMenu(); input.focus() })
  return b
}

let menuList!: HTMLElement
let menuSearch!: HTMLInputElement
let searchSeq = 0
let searchTimer: number | undefined

function recentRows() {
  const picked = known.get(targetValue)
  return picked && !sessions.some(x => x.sessionId === targetValue) ? [picked, ...sessions] : sessions
}

function fillList(items: SessionInfo[], searching: boolean, note?: string) {
  const rows: HTMLElement[] = items.map(s => opt(
    s.sessionId,
    `${!searching && s.sessionId === currentId ? '当前 · ' : ''}${titleOf(s)}`,
    metaOf(s),
    s.running,
    searching ? [s.workspace, s.snippet && s.snippet.replace(/\s+/g, ' ')].filter(Boolean).join(' · ') : '',
  ))
  if (note) rows.push(Object.assign(document.createElement('div'), { className: 'menu-note', textContent: note }))
  menuList.replaceChildren(...rows)
  focusOpt(0)
  fitMenu()
}

function focusOpt(i: number, force?: boolean) {
  const all = [...menu.querySelectorAll<HTMLElement>('.opt')].filter(b => b.offsetParent !== null)
  all.forEach(b => b.classList.remove('focus'))
  if (!all.length || (!force && !menuSearch.value.trim())) return
  const b = all[(i + all.length) % all.length]
  b.classList.add('focus')
  b.scrollIntoView({ block: 'nearest' })
}

function onSearch() {
  const q = menuSearch.value.trim()
  clearTimeout(searchTimer)
  const seq = ++searchSeq
  if (!q) return fillList(recentRows(), false)
  const local = [...known.values()].filter(s => titleOf(s).toLowerCase().includes(q.toLowerCase()))
  fillList(local, true, `在 ${agentName} 里搜…`)
  searchTimer = setTimeout(async () => {
    const res = await requestSessions({ type: 'sessions-search', query: q })
    if (seq !== searchSeq || menu.hidden) return
    if (res.timeout) return fillList(local, true, local.length ? '' : '没找到')
    for (const item of res.items ?? []) known.set(item.sessionId, { ...known.get(item.sessionId), ...item })
    fillList(res.items ?? [], true, res.items?.length ? '' : '没找到')
  }, 250)
}

function openMenu() {
  if ($('target').disabled) return
  closeModelMenu()
  menuSearch = Object.assign(document.createElement('input'), { className: 'menu-search', placeholder: '搜索会话标题', spellcheck: false })
  menuSearch.addEventListener('input', onSearch)
  menuSearch.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    const all = [...menu.querySelectorAll<HTMLElement>('.opt')].filter(b => b.offsetParent !== null)
    const at = all.findIndex(b => b.classList.contains('focus'))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusOpt(at < 0 && e.key === 'ArrowUp' ? -1 : at + (e.key === 'ArrowDown' ? 1 : -1), true)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = all[at] ?? all[0]
      if (pick) pick.click()
    }
  })
  menuList = Object.assign(document.createElement('div'), { className: 'menu-list' })
  const newRow = opt('new', '新任务', '', false)
  const parts = [menuSearch, menuList, Object.assign(document.createElement('div'), { className: 'sep' }), newRow]
  if (workspaces.length > 1) {
    const ws = document.createElement('span')
    ws.className = 'ws'
    ws.title = '换新任务放进的工作区'
    ws.innerHTML = '<span></span><svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5"/></svg>'
    ws.firstChild!.textContent = `在 ${trunc(workspaceTitle(), 14)}`
    newRow.querySelector('.meta')!.replaceWith(ws)
    const wsList = Object.assign(document.createElement('div'), { className: 'ws-list', hidden: true })
    for (const w of workspaces) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'opt'
      b.innerHTML = '<span class="tick"></span><span class="name"></span>'
      b.querySelector('.tick')!.textContent = w.id === workspaceId ? '✓' : ''
      b.querySelector('.name')!.textContent = w.title
      b.addEventListener('click', () => { setWorkspace(w.id); setTarget('new'); closeMenu(); input.focus() })
      wsList.append(b)
    }
    ws.addEventListener('click', (e) => { e.stopPropagation(); wsList.hidden = !wsList.hidden; fitMenu() })
    parts.push(wsList)
  }
  parts.push(Object.assign(document.createElement('div'), { className: 'menu-hint', textContent: 'Tab 切换当前对话 / 新任务' }))
  menu.replaceChildren(...parts)
  menu.hidden = false
  fillList(recentRows(), false)
  menuSearch.focus()
}
function fitMenu() {
  const r = $('target').getBoundingClientRect()
  menu.style.left = `${r.left - 6}px`
  const h = menu.getBoundingClientRect().height
  if (r.top - h - 4 >= 0) { menu.style.top = `${r.top - h - 4}px`; return }
  menu.style.top = `${r.bottom + 4}px`
  const need = Math.ceil(menu.getBoundingClientRect().bottom + 12)
  if (need <= window.innerHeight) return
  const card = $('card')
  if (!card.style.height) {
    card.style.height = `${card.getBoundingClientRect().height}px`
    card.style.boxSizing = 'border-box'
    card.style.bottom = 'auto'
  }
  window.card.menuRoom(need)
}
function closeMenu() {
  if (menu.hidden) return
  menu.hidden = true
  searchSeq++
  clearTimeout(searchTimer)
  $('card').style.height = ''
  $('card').style.bottom = ''
  $('card').style.boxSizing = ''
  window.card.menuRoom(0)
  fitHeight()
}
$('target').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu() })
document.addEventListener('click', (e) => { if (!menu.contains(e.target as Node)) closeMenu() })

function setWorkspace(id: string) {
  workspaceId = id
  try { localStorage.setItem(WORKSPACE_KEY, id) } catch {}
}

function requestSessions(msg: { type: 'sessions-request' } | { type: 'sessions-search'; query: string }) {
  const reqId = newId()
  return new Promise<SessionsReply>((resolve) => {
    const off = setTimeout(() => { pendingSessions.delete(reqId); resolve({ items: [], timeout: true }) }, 5000)
    pendingSessions.set(reqId, (res) => { clearTimeout(off); pendingSessions.delete(reqId); resolve(res) })
    window.card.send({ ...msg, reqId }).then((ok) => { if (!ok) { clearTimeout(off); resolve({ items: [], offline: true }) } })
  })
}

async function loadSessions() {
  const res = await requestSessions({ type: 'sessions-request' })
  if (res.offline) {
    targetLabel.textContent = `${agentName} 没连上`
    $('target-meta').textContent = ''
    $('target').disabled = true
    return
  }
  currentId = res.activeRoot
  const items = res.items ?? []
  for (const item of items) known.set(item.sessionId, item)
  sessions = [...items.filter(s => s.sessionId === currentId), ...items.filter(s => s.sessionId !== currentId)].slice(0, 5)
  workspaces = res.workspaces ?? []
  defaultWorkspaceId = res.defaultWorkspaceId
  let saved: string | null | undefined
  try { saved = localStorage.getItem(WORKSPACE_KEY) } catch {}
  workspaceId = workspaces.some(w => w.id === saved) ? saved : defaultWorkspaceId
  models = res.models ?? []
  defaultModel = res.defaultModel
  routeModel = res.model ?? ''
  setTarget(defaultTarget())
}

const modelMenu = $('model-menu')
let models: ModelEntry[] = []
let defaultModel: ModelChoice | undefined
let routeModel = ''
let modelBase: ModelChoice | undefined
let modelPick: ModelChoice | undefined
let sessionModel: ModelChoice | undefined

const sameModel = (a: ModelChoice | undefined, b: ModelChoice | undefined) => !!a && !!b && a.provider === b.provider && a.model === b.model
const entryOf = (m: ModelChoice | undefined) => models.find(x => sameModel(x, m))
const effortOf = (m: ModelChoice | undefined) => m?.reasoningEffort ?? entryOf(m)?.defaultEffort
const sameChoice = (a: ModelChoice | undefined, b: ModelChoice | undefined) => sameModel(a, b) && effortOf(a) === effortOf(b)
const prettyId = (id: string) => id.split(/[-_]/).map(w => w.toLowerCase() === 'deepseek' ? 'DeepSeek' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const modelName = (m: ModelChoice | undefined) => m ? (entryOf(m)?.name ?? prettyId(m.model)) : (routeModel ? prettyId(routeModel) : 'DeepSeek')
const effortName = (m: ModelChoice | undefined) => entryOf(m)?.efforts?.find(e => e.id === effortOf(m))?.name ?? ''

function lowOf(m: ModelChoice | undefined) {
  if (!m || !entryOf(m)?.efforts?.some(e => e.id === 'low')) return m
  return { provider: m.provider, model: m.model, reasoningEffort: 'low' }
}
const autoChoice = () => (mode === 'quick' ? lowOf(modelBase) : modelBase)
const wantedModel = () => modelPick ?? autoChoice()

function renderModel() {
  const m = wantedModel()
  const effort = effortName(m)
  $('model-label').textContent = effort ? `${modelName(m)} · ${effort}` : modelName(m)
  $('model').disabled = !models.length
}

function pickModel(choice: ModelChoice) {
  modelPick = sameChoice(choice, autoChoice()) ? undefined : choice
  renderModel()
}

function syncModelBase() {
  const s = known.get(sessionId ?? targetValue)
  modelBase = s ? (loweredFrom(s) ?? s.model) : (targetValue === 'new' && sessionId === undefined ? defaultModel : modelBase)
  if (sessionId === undefined) sessionModel = s ? s.model : modelBase
  renderModel()
}

const LOWERED_KEY = 'pointy.loweredSessions'
const loweredMap = (): Record<string, ModelChoice> => { try { return JSON.parse(localStorage.getItem(LOWERED_KEY) ?? '{}') } catch { return {} } }
function loweredFrom(s: SessionInfo) {
  const was = loweredMap()[s.sessionId]
  return was && s.model && sameChoice(s.model, lowOf(was)) ? was : undefined
}
function rememberLowered(id: string, was: ModelChoice | null | undefined) {
  const all = loweredMap()
  if (was) all[id] = was
  else delete all[id]
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k]
  try { localStorage.setItem(LOWERED_KEY, JSON.stringify(all)) } catch {}
}
let loweredPending: ModelChoice | null | undefined

function openModelMenu() {
  if ($('model').disabled) return
  closeMenu()
  const current = wantedModel()
  const multi = new Set(models.map(m => m.provider)).size > 1
  const items: HTMLElement[] = []
  let group: string | undefined
  for (const m of models) {
    if (multi && m.provider !== group) {
      group = m.provider
      items.push(Object.assign(document.createElement('div'), { className: 'group', textContent: m.providerName || m.provider }))
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'opt'
    b.innerHTML = '<span class="tick"></span><span class="name"></span>'
    b.querySelector('.tick')!.textContent = sameModel(m, current) ? '✓' : ''
    b.querySelector('.name')!.textContent = m.name
    b.title = `${m.providerName || m.provider} · ${m.model}`
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      pickModel({ provider: m.provider, model: m.model })
      openModelMenu()
    })
    items.push(b)
  }
  const efforts = entryOf(current)?.efforts ?? []
  if (efforts.length) {
    const row = Object.assign(document.createElement('div'), { className: 'effort-row' })
    row.append(Object.assign(document.createElement('span'), { className: 'effort-label', textContent: '思考' }))
    const seg = Object.assign(document.createElement('div'), { className: 'effort-seg' })
    for (const ef of efforts) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = ef.name
      b.classList.toggle('on', ef.id === effortOf(current))
      b.addEventListener('click', () => {
        pickModel({ provider: current!.provider, model: current!.model, reasoningEffort: ef.id })
        closeModelMenu()
        input.focus()
      })
      seg.append(b)
    }
    row.append(seg)
    items.push(Object.assign(document.createElement('div'), { className: 'sep' }), row)
  }
  modelMenu.replaceChildren(...items)
  modelMenu.style.maxHeight = `${Math.max(120, $('model').getBoundingClientRect().top - 40)}px`
  modelMenu.hidden = false
}
function closeModelMenu() { modelMenu.hidden = true }
$('model').addEventListener('click', (e) => { e.stopPropagation(); modelMenu.hidden ? openModelMenu() : closeModelMenu() })
document.addEventListener('click', (e) => { if (!modelMenu.contains(e.target as Node)) closeModelMenu() })

const grip = $('grip')
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  grip.setPointerCapture(e.pointerId)
  window.card.gripStart()
})
let gripFrame = 0
grip.addEventListener('pointermove', (e) => {
  if (!grip.hasPointerCapture(e.pointerId) || gripFrame) return
  $('card').classList.add('manual')
  gripFrame = requestAnimationFrame(() => { gripFrame = 0; window.card.gripMove() })
})
const gripEnd = (e: PointerEvent) => { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId); window.card.gripEnd() }
grip.addEventListener('pointerup', gripEnd)
grip.addEventListener('pointercancel', gripEnd)

const toLatest = $('to-latest')
let stick = true
// scrollTop when last pinned: a smaller one means the user scrolled up, not that content grew.
let pinnedAt = 0
const gapBelow = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight
function pin() {
  if (stick) { thread.scrollTop = thread.scrollHeight; pinnedAt = thread.scrollTop }
  toLatest.hidden = gapBelow() < 32
}
const threadSize = new ResizeObserver(pin)
threadSize.observe(thread)
new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) threadSize.observe(n) }).observe(thread, { childList: true })
thread.addEventListener('scroll', () => {
  const atBottom = gapBelow() < 32
  if (atBottom) { stick = true; pinnedAt = thread.scrollTop } else if (thread.scrollTop < pinnedAt) stick = false
  toLatest.hidden = atBottom
})
toLatest.addEventListener('click', () => { stick = true; pin() })

function addTurn(youText: string) {
  thread.hidden = false
  thread.append(Object.assign(document.createElement('div'), { className: 'you', textContent: youText }))
  const el = Object.assign(document.createElement('div'), { className: 'reply' })
  thread.append(el)
  thread.append(activity)
  reply = { el, text: '' }
  stick = true
  pin()
}

async function send(instruction: string, label?: string) {
  const extra = input.value.trim()
  const followUp = sessionId !== undefined
  const question = [instruction, extra].filter(Boolean).join('\n\n')
  const first = followUp ? undefined : material()
  if (!question && (followUp || (!first!.selection && !first!.ctx.length && !image && !wideImage))) return input.focus()
  if (!followUp && $('target').disabled) return
  lastAsked = (label || extra || instruction).replace(/\s+/g, ' ').trim()
  const to = followUp ? sessionId! : targetValue
  if (!followUp) insertedInto = to !== 'new'
  if (!followUp) sessionName = nameOf(known.get(to))
  askId = newId()
  finished = false
  asked = true
  addTurn(label || extra || instruction)
  input.value = ''
  suggestBox.hidden = true
  setStatus('running', '正在做')
  const sendMode = mode
  startProgress(sendMode === 'deep')
  showActivity({ step: 'sent' })
  autoGrow()
  const wanted = wantedModel()
  const change = wanted && !sameChoice(wanted, sessionModel) ? wanted : undefined
  const manual = !!modelPick
  const model = change ? { ...change, ...(manual ? {} : { sessionOnly: true }) } : undefined
  closeModelMenu()
  const ws = to === 'new' && workspaceId ? { workspaceId } : {}
  const shots = followUp ? [] : [image, wideImage].filter((s): s is string => Boolean(s))
  const ok = await window.card.send({
    type: 'ask', askId, target: to, question, mode: sendMode, followUp,
    modeChanged: followUp && sentMode !== sendMode,
    ...(first ? { material: first } : {}),
    ...ws, ...(model ? { model } : {}), ...(shots.length ? { images: shots } : {}),
  })
  if (ok) sentMode = sendMode
  if (ok && !followUp) {
    for (const b of document.querySelectorAll<HTMLElement>('.drop')) b.hidden = true
    quote.classList.add('compact')
    window.card.asked()
  }
  if (ok && change) {
    sessionModel = change
    if (manual) { modelBase = change; modelPick = undefined }
    loweredPending = manual ? null : sameChoice(change, modelBase) ? null : modelBase
    if (sessionId !== undefined) { rememberLowered(sessionId, loweredPending); loweredPending = undefined }
    renderModel()
  }
  if (!ok) {
    setStatus('error', `${agentName} 没连上`)
    stopProgress()
    activity.className = 'error'
    activity.textContent = `${agentName} 没开或没连上。点右上角 ↗ 打开 ${agentName}，连上后再发一次。`
    input.value = extra
    autoGrow()
    return
  }
  const sent = askId
  setTimeout(() => {
    if (askId === sent && sessionId === undefined && !followUp) {
      setStatus('error', `${agentName} 没回应`)
      stopProgress()
      activity.className = 'error'
      activity.textContent = `${agentName} 没回应。插件可能还是旧版，重启一次 ${agentName} 再试。`
    }
  }, 10_000)
}

let progressFull = false
let progressStart = 0
let progressTimer: number | undefined
type Progress = { step: 'sent' | 'thinking' | 'writing' } | ToolActivity
let progressSteps: ToolActivity[] = []
let progressNow: Progress | undefined

function startProgress(full: boolean) {
  progressFull = full
  progressStart = Date.now()
  progressSteps = []
  progressNow = undefined
  clearInterval(progressTimer)
  if (full) progressTimer = setInterval(renderProgress, 1000)
}
function stopProgress() {
  clearInterval(progressTimer)
  progressTimer = undefined
}
const elapsed = () => {
  const sec = Math.floor((Date.now() - progressStart) / 1000)
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
const isTool = (p: Progress): p is ToolActivity => p.step !== 'sent' && p.step !== 'thinking' && p.step !== 'writing'
const sameProgress = (a: Progress, b: Progress) => a.step === b.step && (isTool(a) ? a.detail : undefined) === (isTool(b) ? b.detail : undefined)
function progressLabel(p: Progress) {
  switch (p.step) {
    case 'sent': return `发给 ${agentName} 了`
    case 'thinking': return '在想…'
    case 'writing': return '正在写…'
    default: return activityLabel(p)
  }
}
function showActivity(next: Progress) {
  const now = progressNow
  if (progressFull && now && isTool(now) && !sameProgress(next, now)) {
    progressSteps = [...progressSteps.filter(s => !sameProgress(s, now)), now].slice(-3)
  }
  progressNow = next
  activity.hidden = false
  activity.className = 'busy'
  renderProgress()
}
function renderProgress() {
  if (activity.className !== 'busy') return
  const steps = progressFull ? progressSteps.map(s => `<div class="step">${escapeText(progressLabel(s).replace(/…$/, ''))}</div>`).join('') : ''
  const time = progressFull ? `<span class="time">${elapsed()}</span>` : ''
  activity.innerHTML = `${steps}<div class="now"><span class="dots"></span>${escapeText(progressNow ? progressLabel(progressNow).replace(/…$/, '') : '')}${time}</div>`
  fitHeight()
}
const escapeText = (t: string) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c])

interface KeyLink { href: string; label: string }

function keyLinks(text: string) {
  const out: KeyLink[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]"'`，。]+/g)) {
    const href = m[0].replace(/[.,;:]+$/, '')
    if (seen.has(href)) continue
    seen.add(href)
    let label = href
    try {
      const u = new URL(href)
      const parts = u.pathname.split('/').filter(Boolean)
      if (/(^|\.)github\.com$/.test(u.hostname) && parts[2] === 'pull' && parts[3]) label = `PR #${parts[3]}`
      else if (/(^|\.)github\.com$/.test(u.hostname) && parts[2] === 'issues' && parts[3]) label = `issue #${parts[3]}`
      else label = `${u.hostname.replace(/^www\./, '')}${parts.length ? `/${parts.slice(-1)[0]}` : ''}`
    } catch {}
    out.push({ href, label: label.length > 28 ? `${label.slice(0, 27)}…` : label })
  }
  out.sort((a, b) => Number(/^(PR|issue) #/.test(b.label)) - Number(/^(PR|issue) #/.test(a.label)))
  for (const m of text.matchAll(/\b[a-zA-Z]:\\[^\s`"'<>|*?，。)]+/g)) {
    const href = m[0].replace(/[.,;:]+$/, '')
    if (seen.has(href)) continue
    seen.add(href)
    out.push({ href, label: href.split(/[\\/]/).filter(Boolean).pop()! })
  }
  return out.slice(0, 3)
}

function renderReply() {
  reply!.el.innerHTML = renderMarkdown(reply!.text)
}

const openInAgent = () => window.card.openAgent(sessionId ?? (targetValue !== 'new' ? targetValue : undefined))

function addAfterLinks(links: KeyLink[] = []) {
  const after = document.createElement('div')
  after.className = 'after'
  for (const l of links) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'key-link', title: l.href })
    b.textContent = l.label
    b.addEventListener('click', () => window.card.openLink(l.href))
    after.append(b)
  }
  const COPY_ICON = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>'
  const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'copy', title: '复制回答' })
  copy.innerHTML = COPY_ICON
  copy.addEventListener('click', () => {
    window.card.copy(allText)
    copy.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
    copy.title = '已复制'
    setTimeout(() => { copy.innerHTML = COPY_ICON; copy.title = '复制回答' }, 1500)
  })
  const open = Object.assign(document.createElement('button'), { type: 'button' })
  open.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6 3h7v7M13 3 4 12"/></svg>'
  open.append(`在 ${agentName} 里继续`)
  open.addEventListener('click', openInAgent)
  after.append(open, copy)
  thread.append(after)
  thread.append(activity)
}

function describeSource(g: Grab) {
  let host = ''
  try { host = g.url ? new URL(g.url).hostname.replace(/^www\./, '') : '' } catch {}
  const app = String(g.source?.app ?? '').replace(/\.exe$/i, '')
  if (host) return `来自 ${host}`
  const title = String(g.source?.title ?? '').trim()
  return title ? `来自 ${title}` : app ? `来自 ${app}` : ''
}

window.card.onInit((data) => {
  if (data.mode === 'pair') {
    for (const id of ['quote-wrap', 'composer', 'target-wrap', 'status', 'grip']) $(id).hidden = true
    $('pair-view').hidden = false
    $('pair-code').textContent = data.code
    setMascot('idle')
    fitHeight()
    return
  }
  const g = data.grab
  agentName = data.agent?.name || agentName
  pageKey = g.url ? String(g.url).split('#')[0] : (g.source?.app ? `${g.source.app}|${g.source.title ?? ''}` : '')
  $('source').textContent = describeSource(g)
  if (g.note?.text) {
    $('note').querySelector('span')!.textContent = g.note.text
    $('note').querySelector('button')!.hidden = !g.note.install
    $('note').hidden = false
  }
  element = g.element
  selection = (element?.fields?.正文 || g.text || '').trim()
  if (element && !KEEP_AS_IS.has(element.kind)) selection = cleanText(selection)
  quote.textContent = selection
  $('quote-wrap').hidden = !selection
  image =typeof g.image === 'string' && g.image.startsWith('data:image/') ? g.image : undefined
  wideImage = typeof g.wideImage === 'string' && g.wideImage.startsWith('data:image/') ? g.wideImage : undefined
  shotKind = g.shotKind === 'focus' ? 'focus' : 'element'
  const firstEl = $('shot').querySelector<HTMLImageElement>('img:not(.wide)')!
  firstEl.hidden = !image
  if (image) firstEl.src = image
  const wideEl = $('shot').querySelector<HTMLImageElement>('img.wide')
  if (wideEl) { wideEl.hidden = !wideImage; if (wideImage) wideEl.src = wideImage }
  $('shot').hidden = !image && !wideImage
  ctxItems = []
  if (g.source?.app && !element) ctxItems.push({ label: '来源', text: `${g.source.app}${g.source.title ? ` · ${g.source.title}` : ''}` })
  else if (element && !g.url && g.source?.title) ctxItems.push({ label: '窗口', text: g.source.title })
  if (g.url) ctxItems.push({ label: '网址', text: g.url })
  if (element) {
    if (g.pageTitle) ctxItems.push({ label: '页面', text: g.pageTitle })
    for (const [k, v] of Object.entries({ ...element.page, ...element.fields })) {
      if (v && k !== '正文') ctxItems.push({ label: k, text: String(v) })
    }
  }
  if (g.before) ctxItems.push({ label: '前文', text: g.before })
  if (g.after) ctxItems.push({ label: '后文', text: g.after })
  setStatus('', '空闲')
  autoGrow()
  loadSessions().then(() => window.card.rendered('opened'))
  if (selection) loadSuggestions()
  input.focus()
})

function showTitle() {
  const t = nameLabel(sessionName) ?? (lastAsked || '新任务')
  $('title').textContent = t
  $('title').title = t
  $('title').hidden = !t
}

window.card.onAgent((msg) => {
  if (msg.type === 'sessions') return pendingSessions.get(msg.reqId)?.(msg)
  if (msg.type === 'suggestions') return pendingSuggest.get(msg.reqId)?.(msg)
  if (msg.type === 'title') {
    if (msg.sessionId === sessionId && rename(msg.title)) showTitle()
    return
  }
  if (msg.askId !== askId) return
  switch (msg.type) {
    case 'ask-accepted':
      sessionId = msg.sessionId
      rename(msg.title)
      $('target').disabled = true
      $('card').classList.add('asked')
      showTitle()
      rememberAsk(sessionId)
      if (loweredPending !== undefined) { rememberLowered(sessionId, loweredPending); loweredPending = undefined }
      fitHeight()
      $('new-task').hidden = true
      input.placeholder = '接着问…'
      break
    case 'ask-step':
      if (!finished) showActivity({ step: 'thinking' })
      break
    case 'ask-delta':
      reply!.text += msg.text
      allText += msg.text
      renderReply()
      if (!finished && progressNow?.step !== 'writing') showActivity({ step: 'writing' })
      fitHeight()
      break
    case 'ask-activity':
      if (!finished) showActivity(msg.activity ?? { step: 'other' })
      break
    case 'ask-done':
      finished = true
      if (rename(msg.title)) showTitle()
      setStatus(msg.reason === 'completed' ? 'done' : 'error', msg.reason === 'completed' ? '完成' : `结束（${msg.reason}）`)
      stopProgress()
      activity.className = ''
      activity.hidden = msg.reason === 'completed'
      if (msg.reason !== 'completed') activity.textContent = `结束（${msg.reason}）`
      if (reply?.text) addAfterLinks(progressFull ? keyLinks(reply.text) : [])
      if (progressFull && reply?.el && reply.text.length > 400) {
        stick = false
        thread.scrollTop = Math.max(0, reply.el.offsetTop - thread.offsetTop - 8)
      }
      allText += '\n\n'
      fitHeight()
      window.card.rendered('answered')
      break
    case 'ask-error':
      setStatus('error', '出错了')
      stopProgress()
      activity.hidden = false
      activity.className = 'error'
      activity.textContent = `出错了：${msg.error}`
      fitHeight()
      break
  }
})

input.addEventListener('input', autoGrow)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (input.value.trim()) send('') }
})
$('send').addEventListener('click', () => send(''))
quote.addEventListener('click', () => { quote.classList.toggle('open'); fitHeight() })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!modelMenu.hidden) closeModelMenu()
    else if (!menu.hidden) closeMenu()
    else dismiss()
  } else if (e.key === 'Tab' && !$('target').disabled) {
    e.preventDefault()
    closeMenu()
    setTarget(targetValue === 'new' && currentId ? currentId : 'new')
  }
})
let lastAsked = ''
let insertedInto = false
function keepAsPill() {
  const named = nameLabel(sessionName)
  const title = insertedInto ? lastAsked || named : named ?? (lastAsked || undefined)
  const state = !finished ? 'run' : status.className === 'error' ? 'error' : 'done'
  $('card').classList.add('shrinking')
  window.card.keep({ sessionId, title, state, fixedTitle: insertedInto })
}
function dismiss() {
  if (sessionId !== undefined && !finished && status.className !== 'error') keepAsPill()
  else window.card.close()
}
$('close').addEventListener('click', dismiss)
window.card.onSetAside(() => {
  if (sessionId !== undefined) keepAsPill()
  else window.card.close()
})
window.card.onRestore(() => {
  const el = $('card')
  el.classList.remove('shrinking')
  el.classList.add('restoring')
  el.style.animation = 'none'
  void el.offsetWidth
  el.style.animation = 'restore 240ms cubic-bezier(.2,.8,.3,1)'
})
$('shot').querySelector('.drop')!.addEventListener('click', () => { image = undefined; wideImage = undefined; $('shot').hidden = true; fitHeight() })
for (const img of $('shot').querySelectorAll('img')) img.addEventListener('load', () => fitHeight())
$('quote-wrap').querySelector('.drop')!.addEventListener('click', () => { selection = ''; $('quote-wrap').hidden = true; fitHeight() })
$('note').querySelector('button')!.addEventListener('click', () => window.card.extensionGuide())
thread.addEventListener('load', (e) => { if ((e.target as Element).tagName === 'IMG') fitHeight() }, true)
thread.addEventListener('click', (e) => {
  const target = e.target as Element
  const img = target.closest<HTMLElement>('img[data-path]')
  if (img) { e.preventDefault(); window.card.openImage(img.dataset.path!); return }
  const a = target.closest<HTMLElement>('a[data-href]')
  if (!a) return
  e.preventDefault()
  window.card.openLink(a.dataset.href!)
})

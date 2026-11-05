import { renderMarkdown } from './markdown.js'

const $ = (id) => document.getElementById(id)
const quote = $('quote')
const input = $('input')
const thread = $('thread')
const activity = $('activity')
const status = $('status')
const suggestBox = $('suggest')

const MAX_WINDOW_HEIGHT = 640

let ctxItems = [] // { label, text }：来源、网址这些周边信息，不显示，第一问时一起发
let selection = ''
let image // 指到那块的截图（data URL，只在内存里）
let wideImage // 第二张：空壳程序（QQ、网易云）里是大框整块，其他程序是整个窗口
let shotKind = 'element' // 第一张是什么：focus = 鼠标附近那块，element = 指到的控件
let element // 指认到的元素（浏览器扩展给的结构化信息）
let askId
let finished = false // 这一问已经结束；之后晚到的增量不再改状态
let sessionId // 第一次发出去之后，后续追问都发到这个会话
let sessionTitle = ''
let asked = false // 问过一次之后就不再显示建议
let reply // { el, text } 当前正在写的回答
let allText = '' // 所有回答拼起来，复制用

let agentName = 'AI' // 卡片背后的 agent 叫什么（"在 XX 里继续"这类文字用），初始化时主进程给

const newId = () => crypto.randomUUID()

// ---------- 抓取内容清理：去掉网页上的噪音，只留正文 ----------
// 代码和用户自己选的文字原样保留
const KEEP_AS_IS = new Set(['code', 'code-line', 'selection'])
const STAT_LINE = /^[\d.,]+\s*[KkMmWw万亿]?$/ // 点赞、转发、播放数这类互动数字
const SENTENCE_END = /[。！？.!?：:；;，,]$/

function cleanText(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !STAT_LINE.test(l))
  // 连着的几行都很短（作者名、@、时间这种）就并成一行
  const out = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    const short = (l) => l.length <= 16 && !l.startsWith('[图:') && !SENTENCE_END.test(l)
    if (prev !== undefined && short(line) && prev.length + line.length < 32 && short(prev.split(' ').pop()) && !prev.startsWith('[图:')) out[out.length - 1] = `${prev} ${line}`
    else out.push(line)
  }
  return out.join('\n')
}

// 头像、表情、图标不算内容
const NOISE_IMAGE = /profile_images|avatar|emoji|icon|face|badge/i
// 帖子、评论、issue 本身的链接排前面
const OWN_LINK = /\/status\/|\/post|\/comment|\/issues?\/|\/pull\/|\/video\/|\/p\/|\/answer\/|#/i

function usefulImages(images = []) {
  return images.filter(i => i.alt && !NOISE_IMAGE.test(i.src)).slice(0, 3)
}

function usefulLinks(links = []) {
  const seen = new Set()
  const list = links.filter(l => l.text && !seen.has(l.href) && seen.add(l.href))
  return [...list.filter(l => OWN_LINK.test(l.href)), ...list.filter(l => !OWN_LINK.test(l.href))].slice(0, 2)
}

/**
 * 交给 agent 的材料：指到的东西整理好（去过噪音、用户点 × 去掉的不带），怎么拼成一段话由 agent 那边决定
 * （app/agents/compose.js）。截图本身另外随第一问发，这里只说有没有
 */
function material() {
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

// ---------- 快答 / 完整 ----------
// 快答：让 agent 直接简短回答；完整：不加限制。具体怎么跟 agent 说由 agent 那边定
const MODE_KEY = 'pointy.answerMode'
let mode = (() => { try { return localStorage.getItem(MODE_KEY) === 'deep' ? 'deep' : 'quick' } catch { return 'quick' } })()
let sentMode // 这张卡片上一条发出去的消息是哪一档

function renderMode() {
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.mode === mode)
}
for (const b of document.querySelectorAll('#mode button')) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode
    try { localStorage.setItem(MODE_KEY, mode) } catch {}
    renderMode()
    input.focus()
  })
}
renderMode()

// ---------- 高度：跟着内容走，最高 640 ----------
// 对话区被压扁时 scrollHeight 不准，直接把里面每一块的高度加起来
function contentHeight(el) {
  let h = 0
  for (const c of el.children) {
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
  for (const el of card.children) {
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

function setStatus(kind, title) {
  status.className = kind
  status.title = title
  $('close').title = kind === 'running' ? `关掉，${agentName} 在后台接着做（Esc）` : '关闭（Esc）'
  setMascot({ running: 'think', done: 'done', error: 'error' }[kind] ?? 'idle')
}

// ---------- 看板娘：跟着状态换表情，待机和干活时隔几秒眨一下眼 ----------
// 图换了只改这张表；没有的表情退回 idle
const MASCOT = { idle: 'idle.png', blink: 'blink.png', think: 'think.png', done: 'done.png', error: 'error.png', peek: 'peek.png' }
const mascot = $('mascot')
const mascotImg = mascot.querySelector('img')
let mood = ''
let blinkTimer
function mascotFrame(name) { mascotImg.src = `mascot/${MASCOT[name] ?? MASCOT.idle}` }
function setMascot(next) {
  if (next === mood) return
  // 卡片刚弹出：先探个头，再整个人出来
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

// ---------- 建议 ----------
const pendingSuggest = new Map()

function showSuggestions(list) {
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
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ suggestions: [] }), 12_000)
    pendingSuggest.set(reqId, (msg) => { clearTimeout(timer); resolve(msg) })
    window.card.send({ type: 'suggest-request', reqId, material: material() }).then((ok) => { if (!ok) { clearTimeout(timer); resolve({ suggestions: [] }) } })
  })
  if (asked) return
  // 拿不到针对这块内容的建议就不显示，不拿"这是什么意思"之类的通用问题凑数
  showSuggestions(result.suggestions ?? [])
  window.card.rendered('suggested')
}

// ---------- 发送目标 ----------
// 默认：当前会话 5 分钟内用过且没在跑 → 插进去；否则新任务。按网站记住手动选择。
const RECENT_MS = 5 * 60 * 1000
const CHOICE_KEY = 'dshpet.targetBySite' // 键名是旧的，改了会丢掉用户记住的选择
const pendingSessions = new Map()
const targetLabel = $('target-label')
const menu = $('target-menu')
// 下拉挂在 body 上，不在卡片里面，这样不会被卡片的圆角裁掉，能盖到卡片下面去
document.body.append(menu)

let sessions = [] // 最近 5 个会话 { sessionId, title, updatedAt, running, workspace }
const known = new Map() // 见过的会话（最近的 + 搜到的），选中的会话从这里查
let workspaces = [] // { id, title }，新任务能放进的工作区
let defaultWorkspaceId
let workspaceId // 新任务放进哪个工作区，全局记住
const WORKSPACE_KEY = 'pointy.workspace'
let currentId // agent 里"当前"的会话
let targetValue = 'new' // 'new' 或 sessionId
let siteKey = ''

// agent 给的标题都能直接显示（它自己的临时标题在适配那边滤掉了）；没标题的是还没起好
const titleOf = (s) => s.title || '还没起标题的会话'
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
function ago(ms) {
  const d = Date.now() - Number(ms)
  if (!Number.isFinite(d) || d < 0) return ''
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}
const metaOf = (s) => (s.running ? '运行中' : ago(s.updatedAt))
const workspaceTitle = () => workspaces.find(w => w.id === workspaceId)?.title ?? '默认工作区'

function loadChoices() {
  try { return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}') } catch { return {} }
}
function saveChoice(value) {
  if (!siteKey) return
  const all = loadChoices()
  // 选的是当前会话就记"当前"，下次换了当前会话也照样插进去
  all[siteKey] = value === currentId ? 'current' : value
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(all)) } catch {}
}

function defaultTarget() {
  const saved = loadChoices()[siteKey]
  if (saved === 'new') return 'new'
  if (saved === 'current' && currentId) return currentId
  if (saved && known.has(saved)) return saved
  const current = sessions.find(s => s.sessionId === currentId)
  return current && !current.running && Date.now() - Number(current.updatedAt) < RECENT_MS ? current.sessionId : 'new'
}

function renderTarget() {
  const s = known.get(targetValue)
  // 新任务不在默认工作区时，标一下放在哪
  const otherWs = workspaces.length > 1 && workspaceId !== defaultWorkspaceId
  // 标题太长只截标题，"· 3 分钟前"始终完整
  targetLabel.textContent = s ? `接着：${trunc(titleOf(s), 16)}` : '新任务'
  $('target-meta').textContent = s ? `· ${metaOf(s)}` : otherWs ? `· ${trunc(workspaceTitle(), 12)}` : ''
  $('target-meta').classList.toggle('running', !!s?.running)
  $('target').title = s ? `${titleOf(s)}\n最后活动：${ago(s.updatedAt)}${s.running ? '（运行中，消息会排在这一轮之后）' : ''}\nTab 切换当前会话 / 新任务` : `开一个新的 ${agentName} 任务（${workspaceTitle()}）\nTab 切换当前会话 / 新任务`
  // 正要插进某个会话时，旁边给个 + 一下改成新对话；已经是新任务或者问过了就不显示
  $('new-task').hidden = !s || $('target').disabled
}
$('new-task').addEventListener('click', () => { setTarget('new', true); input.focus() })

function setTarget(value, remember) {
  targetValue = value
  renderTarget()
  syncModelBase()
  if (remember) saveChoice(value)
}

// 下拉：顶上搜索框；空着显示最近 5 个，输入后搜标题（agent 支持的话也搜聊过的内容）。新任务那行可以换工作区
function opt(value, name, meta, running, sub) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'opt'
  b.innerHTML = '<span class="tick"></span><span class="body"><span class="name"></span><span class="sub"></span></span><span class="meta"></span>'
  b.querySelector('.tick').textContent = value === targetValue ? '✓' : ''
  b.querySelector('.name').textContent = name
  b.querySelector('.sub').textContent = sub ?? ''
  b.querySelector('.meta').textContent = meta
  if (running) b.querySelector('.meta').classList.add('running')
  b.addEventListener('click', () => { setTarget(value, true); closeMenu(); input.focus() })
  return b
}

let menuList // 会话那几行
let menuSearch
let searchSeq = 0
let searchTimer

// 最近 5 个；之前从搜索里挑的会话不在里面就放最上面，好看出现在选的是哪个
function recentRows() {
  const picked = known.get(targetValue)
  return picked && !sessions.some(x => x.sessionId === targetValue) ? [picked, ...sessions] : sessions
}

function fillList(items, searching, note) {
  const rows = items.map(s => opt(
    s.sessionId,
    `${!searching && s.sessionId === currentId ? '当前 · ' : ''}${titleOf(s)}`,
    metaOf(s),
    s.running,
    // 搜索结果标上工作区；按内容搜到的再带一句命中的原文
    searching ? [s.workspace, s.snippet && s.snippet.replace(/\s+/g, ' ')].filter(Boolean).join(' · ') : '',
  ))
  if (note) rows.push(Object.assign(document.createElement('div'), { className: 'menu-note', textContent: note }))
  menuList.replaceChildren(...rows)
  focusOpt(0)
  fitMenu()
}

// 方向键在列表里挪，Enter 选；没在搜、也没按方向键时不预先高亮
function focusOpt(i, force) {
  const all = [...menu.querySelectorAll('.opt')].filter(b => b.offsetParent !== null)
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
  // 先在手上的会话里按标题过滤，agent 的结果（可能含聊天内容）回来再替换
  const local = [...known.values()].filter(s => titleOf(s).toLowerCase().includes(q.toLowerCase()))
  fillList(local, true, `在 ${agentName} 里搜…`)
  searchTimer = setTimeout(async () => {
    const res = await requestSessions({ type: 'sessions-search', query: q })
    if (seq !== searchSeq || menu.hidden) return
    // 旧版插件不认这个请求：只留标题过滤的结果
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
    const all = [...menu.querySelectorAll('.opt')].filter(b => b.offsetParent !== null)
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
    // 新任务那行右边：放进哪个工作区，点开换
    const ws = document.createElement('span')
    ws.className = 'ws'
    ws.title = '换新任务放进的工作区'
    ws.innerHTML = '<span></span><svg viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5"/></svg>'
    ws.firstChild.textContent = `在 ${trunc(workspaceTitle(), 14)}`
    newRow.querySelector('.meta').replaceWith(ws)
    const wsList = Object.assign(document.createElement('div'), { className: 'ws-list', hidden: true })
    for (const w of workspaces) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'opt'
      b.innerHTML = '<span class="tick"></span><span class="name"></span>'
      b.querySelector('.tick').textContent = w.id === workspaceId ? '✓' : ''
      b.querySelector('.name').textContent = w.title
      b.addEventListener('click', () => { setWorkspace(w.id); setTarget('new', true); closeMenu(); input.focus() })
      wsList.append(b)
    }
    ws.addEventListener('click', (e) => { e.stopPropagation(); wsList.hidden = !wsList.hidden; fitMenu() })
    parts.push(wsList)
  }
  parts.push(Object.assign(document.createElement('div'), { className: 'menu-hint', textContent: siteKey ? `在 ${siteKey} 上会记住你的选择 · Tab 快速切换` : 'Tab 快速切换' }))
  menu.replaceChildren(...parts)
  menu.hidden = false
  fillList(recentRows(), false)
  menuSearch.focus()
}
// 窗口不够高就临时往下撑高，卡片本身高度不变，菜单浮在外面；关菜单时窗口还原
function fitMenu() {
  const r = $('target').getBoundingClientRect()
  menu.style.left = `${r.left - 6}px`
  // 「发到哪」在输入框下面：上面放得下就往上开，放不下再往下开、临时撑高窗口
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
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu() })

function setWorkspace(id) {
  workspaceId = id
  try { localStorage.setItem(WORKSPACE_KEY, id) } catch {}
}

function requestSessions(msg) {
  const reqId = newId()
  return new Promise((resolve) => {
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
  // 当前会话排第一，其余按最近更新，一共 5 个
  const items = res.items ?? []
  for (const item of items) known.set(item.sessionId, item)
  sessions = [...items.filter(s => s.sessionId === currentId), ...items.filter(s => s.sessionId !== currentId)].slice(0, 5)
  workspaces = res.workspaces ?? []
  defaultWorkspaceId = res.defaultWorkspaceId
  let saved
  try { saved = localStorage.getItem(WORKSPACE_KEY) } catch {}
  workspaceId = workspaces.some(w => w.id === saved) ? saved : defaultWorkspaceId
  models = res.models ?? []
  defaultModel = res.defaultModel
  routeModel = res.model ?? ''
  setTarget(defaultTarget(), false)
}

// ---------- 模型 ----------
// 默认显示目标会话正在用的模型（新任务是 agent 的默认模型）；换了的话发出去前让 agent 给这个会话切过去
const modelMenu = $('model-menu')
let models = [] // { provider, providerName, model, name, efforts?: [{ id, name }], defaultEffort? }
let defaultModel // 新任务用的 { provider, model, reasoningEffort? }
let routeModel = '' // 拿不到目录时显示的模型 id
let modelBase // 目标会话现在用的模型（含思考强度）
let modelPick // 用户在卡片里选的模型（含思考强度）

const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model
const entryOf = (m) => models.find(x => sameModel(x, m))
// 没选过思考强度就是这个模型的默认档
const effortOf = (m) => m?.reasoningEffort ?? entryOf(m)?.defaultEffort
const sameChoice = (a, b) => sameModel(a, b) && effortOf(a) === effortOf(b)
// deepseek-flash → DeepSeek Flash
const prettyId = (id) => id.split(/[-_]/).map(w => w.toLowerCase() === 'deepseek' ? 'DeepSeek' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const modelName = (m) => m ? (entryOf(m)?.name ?? prettyId(m.model)) : (routeModel ? prettyId(routeModel) : 'DeepSeek')
const effortName = (m) => entryOf(m)?.efforts?.find(e => e.id === effortOf(m))?.name ?? ''

function renderModel() {
  const m = modelPick ?? modelBase
  const effort = effortName(m)
  $('model-label').textContent = effort ? `${modelName(m)} · ${effort}` : modelName(m)
  $('model').disabled = !models.length
}

/** 选了模型或思考强度：和目标会话现在的一样就不算换 */
function pickModel(choice) {
  modelPick = sameChoice(choice, modelBase) ? undefined : choice
  renderModel()
}

/** 目标换了：显示那个会话自己的模型（用户手动选过就保持手动选的） */
function syncModelBase() {
  const s = known.get(sessionId ?? targetValue)
  modelBase = s ? s.model : (targetValue === 'new' && sessionId === undefined ? defaultModel : modelBase)
  renderModel()
}

function openModelMenu() {
  if ($('model').disabled) return
  closeMenu()
  const current = modelPick ?? modelBase
  const multi = new Set(models.map(m => m.provider)).size > 1
  const items = []
  let group
  for (const m of models) {
    if (multi && m.provider !== group) {
      group = m.provider
      items.push(Object.assign(document.createElement('div'), { className: 'group', textContent: m.providerName || m.provider }))
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'opt'
    b.innerHTML = '<span class="tick"></span><span class="name"></span>'
    b.querySelector('.tick').textContent = sameModel(m, current) ? '✓' : ''
    b.querySelector('.name').textContent = m.name
    b.title = `${m.providerName || m.provider} · ${m.model}`
    // 换模型时菜单不关，下面的思考强度跟着换成这个模型的档位
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      pickModel({ provider: m.provider, model: m.model })
      openModelMenu()
    })
    items.push(b)
  }
  // 思考强度：当前模型有档位才显示，名字用 agent 自己给的
  const efforts = entryOf(current)?.efforts ?? []
  if (efforts.length) {
    // 一行分段按钮，和快答/完整同一个样子，不占菜单高度
    const row = Object.assign(document.createElement('div'), { className: 'effort-row' })
    row.append(Object.assign(document.createElement('span'), { className: 'effort-label', textContent: '思考' }))
    const seg = Object.assign(document.createElement('div'), { className: 'effort-seg' })
    for (const ef of efforts) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = ef.name
      b.classList.toggle('on', ef.id === effortOf(current))
      b.addEventListener('click', () => {
        pickModel({ provider: current.provider, model: current.model, reasoningEffort: ef.id })
        closeModelMenu()
        input.focus()
      })
      seg.append(b)
    }
    row.append(seg)
    items.push(Object.assign(document.createElement('div'), { className: 'sep' }), row)
  }
  modelMenu.replaceChildren(...items)
  // 菜单往上开，别超出卡片顶
  modelMenu.style.maxHeight = `${Math.max(120, $('model').getBoundingClientRect().top - 40)}px`
  modelMenu.hidden = false
}
function closeModelMenu() { modelMenu.hidden = true }
$('model').addEventListener('click', (e) => { e.stopPropagation(); modelMenu.hidden ? openModelMenu() : closeModelMenu() })
document.addEventListener('click', (e) => { if (!modelMenu.contains(e.target)) closeModelMenu() })

// ---------- 右下角拖拽调大小 ----------
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
  // 拖过之后窗口大小由用户定，里面的东西跟着撑满（主进程也不再按内容改高度）
  $('card').classList.add('manual')
  gripFrame = requestAnimationFrame(() => { gripFrame = 0; window.card.gripMove() })
})
const gripEnd = (e) => { if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId); window.card.gripEnd() }
grip.addEventListener('pointerup', gripEnd)
grip.addEventListener('pointercancel', gripEnd)

// ---------- 发问 ----------
function addTurn(youText) {
  thread.hidden = false
  thread.append(Object.assign(document.createElement('div'), { className: 'you', textContent: youText }))
  const el = Object.assign(document.createElement('div'), { className: 'reply' })
  thread.append(el)
  reply = { el, text: '' }
  // 刚问的这句要看得见
  thread.scrollTop = thread.scrollHeight
}

async function send(instruction, label) {
  const extra = input.value.trim()
  const followUp = sessionId !== undefined
  const question = [instruction, extra].filter(Boolean).join('\n\n')
  const first = followUp ? undefined : material()
  // 第一问：有问题或有材料才发；追问：得打了字
  if (!question && (followUp || (!first.selection && !first.ctx.length && !image && !wideImage))) return input.focus()
  if (!followUp && $('target').disabled) return // agent 没连上
  lastAsked = (label || extra || instruction).replace(/\s+/g, ' ').trim()
  const to = followUp ? sessionId : targetValue
  if (!followUp) insertedInto = to !== 'new'
  if (!followUp) {
    const s = known.get(to)
    sessionTitle = s ? titleOf(s) : '新任务'
  }
  askId = newId()
  finished = false
  asked = true
  addTurn(label || extra || instruction)
  input.value = ''
  suggestBox.hidden = true
  setStatus('running', '正在做')
  activity.hidden = false
  activity.className = ''
  activity.textContent = `发给 ${agentName} 了…`
  autoGrow()
  // 只有换了模型才让 agent 切；切过之后这就是这个会话的模型
  const model = modelPick && !sameChoice(modelPick, modelBase) ? modelPick : undefined
  closeModelMenu()
  // 截图只跟第一问走
  const sendMode = mode
  const ws = to === 'new' && workspaceId ? { workspaceId } : {}
  const shots = followUp ? [] : [image, wideImage].filter(Boolean)
  const ok = await window.card.send({
    type: 'ask', askId, target: to, question, mode: sendMode, followUp,
    // 追问时档位和上一条不一样，agent 那边会补一句对应的要求
    modeChanged: followUp && sentMode !== sendMode,
    ...(first ? { material: first } : {}),
    ...ws, ...(model ? { model } : {}), ...(shots.length ? { images: shots } : {}),
  })
  if (ok) sentMode = sendMode
  // 发出去之后引用和截图就定了，× 收起来
  if (ok && !followUp) {
    for (const b of document.querySelectorAll('.drop')) b.hidden = true
    // 问出去了，指认的高亮框就没用了，让Pointy撤掉
    window.card.asked()
  }
  if (ok && model) { modelBase = model; modelPick = undefined; renderModel() }
  if (!ok) {
    // agent 可以没开：提示一下，右上角 ↗ 能把它叫起来
    setStatus('error', `${agentName} 没连上`)
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
      activity.className = 'error'
      activity.textContent = `${agentName} 没回应。插件可能还是旧版，重启一次 ${agentName} 再试。`
    }
  }, 10_000)
}

// 只有停在底部时才跟着新字往下滚；用户往上翻了就不拽回来，翻回底部再继续跟
function renderReply() {
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 32
  reply.el.innerHTML = renderMarkdown(reply.text)
  if (atBottom) thread.scrollTop = thread.scrollHeight
}

// 问过就开那个会话；没问过就开选中的目标会话；目标是"新任务"时只把 agent 提到前台
const openInAgent = () => window.card.openAgent(sessionId ?? (targetValue !== 'new' ? targetValue : undefined))

function addAfterLinks() {
  const after = document.createElement('div')
  after.className = 'after'
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
}

/** 卡片顶上那一行：从哪指过来的。网页写域名，普通程序写窗口标题或程序名 */
function describeSource(g) {
  let host = ''
  try { host = g.url ? new URL(g.url).hostname.replace(/^www\./, '') : '' } catch {}
  const app = String(g.source?.app ?? '').replace(/\.exe$/i, '')
  if (host) return `来自 ${host}`
  const title = String(g.source?.title ?? '').trim()
  return title ? `来自 ${title}` : app ? `来自 ${app}` : ''
}

// ---------- 初始化 ----------
window.card.onInit((data) => {
  if (data.mode === 'pair') {
    for (const id of ['quote-wrap', 'composer', 'target-wrap', 'status', 'open-agent', 'grip']) $(id).hidden = true
    $('pair-view').hidden = false
    $('pair-code').textContent = data.code
    setMascot('idle')
    fitHeight()
    return
  }
  const g = data.grab
  agentName = data.agent?.name || agentName
  $('open-agent').title = `在 ${agentName} 中打开`
  // "按网站记住"的网站：浏览器里是域名，普通程序是程序名
  try { siteKey = g.url ? new URL(g.url).hostname : (g.source?.app ?? '') } catch { siteKey = g.source?.app ?? '' }
  $('source').textContent = describeSource(g)
  element = g.element
  selection = (element?.fields?.正文 || g.text || '').trim()
  if (element && !KEEP_AS_IS.has(element.kind)) selection = cleanText(selection)
  quote.textContent = selection
  $('quote-wrap').hidden = !selection
  image =typeof g.image === 'string' && g.image.startsWith('data:image/') ? g.image : undefined
  wideImage = typeof g.wideImage === 'string' && g.wideImage.startsWith('data:image/') ? g.wideImage : undefined
  shotKind = g.shotKind === 'focus' ? 'focus' : 'element'
  const firstEl = $('shot').querySelector('img:not(.wide)')
  firstEl.hidden = !image
  if (image) firstEl.src = image
  const wideEl = $('shot').querySelector('img.wide')
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
  // 建议只看文字；只有截图、没有文字时想不出针对性的，就不出建议
  if (selection) loadSuggestions()
  input.focus()
})

/** 问过之后卡片顶上显示对话标题，来源跟在后面变淡 */
function showTitle() {
  // 新任务刚发出去还没起标题，先用问题原话
  const t = sessionTitle && sessionTitle !== '新任务' ? sessionTitle : lastAsked || sessionTitle
  $('title').textContent = t
  $('title').title = t
  $('title').hidden = !t
}

window.card.onAgent((msg) => {
  if (msg.type === 'sessions') return pendingSessions.get(msg.reqId)?.(msg)
  if (msg.type === 'suggestions') return pendingSuggest.get(msg.reqId)?.(msg)
  // agent 常在答完之后才起好标题：是这张卡片的会话就换掉头上的标题
  if (msg.type === 'title') {
    if (msg.sessionId === sessionId && msg.title && msg.title !== sessionTitle) {
      sessionTitle = msg.title
      showTitle()
    }
    return
  }
  if (msg.askId !== askId) return
  switch (msg.type) {
    case 'ask-accepted':
      sessionId = msg.sessionId
      if (msg.title) sessionTitle = msg.title
      // 发出去之后目标就定了：后续追问都进这个会话
      // 发出去之后目标就定了，下面那行收起来，对话标题挪到卡片顶上
      $('target').disabled = true
      $('card').classList.add('asked')
      showTitle()
      $('new-task').hidden = true
      input.placeholder = '接着问…'
      break
    case 'ask-step':
      if (!finished) activity.textContent = '在想…'
      break
    case 'ask-delta':
      reply.text += msg.text
      allText += msg.text
      renderReply()
      if (!finished) activity.textContent = '正在写…'
      fitHeight()
      break
    case 'ask-activity':
      if (!finished) activity.textContent = String(msg.text || '正在处理…')
      break
    case 'ask-done':
      finished = true
      // 新任务发出时还没有标题，agent 起好标题后换掉头上的"新任务"
      if (msg.title && msg.title !== sessionTitle) {
        sessionTitle = msg.title
        showTitle()
      }
      setStatus(msg.reason === 'completed' ? 'done' : 'error', msg.reason === 'completed' ? '完成' : `结束（${msg.reason}）`)
      activity.hidden = msg.reason === 'completed'
      if (msg.reason !== 'completed') activity.textContent = `结束（${msg.reason}）`
      if (reply?.text) addAfterLinks()
      allText += '\n\n'
      fitHeight()
      window.card.rendered('answered')
      break
    case 'ask-error':
      setStatus('error', '出错了')
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
    // Tab：当前会话 ↔ 新任务
    e.preventDefault()
    closeMenu()
    setTarget(targetValue === 'new' && currentId ? currentId : 'new', true)
  }
})
// 卡片什么时候消失：问过问题的卡片不会悄悄没了，被挤走就缩成右下角的胶囊，点胶囊放回来
let lastAsked = '' // 最近一问的原话：agent 还没起标题时胶囊上显示它，免得一排"新任务"分不清
let insertedInto = false // 第一问是插进已有会话的：好几张卡片可能共用这个会话，胶囊用问题原话区分，不跟会话标题走
function keepAsPill() {
  const title = insertedInto ? lastAsked || sessionTitle : sessionTitle && sessionTitle !== '新任务' ? sessionTitle : lastAsked || '新任务'
  const state = !finished ? 'run' : status.className === 'error' ? 'error' : 'done'
  $('card').classList.add('shrinking')
  window.card.keep({ sessionId, title, state, fixedTitle: insertedInto })
}
// × / Esc：还在答就缩成胶囊；没问过或答完了（你看过了）就真的关掉
function dismiss() {
  if (sessionId !== undefined && !finished && status.className !== 'error') keepAsPill()
  else window.card.close()
}
$('close').addEventListener('click', dismiss)
// 新指认挤走这张：问过问题的不管答没答完都缩成胶囊，没问过的关掉
window.card.onSetAside(() => {
  if (sessionId !== undefined) keepAsPill()
  else window.card.close()
})
// 从胶囊放回来：再放大一次
window.card.onRestore(() => {
  const el = $('card')
  el.classList.remove('shrinking')
  el.classList.add('restoring')
  el.style.animation = 'none'
  void el.offsetWidth
  el.style.animation = 'restore 240ms cubic-bezier(.2,.8,.3,1)'
})
$('shot').querySelector('.drop').addEventListener('click', () => { image = undefined; wideImage = undefined; $('shot').hidden = true; fitHeight() })
// 截图是异步解码的，加载完卡片才知道真高度，再量一次
for (const img of $('shot').querySelectorAll('img')) img.addEventListener('load', () => fitHeight())
$('quote-wrap').querySelector('.drop').addEventListener('click', () => { selection = ''; $('quote-wrap').hidden = true; fitHeight() })
$('open-agent').addEventListener('click', openInAgent)
// 回复里的链接不在卡片里跳转，交给主进程：网址用浏览器打开，本机文件在资源管理器里定位
thread.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]')
  if (!a) return
  e.preventDefault()
  window.card.openLink(a.dataset.href)
})

import { Sprite2DRenderer } from './renderer2d.js'
import { pickLine } from './lines.js'

const $ = (id) => document.getElementById(id)
const characterEl = $('character')
const bubble = $('bubble')
const bubbleText = $('bubble-text')
const bubbleDetail = $('bubble-detail')
const bubbleActions = $('bubble-actions')
const badge = $('badge')

const renderer = new Sprite2DRenderer(characterEl)

const HOLD_MS = { done: 6000, error: 10000 }
const SLEEP_AFTER_MS = 10 * 60 * 1000
const LINE_GAP_MS = 20000
const LINE_TIMEOUT_MS = 10000
const BUBBLE_MS = 6000
const SCALE_STEP = 0.05
const SCREEN_EDGE = 8
// 这些状态一进入就说一句；工具类状态在同一轮里只在类别变化时说
const SPEAK_ON = new Set(['done', 'error', 'waiting', 'running', 'editing', 'reading', 'web'])
const ACTIVE = new Set(['thinking', 'running', 'editing', 'reading', 'web'])

let connected = false
let suppressed = false // 全屏 / 勿扰：窗口已藏起来，不说话也不请求台词
let state = 'idle'
let holdUntil = 0
let holdTimer
let sleepTimer
let lastLineAt = 0
let lastSpokenState
let bubbleTimer
let errorDetail = ''
const approvals = [] // 等待中的批准，队首显示在气泡里
let reqSeq = 0
const lineWaiters = new Map()

function setState(next, { hold = 0, force = false } = {}) {
  const now = Date.now()
  if (!force && now < holdUntil && !(next === 'waiting' || next === 'error' || ACTIVE.has(next))) {
    // done/error 的表情至少留一会儿，期间来的 idle 等到时候再切
    clearTimeout(holdTimer)
    holdTimer = setTimeout(() => setState(next, { force: true }), holdUntil - now)
    return
  }
  clearTimeout(holdTimer)
  holdUntil = hold ? now + hold : 0
  const changed = next !== state
  state = next
  if (approvals.length === 0) renderer.setState(next)
  if (changed) window.pet.rendered(next)
  clearTimeout(sleepTimer)
  if (next === 'idle') sleepTimer = setTimeout(() => setState('sleep'), SLEEP_AFTER_MS)
  return changed
}

function showBubble(text, { kind = '', detail = '', sticky = false } = {}) {
  clearTimeout(bubbleTimer)
  bubble.hidden = false
  bubble.className = kind
  bubbleText.textContent = text
  bubbleDetail.hidden = true
  bubbleDetail.textContent = detail
  bubbleActions.hidden = kind !== 'approval'
  if (kind === 'error' && detail) bubble.classList.add('clickable')
  if (kind === 'approval' && detail) bubbleDetail.hidden = false
  if (!sticky) bubbleTimer = setTimeout(hideBubble, kind === 'error' ? BUBBLE_MS * 2 : BUBBLE_MS)
}

function hideBubble() {
  if (approvals.length) return renderApproval()
  bubble.hidden = true
}

// 先问插件要一句 DSH 模型生成的台词，超时或失败就用内置的
async function say(kind, detail, { urgent = false } = {}) {
  const now = Date.now()
  if (suppressed) return
  if (!urgent && now - lastLineAt < LINE_GAP_MS) return
  lastLineAt = now
  let text
  if (connected) {
    const reqId = ++reqSeq
    text = await new Promise((resolve) => {
      lineWaiters.set(reqId, resolve)
      window.pet.send({ type: 'line-request', reqId, state: kind, detail })
      setTimeout(() => { lineWaiters.delete(reqId); resolve(undefined) }, LINE_TIMEOUT_MS)
    })
  }
  if (approvals.length) return
  text ||= pickLine(connected ? kind : 'offline')
  if (kind === 'error') showBubble(`${text}（点我看原因）`, { kind: 'error', detail: errorDetail })
  else showBubble(text)
}

function renderApproval() {
  const a = approvals[0]
  if (!a) return
  renderer.setState('waiting')
  const where = a.title ? `「${a.title}」` : '会话'
  showBubble(`${where}要执行 ${a.toolName}：${a.reason || '需要你批准'}`, { kind: 'approval', detail: a.detail, sticky: true })
  badge.hidden = approvals.length < 2
  badge.textContent = String(approvals.length)
  window.pet.approvals(approvals.length)
  window.pet.rendered('approval')
}

function closeApproval(id) {
  const i = approvals.findIndex(a => a.id === id)
  if (i < 0) return
  approvals.splice(i, 1)
  window.pet.approvals(approvals.length)
  badge.hidden = approvals.length < 2
  if (approvals.length) return renderApproval()
  window.pet.front(false)
  bubble.hidden = true
  renderer.setState(state)
}

function answer(decision) {
  const a = approvals[0]
  if (!a) return
  window.pet.send({ type: 'approve', id: a.id, decision })
  closeApproval(a.id)
}

window.pet.onDsh((msg) => {
  switch (msg.type) {
    case 'link':
      connected = msg.connected
      renderer.setOffline(!connected)
      if (!connected) {
        approvals.length = 0
        window.pet.approvals(0)
        window.pet.front(false)
        setState('idle', { force: true })
        say('offline', '', { urgent: true })
      } else {
        showBubble('连上 DSH 了，开工吧~')
      }
      break
    case 'state': {
      const s = msg.state
      if (s === 'error') errorDetail = msg.detail || ''
      const changed = setState(s, { hold: HOLD_MS[s] ?? 0 })
      if (s === 'thinking') lastSpokenState = undefined
      if (changed && SPEAK_ON.has(s) && s !== lastSpokenState && s !== 'waiting') {
        lastSpokenState = s
        if (s === 'error') renderer.alarm()
        say(s, msg.tool ? `${msg.tool} ${msg.detail ?? ''}` : '', { urgent: s === 'error' || s === 'done' })
      }
      break
    }
    case 'notice':
      showBubble(msg.text, { kind: msg.kind ?? '' })
      break
    case 'kept':
      // 没有批准在等时，角标用来显示后台任务：✓ 做完待看，… 还在做
      if (approvals.length < 2) {
        badge.hidden = msg.running + msg.finished === 0
        badge.textContent = msg.finished ? `✓${msg.finished}` : `…${msg.running}`
      }
      break
    case 'suppressed':
      suppressed = msg.on
      break
    case 'status':
      if (!msg.running && ACTIVE.has(state)) setState('idle')
      break
    case 'approval':
      approvals.push(msg)
      window.pet.front(true)
      renderer.poke()
      renderApproval()
      break
    case 'approval-closed':
      closeApproval(msg.id)
      break
    case 'line': {
      const resolve = lineWaiters.get(msg.reqId)
      lineWaiters.delete(msg.reqId)
      resolve?.(msg.text)
      break
    }
    case 'files-result':
      showBubble(msg.ok ? `收到 ${msg.count} 个文件，交给 DSH 了` : msg.error, { kind: msg.ok ? '' : 'error' })
      break
    case 'layout':
      document.documentElement.style.setProperty('--scale', String(msg.scale))
      break
    case 'server-error':
      showBubble(`端口被占用了：${msg.error}`, { kind: 'error', sticky: true })
      break
  }
})

$('btn-allow').addEventListener('click', () => answer('allow'))
$('btn-reject').addEventListener('click', () => answer('reject'))

bubble.addEventListener('click', (e) => {
  if (e.target.closest('button')) return
  if (bubble.classList.contains('error') && bubbleDetail.textContent) {
    clearTimeout(bubbleTimer)
    bubbleDetail.hidden = !bubbleDetail.hidden
    if (bubbleDetail.hidden) bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  } else if (!approvals.length) {
    hideBubble()
  }
})

// 拖动窗口；没怎么动就算戳了一下
let drag
characterEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  characterEl.setPointerCapture(e.pointerId)
  drag = { x: e.screenX, y: e.screenY, moved: 0, at: Date.now() }
  window.pet.dragging(true)
})
characterEl.addEventListener('lostpointercapture', () => window.pet.dragging(false))
characterEl.addEventListener('pointermove', (e) => {
  if (!drag) return
  const dx = e.screenX - drag.x
  const dy = e.screenY - drag.y
  if (!dx && !dy) return
  drag.moved += Math.abs(dx) + Math.abs(dy)
  drag.x = e.screenX
  drag.y = e.screenY
  window.pet.moveBy(dx, dy)
})
characterEl.addEventListener('pointerup', () => {
  if (drag && drag.moved < 5 && Date.now() - drag.at < 500) {
    window.pet.clicked()
    renderer.poke()
    if (state === 'sleep') setState('idle', { force: true })
    say('poke', state, { urgent: true })
  }
  drag = undefined
})
window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.pet.menu() })
// 在人物上 Ctrl+滚轮调大小
characterEl.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  window.pet.scaleBy(e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)
}, { passive: false })

// 拖文件给她
document.addEventListener('dragover', (e) => { e.preventDefault(); characterEl.classList.add('drop-hover') })
document.addEventListener('dragleave', () => characterEl.classList.remove('drop-hover'))
document.addEventListener('drop', (e) => {
  e.preventDefault()
  characterEl.classList.remove('drop-hover')
  const paths = [...e.dataTransfer.files].map(f => window.pet.pathForFile(f)).filter(Boolean)
  if (!paths.length) return
  if (!connected) return showBubble('DSH 没连上，交不出去……', { kind: 'error' })
  renderer.poke()
  window.pet.send({ type: 'files', paths })
})

// 立绘、气泡、角标在窗口里的位置报给主进程，主进程据此决定哪里接鼠标、哪里点击穿透
let lastLayout = ''
const rectOf = (el) => {
  if (el.hidden) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
// 气泡默认在头顶正中；快出屏幕（工作区）时横移回来
let bubbleShift = 0
function keepBubbleOnScreen() {
  if (bubble.hidden) return
  const r = bubble.getBoundingClientRect()
  const left = window.screenX + r.left - bubbleShift
  const right = left + r.width
  const min = screen.availLeft + SCREEN_EDGE
  const max = screen.availLeft + screen.availWidth - SCREEN_EDGE
  const shift = Math.round(right > max ? max - right : left < min ? min - left : 0)
  if (shift === bubbleShift) return
  bubbleShift = shift
  bubble.style.setProperty('--shift', `${shift}px`)
}

setInterval(() => {
  keepBubbleOnScreen()
  const layout = { character: rectOf(characterEl), bubble: rectOf(bubble), badge: rectOf(badge) }
  const key = JSON.stringify(layout)
  if (key === lastLayout) return
  lastLayout = key
  window.pet.layout(layout)
}, 100)

setState('idle', { force: true })

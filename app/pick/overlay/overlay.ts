import { t, tm } from '../../i18n/i18n.ts'

const box = document.getElementById('box')!
const what = document.getElementById('what')!
const focus = document.getElementById('focus')!
let bx = 0
let by = 0

window.overlay.onHighlight((h) => {
  if (!h) { box.style.opacity = '0'; focus.style.opacity = '0'; what.style.display = 'none'; document.getElementById('wheel-hint')!.hidden = true; return }
  document.getElementById('wheel-hint')!.hidden = !h.focus
  if (h.focus) {
    Object.assign(focus.style, { transform: `translate(${h.focus.x}px, ${h.focus.y}px)`, width: `${h.focus.width}px`, height: `${h.focus.height}px`, opacity: '1' })
    if (!focus.classList.contains('live')) { focus.getBoundingClientRect(); focus.classList.add('live') }
  } else {
    focus.style.opacity = '0'
  }
  bx = h.x - 3
  by = h.y - 3
  Object.assign(box.style, { transform: `translate(${bx}px, ${by}px)`, width: `${h.width + 6}px`, height: `${h.height + 6}px`, opacity: '1' })
  if (!box.classList.contains('live')) { box.getBoundingClientRect(); box.classList.add('live') }
  what.textContent = h.name ? t('overlay.named', { control: tm(h.control), name: h.name }) : tm(h.control)
  Object.assign(what.style, { display: 'block', left: `${h.x}px`, top: `${Math.max(0, h.y - 26)}px` })
})


window.overlay.onNote((note) => {
  const el = document.getElementById('note-hint')!
  el.textContent = `· ${tm(note)}`
  el.hidden = false
})

window.overlay.onHold(() => {
  what.style.display = 'none'
  document.getElementById('pill')!.style.display = 'none'
  document.getElementById('wheel')!.style.display = 'none'
})

window.overlay.onShift(({ dx, dy }) => {
  box.classList.remove('live')
  bx += dx
  by += dy
  box.style.transform = `translate(${bx}px, ${by}px)`
})

export {}

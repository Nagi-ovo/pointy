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
  what.textContent = h.label
  Object.assign(what.style, { display: h.label ? 'block' : 'none', left: `${h.x}px`, top: `${Math.max(0, h.y - 26)}px` })
})


window.overlay.onNote((text) => {
  const el = document.getElementById('note-hint')!
  el.textContent = text ? `· ${text}` : ''
  el.hidden = !text
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

// 指认遮罩：主进程告诉高亮框画在哪（窗口内 CSS 像素），这里只负责画
const box = document.getElementById('box')!
const what = document.getElementById('what')!
const focus = document.getElementById('focus')!
let bx = 0
let by = 0 // 高亮框现在的位置，跟着来源窗口挪时用

window.overlay.onHighlight((h) => {
  if (!h) { box.style.opacity = '0'; focus.style.opacity = '0'; what.style.display = 'none'; document.getElementById('wheel-hint')!.hidden = true; return }
  // 空壳程序（QQ、网易云）里多一个跟着鼠标的小框，截图只截它
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
  // 第一次直接出现在原地，之后才开过渡
  if (!box.classList.contains('live')) { box.getBoundingClientRect(); box.classList.add('live') }
  // 高亮框上角只标是什么控件，怎么操作看屏幕下方的提示
  what.textContent = h.label
  Object.assign(what.style, { display: h.label ? 'block' : 'none', left: `${h.x}px`, top: `${Math.max(0, h.y - 26)}px` })
})


// 提示条后面补一句（比如浏览器里扩展没连上）
window.overlay.onNote((text) => {
  const el = document.getElementById('note-hint')!
  el.textContent = text ? `· ${text}` : ''
  el.hidden = !text
})

// 选中之后：只留高亮框，控件名和操作提示收起来
window.overlay.onHold(() => {
  what.style.display = 'none'
  document.getElementById('pill')!.style.display = 'none'
  document.getElementById('wheel')!.style.display = 'none'
})

// 选中之后来源窗口被拖动：高亮框跟着平移，不要过渡动画（否则拖起来拖泥带水）
window.overlay.onShift(({ dx, dy }) => {
  box.classList.remove('live')
  bx += dx
  by += dy
  box.style.transform = `translate(${bx}px, ${by}px)`
})

export {}

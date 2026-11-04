// 小提示窗：一个标题、几段话、几个按钮。点了哪个按钮（或关掉）告诉 main.js。
// 段落里只认 **粗体**，其余按纯文本放进去。
const $ = (id) => document.getElementById(id)

function paragraph(text) {
  const p = document.createElement('p')
  String(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      const b = document.createElement('b')
      b.textContent = part.slice(2, -2)
      p.append(b)
    } else if (part) p.append(part)
  })
  return p
}

window.notice.onInit((data) => {
  $('buttons').hidden = !data.buttons?.length
  $('title').textContent = data.title ?? ''
  $('body').replaceChildren(...(data.body ?? []).map(paragraph))
  $('buttons').replaceChildren(...(data.buttons ?? []).map((b) => {
    const el = document.createElement('button')
    el.className = b.primary ? 'b primary' : 'b'
    el.textContent = b.label
    el.addEventListener('click', () => window.notice.choose(b.id))
    return el
  }))
  // 量卡片本身（加上下各 14px 边距）：量整页的话，内容比窗口矮时量出来的是窗口高度，缩不回去
  requestAnimationFrame(() => window.notice.resize(Math.ceil($('box').getBoundingClientRect().height) + 28))
})

$('x').addEventListener('click', () => window.notice.choose(null))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.notice.choose(null) })

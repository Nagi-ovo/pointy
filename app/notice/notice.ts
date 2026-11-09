const $ = (id: string) => document.getElementById(id)!

function paragraph(text: string) {
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

function copyRow(values: string[]) {
  const row = document.createElement('div')
  row.className = 'copies'
  for (const value of values) {
    const chip: HTMLButtonElement & { timer?: number } = document.createElement('button')
    chip.type = 'button'
    chip.className = 'copy'
    chip.title = '复制'
    const code = Object.assign(document.createElement('code'), { textContent: value })
    const tag = Object.assign(document.createElement('span'), { className: 'tag', textContent: '复制' })
    chip.append(code, tag)
    chip.addEventListener('click', () => {
      window.notice.copy(value)
      tag.textContent = '已复制'
      chip.classList.add('done')
      clearTimeout(chip.timer)
      chip.timer = setTimeout(() => { tag.textContent = '复制'; chip.classList.remove('done') }, 1500)
    })
    row.append(chip)
  }
  return row
}

const item = (it: NoticeParagraph) => (typeof it === 'object' && it ? [paragraph(it.text ?? ''), copyRow(it.copy ?? [])] : [paragraph(it)])

window.notice.onInit((data) => {
  $('buttons').hidden = !data.buttons?.length
  $('title').textContent = data.title ?? ''
  $('body').replaceChildren(...(data.body ?? []).flatMap(item))
  $('buttons').replaceChildren(...(data.buttons ?? []).map((b) => {
    const el = document.createElement('button')
    el.className = b.primary ? 'b primary' : 'b'
    el.textContent = b.label
    el.addEventListener('click', () => window.notice.choose(b.id))
    return el
  }))
  requestAnimationFrame(() => window.notice.resize(Math.ceil($('box').getBoundingClientRect().height) + 28))
})

$('x').addEventListener('click', () => window.notice.choose(null))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.notice.choose(null) })

export {}

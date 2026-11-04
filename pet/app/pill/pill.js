// 主进程给整份列表，这里照着画；点胶囊去 DSH 看，× 不看了
const list = document.getElementById('list')
const rows = new Map() // id -> element

function row(p) {
  const el = document.createElement('div')
  el.dataset.id = p.id
  el.innerHTML = '<img src="../card/mascot/idle.png" alt=""><span class="dot"></span><span class="title"></span><button class="x" type="button" title="不看了">×</button>'
  el.addEventListener('click', () => window.pill.open(p.id))
  el.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); window.pill.dismiss(p.id) })
  return el
}

function fit() {
  // 等动画的那帧量不准，下一帧再报高度
  requestAnimationFrame(() => window.pill.resize(Math.ceil(list.getBoundingClientRect().height)))
}

window.pill.onList((items) => {
  const keep = new Set(items.map(p => p.id))
  for (const [id, el] of rows) {
    if (keep.has(id)) continue
    rows.delete(id)
    el.classList.add('out')
    el.addEventListener('animationend', () => { el.remove(); fit() }, { once: true })
  }
  for (const p of items) {
    let el = rows.get(p.id)
    if (!el) { el = row(p); rows.set(p.id, el); list.append(el) }
    el.className = `pill ${p.state}`
    el.querySelector('.title').textContent = p.title
    el.title = { run: '在后台做：', done: '做完了：', error: '出错了：' }[p.state] + p.title + '\n点一下到 DSH 里看'
  }
  fit()
})

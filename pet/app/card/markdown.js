// 卡片里够用的 Markdown：代码块、表格、引用块、列表、标题、粗体、行内代码、链接。
// 先转义再拼标签，不会把回复里的 HTML 当真；链接只给 http(s) 和本机绝对路径，点击由卡片交给主进程处理。

const escapeHtml = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// [文字](链接) 或 [文字](<带空格的路径>)，在转义之后的文本上匹配
const LINK = /\[([^\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|([^)\s]+))\)/g

function linkTarget(raw) {
  const href = raw.replace(/&amp;/g, '&')
  if (/^https?:\/\//i.test(href)) return href
  if (/^[a-z]:[\\/]/i.test(href)) return href
  return undefined
}

function inline(text) {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(LINK, (m, label, angled, plain) => {
      const href = linkTarget(angled ?? plain)
      return href ? `<a href="#" data-href="${href.replace(/"/g, '&quot;')}" title="${href.replace(/"/g, '&quot;')}">${label}</a>` : m
    })
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

/** 非代码部分按行处理：表格、引用块、标题、列表，其余原样（卡片用 pre-wrap 保留换行） */
function blocks(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line)
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      i--
      out.push(`<table><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`)
      continue
    }
    if (/^&gt;\s?/.test(line)) {
      const quoted = []
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^&gt;\s?/, ''))
      i--
      out.push(`<blockquote>${quoted.map(inline).join('\n')}</blockquote>`)
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) { out.push(`<b class="h">${inline(heading[1])}</b>`); continue }
    out.push(inline(line.replace(/^(\s*)[-*]\s+/, '$1• ')))
  }
  // 表格和引用块自己是块级元素，前后的换行会多出空行，去掉
  return out.join('\n').replace(/\n?(<table>|<blockquote>)/g, '$1').replace(/(<\/table>|<\/blockquote>)\n?/g, '$1')
}

export function renderMarkdown(md) {
  return md.split(/```[^\n]*\n?/).map((part, i) => {
    const html = escapeHtml(part)
    return i % 2 === 1 ? `<pre><code>${html}</code></pre>` : blocks(html)
  }).join('')
}

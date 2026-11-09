// 卡片里够用的 Markdown：代码块、表格、引用块、列表、标题、粗体、行内代码、链接、本机图片。
// 先转义再拼标签，不会把回复里的 HTML 当真；链接只给 http(s) 和本机绝对路径，点击由卡片交给主进程处理。

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, c => HTML_ESCAPE[c])

// [文字](链接) 或 [文字](<带空格的路径>)，在转义之后的文本上匹配
const LINK = /\[([^\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|([^)\s]+))\)/g

// 本机绝对路径：Windows 的 C:\…，macOS 的 /Users/…（// 开头的是省略协议的网址，不算）
const WINDOWS_PATH = /^[a-z]:[\\/]/i
const isLocalPath = (p: string) => WINDOWS_PATH.test(p) || /^\/(?!\/)/.test(p)

function linkTarget(raw: string) {
  const href = raw.replace(/&amp;/g, '&')
  if (/^https?:\/\//i.test(href)) return href
  if (isLocalPath(href)) return href
  return undefined
}

// ![说明](路径)：本机图片直接显示缩略图（点开用系统看图），网络图片只给链接
const IMG = /!\[([^\]\n]*)\]\((?:&lt;([^\n]+?)&gt;|([^)\s]+))\)/g
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

function localImage(raw: string) {
  let path = raw.replace(/&amp;/g, '&')
  if (/^file:\/\/\//i.test(path)) {
    try { path = decodeURI(path.slice(7)) } catch { return undefined }
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1)
  }
  if (!isLocalPath(path) || !IMAGE_FILE.test(path)) return undefined
  return WINDOWS_PATH.test(path) ? path.replace(/\//g, '\\') : path
}
const fileUrl = (path: string) => `file://${WINDOWS_PATH.test(path) ? '/' : ''}${encodeURI(path.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
const attr = (v: string) => v.replace(/&(?!amp;|lt;|gt;|quot;)/g, '&amp;').replace(/"/g, '&quot;')

// IMG 和 LINK 的两种写法二选一：angled 没捕获到时 plain 一定有

function inline(text: string) {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(IMG, (m, alt: string, angled: string | undefined, plain: string) => {
      const raw = angled ?? plain
      const path = localImage(raw)
      if (path) return `<img class="md-img" src="${attr(fileUrl(path))}" alt="${attr(alt)}" title="点开用系统看图" data-path="${attr(path)}">`
      const href = linkTarget(raw)
      return href ? `<a href="#" data-href="${attr(href)}" title="${attr(href)}">${alt || '图片'}</a>` : m
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(LINK, (m, label: string, angled: string | undefined, plain: string) => {
      const href = linkTarget(angled ?? plain)
      return href ? `<a href="#" data-href="${href.replace(/"/g, '&quot;')}" title="${href.replace(/"/g, '&quot;')}">${label}</a>` : m
    })
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

/** 非代码部分按行处理：表格、引用块、标题、列表，其余原样（卡片用 pre-wrap 保留换行） */
function blocks(text: string) {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      i--
      out.push(`<table><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`)
      continue
    }
    if (/^&gt;\s?/.test(line)) {
      const quoted: string[] = []
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

export function renderMarkdown(md: string) {
  return md.split(/```[^\n]*\n?/).map((part, i) => {
    const html = escapeHtml(part)
    return i % 2 === 1 ? `<pre><code>${html}</code></pre>` : blocks(html)
  }).join('')
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from '../app/card/markdown.ts'

test('http(s) links become data-href anchors with the original URL', () => {
  const html = renderMarkdown('看 [文档](https://example.com/a?b=1&c=2) 吧')
  assert.equal(html, '看 <a href="#" data-href="https://example.com/a?b=1&c=2" title="https://example.com/a?b=1&c=2">文档</a> 吧')
})

test('links to anything but http(s) or a local path stay as text', () => {
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
  assert.equal(renderMarkdown('[cdn](//cdn.example.com/x.js)'), '[cdn](//cdn.example.com/x.js)')
  assert.equal(renderMarkdown('[rel](docs/a.md)'), '[rel](docs/a.md)')
})

test('Windows and macOS absolute paths are links', () => {
  assert.match(renderMarkdown('[报告](C:\\Users\\me\\report.docx)'), /data-href="C:\\Users\\me\\report\.docx"/)
  assert.match(renderMarkdown('[笔记](/Users/me/notes.md)'), /data-href="\/Users\/me\/notes\.md"/)
})

test('angle-bracket targets may contain spaces', () => {
  assert.match(renderMarkdown('[a](<C:\\My Docs\\a.txt>)'), /<a href="#" data-href="C:\\My Docs\\a\.txt"[^>]*>a<\/a>/)
  assert.match(renderMarkdown('[b](</Users/me/My Notes/b.md>)'), /data-href="\/Users\/me\/My Notes\/b\.md"/)
})

test('local images render as thumbnails with a file URL and the original path', () => {
  assert.equal(
    renderMarkdown('![截图](/Users/me/shot.png)'),
    '<img class="md-img" src="file:///Users/me/shot.png" alt="截图" title="点开用系统看图" data-path="/Users/me/shot.png">',
  )
  const win = renderMarkdown('![图](<C:\\Users\\me\\a b#1.png>)')
  assert.match(win, /src="file:\/\/\/C:\/Users\/me\/a%20b%231\.png"/)
  assert.match(win, /data-path="C:\\Users\\me\\a b#1\.png"/)
})

test('file:/// image URLs are turned back into local paths', () => {
  assert.match(renderMarkdown('![x](file:///C:/pics/a.jpg)'), /data-path="C:\\pics\\a\.jpg"/)
  assert.match(renderMarkdown('![x](file:///Users/me/a%20b.png)'), /data-path="\/Users\/me\/a b\.png"/)
})

test('remote images and local non-image files in image syntax become links', () => {
  assert.equal(renderMarkdown('![猫](https://x.com/cat.png)'), '<a href="#" data-href="https://x.com/cat.png" title="https://x.com/cat.png">猫</a>')
  assert.equal(renderMarkdown('![](https://x.com/cat.png)'), '<a href="#" data-href="https://x.com/cat.png" title="https://x.com/cat.png">图片</a>')
  assert.match(renderMarkdown('![日志](/Users/me/a.txt)'), /<a href="#" data-href="\/Users\/me\/a\.txt"/)
})

test('pipe tables become HTML tables without surrounding blank lines', () => {
  const html = renderMarkdown('前\n| 名字 | 值 |\n|---|:--:|\n| a | **1** |\n| b | 2 |\n后')
  assert.equal(html, '前<table><tr><th>名字</th><th>值</th></tr><tr><td>a</td><td><b>1</b></td></tr><tr><td>b</td><td>2</td></tr></table>后')
})

test('HTML in the reply is escaped, not rendered', () => {
  const html = renderMarkdown('<script>alert("x")</script> & <img src=x onerror=1>')
  assert.equal(html, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=1&gt;')
})

test('attribute values cannot break out of their quotes', () => {
  const html = renderMarkdown('![a" onerror="x](/Users/me/a.png)')
  assert.doesNotMatch(html, / onerror="/)
  assert.match(html, /alt="a&quot; onerror=&quot;x"/)
})

test('code blocks are escaped and left unformatted', () => {
  assert.equal(renderMarkdown('```js\n<b>**x**</b>\n```'), '<pre><code>&lt;b&gt;**x**&lt;/b&gt;\n</code></pre>')
})

test('quotes, headings, lists, bold and inline code', () => {
  assert.equal(renderMarkdown('> 一\n> 二\n正文'), '<blockquote>一\n二</blockquote>正文')
  assert.equal(renderMarkdown('## 标题'), '<b class="h">标题</b>')
  assert.equal(renderMarkdown('- 甲\n  * 乙'), '• 甲\n  • 乙')
  assert.equal(renderMarkdown('**粗** 和 `a<b`'), '<b>粗</b> 和 <code>a&lt;b</code>')
})

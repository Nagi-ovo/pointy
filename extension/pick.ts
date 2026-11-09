(() => {
  window.__pointyPickCleanup?.()
  window.__pointyPick = true

  const MAX_TEXT = 4000

  const parentOf = (el: Element): Element | null => el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)

  const OVERLAY = /mask|overlay|wall|backdrop|curtain|scrim/i
  const isOverlay = (el: Element) => OVERLAY.test(el.id ?? '') || (typeof el.className === 'string' && OVERLAY.test(el.className))

  function topAt(root: Document | ShadowRoot, x: number, y: number, exclude?: Element) {
    return root.elementsFromPoint(x, y).find(el => el !== exclude && !isOverlay(el))
  }

  function deepElementFromPoint(x: number, y: number) {
    let el = topAt(document, x, y)
    while (el?.shadowRoot) {
      const inner = topAt(el.shadowRoot, x, y, el)
      if (!inner || inner === el) break
      el = inner
    }
    return el
  }

  function* deepWalk(root: Element | ShadowRoot): Generator<Element> {
    const stack: (Element | ShadowRoot)[] = [root]
    while (stack.length) {
      const node = stack.pop() as Element
      yield node
      if (node.shadowRoot) stack.push(node.shadowRoot)
      const kids = node.children ?? []
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
    }
  }

  const deepQuery = <E extends Element = Element>(root: Element, selector: string) => { for (const n of deepWalk(root)) if (n.matches?.(selector)) return n as E; return null }
  const deepQueryAll = <E extends Element = Element>(root: Element, selector: string, limit = 20) => { const out: E[] = []; for (const n of deepWalk(root)) { if (n.matches?.(selector)) out.push(n as E); if (out.length >= limit) break } return out }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'])
  const BLOCKY = /^(P|DIV|LI|TR|BR|H[1-6]|ARTICLE|SECTION|BLOCKQUOTE|PRE|TABLE|UL|OL)$/

  /** innerText 进不了 shadow DOM（B 站评论全在里面），自己拼 */
  function deepText(root: Node) {
    let out = ''
    const visit = (node: Node) => {
      if (out.length > MAX_TEXT) return
      if (node.nodeType === Node.TEXT_NODE) { out += node.textContent; return }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
      if (SKIP.has(node.nodeName)) return
      const el = node as HTMLImageElement
      if (node.nodeType === Node.ELEMENT_NODE) {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return
        if (el.tagName === 'IMG' && el.alt) out += `[图:${el.alt}]`
      }
      const children = el.shadowRoot ? el.shadowRoot.childNodes : node.childNodes
      for (const c of children) visit(c)
      // 有 shadowRoot 时 slot 进来的 light DOM 也要
      if (el.shadowRoot) for (const c of node.childNodes) visit(c)
      if (BLOCKY.test(node.nodeName)) out += '\n'
    }
    visit(root)
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT)
  }

  const SEMANTIC_TAG = /^(ARTICLE|LI|TR|PRE|BLOCKQUOTE|FIGURE|IMG|VIDEO|P|H[1-6]|TABLE|DETAILS|DIALOG)$/
  const SEMANTIC_CLASS = /comment|reply|card|item|post|feed|message|msg|tweet|issue|timeline|entry|thread|bubble|answer|review/i

  function isSemantic(el: Element) {
    if (SEMANTIC_TAG.test(el.tagName)) return true
    if (el.tagName.includes('-') && /comment|reply|card|item|post|thread/i.test(el.tagName)) return true
    const role = el.getAttribute?.('role')
    if (role && /article|listitem|row|comment|dialog/.test(role)) return true
    if (typeof el.className === 'string' && SEMANTIC_CLASS.test(el.className)) return true
    return [...(el.attributes ?? [])].some(a => /^data-.*(id|key)$/i.test(a.name))
  }

  function chainAt(x: number, y: number) {
    const chain: Element[] = []
    for (let el: Element | null | undefined = deepElementFromPoint(x, y); el && el !== document.documentElement; el = parentOf(el)) {
      if (el === document.body) break
      const r = el.getBoundingClientRect()
      if (r.width < 16 || r.height < 12) continue
      if (r.width >= innerWidth * 0.98 && r.height >= innerHeight * 0.9) break
      if (isSemantic(el) || el.tagName === 'IMG' || el.tagName === 'VIDEO') chain.push(el)
    }
    if (!chain.length) {
      const el = deepElementFromPoint(x, y)
      if (el && el !== document.body) chain.push(el)
    }
    return chain
  }

  interface SiteInfo { site?: string, kind?: string, fields?: Record<string, string>, page?: Record<string, string> }

  const pickText = (root: Element, selector: string) => { const n = root && deepQuery(root, selector); return n ? deepText(n).slice(0, 300) : '' }

  function biliAdapter(el: Element) {
    const info: SiteInfo = { site: 'bilibili' }
    const bv = location.pathname.match(/\/video\/(BV\w+)/)?.[1]
    if (bv) {
      info.page = { 类型: '视频页', BV号: bv, 标题: document.querySelector('h1')?.textContent.trim() ?? document.title, UP主: document.querySelector('.up-name, .up-detail-top a')?.textContent.trim() ?? '' }
      const video = document.querySelector('video')
      if (video) info.page.播放到 = `${Math.floor(video.currentTime / 60)}:${String(Math.floor(video.currentTime % 60)).padStart(2, '0')}`
    }
    for (let n: Element | null = el; n; n = parentOf(n)) {
      if (/^BILI-COMMENT-(REPLY-)?RENDERER$|^BILI-COMMENT-THREAD-RENDERER$/.test(n.tagName) || (typeof n.className === 'string' && /reply-item|sub-reply-item/.test(n.className))) {
        const userLink = deepQuery<HTMLAnchorElement>(n, 'a[href*="space.bilibili.com"]')
        info.kind = 'comment'
        info.fields = {
          用户: pickText(n, '#user-name, .user-name, .sub-user-name') || userLink?.textContent.trim() || '',
          uid: userLink?.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
          时间: pickText(n, '#pubdate, .reply-time, .sub-reply-time'),
          点赞: pickText(n, '#like #count, .reply-like span, .sub-reply-like span'),
          正文: pickText(n, '#contents, bili-rich-text, .reply-content, .sub-reply-content'),
        }
        return info
      }
      const videoLink = n.matches?.('a[href*="/video/BV"]') ? n as HTMLAnchorElement : null
      if (videoLink || (typeof n.className === 'string' && /video-card|bili-video-card|feed-card/.test(n.className))) {
        const a = videoLink ?? deepQuery<HTMLAnchorElement>(n, 'a[href*="/video/BV"]')
        if (a) {
          info.kind = 'video-card'
          info.fields = {
            BV号: a.href.match(/BV\w+/)?.[0] ?? '',
            标题: a.title || pickText(n, '[title], .bili-video-card__info--tit, h3') || a.textContent.trim(),
            UP主: pickText(n, '.bili-video-card__info--author, .up-name, .name'),
            链接: a.href,
          }
          return info
        }
      }
    }
    return info
  }

  function githubAdapter(el: Element) {
    const [, owner, repo, type, num] = location.pathname.split('/')
    const info: SiteInfo & { page: Record<string, string> } = { site: 'github', page: { 仓库: owner && repo ? `${owner}/${repo}` : '' } }
    if ((type === 'issues' || type === 'pull') && num) { info.page.类型 = type === 'pull' ? 'PR' : 'issue'; info.page.编号 = `#${num}`; info.page.标题 = document.querySelector('.js-issue-title, bdi.markdown-title, [data-testid="issue-title"]')?.textContent.trim() ?? '' }
    const line = el.closest?.('[data-line-number], td.blob-code, .react-code-line-contents, [id^="LC"]')
    if (line) {
      const no = line.getAttribute('data-line-number') ?? line.id?.replace(/^LC/, '') ?? ''
      info.kind = 'code-line'
      info.fields = { 文件: location.pathname.split('/blob/')[1]?.split('/').slice(1).join('/') ?? '', 行号: no, 链接: `${location.origin}${location.pathname}#L${no}` }
      return info
    }
    // 新版 React 页面：正文是 .react-issue-body，评论是 .react-issue-comment；旧版页面的选择器留着兜底
    const comment = el.closest?.('.react-issue-body, .react-issue-comment, .timeline-comment, .js-comment-container, .TimelineItem')
    if (comment) {
      const permalink = comment.querySelector<HTMLAnchorElement>('[data-testid="issue-body-header-link"], a[href*="#issuecomment-"], a[href*="#issue-"], a[href*="#discussion_r"], a.js-timestamp')
      const author = comment.querySelector('[data-testid="issue-body-header-author"], [data-testid="avatar-link"], a.author, .author')
      info.kind = comment.matches('.react-issue-body') ? 'issue-body' : 'comment'
      info.fields = {
        作者: author?.getAttribute('href')?.split('/').filter(Boolean).pop() ?? author?.textContent.trim() ?? '',
        时间: comment.querySelector('relative-time')?.getAttribute('datetime') ?? '',
        链接: permalink?.href ?? location.href,
        正文: deepText(comment.querySelector('.markdown-body, [data-testid="markdown-body"]') ?? comment).slice(0, 3000),
      }
    }
    return info
  }

  function genericInfo(el: Element) {
    const kind =
      el.tagName === 'IMG' ? 'image' :
      el.tagName === 'VIDEO' ? 'video' :
      el.tagName === 'PRE' || el.querySelector?.('pre, code') && el.tagName !== 'ARTICLE' ? 'code' :
      el.tagName === 'TR' ? 'table-row' :
      /^H[1-6]$/.test(el.tagName) ? 'heading' :
      el.tagName === 'A' ? 'link' :
      el.tagName === 'P' ? 'paragraph' : 'block'
    const links = deepQueryAll<HTMLAnchorElement>(el, 'a[href]', 8).map(a => ({ text: a.textContent.trim().slice(0, 60), href: a.href })).filter(l => l.href.startsWith('http'))
    if (el.tagName === 'A' && (el as HTMLAnchorElement).href) links.unshift({ text: el.textContent.trim().slice(0, 60), href: (el as HTMLAnchorElement).href })
    const images = (el.tagName === 'IMG' ? [el as HTMLImageElement] : deepQueryAll<HTMLImageElement>(el, 'img', 6)).map(i => ({ src: i.currentSrc || i.src, alt: i.alt })).filter(i => i.src && !i.src.startsWith('data:'))
    return { kind, links, images }
  }

  function describe(el: Element): PickedElement {
    const host = location.hostname
    const adapter: SiteInfo = /bilibili\.com$/.test(host) ? biliAdapter(el) : /github\.com$/.test(host) ? githubAdapter(el) : {}
    const generic = genericInfo(el)
    const r = el.getBoundingClientRect()
    return {
      kind: adapter.kind ?? generic.kind,
      site: adapter.site ?? host,
      fields: adapter.fields ?? {},
      page: adapter.page ?? {},
      text: el.tagName === 'IMG' ? ((el as HTMLImageElement).alt || '') : deepText(el),
      links: generic.links,
      images: generic.images,
      tag: el.tagName.toLowerCase(),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    }
  }

  const existing = getSelection()?.toString().trim()
  if (existing) {
    const range = getSelection()!.getRangeAt(0)
    const r = range.getBoundingClientRect()
    let block = range.commonAncestorContainer as Element
    if (block.nodeType !== 1) block = block.parentElement as Element
    chrome.runtime.sendMessage<PickResultMessage>({ type: 'pick-result', result: { ...describe(block), kind: 'selection', text: existing.slice(0, 20000), rect: { x: r.left, y: r.top, width: r.width, height: r.height } } })
    window.__pointyPick = false
    return
  }

  window.__pointyHeld?.()

  const box = document.createElement('div')
  const label = document.createElement('div')
  const EASE = '170ms cubic-bezier(0.34, 1.2, 0.64, 1)'
  Object.assign(box.style, {
    position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box',
    border: '1.5px solid rgba(77, 107, 254, 0.95)', background: 'rgba(77, 107, 254, 0.08)', borderRadius: '8px',
    boxShadow: '0 0 0 3px rgba(77, 107, 254, 0.16), 0 0 16px 4px rgba(77, 107, 254, 0.28)',
    opacity: '0', willChange: 'transform, width, height',
    transition: `transform ${EASE}, width ${EASE}, height ${EASE}, opacity 120ms ease-out`,
  })
  Object.assign(label.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none' })
  label.attachShadow({ mode: 'open' }).innerHTML = `
    <style>
      .pill { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 10px 22px; border-radius: 999px;
        background: rgba(28, 32, 51, 0.92); color: #fff; font: 16px "Segoe UI", "Microsoft YaHei UI", sans-serif; white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); pointer-events: none; }
      kbd { font: inherit; font-size: 14px; padding: 1px 9px; border: 1px solid rgba(255, 255, 255, 0.45); border-radius: 7px; }
      .pill svg { width: 15px; height: 20px; }
    </style>
    <div class="pill"><svg viewBox="-1 -1 14 22"><path d="M0 0V17L4 13L7 20L10 18.7L7 12H12Z" fill="#fff"/></svg>右键 或 <kbd>Esc</kbd> 退出</div>`
  const cursorStyle = document.createElement('style')
  const cur = (n: number) => chrome.runtime.getURL(`cursor-${n}.png`)
  cursorStyle.textContent = `* { cursor: image-set(url("${cur(32)}") 1x, url("${cur(48)}") 1.5x, url("${cur(64)}") 2x) 0 8, default !important; }`
  document.documentElement.append(box, label, cursorStyle)

  let chain: Element[] = []
  let level = 0
  let levelUp = 0
  const start = window.__pointyStart
  let lastPoint = start
    ? { x: start.x / devicePixelRatio - screenX - (outerWidth - innerWidth) / 2, y: start.y / devicePixelRatio - screenY - (outerHeight - innerHeight) }
    : { x: innerWidth / 2, y: innerHeight / 2 }

  const current = () => chain[Math.min(level, chain.length - 1)]
  let shown = false
  function render() {
    const el = current()
    if (!el) { box.style.opacity = '0'; shown = false; return }
    const r = el.getBoundingClientRect()
    if (!shown) box.style.transition = 'opacity 120ms ease-out'
    Object.assign(box.style, { transform: `translate(${r.left - 3}px, ${r.top - 3}px)`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, opacity: '1' })
    if (!shown) {
      shown = true
      box.getBoundingClientRect()
      box.style.transition = `transform ${EASE}, width ${EASE}, height ${EASE}, opacity 120ms ease-out`
    }
  }
  function retarget(x: number, y: number) {
    chain = chainAt(x, y)
    level = Math.min(levelUp, chain.length - 1)
    render()
  }
  const setLevel = (n: number) => { level = Math.max(0, Math.min(chain.length - 1, n)); levelUp = level; render() }

  function cleanup(keepBox?: boolean) {
    clearTimeout(giveUp)
    chrome.runtime.onMessage?.removeListener(onAbort)
    removeEventListener('mousemove', onMove, true)
    removeEventListener('click', onClick, true)
    removeEventListener('mousedown', onMouseDown, true)
    removeEventListener('mouseup', swallow, true)
    removeEventListener('keydown', onKey, true)
    removeEventListener('contextmenu', onContextMenu, true)
    removeEventListener('scroll', onScroll, true)
    cancelAnimationFrame(moveFrame)
    if (!keepBox) box.remove()
    label.remove()
    cursorStyle.remove()
    window.__pointyPick = false
    if (window.__pointyPickCleanup === stale) window.__pointyPickCleanup = undefined
  }
  const stale = () => cleanup()
  window.__pointyPickCleanup = stale

  function hold(el: Element) {
    const follow = () => {
      const r = el.getBoundingClientRect()
      Object.assign(box.style, { transform: `translate(${r.left - 3}px, ${r.top - 3}px)`, width: `${r.width + 6}px`, height: `${r.height + 6}px` })
    }
    let holdId: string | undefined
    const onMsg = (msg: PickControlMessage | undefined) => {
      if (msg?.type === 'pick-hold') { holdId = msg.reqId; follow(); box.style.transition = 'opacity 120ms ease-out'; box.style.opacity = '1' }
      else if (msg?.type === 'pick-release' && msg.reqId === holdId) release()
    }
    const release = () => {
      removeEventListener('scroll', follow, true)
      removeEventListener('resize', follow)
      chrome.runtime.onMessage?.removeListener(onMsg)
      clearTimeout(expire)
      box.remove()
      if (window.__pointyHeld === release) window.__pointyHeld = undefined
    }
    const expire = setTimeout(release, 5 * 60 * 1000)
    addEventListener('scroll', follow, true)
    addEventListener('resize', follow)
    chrome.runtime.onMessage?.addListener(onMsg)
    window.__pointyHeld = release
  }

  let moveFrame = 0
  const onMove = (e: MouseEvent) => {
    lastPoint = { x: e.clientX, y: e.clientY }
    if (moveFrame) return
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0
      retarget(lastPoint.x, lastPoint.y)
    })
  }
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation() }
  function onMouseDown(e: MouseEvent) {
    swallow(e)
    if (e.button !== 2) return
    const eat = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); removeEventListener('contextmenu', eat, true) }
    addEventListener('contextmenu', eat, true)
    setTimeout(() => removeEventListener('contextmenu', eat, true), 1500)
    cancel(e)
  }
  function onClick(e: MouseEvent) {
    swallow(e)
    const el = current()
    cleanup(!!el)
    if (!el) return chrome.runtime.sendMessage<PickResultMessage>({ type: 'pick-result', cancelled: true })
    const result = describe(el)
    // 高亮框先藏起来，等两帧再让扩展截图，免得截进去；截完扩展会发 pick-hold 让它回来
    box.style.transition = 'none'
    box.style.opacity = '0'
    hold(el)
    requestAnimationFrame(() => requestAnimationFrame(() => chrome.runtime.sendMessage<PickResultMessage>({ type: 'pick-result', result })))
  }
  function cancel(e: Event) {
    swallow(e)
    cleanup()
    chrome.runtime.sendMessage<PickResultMessage>({ type: 'pick-result', cancelled: true })
  }
  const onContextMenu = (e: Event) => cancel(e)
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') cancel(e)
    else if (e.key === '[') { swallow(e); setLevel(level - 1) }
    else if (e.key === ']') { swallow(e); setLevel(level + 1) }
  }
  const onScroll = () => retarget(lastPoint.x, lastPoint.y)

  const giveUp = setTimeout(() => { cleanup(); chrome.runtime.sendMessage<PickResultMessage>({ type: 'pick-result', cancelled: true }) }, 45_000)
  const onAbort = (msg: PickControlMessage | undefined) => { if (msg?.type === 'pick-abort') cleanup() }
  chrome.runtime.onMessage?.addListener(onAbort)

  addEventListener('mousemove', onMove, true)
  addEventListener('click', onClick, true)
  addEventListener('mousedown', onMouseDown, true)
  addEventListener('mouseup', swallow, true)
  addEventListener('keydown', onKey, true)
  addEventListener('contextmenu', onContextMenu, true)
  addEventListener('scroll', onScroll, true)
  retarget(lastPoint.x, lastPoint.y)
})()

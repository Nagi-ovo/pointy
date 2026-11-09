const short = (s: string, n = 36) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function describeUrl(raw: string) {
  let u
  try { u = new URL(raw) } catch { return short(raw) }
  const parts = u.pathname.split('/').filter(Boolean)
  if (/(^|\.)github\.com$/.test(u.hostname)) {
    if (parts[2] === 'issues' && parts[3]) return `issue #${parts[3]}`
    if (parts[2] === 'pull' && parts[3]) return `PR #${parts[3]}`
    if (parts[2] === 'blob') return baseName(u.pathname)
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  }
  const bv = u.pathname.match(/BV\w+/)?.[0]
  if (/bilibili\.com$/.test(u.hostname) && bv) return `B 站视频 ${bv}`
  return short(`${u.hostname.replace(/^www\./, '')}${parts.length ? `/${parts.join('/')}` : ''}`)
}

export function activityText(tool: string, detail: string) {
  const t = tool.toLowerCase()
  const d = detail.trim()
  if (/search/.test(t) && /^web|search_web|google/.test(t)) return d ? `正在搜索「${short(d, 24)}」…` : '正在搜索…'
  if (/^(web|fetch)/.test(t)) return /^https?:/.test(d) ? `正在读取 ${describeUrl(d)}…` : d ? `正在搜索「${short(d, 24)}」…` : '正在上网查…'
  if (/^(pwsh|bash|terminal|shell|run_code|job_|ptc)/.test(t)) return d ? `正在运行：${short(d)}` : '正在运行命令…'
  if (/^(read|view|open)/.test(t)) return d ? `正在看 ${baseName(d)}…` : '正在看文件…'
  if (/^(grep|glob|search|find|list|ls)/.test(t)) return d ? `正在找「${short(d, 24)}」…` : '正在找文件…'
  if (/^(write|edit|str_replace|apply_patch|multi_edit)/.test(t)) return d ? `正在改 ${baseName(d)}…` : '正在改文件…'
  if (/subagent|task|agent/.test(t)) return '正在分派子任务…'
  if (/todo|plan/.test(t)) return '正在列计划…'
  if (/skill/.test(t)) return '正在用技能…'
  return '正在处理…'
}

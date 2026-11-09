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

export function activityLabel({ step, detail = '' }: ToolActivity) {
  switch (step) {
    case 'search': return detail ? `正在搜索「${short(detail, 24)}」…` : '正在搜索…'
    case 'fetch': return `正在读取 ${describeUrl(detail)}…`
    case 'browse': return '正在上网查…'
    case 'run': return detail ? `正在运行：${short(detail)}` : '正在运行命令…'
    case 'read': return detail ? `正在看 ${baseName(detail)}…` : '正在看文件…'
    case 'find': return detail ? `正在找「${short(detail, 24)}」…` : '正在找文件…'
    case 'edit': return detail ? `正在改 ${baseName(detail)}…` : '正在改文件…'
    case 'delegate': return '正在分派子任务…'
    case 'plan': return '正在列计划…'
    case 'skill': return '正在用技能…'
    default: return '正在处理…'
  }
}

import { t } from '../i18n/i18n.ts'

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
  if (/bilibili\.com$/.test(u.hostname) && bv) return t('activity.bilibiliVideo', { id: bv })
  return short(`${u.hostname.replace(/^www\./, '')}${parts.length ? `/${parts.join('/')}` : ''}`)
}

export function activityLabel({ step, detail = '' }: ToolActivity) {
  switch (step) {
    case 'search': return detail ? t('activity.search', { query: short(detail, 24) }) : t('activity.searchAny')
    case 'fetch': return t('activity.fetch', { page: describeUrl(detail) })
    case 'browse': return t('activity.browse')
    case 'run': return detail ? t('activity.run', { command: short(detail) }) : t('activity.runAny')
    case 'read': return detail ? t('activity.read', { file: baseName(detail) }) : t('activity.readAny')
    case 'find': return detail ? t('activity.find', { pattern: short(detail, 24) }) : t('activity.findAny')
    case 'edit': return detail ? t('activity.edit', { file: baseName(detail) }) : t('activity.editAny')
    case 'delegate': return t('activity.delegate')
    case 'plan': return t('activity.plan')
    case 'skill': return t('activity.skill')
    default: return t('activity.other')
  }
}

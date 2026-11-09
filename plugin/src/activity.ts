/// <reference path="../../app/protocol.d.ts" />

export function activityOf(tool: string, detail: string): ToolActivity {
  const t = tool.toLowerCase()
  const d = detail.trim()
  const step = (s: ToolStep): ToolActivity => (d ? { step: s, detail: d } : { step: s })
  if (/search/.test(t) && /^web|search_web|google/.test(t)) return step('search')
  if (/^(web|fetch)/.test(t)) return /^https?:/.test(d) ? step('fetch') : d ? step('search') : { step: 'browse' }
  if (/^(pwsh|bash|terminal|shell|run_code|job_|ptc)/.test(t)) return step('run')
  if (/^(read|view|open)/.test(t)) return step('read')
  if (/^(grep|glob|search|find|list|ls)/.test(t)) return step('find')
  if (/^(write|edit|str_replace|apply_patch|multi_edit)/.test(t)) return step('edit')
  if (/subagent|task|agent/.test(t)) return { step: 'delegate' }
  if (/todo|plan/.test(t)) return { step: 'plan' }
  if (/skill/.test(t)) return { step: 'skill' }
  return { step: 'other' }
}

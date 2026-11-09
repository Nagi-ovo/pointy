// The protocol between cards and the agent plugin. Go relays these
// messages without reading them, so they are written by hand here, and the
// plugin type-checks against this file alone.

interface CtxItem { label: string; text: string }
interface Material {
  site?: string
  kind?: string
  ctx: CtxItem[]
  images: { alt: string; src: string }[]
  links: { text: string; href: string }[]
  selection: string
  shots: { image: boolean; wide: boolean; kind: 'focus' | 'element' }
}
type AnswerMode = 'quick' | 'deep'

interface ModelChoice { provider: string; model: string; reasoningEffort?: string }
interface ModelEffort { id: string; name: string }
interface ModelEntry { provider: string; providerName?: string; model: string; name: string; efforts?: ModelEffort[]; defaultEffort?: string }
interface SessionInfo {
  sessionId: string
  title?: string
  updatedAt?: number
  running?: boolean
  workspace?: string
  snippet?: string
  model?: ModelChoice
}
interface Workspace { id: string; title: string }
interface Suggestion { label: string; prompt: string }

// What the agent is doing with a tool; detail is what the call names (a
// query, a URL, a command, a path), raw, for the card to word.
type ToolStep = 'search' | 'fetch' | 'browse' | 'run' | 'read' | 'find' | 'edit' | 'delegate' | 'plan' | 'skill' | 'other'
interface ToolActivity { step: ToolStep; detail?: string }

interface AskRequest {
  type: 'ask'
  askId: string
  target: string
  question: string
  mode: AnswerMode
  followUp: boolean
  modeChanged: boolean
  material?: Material
  workspaceId?: string
  model?: ModelChoice & { sessionOnly?: boolean }
  images?: string[]
}
type CardRequest =
  | { type: 'sessions-request'; reqId: string }
  | { type: 'sessions-search'; reqId: string; query: string }
  | { type: 'suggest-request'; reqId: string; material: Material }
  | AskRequest

interface SessionsReply {
  items?: SessionInfo[]
  activeRoot?: string
  workspaces?: Workspace[]
  defaultWorkspaceId?: string
  models?: ModelEntry[]
  defaultModel?: ModelChoice
  model?: string
  timeout?: boolean
  offline?: boolean
}
type AgentEvent =
  | ({ type: 'sessions'; reqId: string } & SessionsReply)
  | { type: 'suggestions'; reqId: string; suggestions?: Suggestion[] }
  | { type: 'title'; sessionId: string; title?: string }
  | { type: 'ask-accepted'; askId: string; sessionId: string; title?: string }
  | { type: 'ask-step'; askId: string }
  | { type: 'ask-delta'; askId: string; text: string }
  | { type: 'ask-activity'; askId: string; activity: ToolActivity }
  | { type: 'ask-done'; askId: string; sessionId?: string; reason: string; title?: string }
  | { type: 'ask-error'; askId: string; sessionId?: string; error: string }

/// <reference path="./bridge/runtime.d.ts" />

type ScreenRect = [number, number, number, number]

// Data that crosses between Go and the pages is declared in Go
// (desktop/internal/contract) and generated into bridge/mygo.ts.
type GrabSource = import('./bridge/mygo.ts').GrabSource
type GrabLink = import('./bridge/mygo.ts').GrabLink
type GrabImage = import('./bridge/mygo.ts').GrabImage
type GrabElement = import('./bridge/mygo.ts').GrabElement
type GrabMethod = import('./bridge/mygo.ts').GrabMethod
type GrabNote = import('./bridge/mygo.ts').GrabNote
type Grab = import('./bridge/mygo.ts').Grab & { mode?: undefined }

interface PairCard { mode: 'pair'; code: string }
type CardInit = PairCard | { mode?: undefined; grab: Grab; agent: { name: string } }

interface CtxItem { label: string; text: string }
interface Material {
  site?: string
  kind?: string
  ctx: CtxItem[]
  images: GrabImage[]
  links: GrabLink[]
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
  | { type: 'ask-activity'; askId: string; text: string }
  | { type: 'ask-done'; askId: string; sessionId?: string; reason: string; title?: string }
  | { type: 'ask-error'; askId: string; sessionId?: string; error: string }

type PillState = import('./bridge/mygo.ts').PillState
type KeepInfo = import('./bridge/mygo.ts').KeepInfo
type PillItem = import('./bridge/mygo.ts').PillItem

interface NoticeButton { id: string; label: string; primary?: boolean }
type NoticeParagraph = string | { text: string; copy: string[] }
interface NoticeInit { title: string; body: NoticeParagraph[]; buttons?: NoticeButton[] }
type IntroInit = import('./bridge/mygo.ts').IntroInit
type LocalRect = import('./bridge/mygo.ts').LocalRect
type OverlayHighlight = import('./bridge/mygo.ts').OverlayHighlight

interface A11yChainItem { rect: ScreenRect | null; control: string; cls?: string; name?: string; opaque?: boolean }
interface A11yGrabReply { ok: boolean; isPassword?: boolean; control?: string; text?: string; error?: string }
interface A11yPointReply { ok: boolean; chain?: A11yChainItem[]; leafKids?: boolean; leafReadable?: boolean; win?: ScreenRect | null; error?: string }
interface A11yElementReply {
  ok: boolean
  isPassword?: boolean
  name?: string
  control?: string
  className?: string
  rect?: ScreenRect | null
  kids?: boolean
  readable?: boolean
  win?: ScreenRect | null
  text?: string
  href?: string
  error?: string
}

interface CardApi {
  onInit(fn: (data: CardInit) => void): void
  onAgent(fn: (msg: AgentEvent) => void): void
  send(msg: CardRequest): Promise<boolean>
  close(): void
  openAgent(sessionId?: string): void
  copy(text: string): void
  resize(height: number): void
  menuRoom(height: number): void
  rendered(name: string): void
  keep(info: KeepInfo): void
  onSetAside(fn: () => void): void
  onRestore(fn: () => void): void
  openLink(href: string): void
  openImage(path: string): void
  extensionGuide(): void
  gripStart(): void
  gripMove(): void
  gripEnd(): void
  asked(): void
}
interface PillApi {
  onList(fn: (items: PillItem[]) => void): void
  open(id: string): void
  dismiss(id: string): void
  resize(height: number): void
}
interface NoticeApi {
  onInit(fn: (data: NoticeInit) => void): void
  choose(id: string | null): void
  resize(height: number): void
  copy(text: string): void
}
interface IntroApi {
  onInit(fn: (data: IntroInit) => void): void
  done(): void
}
interface OverlayApi {
  onHighlight(fn: (h: OverlayHighlight | null) => void): void
  onHold(fn: () => void): void
  onShift(fn: (d: { dx: number; dy: number }) => void): void
  onNote(fn: (text: string) => void): void
}
interface Window {
  card: CardApi
  pill: PillApi
  notice: NoticeApi
  intro: IntroApi
  overlay: OverlayApi
}

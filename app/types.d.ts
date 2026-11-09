// 跨进程、跨窗口共用的数据形状：主进程、preload、各个页面、读控件的小进程都按这里说话。
// 全局声明（不 import 也能用），只有类型，不产出 JS

/** 屏幕坐标（见 core/os）里的一个框：[x, y, 宽, 高] */
type ScreenRect = [number, number, number, number]

// ---------- 抓到的东西（pick/ 交出来，卡片按它显示、拼给 agent） ----------
interface GrabSource { app: string; title: string }
interface GrabLink { text: string; href: string }
interface GrabImage { alt: string; src: string }
/** 指认到的元素：浏览器扩展给的结构化信息，或者普通程序里读到的控件 */
interface GrabElement {
  kind: string
  site?: string
  tag?: string
  text?: string
  fields?: Record<string, string>
  page?: Record<string, string>
  links?: GrabLink[]
  images?: GrabImage[]
}
type GrabMethod = 'pick' | 'uia-pick' | 'extension' | 'uia' | 'clipboard' | 'none'
/** 浏览器里没走扩展时卡片上提的一句；install = 显示「装扩展」按钮 */
interface GrabNote { text: string; install: boolean }
interface Grab {
  mode?: undefined
  source: GrabSource
  method: GrabMethod
  text?: string
  url?: string
  pageTitle?: string
  element?: GrabElement
  /** 指到那块的截图（data URL，只在内存里） */
  image?: string
  wideImage?: string
  shotKind?: 'focus' | 'element'
  before?: string
  after?: string
  note?: GrabNote
  blocked?: string
}

// ---------- 卡片 ----------
/** 旧版扩展配对用的卡片 */
interface PairCard { mode: 'pair'; code: string }
type CardInit = PairCard | { mode?: undefined; grab: Grab; agent: { name: string } }

interface CtxItem { label: string; text: string }
/** 卡片整理好交给 agent 的材料（已经去过噪音），怎么拼成一段话见 agents/compose */
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
  /** 按内容搜到时命中的原文 */
  snippet?: string
  model?: ModelChoice
}
interface Workspace { id: string; title: string }
interface Suggestion { label: string; prompt: string }

/** 卡片发给 agent 的请求 */
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

/** 会话列表的回答；卡片自己超时 / 没连上时补 timeout / offline */
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
/** agent 发给卡片的消息 */
type AgentEvent =
  | ({ type: 'sessions'; reqId: string } & SessionsReply)
  | { type: 'suggestions'; reqId: string; suggestions?: Suggestion[] }
  | { type: 'title'; sessionId: string; title?: string }
  | { type: 'ask-accepted'; askId: string; sessionId: string; title?: string }
  | { type: 'ask-step'; askId: string }
  | { type: 'ask-delta'; askId: string; text: string }
  | { type: 'ask-activity'; askId: string; text: string; tool?: unknown; detail?: unknown }
  | { type: 'ask-done'; askId: string; sessionId?: string; reason: string; title?: string }
  | { type: 'ask-error'; askId: string; sessionId?: string; error: string }

type PillState = 'run' | 'done' | 'error'
/** 卡片收起成胶囊时报的 */
interface KeepInfo { sessionId?: string; title: string; state: PillState; fixedTitle: boolean }
interface PillItem { id: string; title: string; state: PillState }

// ---------- 提示窗、开场、指认遮罩 ----------
interface NoticeButton { id: string; label: string; primary?: boolean }
/** 一段话；也可以带一行可复制的值 */
type NoticeParagraph = string | { text: string; copy: string[] }
interface NoticeInit { title: string; body: NoticeParagraph[]; buttons?: NoticeButton[] }
interface IntroInit { version: string }
interface LocalRect { x: number; y: number; width: number; height: number }
/** 窗口内 CSS 像素；focus 是空壳程序里跟着鼠标的小框 */
interface OverlayHighlight extends LocalRect { label: string; focus: LocalRect | null }

// ---------- 读控件的小进程（uia-selection.ps1 / ax-helper）：一行命令一行 JSON ----------
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

// ---------- preload 挂到页面 window 上的接口 ----------
interface CardApi {
  onInit(fn: (data: CardInit) => void): void
  onAgent(fn: (msg: AgentEvent) => void): void
  /** false = agent 没连上 */
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

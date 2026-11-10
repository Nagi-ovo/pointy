/// <reference path="./bridge/runtime.d.ts" />
/// <reference path="./protocol.d.ts" />

// Data that crosses between Go and the pages is declared in Go
// (desktop/internal/contract) and generated into bridge/mygo.ts.
type GrabSource = import('./bridge/mygo.ts').GrabSource
type GrabLink = import('./bridge/mygo.ts').GrabLink
type GrabImage = import('./bridge/mygo.ts').GrabImage
type GrabElement = import('./bridge/mygo.ts').GrabElement
type GrabMethod = import('./bridge/mygo.ts').GrabMethod
type GrabNote = import('./bridge/mygo.ts').GrabNote
type Message = import('./bridge/mygo.ts').Message
type BlockReason = import('./bridge/mygo.ts').BlockReason
type Grab = import('./bridge/mygo.ts').Grab & { mode?: undefined }

interface PairCard { mode: 'pair'; code: string }
type CardInit = PairCard | { mode?: undefined; grab: Grab; agent: { name: string } }

type PillState = import('./bridge/mygo.ts').PillState
type KeepInfo = import('./bridge/mygo.ts').KeepInfo
type PillItem = import('./bridge/mygo.ts').PillItem

type NoticeText = string | Message
interface NoticeButton { id: string; label: NoticeText; primary?: boolean }
type NoticeParagraph = NoticeText | { text: NoticeText; copy: string[] }
interface NoticeInit { title: NoticeText; body: NoticeParagraph[]; buttons?: NoticeButton[] }
type IntroInit = import('./bridge/mygo.ts').IntroInit
type LocalRect = import('./bridge/mygo.ts').LocalRect
type OverlayHighlight = import('./bridge/mygo.ts').OverlayHighlight

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
  onNote(fn: (note: Message) => void): void
}
interface Window {
  card: CardApi
  pill: PillApi
  notice: NoticeApi
  intro: IntroApi
  overlay: OverlayApi
}

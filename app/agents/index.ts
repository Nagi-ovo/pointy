// 卡片背后接的是哪个 agent。现在只有 DSH；以后加 Claude Code、Codex 等，在这里登记、按设置选一个。
//
// 每个 agent 模块对外的样子见下面的 Agent（实现见 dsh/index.ts）。
// 发给卡片的消息（toCards）见 types.d.ts 的 AgentEvent。
// 标题已经是能显示的（agent 自己的临时标题要在适配里滤掉）。
import type { WebSocket } from 'ws'
import * as dsh from './dsh/index.ts'
import type { ConnectionHandler } from '../server.ts'

/** 任务进度（胶囊用）：做完、出错、标题变了 */
export interface TaskEvent {
  type: 'ask-done' | 'ask-error' | 'state' | 'title'
  sessionId?: string
  title?: string
  reason?: string
}

export interface AgentDeps {
  toCards(msg: AgentEvent): void
  onTask(msg: TaskEvent): void
  notify(title: string, content: string, onClick?: () => void): void
  showHint(text: string): void
  focusTab(origin: string | undefined): boolean
  onChange(): void
}

/** agent 是桌面版，还是浏览器里的 web 版（origin 是它的地址） */
export interface AgentUi { kind: 'desktop' | 'web'; origin?: string }

export interface Agent {
  /** 显示用的名字（卡片、托盘、引导里的"问 XX""在 XX 里继续"） */
  name: string
  init(deps: AgentDeps): void
  /** 本机服务认证通过一条 agent 桥连接时调用 */
  attach(ws: WebSocket): ConnectionHandler
  /** 卡片发来的请求；false = 没连上 */
  request(msg: CardRequest): boolean
  /** 把 agent 叫到前台（有 sessionId 就切到那个会话） */
  open(sessionId?: string): void
  status(): { connected: boolean; version?: string; pendingApprovals: number }
  /** Pointy 退出前 */
  willQuit(): void
  ui?(): AgentUi
}

const current: Agent = dsh

const currentAgent = () => current
export { currentAgent as current }

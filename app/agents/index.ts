import type { WebSocket } from 'ws'
import * as dsh from './dsh/index.ts'
import type { ConnectionHandler } from '../server.ts'

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

export interface AgentUi { kind: 'desktop' | 'web'; origin?: string }

export interface Agent {
  name: string
  init(deps: AgentDeps): void
  attach(ws: WebSocket): ConnectionHandler
  request(msg: CardRequest): boolean
  open(sessionId?: string): void
  status(): { connected: boolean; version?: string; pendingApprovals: number }
  willQuit(): void
  ui?(): AgentUi
}

const current: Agent = dsh

const currentAgent = () => current
export { currentAgent as current }

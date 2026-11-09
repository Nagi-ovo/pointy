// 本机 WebSocket 服务（127.0.0.1）：agent 的桥（现在是 DSH 插件）和浏览器扩展都连这里。
// 这里只管握手认证，认证完把连接交出去：agent 交给 agents/，扩展交给 browser/extensions
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { HOME_DIR, PORT, logError } from './core/env.ts'
import * as extensions from './browser/extensions.ts'

const TOKEN_FILE = path.join(HOME_DIR, 'token')

/** 认证通过的一条连接：之后的每条消息交给 onMessage，断开时 onClose */
export interface ConnectionHandler {
  onMessage(msg: any): void
  onClose(): void
}

/** agent 桥用的共享密钥（~/.pointy/token），没有就生成 */
function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

const hmac = (token: string, data: string) => crypto.createHmac('sha256', token).update(data).digest('hex')
const safeEqual = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * @param onAgent agent 桥认证通过时调用
 */
export function startServer({ onAgent }: { onAgent: (ws: WebSocket) => ConnectionHandler }) {
  const token = loadToken()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 8 << 20 })
  wss.on('error', (err) => logError('server', err))
  wss.on('connection', (ws, req) => {
    const nonce = crypto.randomBytes(16).toString('hex')
    let handler: ConnectionHandler | undefined // 认证后才有
    ws.send(JSON.stringify({ type: 'challenge', nonce }))
    const kick = setTimeout(() => { if (!handler) ws.close() }, 10_000)
    ws.on('message', (raw) => {
      // 对面发来的 JSON：认证前按握手消息看，认证后整条交给 handler
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (handler) return handler.onMessage(msg)
      if (msg.type === 'pair-request') return extensions.handlePairRequest(ws, req, msg, () => clearTimeout(kick))
      if (msg.type !== 'hello' || typeof msg.nonce !== 'string') return ws.close()
      if (msg.role === 'extension') {
        const id = extensions.authenticate(ws, msg, nonce)
        if (!id) return ws.close()
        clearTimeout(kick)
        handler = { onMessage: extensions.onMessage, onClose: () => extensions.onClosed(id, ws) }
        return
      }
      if (!safeEqual(msg.proof, hmac(token, `plugin|${nonce}`))) return ws.close()
      clearTimeout(kick)
      ws.send(JSON.stringify({ type: 'hello-ok', proof: hmac(token, `pet|${msg.nonce}`) }))
      handler = onAgent(ws)
    })
    ws.on('close', () => {
      clearTimeout(kick)
      handler?.onClose()
    })
  })
}

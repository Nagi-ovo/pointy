import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { HOME_DIR, PORT, logError } from './core/env.ts'
import * as extensions from './browser/extensions.ts'

const TOKEN_FILE = path.join(HOME_DIR, 'token')

export interface ConnectionHandler {
  onMessage(msg: any): void
  onClose(): void
}

function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

const hmac = (token: string, data: string) => crypto.createHmac('sha256', token).update(data).digest('hex')
const safeEqual = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function startServer({ onAgent }: { onAgent: (ws: WebSocket) => ConnectionHandler }) {
  const token = loadToken()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 8 << 20 })
  wss.on('error', (err) => logError('server', err))
  wss.on('connection', (ws, req) => {
    const nonce = crypto.randomBytes(16).toString('hex')
    let handler: ConnectionHandler | undefined
    ws.send(JSON.stringify({ type: 'challenge', nonce }))
    const kick = setTimeout(() => { if (!handler) ws.close() }, 10_000)
    ws.on('message', (raw) => {
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

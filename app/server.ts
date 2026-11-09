// 本机 WebSocket 服务（127.0.0.1）：agent 的桥（现在是 DSH 插件）和浏览器扩展都连这里。
// 这里只管握手认证，认证完把连接交出去：agent 交给 agents/，扩展交给 browser/extensions
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const { HOME_DIR, PORT, logError } = require('./core/env')
const extensions = require('./browser/extensions')

const TOKEN_FILE = path.join(HOME_DIR, 'token')

/** agent 桥用的共享密钥（~/.pointy/token），没有就生成 */
function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

const hmac = (token, data) => crypto.createHmac('sha256', token).update(data).digest('hex')
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * @param onAgent (ws) => { onMessage(msg), onClose() }：agent 桥认证通过时调用
 */
function startServer({ onAgent }) {
  const token = loadToken()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: 8 << 20 })
  wss.on('error', (err) => logError('server', err))
  wss.on('connection', (ws, req) => {
    const nonce = crypto.randomBytes(16).toString('hex')
    let handler // 认证后：{ onMessage, onClose }
    ws.send(JSON.stringify({ type: 'challenge', nonce }))
    const kick = setTimeout(() => { if (!handler) ws.close() }, 10_000)
    ws.on('message', (raw) => {
      let msg
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

module.exports = { startServer }

// 不开 DSH 也能测Pointy：冒充 pointy-bridge 连上来，按顺序推一遍状态和一次批准
// 用法：node tools/fake-plugin.ts [间隔毫秒]
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const token = fs.readFileSync(path.join(os.homedir(), '.pointy', 'token'), 'utf8').trim()
const gap = Number(process.argv[2]) || 2500
const hmac = (d: string) => crypto.createHmac('sha256', token).update(d).digest('hex')
const nonce = crypto.randomBytes(16).toString('hex')
const ws = new WebSocket(`ws://127.0.0.1:${process.env.POINTY_PORT || 47321}`)
const send = (m: object) => ws.send(JSON.stringify(m))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sid = 'session-fake'

/** 宠物发给插件的消息，这里只看用到的字段 */
type PetMessage =
  | { type: 'challenge', nonce: string }
  | { type: 'hello-ok', proof: string }
  | { type: 'line-request', reqId: string, state: string }
  | { type: 'approve', id: string, decision: string }
  | { type: 'files', paths: string[] }

ws.on('message', async (raw) => {
  const msg: PetMessage = JSON.parse(String(raw))
  if (msg.type === 'challenge') return send({ type: 'hello', v: 1, nonce, proof: hmac(`plugin|${msg.nonce}`) })
  if (msg.type === 'hello-ok') {
    if (msg.proof !== hmac(`pet|${nonce}`)) throw new Error('pet proof mismatch')
    console.log('authenticated')
    return run()
  }
  if (msg.type === 'line-request') return send({ type: 'line', reqId: msg.reqId, text: `（假台词：${msg.state}）` })
  console.log('pet ->', msg)
  if (msg.type === 'approve') send({ type: 'approval-closed', id: msg.id, sessionId: sid, outcome: msg.decision === 'allow' ? 'allowed-once' : 'rejected', by: 'pet' })
  if (msg.type === 'files') send({ type: 'files-result', ok: true, sessionId: sid, count: msg.paths.length })
})

async function run() {
  const steps = [
    { state: 'thinking' },
    { state: 'running', tool: 'pwsh', detail: 'List project files' },
    { state: 'editing', tool: 'write', detail: 'E:\\DEV\\demo\\a.txt' },
    { state: 'reading', tool: 'read', detail: 'README.md' },
    { state: 'error', detail: 'Exit code 1\nGet-Item: Cannot find path E:\\nope because it does not exist.' },
    { state: 'thinking' },
    { state: 'done', detail: 'completed' },
  ]
  for (const s of steps) {
    send({ type: 'state', sessionId: sid, title: '假会话', at: Date.now(), ...s })
    await sleep(gap)
  }
  send({ type: 'approval', id: 'fake-1', sessionId: sid, title: '假会话', toolName: 'pwsh', reason: process.env.FAKE_REASON || '需要写入工作区外的目录', detail: 'Remove-Item C:\\temp\\old -Recurse' })
}

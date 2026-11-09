// Stands in for the DSH plugin: authenticates to Pointy, then answers cards
// with canned sessions, suggestions and a streamed answer.
// POINTY_HOME, POINTY_PORT pick the Pointy; FAKE_APPROVAL=1 asks for one approval.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const home = process.env.POINTY_HOME || path.join(os.homedir(), '.pointy')
const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim()
const hmac = (d: string) => crypto.createHmac('sha256', token).update(d).digest('hex')
const nonce = crypto.randomBytes(16).toString('hex')
const ws = new WebSocket(`ws://127.0.0.1:${process.env.POINTY_PORT || 47321}`)
const send = (m: object) => ws.send(JSON.stringify(m))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sid = 'session-fake'

const ANSWER = [
  '## 这是假回答',
  '',
  '下面是一段 **Markdown**，用来看卡片怎么排版。',
  '',
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}. 第 ${i + 1} 条，带一个 [链接](https://example.com/${i + 1})`),
  '',
  '```ts',
  ...Array.from({ length: 10 }, (_, i) => `const line${i} = ${i} // 代码`),
  '```',
  '',
  '### 小结',
  '',
  ...Array.from({ length: 8 }, (_, i) => `- 要点 ${i + 1}`),
].join('\n')

type PetMessage =
  | { type: 'challenge', nonce: string }
  | { type: 'hello-ok', proof: string }
  | { type: 'sessions-request' | 'sessions-search', reqId: string }
  | { type: 'suggest-request', reqId: string }
  | { type: 'ask', askId: string, question: string }
  | { type: 'focus', sessionId: string }

async function answer(askId: string) {
  send({ type: 'ask-accepted', askId, sessionId: sid, title: '假会话' })
  send({ type: 'ask-step', askId, sessionId: sid })
  send({ type: 'ask-activity', askId, sessionId: sid, text: '正在搜索网页' })
  for (const chunk of ANSWER.match(/[\s\S]{1,40}/g) ?? []) {
    send({ type: 'ask-delta', askId, sessionId: sid, text: chunk })
    await sleep(Number(process.env.FAKE_DELTA_MS) || 30)
  }
  send({ type: 'ask-done', askId, sessionId: sid, title: '假会话', reason: 'completed' })
}

ws.on('message', async (raw) => {
  const msg: PetMessage = JSON.parse(String(raw))
  if (msg.type === 'challenge') return send({ type: 'hello', v: 1, nonce, proof: hmac(`plugin|${msg.nonce}`) })
  if (msg.type === 'hello-ok') {
    if (msg.proof !== hmac(`pet|${nonce}`)) throw new Error('pet proof mismatch')
    console.log('authenticated')
    send({ type: 'ready', plugin: 'fake' })
    send({ type: 'ui', kind: 'desktop' })
    if (process.env.FAKE_APPROVAL === '1') send({ type: 'approval', id: 'fake-1', sessionId: sid, title: '假会话', toolName: 'bash', reason: '需要写入工作区外的目录' })
    return
  }
  console.log('pet ->', JSON.stringify(msg))
  if (msg.type === 'sessions-request' || msg.type === 'sessions-search') {
    return send({ type: 'sessions', reqId: msg.reqId, items: [{ sessionId: sid, title: '假会话', updatedAt: Date.now() }], workspaces: [{ id: 'w1', title: 'demo' }], defaultWorkspaceId: 'w1' })
  }
  if (msg.type === 'suggest-request') return send({ type: 'suggestions', reqId: msg.reqId, suggestions: [{ label: '这是什么', prompt: '这是什么？' }] })
  if (msg.type === 'ask') return answer(msg.askId)
})
ws.on('close', () => { console.log('closed'); process.exit(0) })

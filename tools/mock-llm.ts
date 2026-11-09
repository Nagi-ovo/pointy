// A stand-in for DeepSeek's Anthropic-compatible API, for DSH under test:
//   node tools/mock-llm.ts <port> <log.jsonl>
//   DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/anthropic dsh web ...
// It answers suggestion and title requests, calls the web search tool once
// when DSH offers one, then answers. Every request is appended to the log.
import fs from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2])
const log = process.argv[3]
let n = 0

const sse = (res: http.ServerResponse, events: object[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}
const start = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }
const text = (t: string) => [start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' }]
const toolUse = (name: string, input: object) => [start,
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${++n}`, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' }]

http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let json: any = {}
    try { json = JSON.parse(body) } catch {}
    fs.appendFileSync(log, JSON.stringify({ at: Date.now(), url: req.url, body: json }) + '\n')
    if (req.method !== 'POST' || !/\/messages$/.test(req.url ?? '')) { res.writeHead(404); return res.end('{}') }
    const messages: any[] = json.messages ?? []
    const last = messages.at(-1)
    const lastHasResult = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
    const tools: any[] = json.tools ?? []
    const search = tools.find(t => /search/i.test(t.name) && /web/i.test(t.name))
    setTimeout(() => {
      if (/替他想 2 个/.test(JSON.stringify(json.system ?? ''))) return sse(res, text('[{"label":"查查 Pointy 是什么","prompt":"Pointy 是什么？"},{"label":"Pointy 怎么用","prompt":"Pointy 怎么用？"}]'))
      if (!tools.length) return sse(res, text('Mock 标题'))
      if (search && !lastHasResult) return sse(res, toolUse(search.name, { query: 'pointy 指认工具' }))
      sse(res, text('这是一段模拟回答。'))
    }, 1500)
  })
}).listen(port, '127.0.0.1', () => console.log(`mock llm on ${port}`))

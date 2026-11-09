import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeFirst, composeFollowUp, isOurPreamble } from '../app/agents/compose.ts'

const material = (patch = {}) => ({
  site: 'github.com',
  kind: 'comment',
  ctx: [{ label: '网址', text: 'https://github.com/a/b/issues/1' }],
  images: [],
  links: [],
  selection: '第一行\n第二行',
  shots: { image: false, wide: false, kind: 'element' as const },
  ...patch,
})

test('first question wraps the material and puts the question last', () => {
  const text = composeFirst({ material: material(), question: '这是什么意思？', mode: 'quick' })
  const parts = text.split('\n\n')
  assert.equal(parts.length, 3)
  assert.ok(parts[0].startsWith('<抓取内容>\n'))
  assert.ok(parts[0].endsWith('\n</抓取内容>'))
  assert.match(parts[0], /\n来源：github\.com（评论）\n/)
  assert.match(parts[0], /\n网址：https:\/\/github\.com\/a\/b\/issues\/1\n/)
  assert.match(parts[0], /\n内容：\n> 第一行\n> 第二行\n/)
  assert.match(parts[1], /^回答要求：这是随手一问/)
  assert.equal(parts[2], '用户的问题：这是什么意思？')
})

test('deep mode asks for a one-line conclusion first instead of a short answer', () => {
  const text = composeFirst({ material: material(), question: '修一下', mode: 'deep' })
  assert.match(text, /\n\n回答要求：做完以后，最后回复的第一句先用一句话说结论/)
  assert.doesNotMatch(text, /随手一问/)
})

test('without a question (suggestion request) only the material block is sent', () => {
  const text = composeFirst({ material: material() })
  assert.ok(text.startsWith('<抓取内容>'))
  assert.ok(text.endsWith('</抓取内容>'))
  assert.doesNotMatch(text, /回答要求|用户的问题/)
})

test('without material the question goes out with only the answer note', () => {
  assert.equal(composeFirst({ question: '你好', mode: 'deep' }).split('\n\n')[1], '你好')
  assert.match(composeFirst({ question: '你好', mode: 'quick' }), /^回答要求：这是随手一问[^]*\n\n你好$/)
  assert.equal(composeFirst({ material: { ...material(), site: undefined, ctx: [], selection: '' }, question: '' }), '')
})

test('unknown element kinds fall back to a generic label', () => {
  assert.match(composeFirst({ material: material({ kind: 'mystery' }) }), /来源：github\.com（元素）/)
})

test('one link is listed inline, several as a list', () => {
  const one = composeFirst({ material: material({ links: [{ text: 'PR', href: 'https://x/1' }] }) })
  assert.match(one, /\n链接：https:\/\/x\/1\n/)
  const two = composeFirst({ material: material({ links: [{ text: 'A', href: 'https://x/1' }, { text: 'B', href: 'https://x/2' }] }) })
  assert.match(two, /\n链接：\n- A https:\/\/x\/1\n- B https:\/\/x\/2\n/)
})

test('screenshots are described by which ones are attached', () => {
  const shots = (image: boolean, wide: boolean, kind: 'focus' | 'element' = 'element') => composeFirst({ material: material({ shots: { image, wide, kind } }) })
  assert.match(shots(true, true, 'focus'), /附图：两张截图，第一张是鼠标附近那块/)
  assert.match(shots(true, true), /附图：两张截图，第一张是指到的那块，第二张是整个窗口/)
  assert.match(shots(true, false), /附图：指到的那块的截图/)
  assert.match(shots(false, true), /附图：整个窗口的截图/)
  assert.doesNotMatch(shots(false, false), /附图/)
})

test('follow-ups send only the typed text unless the answer mode changed', () => {
  assert.equal(composeFollowUp({ question: '再说说', mode: 'quick', modeChanged: false }), '再说说')
  assert.match(composeFollowUp({ question: '再说说', mode: 'quick', modeChanged: true }), /^回答要求：这是随手一问[^]*\n\n再说说$/)
  assert.match(composeFollowUp({ question: '再说说', mode: 'deep', modeChanged: true }), /^回答要求：这次可以充分查资料[^]*\n\n再说说$/)
})

test('isOurPreamble recognises text we composed', () => {
  assert.equal(isOurPreamble(composeFirst({ material: material() })), true)
  assert.equal(isOurPreamble('  回答要求：这是随手一问'), true)
  assert.equal(isOurPreamble('修复登录页的报错'), false)
  assert.equal(isOurPreamble(undefined), false)
})

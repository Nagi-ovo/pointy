import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityText, describeUrl } from '../plugin/src/activity.ts'

test('GitHub URLs are named by what they point at', () => {
  assert.equal(describeUrl('https://github.com/pointylab/pointy/issues/5075'), 'issue #5075')
  assert.equal(describeUrl('https://github.com/pointylab/pointy/pull/12#discussion'), 'PR #12')
  assert.equal(describeUrl('https://github.com/pointylab/pointy/blob/main/app/main.ts'), 'main.ts')
  assert.equal(describeUrl('https://github.com/pointylab/pointy'), 'pointylab/pointy')
  assert.equal(describeUrl('https://gist.github.com/someone/abc'), 'someone/abc')
})

test('Bilibili videos are named by their BV id', () => {
  assert.equal(describeUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2'), 'B 站视频 BV1xx411c7mD')
})

test('other URLs are host plus path, without www, shortened to 36 characters', () => {
  assert.equal(describeUrl('https://www.example.com/'), 'example.com')
  assert.equal(describeUrl('https://example.com/a/b'), 'example.com/a/b')
  const long = describeUrl('https://example.com/a-very-long-path/that-keeps-going/and-going')
  assert.equal(long.length, 36)
  assert.ok(long.endsWith('…'))
})

test('text that is not a URL is only shortened', () => {
  assert.equal(describeUrl('not a url'), 'not a url')
})

test('tool calls are described in plain words', () => {
  assert.equal(activityText('web_search', 'pointy 指认'), '正在搜索「pointy 指认」…')
  assert.equal(activityText('search_web', ''), '正在搜索…')
  assert.equal(activityText('fetch', 'https://github.com/a/b/issues/5'), '正在读取 issue #5…')
  assert.equal(activityText('web_fetch', '天气'), '正在搜索「天气」…')
  assert.equal(activityText('WebFetch', ''), '正在上网查…')
  assert.equal(activityText('bash', 'npm test'), '正在运行：npm test')
  assert.equal(activityText('pwsh', ''), '正在运行命令…')
  assert.equal(activityText('read_file', 'C:\\repo\\app\\main.ts'), '正在看 main.ts…')
  assert.equal(activityText('grep', 'TODO'), '正在找「TODO」…')
  assert.equal(activityText('edit', '/Users/me/repo/README.md'), '正在改 README.md…')
  assert.equal(activityText('spawn_subagent', ''), '正在分派子任务…')
  assert.equal(activityText('todo_write', ''), '正在列计划…')
  assert.equal(activityText('use_skill', ''), '正在用技能…')
  assert.equal(activityText('mystery', 'x'), '正在处理…')
})

test('long details are cut with an ellipsis', () => {
  assert.equal(activityText('grep', 'a'.repeat(40)), `正在找「${'a'.repeat(23)}…」…`)
})

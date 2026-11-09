import { test } from 'node:test'
import assert from 'node:assert/strict'
import catalogs from '../app/i18n/catalogs.ts'
import { locale, t, tm, translate, type Locale } from '../app/i18n/i18n.ts'

const PLURAL = /_(zero|one|two|few|many|other)$/

function leaves(tree: object, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`)))
}
const placeholders = (msg: string) => [...msg.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
const langs = Object.keys(catalogs) as Locale[]

test('every language has the messages of the source, with the same placeholders', () => {
  const source = new Map(leaves(catalogs['zh-CN']).map(([k, v]) => [k.replace(PLURAL, ''), placeholders(v)]))
  for (const lang of langs) {
    const own = new Map(leaves(catalogs[lang]).map(([k, v]) => [k.replace(PLURAL, ''), placeholders(v)]))
    assert.deepEqual([...own.keys()].sort(), [...source.keys()].sort(), `${lang} keys`)
    for (const [k, names] of own) assert.deepEqual(names, source.get(k), `${lang} ${k} placeholders`)
  }
})

test('a plural message has every form its language has', () => {
  for (const lang of langs) {
    const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
    const keys = leaves(catalogs[lang]).map(([k]) => k)
    for (const base of new Set(keys.filter(k => PLURAL.test(k)).map(k => k.replace(PLURAL, '')))) {
      for (const form of forms) assert.ok(keys.includes(`${base}_${form}`), `${lang} ${base}_${form}`)
    }
  }
})

test('messages fill placeholders and pick plural forms', () => {
  assert.equal(translate('zh-CN', 'tray.approvals', { count: 1 }), '1 个操作等你批准')
  assert.equal(translate('en', 'tray.approvals', { count: 1 }), '1 action needs your approval')
  assert.equal(translate('en', 'tray.approvals', { count: 2 }), '2 actions need your approval')
  assert.equal(translate('en', 'progress.sent', { agent: 'DSH' }), 'Sent to DSH')
  assert.equal(translate('en', 'progress.sent'), 'Sent to {agent}')
})

test('a page without a language from Go speaks Chinese, as before', () => {
  assert.equal(locale, 'zh-CN')
  assert.equal(t('task.new'), '新任务')
  assert.equal(tm({ key: 'pair.title', params: { browser: 'Edge' } }), 'Edge 里的 Pointy 扩展想连接')
  assert.equal(tm({ key: 'no.such.key' }), 'no.such.key')
})

test('a key that names no message does not compile', () => {
  // @ts-expect-error the catalog has no such key
  assert.equal(t('task.nope'), 'task.nope')
})

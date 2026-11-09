import catalogs from './catalogs.ts'

export type Locale = keyof typeof catalogs
type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type Keys<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K extends `${infer Base}_${PluralForm}` ? Base : K}` : Keys<T[K], `${P}${K}.`>
}[keyof T & string]
export type Key = Keys<(typeof catalogs)['zh-CN']>
export type Params = Record<string, string | number>

const SOURCE: Locale = 'zh-CN'
const isLocale = (tag: unknown): tag is Locale => typeof tag === 'string' && Object.hasOwn(catalogs, tag)
const injected = (globalThis as { pointyLocale?: unknown }).pointyLocale
export const locale: Locale = isLocale(injected) ? injected : SOURCE

function find(lang: Locale, id: string) {
  let node: unknown = catalogs[lang]
  for (const part of id.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
  return typeof node === 'string' ? node : undefined
}

function lookup(lang: Locale, id: string, count: unknown) {
  if (typeof count === 'number') return find(lang, `${id}_${new Intl.PluralRules(lang).select(count)}`) ?? find(lang, `${id}_other`)
  return find(lang, id)
}

function say(lang: Locale, id: string, params: Params = {}) {
  const msg = lookup(lang, id, params.count) ?? lookup(SOURCE, id, params.count) ?? id
  return msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

export const translate = (lang: Locale, key: Key, params?: Params) => say(lang, key, params)

// The page's texts, in the language Go gave it.
export const t = (key: Key, params?: Params) => say(locale, key, params)

// A text Go sent as a key and its params.
export const tm = (m: Message) => say(locale, m.key, m.params)

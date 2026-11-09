// Typed access to the Go services and events of the generated client,
// over window.mygo. Go injects this script with a page's adapter, in one
// scope, before the page's own scripts.

type GoClient = typeof import('./mygo.ts')
type GoServiceName = 'Card' | 'Pill' | 'Notice' | 'Intro'

function goService<K extends GoServiceName>(name: K): GoClient[K] {
  return new Proxy({}, {
    get: (_, method: string) => (...args: unknown[]) => window.mygo.call(`${name}.${method[0].toUpperCase()}${method.slice(1)}`, ...args),
  }) as GoClient[K]
}

const goEvents = new Proxy({}, {
  get: (_, name: string) => ({
    name,
    on: (listener: (payload: unknown) => void) => window.mygo.on(name, listener),
    once: (listener: (payload: unknown) => void) => window.mygo.once(name, listener),
  }),
}) as GoClient['events']

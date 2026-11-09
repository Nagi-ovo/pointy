// The part of mygo's page runtime (window.mygo) the generated client and
// the adapters use, in place of the mygo-runtime npm package.

interface MygoEvent<T> {
  readonly name: string
  on(listener: (payload: T) => void): () => void
  once(listener: (payload: T) => void): () => void
}

interface MygoRuntime {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  on<T = unknown>(name: string, listener: (payload: T) => void): () => void
  once<T = unknown>(name: string, listener: (payload: T) => void): () => void
}

interface Window {
  mygo: MygoRuntime
}

declare module 'mygo-runtime' {
  export function call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  export function event<T>(name: string): MygoEvent<T>
}

import os from '../core/os/index.ts'
import type { A11yHelperProcess, Foreground } from '../core/os/types.ts'

const { BROWSERS, foreground } = os

const BLOCKED_TITLE = /密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay/i

export function blockedReason(fg: Foreground) {
  if (os.BLOCKED_APPS.has(fg.exe)) return `${fg.exe} 在黑名单里`
  if (BLOCKED_TITLE.test(fg.title)) return '窗口像是登录或密码页面'
  return undefined
}

export interface ExtensionSelection {
  blocked?: string
  text?: string
  url?: string
  pageTitle?: string
  before?: string
  after?: string
}

class UiaHelper {
  proc: A11yHelperProcess | undefined
  buffer = ''
  waiters: ((reply: unknown) => void)[] = []

  start() {
    const proc = os.spawnA11yHelper()
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    this.buffer = ''
    this.waiters = []
    proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        this.waiters.shift()?.(parsed)
      }
    })
    proc.on('exit', () => {
      this.proc = undefined
      for (const w of this.waiters.splice(0)) w(undefined)
    })
  }

  grab(timeoutMs = 1500) {
    return this.request('grab', timeoutMs)
  }

  request(command: 'grab', timeoutMs?: number): Promise<A11yGrabReply | undefined>
  request(command: `point ${number} ${number}`, timeoutMs?: number): Promise<A11yPointReply | undefined>
  request(command: `element ${number} ${number} ${number}`, timeoutMs?: number): Promise<A11yElementReply | undefined>
  request(command: string, timeoutMs = 1500): Promise<any> {
    if (!this.proc) this.start()
    return new Promise((resolve) => {
      let done = false
      const finish = (v: unknown) => { if (!done) { done = true; resolve(v) } }
      this.waiters.push(finish)
      this.proc!.stdin.write(`${command}\n`)
      setTimeout(() => {
        if (done) return
        this.stop()
        finish(undefined)
      }, timeoutMs)
    })
  }

  stop() {
    this.proc?.kill()
    this.proc = undefined
  }
}

const uia = new UiaHelper()

export async function grabSelection(): Promise<Grab> {
  const fg = foreground()
  const source = { app: fg.exe, title: fg.title }
  const blocked = blockedReason(fg)
  if (blocked) return { source, blocked, method: 'none' }
  const u = await uia.grab()
  if (u?.isPassword) return { source, blocked: '焦点在密码框里', method: 'uia' }
  if (u?.ok && u.text?.trim()) return { source, method: 'uia', text: u.text }
  return { source, method: 'none', text: '' }
}

export { foreground, BROWSERS }
export const elevatedUnderCursor = os.elevatedUnderCursor
export const uiaRequest = uia.request.bind(uia)
export const stopSelectionHelper = () => uia.stop()

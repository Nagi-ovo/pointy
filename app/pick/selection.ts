// 按下快捷键的那一刻取"用户选中了什么"：先认前台程序，浏览器问扩展，
// 其他程序读控件（UI Automation / 辅助功能接口），再不行就模拟一次复制并把剪贴板还原。只在被调用时读，不做任何监听。
import { clipboard as electronClipboard } from 'electron'
import type { NativeImage } from 'electron'
import os from '../core/os/index.ts'
import type { A11yHelperProcess, Foreground } from '../core/os/types.ts'

const { BROWSERS, NO_COPY_APPS, foreground } = os

// 下面按同步的老剪贴板接口写。Electron 44 的类型和实测（44.10.1）都已经是异步接口，没有 readHTML / readRTF / readImage，
// 这条路现在只有测试钩子走得到（晃动那条 allowCopy: false）
interface ClipboardSnapshot { text?: string; html?: string; rtf?: string; image?: NativeImage }
interface SyncClipboard {
  readText(): string
  readHTML(): string
  readRTF(): string
  readImage(): NativeImage
  write(data: ClipboardSnapshot): void
  clear(): void
}
const clipboard = electronClipboard as unknown as SyncClipboard
const BLOCKED_TITLE = /密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay/i
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function blockedReason(fg: Foreground) {
  if (os.BLOCKED_APPS.has(fg.exe)) return `${fg.exe} 在黑名单里`
  if (BLOCKED_TITLE.test(fg.title)) return '窗口像是登录或密码页面'
  return undefined
}

/** 扩展回来的选区（grab-result） */
export interface ExtensionSelection {
  blocked?: string
  text?: string
  url?: string
  pageTitle?: string
  before?: string
  after?: string
}

/** 读控件走一个常驻小进程（Windows 是 UI Automation，macOS 是辅助功能接口），一行命令一行 JSON */
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

  /** 发一行命令（grab / point X Y / element X Y UP），等一行 JSON 回来；回答的样子见 types.d.ts 的 A11y*Reply */
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
        // 超时的那次回答以后会错位，干脆重启
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

/** 等用户松开快捷键里的修饰键，否则模拟的 Ctrl+C 会变成 Ctrl+Alt+C */
async function waitKeysReleased(timeoutMs = 800) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!os.modifiersDown()) return true
    await sleep(20)
  }
  return false
}

/** 模拟复制（Ctrl+C / ⌘C）拿选区，拿完把剪贴板原样放回（文本、HTML、RTF、图片） */
export async function copySelection() {
  if (!await waitKeysReleased()) return ''
  const snapshot = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() }
  const before = os.clipboardSeq()
  os.sendCopy()
  // Electron 程序复制是异步的，多等一会儿
  const end = Date.now() + 1200
  while (Date.now() < end && os.clipboardSeq() === before) await sleep(15)
  if (os.clipboardSeq() === before) return ''
  await sleep(30)
  const text = clipboard.readText()
  const restore: ClipboardSnapshot = {}
  if (snapshot.text) restore.text = snapshot.text
  if (snapshot.html) restore.html = snapshot.html
  if (snapshot.rtf) restore.rtf = snapshot.rtf
  if (!snapshot.image.isEmpty()) restore.image = snapshot.image
  if (Object.keys(restore).length) clipboard.write(restore)
  else clipboard.clear()
  return text
}

/**
 * @param extensionGrabFor (exe) => 向该浏览器里的扩展要选区的函数；没有可用扩展时返回 undefined
 */
export async function grabSelection(
  extensionGrabFor: ((exe: string) => (() => Promise<ExtensionSelection>) | undefined) | undefined,
  { allowCopy = true } = {},
): Promise<Grab> {
  const fg = foreground()
  const source = { app: fg.exe, title: fg.title }
  const blocked = blockedReason(fg)
  if (blocked) return { source, blocked, method: 'none' }
  const extensionGrab = extensionGrabFor?.(fg.exe)
  if (extensionGrab) {
    const r = await extensionGrab().catch(() => undefined)
    if (r?.blocked) return { source, blocked: r.blocked, method: 'extension' }
    if (r && (r.text || r.url)) {
      if (BLOCKED_TITLE.test(r.pageTitle ?? '')) return { source, blocked: '页面像是登录或密码页面', method: 'extension' }
      return { source, method: 'extension', ...r }
    }
  }
  const u = await uia.grab()
  if (u?.isPassword) return { source, blocked: '焦点在密码框里', method: 'uia' }
  if (u?.ok && u.text?.trim()) return { source, method: 'uia', text: u.text }
  if (!allowCopy || NO_COPY_APPS.has(fg.exe)) return { source, method: 'none', text: '' }
  const text = await copySelection()
  return { source, method: text ? 'clipboard' : 'none', text }
}

export { foreground, BROWSERS }
export const elevatedUnderCursor = os.elevatedUnderCursor
export const uiaRequest = uia.request.bind(uia)
export const stopSelectionHelper = () => uia.stop()

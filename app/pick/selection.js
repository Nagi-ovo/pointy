// 按下快捷键的那一刻取"用户选中了什么"：先认前台程序，浏览器问扩展，
// 其他程序读控件（UI Automation / 辅助功能接口），再不行就模拟一次复制并把剪贴板还原。只在被调用时读，不做任何监听。
const { clipboard } = require('electron')
const os = require('../core/os')

const { BROWSERS, NO_COPY_APPS, foreground } = os
const BLOCKED_TITLE = /密码|口令|password|passcode|登录|登陆|sign[ -]?in|log[ -]?in|网上银行|网银|online banking|支付宝|alipay/i
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function blockedReason(fg) {
  if (os.BLOCKED_APPS.has(fg.exe)) return `${fg.exe} 在黑名单里`
  if (BLOCKED_TITLE.test(fg.title)) return '窗口像是登录或密码页面'
  return undefined
}

/** 读控件走一个常驻小进程（Windows 是 UI Automation，macOS 是辅助功能接口），一行命令一行 JSON */
class UiaHelper {
  start() {
    this.proc = os.spawnA11yHelper()
    this.proc.stdout.setEncoding('utf8')
    this.buffer = ''
    this.waiters = []
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let i
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim()
        this.buffer = this.buffer.slice(i + 1)
        let parsed
        try { parsed = JSON.parse(line) } catch { continue }
        this.waiters.shift()?.(parsed)
      }
    })
    this.proc.on('exit', () => {
      this.proc = undefined
      for (const w of this.waiters.splice(0)) w(undefined)
    })
  }

  grab(timeoutMs = 1500) {
    return this.request('grab', timeoutMs)
  }

  /** 发一行命令（grab / point X Y / element X Y UP），等一行 JSON 回来 */
  request(command, timeoutMs = 1500) {
    if (!this.proc) this.start()
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      this.waiters.push(finish)
      this.proc.stdin.write(`${command}\n`)
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
async function copySelection() {
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
  const restore = {}
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
 * @returns {{ source, text?, url?, pageTitle?, before?, after?, method, blocked? }}
 */
async function grabSelection(extensionGrabFor, { allowCopy = true } = {}) {
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

module.exports = {
  grabSelection, foreground, blockedReason, elevatedUnderCursor: os.elevatedUnderCursor, copySelection, BROWSERS,
  uiaRequest: (command, timeoutMs) => uia.request(command, timeoutMs),
  stopSelectionHelper: () => uia.stop(),
}

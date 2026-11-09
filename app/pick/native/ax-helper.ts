// macOS 上读控件的常驻小进程，和 uia-selection.ps1 说同样的话：从 stdin 读一行命令，查一次辅助功能接口，输出一行 JSON。
//   grab              焦点控件里选中的文字
//   point X Y         坐标下的控件，以及往上几层祖先（高亮框用）
//   element X Y UP    坐标下的控件往上 UP 层，取它的名字、值、文字（确认指认时用）
// 坐标是屏幕点（和 Electron 的 DIP 一样）。放在单独的进程里，目标程序卡住时不拖慢 Pointy 的主进程
import readline from 'node:readline'
import { AX, TYPE, constant, cfstr, isType, toString, toArray, CFRelease, CFURLGetString } from '../../core/os/mac/cf.ts'
import type { CFRangeValue, CGPointValue, CGSizeValue } from '../../core/os/mac/cf.ts'
import type { Pointer } from '../../core/os/types.ts'

const AXUIElementCreateSystemWide: () => Pointer = AX.func('void *AXUIElementCreateSystemWide()')
const AXUIElementCreateApplication: (pid: number) => Pointer = AX.func('void *AXUIElementCreateApplication(int32 pid)')
const AXUIElementCopyElementAtPosition: (app: Pointer, x: number, y: number, element: [Pointer | null]) => number = AX.func('int32 AXUIElementCopyElementAtPosition(void *app, float x, float y, _Out_ void **element)')
const AXUIElementCopyAttributeValue: (element: Pointer, attr: Pointer, value: [Pointer | null]) => number = AX.func('int32 AXUIElementCopyAttributeValue(void *element, void *attr, _Out_ void **value)')
const AXUIElementCopyParameterizedAttributeValue: (element: Pointer, attr: Pointer, param: Pointer | null, value: [Pointer | null]) => number = AX.func('int32 AXUIElementCopyParameterizedAttributeValue(void *element, void *attr, void *param, _Out_ void **value)')
const AXUIElementSetAttributeValue: (element: Pointer, attr: Pointer, value: Pointer) => number = AX.func('int32 AXUIElementSetAttributeValue(void *element, void *attr, void *value)')
const AXUIElementGetPid: (element: Pointer, pid: [number]) => number = AX.func('int32 AXUIElementGetPid(void *element, _Out_ int32 *pid)')
const AXUIElementSetMessagingTimeout: (element: Pointer, seconds: number) => number = AX.func('int32 AXUIElementSetMessagingTimeout(void *element, float seconds)')
const AXValueGetPoint: (value: Pointer, type: number, out: CGPointValue) => boolean = AX.func('bool AXValueGetValue(void *value, int32 type, _Out_ CGPoint *out)')
const AXValueGetSize: (value: Pointer, type: number, out: CGSizeValue) => boolean = AX.func('bool AXValueGetValue(void *value, int32 type, _Out_ CGSize *out)')
const AXValueGetRange: (value: Pointer, type: number, out: CFRangeValue) => boolean = AX.func('bool AXValueGetValue(void *value, int32 type, _Out_ CFRange *out)')
const AXValueCreateRange: (type: number, value: CFRangeValue) => Pointer | null = AX.func('void *AXValueCreate(int32 type, CFRange *value)')
const kAXValueCGPointType = 1
const kAXValueCGSizeType = 2
const kAXValueCFRangeType = 4
const kCFBooleanTrue = constant('kCFBooleanTrue')

const MAX_TEXT = 4000
const CHAIN_DEPTH = 8

const systemWide = AXUIElementCreateSystemWide()
// 目标程序没响应时最多等这么久（对系统级元素设置，对所有元素生效）
AXUIElementSetMessagingTimeout(systemWide, 0.8)

// 一条命令里拿到的 CF 对象都记在这里，命令做完一起释放；数组里的元素跟着数组活到那时
let held: Pointer[] = []
const hold = <T extends Pointer | null>(ref: T) => { if (ref) held.push(ref); return ref }
function releaseAll() {
  for (const ref of held) CFRelease(ref)
  held = []
}

function attr(el: Pointer, name: string) {
  const out: [Pointer | null] = [null]
  return AXUIElementCopyAttributeValue(el, cfstr(name), out) === 0 ? hold(out[0]) : undefined
}
const str = (el: Pointer, name: string) => toString(attr(el, name))

function rect(el: Pointer): ScreenRect | null {
  const pos = attr(el, 'AXPosition')
  const size = attr(el, 'AXSize')
  if (!isType(pos, TYPE.axValue) || !isType(size, TYPE.axValue)) return null
  // koffi 把 _Out_ 结构体写进这两个对象
  const p = {} as CGPointValue
  const s = {} as CGSizeValue
  if (!AXValueGetPoint(pos, kAXValueCGPointType, p) || !AXValueGetSize(size, kAXValueCGSizeType, s)) return null
  if (s.width <= 0 || s.height <= 0) return null
  return [Math.round(p.x), Math.round(p.y), Math.round(s.width), Math.round(s.height)]
}

// 角色名换成 UI Automation 的控件类型名，uipick.ts 的中文标签和空壳判断按它走
const CONTROL: Record<string, string> = {
  AXWindow: 'Window', AXSheet: 'Window', AXDialog: 'Window', AXTextArea: 'Document', AXWebArea: 'Document', AXTextField: 'Edit',
  AXComboBox: 'Edit', AXSearchField: 'Edit', AXStaticText: 'Text', AXHeading: 'Text', AXList: 'List', AXOutline: 'List', AXBrowser: 'List',
  AXTable: 'Table', AXGrid: 'Table', AXRow: 'DataItem', AXCell: 'DataItem', AXButton: 'Button', AXPopUpButton: 'Button',
  AXMenuButton: 'Button', AXCheckBox: 'Button', AXRadioButton: 'Button', AXGroup: 'Group', AXSplitGroup: 'Group', AXScrollArea: 'Pane',
  AXLayoutArea: 'Pane', AXLink: 'Hyperlink', AXImage: 'Image', AXMenuItem: 'MenuItem', AXMenuBarItem: 'MenuItem', AXDisclosureTriangle: 'TreeItem',
}
const control = (role: string | undefined) => `ControlType.${(role !== undefined && CONTROL[role]) || 'Custom'}`

const oneLine = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const isPassword = (el: Pointer) => str(el, 'AXRole') === 'AXSecureTextField' || str(el, 'AXSubrole') === 'AXSecureTextField'
const name = (el: Pointer) => str(el, 'AXTitle') || str(el, 'AXDescription') || str(el, 'AXHelp') || ''
const children = (el: Pointer) => toArray(attr(el, 'AXChildren'))
const readable = (el: Pointer) => typeof str(el, 'AXValue') === 'string' || typeof str(el, 'AXSelectedText') === 'string'

// Electron 程序（QQ、网易云、VS Code……）默认不给辅助功能接口建控件树，按程序打开一次
const opened = new Set<number>()
function openElectronTree(el: Pointer) {
  const pid: [number] = [0]
  if (AXUIElementGetPid(el, pid) !== 0 || opened.has(pid[0])) return
  opened.add(pid[0])
  const app = AXUIElementCreateApplication(pid[0])
  AXUIElementSetAttributeValue(app, cfstr('AXManualAccessibility'), kCFBooleanTrue)
  CFRelease(app)
}

function chainAt(x: number, y: number) {
  const out: [Pointer | null] = [null]
  if (AXUIElementCopyElementAtPosition(systemWide, x, y, out) !== 0 || !out[0]) return []
  let el: Pointer | undefined = hold(out[0])
  openElectronTree(el)
  const chain: Pointer[] = []
  while (el && chain.length < CHAIN_DEPTH) {
    const role = str(el, 'AXRole')
    if (role === 'AXApplication') break
    chain.push(el)
    const parent = attr(el, 'AXParent')
    el = isType(parent, TYPE.axElement) ? parent : undefined
  }
  return chain
}

function windowRect(el: Pointer) {
  const win = attr(el, 'AXWindow')
  return isType(win, TYPE.axElement) ? rect(win) : null
}

/** 很长的文字（终端、长文档）只取屏幕上看得见的那段 */
function visibleText(el: Pointer) {
  const range = attr(el, 'AXVisibleCharacterRange')
  if (!isType(range, TYPE.axValue)) return undefined
  const r = {} as CFRangeValue
  if (!AXValueGetRange(range, kAXValueCFRangeType, r)) return undefined
  const param = hold(AXValueCreateRange(kAXValueCFRangeType, { location: r.location, length: Math.min(r.length, MAX_TEXT) }))
  const out: [Pointer | null] = [null]
  if (AXUIElementCopyParameterizedAttributeValue(el, cfstr('AXStringForRange'), param, out) !== 0) return undefined
  return toString(hold(out[0]))
}

/** 控件自身的文字：值，否则子孙控件的值和名字拼起来 */
function textOf(el: Pointer) {
  const value = str(el, 'AXValue')
  if (value) return value.length > MAX_TEXT ? (visibleText(el) || value.slice(-MAX_TEXT)) : value
  if (str(el, 'AXRole') === 'AXLink' && name(el)) return name(el)
  const lines: string[] = []
  let length = 0
  const stack = [el]
  let seen = 0
  while (stack.length && seen < 300 && length < MAX_TEXT) {
    const n = stack.pop()!
    seen++
    const own = str(n, 'AXValue') || str(n, 'AXTitle') || str(n, 'AXDescription')
    if (own) { lines.push(own); length += own.length }
    const kids = children(n)
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i])
  }
  return lines.join('\n')
}

function href(el: Pointer) {
  const url = attr(el, 'AXURL')
  if (!isType(url, TYPE.url)) return undefined
  const s = toString(CFURLGetString(url))
  return /^https?:\/\//.test(s ?? '') ? s : undefined
}

const COMMANDS: Record<string, (...args: string[]) => A11yGrabReply | A11yPointReply | A11yElementReply> = {
  grab(): A11yGrabReply {
    const focused = attr(systemWide, 'AXFocusedUIElement')
    if (!isType(focused, TYPE.axElement)) return { ok: false }
    const result: A11yGrabReply = { ok: false, isPassword: isPassword(focused), control: control(str(focused, 'AXRole')) }
    if (result.isPassword) return result
    const text = str(focused, 'AXSelectedText')
    if (typeof text === 'string') Object.assign(result, { ok: true, text })
    return result
  },
  point(x, y): A11yPointReply {
    const chain = chainAt(Number(x), Number(y))
    const result: A11yPointReply = {
      ok: true,
      chain: chain.map((el) => {
        const role = str(el, 'AXRole')
        return { rect: rect(el), control: control(role), cls: role, name: oneLine(name(el) || (role === 'AXStaticText' ? str(el, 'AXValue') : ''), 60) }
      }),
    }
    if (chain.length) {
      result.leafKids = children(chain[0]).length > 0
      result.leafReadable = readable(chain[0])
      result.win = windowRect(chain[0])
    }
    return result
  },
  element(x, y, up): A11yElementReply {
    const chain = chainAt(Number(x), Number(y))
    if (!chain.length) return { ok: false }
    const el = chain[Math.min(Number(up) || 0, chain.length - 1)]
    if (isPassword(el)) return { ok: false, isPassword: true }
    const role = str(el, 'AXRole')
    const text = textOf(el).trim()
    return {
      ok: true,
      isPassword: false,
      name: name(el),
      control: control(role),
      className: role,
      rect: rect(el),
      kids: children(el).length > 0,
      readable: readable(el),
      win: windowRect(el),
      text: text.slice(0, MAX_TEXT),
      ...(role === 'AXLink' && href(el) ? { href: href(el) } : {}),
    }
  },
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, ...args] = line.trim().split(/\s+/)
  let result
  try {
    result = COMMANDS[command]?.(...args) ?? { ok: false, error: `unknown command ${command}` }
  } catch (err) {
    result = { ok: false, error: String((err as { message?: unknown } | undefined)?.message ?? err) }
  } finally {
    releaseAll()
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
})

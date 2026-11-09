// macOS 的系统框架（CoreFoundation、CoreGraphics、辅助功能、objc）经 koffi 调用，
// 主进程（app/core/os/darwin.js）和读控件的小进程（app/pick/native/ax-helper.js）共用
const koffi = require('koffi')

const framework = (name) => koffi.load(`/System/Library/Frameworks/${name}.framework/${name}`)
const CF = framework('CoreFoundation')
const CG = framework('CoreGraphics')
const AX = framework('ApplicationServices')
const libSystem = koffi.load('/usr/lib/libSystem.B.dylib')
const objc = koffi.load('/usr/lib/libobjc.A.dylib')

const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })
const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' })
const CGRect = koffi.struct('CGRect', { origin: CGPoint, size: CGSize })
const CFRange = koffi.struct('CFRange', { location: 'long', length: 'long' })

const dlsym = libSystem.func('void *dlsym(intptr handle, const char *name)')
const RTLD_DEFAULT = -2n
/** 框架导出的常量（kCFBooleanTrue 这类），读出它指向的对象 */
const constant = (name) => koffi.decode(dlsym(RTLD_DEFAULT, name), 'void *')

const CFRelease = CF.func('void CFRelease(void *ref)')
const CFGetTypeID = CF.func('ulong CFGetTypeID(void *ref)')
const CFStringCreateWithCString = CF.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32 encoding)')
const CFStringGetLength = CF.func('long CFStringGetLength(void *s)')
const CFStringGetCharacters = CF.func('void CFStringGetCharacters(void *s, CFRange range, _Out_ uint16 *buf)')
const CFArrayGetCount = CF.func('long CFArrayGetCount(void *a)')
const CFArrayGetValueAtIndex = CF.func('void *CFArrayGetValueAtIndex(void *a, long i)')
const CFDictionaryGetValue = CF.func('void *CFDictionaryGetValue(void *d, void *key)')
const CFNumberGetValue = CF.func('bool CFNumberGetValue(void *n, long type, _Out_ double *out)')
const CFBooleanGetValue = CF.func('bool CFBooleanGetValue(void *b)')
const CFURLGetString = CF.func('void *CFURLGetString(void *url)')
const TYPE = {
  string: CF.func('ulong CFStringGetTypeID()')(),
  array: CF.func('ulong CFArrayGetTypeID()')(),
  number: CF.func('ulong CFNumberGetTypeID()')(),
  boolean: CF.func('ulong CFBooleanGetTypeID()')(),
  url: CF.func('ulong CFURLGetTypeID()')(),
  axValue: AX.func('ulong AXValueGetTypeID()')(),
  axElement: AX.func('ulong AXUIElementGetTypeID()')(),
}
const kCFStringEncodingUTF8 = 0x08000100
const kCFNumberDoubleType = 13
const MAX_STRING = 200_000

const strings = new Map()
/** 常驻的 CFString（属性名、字典键），按内容缓存，不释放 */
function cfstr(s) {
  let ref = strings.get(s)
  if (!ref) { ref = CFStringCreateWithCString(null, s, kCFStringEncodingUTF8); strings.set(s, ref) }
  return ref
}

const isType = (ref, type) => !!ref && CFGetTypeID(ref) === type

function toString(ref, max = MAX_STRING) {
  if (!isType(ref, TYPE.string)) return undefined
  const length = Math.min(CFStringGetLength(ref), max)
  if (length <= 0) return ''
  const buf = Buffer.alloc(length * 2)
  CFStringGetCharacters(ref, { location: 0, length }, buf)
  return buf.toString('utf16le')
}

function toNumber(ref) {
  if (!isType(ref, TYPE.number)) return undefined
  const out = [0]
  return CFNumberGetValue(ref, kCFNumberDoubleType, out) ? out[0] : undefined
}

function toArray(ref) {
  if (!isType(ref, TYPE.array)) return []
  const n = CFArrayGetCount(ref)
  const out = []
  for (let i = 0; i < n; i++) out.push(CFArrayGetValueAtIndex(ref, i))
  return out
}

const dictGet = (dict, key) => CFDictionaryGetValue(dict, cfstr(key))

// objc：只用到几个无参数的消息
const objc_getClass = objc.func('void *objc_getClass(const char *name)')
const sel_registerName = objc.func('void *sel_registerName(const char *name)')
const msgPtr = objc.func('void *objc_msgSend(void *self, void *sel)')
const msgInt = objc.func('int64 objc_msgSend(void *self, void *sel)')
const msgOrder = objc.func('void objc_msgSend(void *self, void *sel, long mode, long relativeTo)')
/** Electron 窗口背后的 NSWindow（getNativeWindowHandle 给的是它的 NSView） */
const nsWindow = (win) => msgPtr(koffi.decode(win.getNativeWindowHandle(), 'void *'), sel_registerName('window'))
const NSWindowAbove = 1
/** 把窗口排到另一个窗口（可以是别的程序的）正上方 */
const orderAbove = (win, windowNumber) => msgOrder(nsWindow(win), sel_registerName('orderWindow:relativeTo:'), NSWindowAbove, Number(windowNumber))
const send = (target, sel) => msgPtr(typeof target === 'string' ? objc_getClass(target) : target, sel_registerName(sel))
const sendInt = (target, sel) => Number(msgInt(typeof target === 'string' ? objc_getClass(target) : target, sel_registerName(sel)))

module.exports = {
  koffi, CF, CG, AX, libSystem, CGPoint, CGSize, CGRect, CFRange, TYPE,
  constant, cfstr, isType, toString, toNumber, toArray, dictGet, CFRelease, CFBooleanGetValue, CFURLGetString,
  send, sendInt, orderAbove, objc, objc_getClass, sel_registerName, msgPtr,
}

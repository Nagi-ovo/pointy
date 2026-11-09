import * as koffi from 'koffi'
import type { BrowserWindow } from 'electron'
import type { Pointer } from '../types.ts'

export interface CGPointValue { x: number; y: number }
export interface CGSizeValue { width: number; height: number }
export interface CGRectValue { origin: CGPointValue; size: CGSizeValue }
export interface CFRangeValue { location: number; length: number }

const framework = (name: string) => koffi.load(`/System/Library/Frameworks/${name}.framework/${name}`)
export const CF = framework('CoreFoundation')
export const CG = framework('CoreGraphics')
export const AX = framework('ApplicationServices')
export const libSystem = koffi.load('/usr/lib/libSystem.B.dylib')
export const objc = koffi.load('/usr/lib/libobjc.A.dylib')

export const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' })
export const CGSize = koffi.struct('CGSize', { width: 'double', height: 'double' })
export const CGRect = koffi.struct('CGRect', { origin: CGPoint, size: CGSize })
export const CFRange = koffi.struct('CFRange', { location: 'long', length: 'long' })

const dlsym: (handle: bigint, name: string) => Pointer | null = libSystem.func('void *dlsym(intptr handle, const char *name)')
const RTLD_DEFAULT = -2n
/** 框架导出的常量（kCFBooleanTrue 这类），读出它指向的对象 */
export const constant = (name: string): Pointer => koffi.decode(dlsym(RTLD_DEFAULT, name), 'void *')

export const CFRelease: (ref: Pointer) => void = CF.func('void CFRelease(void *ref)')
const CFGetTypeID: (ref: Pointer) => number = CF.func('ulong CFGetTypeID(void *ref)')
const CFStringCreateWithCString: (alloc: null, s: string, encoding: number) => Pointer = CF.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32 encoding)')
const CFStringGetLength: (s: Pointer) => number = CF.func('long CFStringGetLength(void *s)')
const CFStringGetCharacters: (s: Pointer, range: CFRangeValue, buf: Buffer) => void = CF.func('void CFStringGetCharacters(void *s, CFRange range, _Out_ uint16 *buf)')
const CFArrayGetCount: (a: Pointer) => number = CF.func('long CFArrayGetCount(void *a)')
const CFArrayGetValueAtIndex: (a: Pointer, i: number) => Pointer = CF.func('void *CFArrayGetValueAtIndex(void *a, long i)')
const CFDictionaryGetValue: (d: Pointer, key: Pointer) => Pointer | null = CF.func('void *CFDictionaryGetValue(void *d, void *key)')
const CFNumberGetValue: (n: Pointer, type: number, out: [number]) => boolean = CF.func('bool CFNumberGetValue(void *n, long type, _Out_ double *out)')
export const CFBooleanGetValue: (b: Pointer) => boolean = CF.func('bool CFBooleanGetValue(void *b)')
export const CFURLGetString: (url: Pointer) => Pointer | null = CF.func('void *CFURLGetString(void *url)')
export const TYPE: Record<'string' | 'array' | 'number' | 'boolean' | 'url' | 'axValue' | 'axElement', number> = {
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

const strings = new Map<string, Pointer>()
export function cfstr(s: string): Pointer {
  let ref = strings.get(s)
  if (!ref) { ref = CFStringCreateWithCString(null, s, kCFStringEncodingUTF8); strings.set(s, ref) }
  return ref
}

export const isType = (ref: Pointer | null | undefined, type: number): ref is Pointer => !!ref && CFGetTypeID(ref) === type

export function toString(ref: Pointer | null | undefined, max = MAX_STRING): string | undefined {
  if (!isType(ref, TYPE.string)) return undefined
  const length = Math.min(CFStringGetLength(ref), max)
  if (length <= 0) return ''
  const buf = Buffer.alloc(length * 2)
  CFStringGetCharacters(ref, { location: 0, length }, buf)
  return buf.toString('utf16le')
}

export function toNumber(ref: Pointer | null | undefined): number | undefined {
  if (!isType(ref, TYPE.number)) return undefined
  const out: [number] = [0]
  return CFNumberGetValue(ref, kCFNumberDoubleType, out) ? out[0] : undefined
}

export function toArray(ref: Pointer | null | undefined): Pointer[] {
  if (!isType(ref, TYPE.array)) return []
  const n = CFArrayGetCount(ref)
  const out: Pointer[] = []
  for (let i = 0; i < n; i++) out.push(CFArrayGetValueAtIndex(ref, i))
  return out
}

export const dictGet = (dict: Pointer, key: string) => CFDictionaryGetValue(dict, cfstr(key))

export const objc_getClass: (name: string) => Pointer = objc.func('void *objc_getClass(const char *name)')
export const sel_registerName: (name: string) => Pointer = objc.func('void *sel_registerName(const char *name)')
export const msgPtr: (self: Pointer, sel: Pointer) => Pointer = objc.func('void *objc_msgSend(void *self, void *sel)')
const msgInt: (self: Pointer, sel: Pointer) => number | bigint = objc.func('int64 objc_msgSend(void *self, void *sel)')
const msgOrder: (self: Pointer, sel: Pointer, mode: number, relativeTo: number) => void = objc.func('void objc_msgSend(void *self, void *sel, long mode, long relativeTo)')
/** Electron 窗口背后的 NSWindow（getNativeWindowHandle 给的是它的 NSView） */
const nsWindow = (win: BrowserWindow) => msgPtr(koffi.decode(win.getNativeWindowHandle(), 'void *'), sel_registerName('window'))
const NSWindowAbove = 1
export const orderAbove = (win: BrowserWindow, windowNumber: bigint) => msgOrder(nsWindow(win), sel_registerName('orderWindow:relativeTo:'), NSWindowAbove, Number(windowNumber))
export const send = (target: string | Pointer, sel: string) => msgPtr(typeof target === 'string' ? objc_getClass(target) : target, sel_registerName(sel))
export const sendInt = (target: string | Pointer, sel: string) => Number(msgInt(typeof target === 'string' ? objc_getClass(target) : target, sel_registerName(sel)))

export { koffi }

// core/os 对外的样子：win32.ts 和 darwin.ts 各实现一份，index.ts 按平台挑一个
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { BrowserWindow, Display, Point, Rectangle } from 'electron'
import type * as Darwin from './darwin.ts'
import type * as Win32 from './win32.ts'

/** koffi 交回来的原生指针（不透明，只能原样传回给原生函数） */
declare const pointerBrand: unique symbol
export type Pointer = { readonly [pointerBrand]: true }

/** 前台程序；exe 是小写的可执行文件名 */
export interface Foreground {
  hwnd?: bigint
  title: string
  pid?: number
  exePath: string
  exe: string
}

export interface ButtonHooks {
  onLeftUp: () => void
  onRightUp: () => void
  /** +1 往上滚 / -1 往下滚 */
  onWheel: (dir: number) => void
  wantWheel?: () => boolean
}

export type A11yHelperProcess = ChildProcess & { stdin: Writable; stdout: Readable }

export interface Os {
  isFullscreenActive(ownIds?: bigint[]): boolean
  windowId(win: BrowserWindow): bigint
  foregroundId(): bigint
  allowAnyForeground(): void
  /** 挂上了返回 true；调用方没挂上就自己置顶 */
  attachToOwner(win: BrowserWindow, owner: bigint): boolean
  windowOrigin(id: bigint): Point | undefined
  cursor(): Point
  toScreenPoint(dip: Point): Point
  toDipPoint(p: Point): Point
  toDipRect(r: Rectangle): Rectangle
  unitsPerDip(display: Display): number
  cursorVisible(): boolean
  buttonDown(): boolean
  rightButtonDown(): boolean
  modifiersDown(): boolean
  foreground(): Foreground
  elevatedUnderCursor(): boolean
  BROWSERS: Set<string>
  browserKind(exe: string): 'chrome' | 'edge'
  BLOCKED_APPS: Set<string>
  NO_COPY_APPS: Set<string>
  clipboardSeq(): number
  sendCopy(): void
  /** 装不上返回 undefined；装上了返回卸掉钩子的函数 */
  hookButtons(hooks: ButtonHooks): (() => void) | undefined
  swapCursor(scaleFactor: number): void
  /** force 用在启动时，防止上次崩溃留下鲸鱼娘光标 */
  restoreCursor(force?: boolean): void
  spawnA11yHelper(): A11yHelperProcess
  /** 读控件需要的系统权限没给时，返回给用户看的一句话 */
  accessHint(): string | undefined
  /** Pointy 退出后删掉 targets */
  removeAfterExit(targets: string[]): void
}

type Implements<T extends Os> = T
export type PlatformModules = [Implements<typeof Darwin>, Implements<typeof Win32>]

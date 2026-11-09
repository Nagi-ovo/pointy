import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { BrowserWindow, Display, Point, Rectangle } from 'electron'
import type * as Win32 from './win32.ts'

declare const pointerBrand: unique symbol
export type Pointer = { readonly [pointerBrand]: true }

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
  onWheel: (dir: number) => void
  wantWheel?: () => boolean
}

export type A11yHelperProcess = ChildProcess & { stdin: Writable; stdout: Readable }

export interface Os {
  isFullscreenActive(ownIds?: bigint[]): boolean
  windowId(win: BrowserWindow): bigint
  foregroundId(): bigint
  allowAnyForeground(): void
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
  foreground(): Foreground
  elevatedUnderCursor(): boolean
  BROWSERS: Set<string>
  browserKind(exe: string): 'chrome' | 'edge'
  BLOCKED_APPS: Set<string>
  hookButtons(hooks: ButtonHooks): (() => void) | undefined
  swapCursor(scaleFactor: number): void
  restoreCursor(force?: boolean): void
  spawnA11yHelper(): A11yHelperProcess
  accessHint(): string | undefined
  removeAfterExit(targets: string[]): void
}

type Implements<T extends Os> = T
export type PlatformModules = [Implements<typeof Win32>]

// 要不要整个藏起来：全屏应用（游戏、演示）、勿扰、测试实例。变了就通知订阅的人（卡片、胶囊、托盘）
import { settings, TEST_HIDDEN } from './env.ts'

let fullscreen = false
const listeners = new Set<(hidden: boolean) => void>()

export const isFullscreen = () => fullscreen
export const suppressed = () => fullscreen || settings.dnd || TEST_HIDDEN

export function setFullscreen(on: boolean) {
  if (on === fullscreen) return
  fullscreen = on
  visibilityChanged()
}

/** 勿扰开关这类会影响 suppressed() 的设置改完后调一下 */
export function visibilityChanged() {
  for (const fn of listeners) {
    try { fn(suppressed()) } catch {}
  }
}

export const onVisibilityChange = (fn: (hidden: boolean) => void) => listeners.add(fn)

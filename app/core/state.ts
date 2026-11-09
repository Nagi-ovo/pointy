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

export function visibilityChanged() {
  for (const fn of listeners) {
    try { fn(suppressed()) } catch {}
  }
}

export const onVisibilityChange = (fn: (hidden: boolean) => void) => listeners.add(fn)

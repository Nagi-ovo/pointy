// "晃一下鼠标"检测：每 16ms 读一次光标位置，只在内存里保留最近一小段水平移动，用来数方向折返。
// 不装鼠标钩子，拿不到点击和按键，也不记录轨迹。
import os from '../core/os/index.ts'
import type { ShakeLevel } from '../core/env.ts'
import { countReversals } from './reversals.ts'

const POLL_MS = 16
const COOLDOWN_MS = 1500

// 灵敏度：窗口时长、至少几次折返、每段至少多远（屏幕坐标，见 core/os）
export const LEVELS: Record<ShakeLevel, { windowMs: number; reversals: number; amplitude: number }> = {
  low: { windowMs: 400, reversals: 4, amplitude: 60 },
  medium: { windowMs: 450, reversals: 3, amplitude: 40 },
  high: { windowMs: 500, reversals: 3, amplitude: 28 },
}
// 晃的时候上下不能跑太远，否则是在正常移动
const MAX_VERTICAL = 120

/**
 * @param onShake x/y 是屏幕坐标（见 core/os）
 * @param shouldIgnore 全屏、勿扰、正在指认时返回 true
 */
export function startShakeDetector({ onShake, shouldIgnore, level = () => 'medium' }: {
  onShake: (x: number, y: number) => void
  shouldIgnore: () => boolean
  level?: () => ShakeLevel
}) {
  let samples: { t: number; x: number; y: number }[] = [] // 只留窗口时长内的
  let lastFire = 0
  const timer = setInterval(() => {
    const p = os.cursor()
    const now = Date.now()
    const cfg = LEVELS[level()] ?? LEVELS.medium
    samples.push({ t: now, x: p.x, y: p.y })
    samples = samples.filter(s => now - s.t <= cfg.windowMs)
    if (samples.length < 6 || now - lastFire < COOLDOWN_MS) return

    const reversals = countReversals(samples.map(s => s.x), cfg.amplitude)
    const ys = samples.map(s => s.y)
    if (reversals < cfg.reversals) return
    if (Math.max(...ys) - Math.min(...ys) > MAX_VERTICAL) return
    if (shouldIgnore() || os.buttonDown() || !os.cursorVisible()) return
    lastFire = now
    samples = []
    onShake(p.x, p.y)
  }, POLL_MS)

  return () => clearInterval(timer)
}

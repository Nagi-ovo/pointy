// "晃一下鼠标"检测：每 16ms 读一次光标位置，只在内存里保留最近一小段水平移动，用来数方向折返。
// 不装鼠标钩子，拿不到点击和按键，也不记录轨迹。
const os = require('../core/os')

const POLL_MS = 16
const COOLDOWN_MS = 1500

// 灵敏度：窗口时长、至少几次折返、每段至少多远（屏幕坐标，见 core/os）
const LEVELS = {
  low: { windowMs: 400, reversals: 4, amplitude: 60 },
  medium: { windowMs: 450, reversals: 3, amplitude: 40 },
  high: { windowMs: 500, reversals: 3, amplitude: 28 },
}
// 晃的时候上下不能跑太远，否则是在正常移动
const MAX_VERTICAL = 120

/**
 * @param onShake (x, y) => void，x/y 是屏幕坐标（见 core/os）
 * @param shouldIgnore () => boolean，全屏、勿扰、正在指认时返回 true
 */
function startShakeDetector({ onShake, shouldIgnore, level = () => 'medium' }) {
  let samples = [] // { t, x, y }，只留窗口时长内的
  let lastFire = 0
  const timer = setInterval(() => {
    const p = os.cursor()
    const now = Date.now()
    const cfg = LEVELS[level()] ?? LEVELS.medium
    samples.push({ t: now, x: p.x, y: p.y })
    samples = samples.filter(s => now - s.t <= cfg.windowMs)
    if (samples.length < 6 || now - lastFire < COOLDOWN_MS) return

    // 记住当前方向上走到的最远点，从最远点往回走够 amplitude 才算一次折返，小抖动不算
    let reversals = 0
    let dir = 0
    let extreme = samples[0].x
    for (const { x } of samples.slice(1)) {
      if (dir === 0) {
        if (Math.abs(x - extreme) >= cfg.amplitude) { dir = Math.sign(x - extreme); extreme = x }
        continue
      }
      if ((x - extreme) * dir > 0) { extreme = x; continue }
      if (Math.abs(extreme - x) >= cfg.amplitude) { reversals++; dir = -dir; extreme = x }
    }
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

module.exports = { startShakeDetector, LEVELS }

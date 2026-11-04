// "晃一下鼠标"检测：每 16ms 读一次光标位置，只在内存里保留最近一小段水平移动，用来数方向折返。
// 不装鼠标钩子，拿不到点击和按键，也不记录轨迹。
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const CURSORINFO = koffi.struct('CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'intptr', ptScreenPos: POINT })
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *info)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int key)')

const CURSOR_SHOWING = 1
const VK_LBUTTON = 1
const VK_RBUTTON = 2
const VK_MBUTTON = 4
const POLL_MS = 16
const COOLDOWN_MS = 1500

// 灵敏度：窗口时长、至少几次折返、每段至少多少像素（物理像素）
const LEVELS = {
  low: { windowMs: 400, reversals: 4, amplitude: 60 },
  medium: { windowMs: 450, reversals: 3, amplitude: 40 },
  high: { windowMs: 500, reversals: 3, amplitude: 28 },
}
// 晃的时候上下不能跑太远，否则是在正常移动
const MAX_VERTICAL = 120

function cursorVisible() {
  const info = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: 0, ptScreenPos: { x: 0, y: 0 } }
  return GetCursorInfo(info) && (info.flags & CURSOR_SHOWING) !== 0
}

const buttonDown = () => [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON].some(k => (GetAsyncKeyState(k) & 0x8000) !== 0)

/**
 * @param onShake (x, y) => void，x/y 是物理像素坐标
 * @param shouldIgnore () => boolean，全屏、勿扰、正在指认时返回 true
 */
function startShakeDetector({ onShake, shouldIgnore, level = () => 'medium' }) {
  let samples = [] // { t, x, y }，只留窗口时长内的
  let lastFire = 0
  const p = { x: 0, y: 0 }

  const timer = setInterval(() => {
    if (!GetCursorPos(p)) return
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
    if (shouldIgnore() || buttonDown() || !cursorVisible()) return
    lastFire = now
    samples = []
    onShake(p.x, p.y)
  }, POLL_MS)

  return () => clearInterval(timer)
}

module.exports = { startShakeDetector, LEVELS }

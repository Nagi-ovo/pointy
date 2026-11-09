// 晃动检测里数方向折返的那一步，单独放这里（不碰系统接口，测试直接用）

/**
 * 一串水平坐标里来回折返了几次。
 * 记住当前方向上走到的最远点，从最远点往回走够 amplitude 才算一次折返，小抖动不算
 */
export function countReversals(xs: number[], amplitude: number) {
  let reversals = 0
  let dir = 0
  let extreme = xs[0]
  for (const x of xs.slice(1)) {
    if (dir === 0) {
      if (Math.abs(x - extreme) >= amplitude) { dir = Math.sign(x - extreme); extreme = x }
      continue
    }
    if ((x - extreme) * dir > 0) { extreme = x; continue }
    if (Math.abs(extreme - x) >= amplitude) { reversals++; dir = -dir; extreme = x }
  }
  return reversals
}

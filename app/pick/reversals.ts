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

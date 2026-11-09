// QQ、网易云这类 Electron 程序关了无障碍，整个窗口只露出一个空壳控件
const CHROMIUM_SHELL = /^Chrome_(RenderWidgetHostHWND|WidgetWin_\d+)$|^Intermediate D3D Window$/

export interface ControlShape {
  cls?: string
  rect?: ScreenRect | null
  kids?: boolean
  readable?: boolean
  win?: ScreenRect | null
  control?: string
}

export function isOpaque({ cls, rect, kids, readable, win, control }: ControlShape) {
  if (CHROMIUM_SHELL.test(cls ?? '')) return true
  if (isWholeWindow({ rect, win, control })) return true
  if (kids || readable || !rect || !win) return false
  return coverage(rect, win) >= 0.9
}
export const coverage = (r: ScreenRect, w: ScreenRect) => (r[2] * r[3]) / Math.max(1, w[2] * w[3])
export const isWholeWindow = ({ rect, win, control }: Pick<ControlShape, 'rect' | 'win' | 'control'>) => control === 'ControlType.Window' && !!rect && !!win && coverage(rect, win) >= 0.98
const FOCUS_W = 720
const FOCUS_H = 320
export function focusRect(rect: ScreenRect, point: { x: number; y: number }, scale: number, zoom = 1): ScreenRect | undefined {
  if (rect[2] <= FOCUS_W * scale * 1.4 && rect[3] <= FOCUS_H * scale * 1.4) return undefined
  const w = Math.round(FOCUS_W * scale * zoom)
  const h = Math.round(FOCUS_H * scale * zoom)
  const cw = Math.min(w, rect[2])
  const ch = Math.min(h, rect[3])
  const x = Math.min(Math.max(point.x - cw / 2, rect[0]), rect[0] + rect[2] - cw)
  const y = Math.min(Math.max(point.y - ch / 2, rect[1]), rect[1] + rect[3] - ch)
  return [Math.round(x), Math.round(y), cw, ch]
}

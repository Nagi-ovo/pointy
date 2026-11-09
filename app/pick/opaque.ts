// 指认时的两条纯判断（不碰系统接口，uipick.ts 用，测试直接用）：读不到里面东西的空壳控件，和空壳里跟着鼠标的小框

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

/**
 * 读不到里面东西的程序：要么是 Chromium 空壳类名；要么这个控件没有子控件、没有文字接口、还几乎占满整个窗口
 * （游戏、Qt、自绘界面）。普通程序里晃到的大面板一般有子控件，编辑区有文字接口，不会算进来
 */
export function isOpaque({ cls, rect, kids, readable, win, control }: ControlShape) {
  if (CHROMIUM_SHELL.test(cls ?? '')) return true
  if (isWholeWindow({ rect, win, control })) return true
  if (kids || readable || !rect || !win) return false
  return coverage(rect, win) >= 0.9
}
export const coverage = (r: ScreenRect, w: ScreenRect) => (r[2] * r[3]) / Math.max(1, w[2] * w[3])
/** 指到的就是整个程序窗口本身（系统只给了一个框，比如 Windows Terminal）：也给虚线小框 */
export const isWholeWindow = ({ rect, win, control }: Pick<ControlShape, 'rect' | 'win' | 'control'>) => control === 'ControlType.Window' && !!rect && !!win && coverage(rect, win) >= 0.98
// 空壳里再加一个跟着鼠标的小框（DIP），截图只截它；滚轮按档缩放
const FOCUS_W = 720
const FOCUS_H = 320
/** 鼠标为中心、不超出大框的小框（屏幕坐标，scale 是每个 DIP 几个单位）；大框本来就不大时 undefined */
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

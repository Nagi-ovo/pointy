// pick.ts 是注入网页的经典脚本，和 background.ts 不在一个工程里，共用的类型放这里（两个 tsconfig 都带上）

interface PointyRect { x: number, y: number, width: number, height: number }

/** Pointy 告诉的光标屏幕坐标（物理像素） */
interface PointyCursor { x: number, y: number }

/** pick.ts 的 describe() 交给扩展的一块内容 */
interface PickedElement {
  kind: string
  site: string
  fields: Record<string, string>
  page: Record<string, string>
  text: string
  links: { text: string, href: string }[]
  images: { src: string, alt: string }[]
  tag: string
  rect: PointyRect
  viewport: { width: number, height: number, dpr: number }
}

/** pick.ts -> background.ts */
type PickResultMessage = { type: 'pick-result', result: PickedElement, cancelled?: undefined } | { type: 'pick-result', cancelled: true, result?: undefined }

/** background.ts -> pick.ts */
type PickControlMessage = { type: 'pick-abort' } | { type: 'pick-hold', reqId: string } | { type: 'pick-release', reqId: string }

interface Window {
  __pointyStart?: PointyCursor | null
  __pointyPick?: boolean
  __pointyPickCleanup?: () => void
  __pointyHeld?: () => void
}

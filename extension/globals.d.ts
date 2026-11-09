interface PointyRect { x: number, y: number, width: number, height: number }

interface PointyCursor { x: number, y: number }

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

type PickResultMessage = { type: 'pick-result', result: PickedElement, cancelled?: undefined } | { type: 'pick-result', cancelled: true, result?: undefined }

type PickControlMessage = { type: 'pick-abort' } | { type: 'pick-hold', reqId: string } | { type: 'pick-release', reqId: string }

interface Window {
  __pointyStart?: PointyCursor | null
  __pointyPick?: boolean
  __pointyPickCleanup?: () => void
  __pointyHeld?: () => void
}

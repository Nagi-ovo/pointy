window.overlay = {
  onHighlight: (fn) => { goEvents.highlight.on(fn) },
  onHold: (fn) => { goEvents.hold.on(() => fn()) },
  onShift: (fn) => { goEvents.shift.on(fn) },
  onNote: (fn) => { goEvents.note.on(fn) },
} satisfies OverlayApi

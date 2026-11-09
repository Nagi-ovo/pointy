const goPill = goService('Pill')

window.pill = {
  onList: (fn) => { goEvents.pills.on(fn) },
  open: (id) => { goPill.open(id) },
  dismiss: (id) => { goPill.dismiss(id) },
  resize: (height) => { goPill.resize(height) },
} satisfies PillApi

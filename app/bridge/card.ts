const goCard = goService('Card')

window.card = {
  onInit: (fn) => {
    goCard.init().then((d) => fn(d.mode === 'pair' ? { mode: 'pair', code: d.code ?? '' } : { grab: d.grab!, agent: d.agent ?? { name: '' } }))
  },
  onAgent: (fn) => { goEvents.agent.on((msg) => fn(msg as AgentEvent)) },
  send: (msg) => goCard.send(msg),
  close: () => { goCard.close() },
  openAgent: (sessionId) => { goCard.openAgent(sessionId ?? '') },
  copy: (text) => { goCard.copy(text) },
  resize: (height) => { goCard.resize(height) },
  menuRoom: (height) => { goCard.menuRoom(height) },
  rendered: (name) => { goCard.rendered(name) },
  keep: (info) => { goCard.keep(info) },
  onSetAside: (fn) => { goEvents.cardSetAside.on(() => fn()) },
  onRestore: (fn) => { goEvents.cardRestore.on(() => fn()) },
  openLink: (href) => { goCard.openLink(href) },
  openImage: (path) => { goCard.openImage(path) },
  extensionGuide: () => { goCard.extensionGuide() },
  gripStart: () => { goCard.gripStart() },
  gripMove: () => { goCard.gripMove() },
  gripEnd: () => { goCard.gripEnd() },
  asked: () => { goCard.asked() },
} satisfies CardApi

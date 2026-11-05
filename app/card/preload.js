const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('card', {
  onInit: (fn) => ipcRenderer.on('card-init', (_e, data) => fn(data)),
  onAgent: (fn) => ipcRenderer.on('agent', (_e, msg) => fn(msg)),
  send: (msg) => ipcRenderer.invoke('card-to-agent', msg),
  close: () => ipcRenderer.send('card-close'),
  openAgent: (sessionId) => ipcRenderer.send('card-open-agent', sessionId),
  copy: (text) => ipcRenderer.send('card-copy', text),
  resize: (height) => ipcRenderer.send('card-resize', height),
  menuRoom: (height) => ipcRenderer.send('card-menu-room', height),
  rendered: (name) => ipcRenderer.send('card-rendered', name),
  keep: (info) => ipcRenderer.send('card-keep', info),
  onSetAside: (fn) => ipcRenderer.on('card-set-aside', () => fn()),
  onRestore: (fn) => ipcRenderer.on('card-restore', () => fn()),
  openLink: (href) => ipcRenderer.send('card-open-link', href),
  gripStart: () => ipcRenderer.send('card-grip-start'),
  gripMove: () => ipcRenderer.send('card-grip-move'),
  gripEnd: () => ipcRenderer.send('card-grip-end'),
  asked: () => ipcRenderer.send('card-asked'),
})

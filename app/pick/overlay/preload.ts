import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('overlay', {
  onHighlight: (fn) => ipcRenderer.on('highlight', (_e, h) => fn(h)),
  onHold: (fn) => ipcRenderer.on('hold', () => fn()),
  onShift: (fn) => ipcRenderer.on('shift', (_e, d) => fn(d)),
  onNote: (fn) => ipcRenderer.on('note', (_e, text) => fn(text)),
} satisfies OverlayApi)

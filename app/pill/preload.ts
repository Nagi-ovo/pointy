import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('pill', {
  onList: (fn) => ipcRenderer.on('pills', (_e, items) => fn(items)),
  open: (id) => ipcRenderer.send('pill-open', id),
  dismiss: (id) => ipcRenderer.send('pill-dismiss', id),
  resize: (height) => ipcRenderer.send('pill-resize', height),
} satisfies PillApi)

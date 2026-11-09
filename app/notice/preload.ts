import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('notice', {
  onInit: (fn) => ipcRenderer.on('notice-init', (_e, data) => fn(data)),
  choose: (id) => ipcRenderer.send('notice-choose', id),
  resize: (height) => ipcRenderer.send('notice-resize', height),
  copy: (text) => ipcRenderer.send('notice-copy', text),
} satisfies NoticeApi)

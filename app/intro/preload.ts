const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('intro', {
  onInit: (fn) => ipcRenderer.on('intro-init', (_e, data) => fn(data)),
  done: () => ipcRenderer.send('intro-done'),
})

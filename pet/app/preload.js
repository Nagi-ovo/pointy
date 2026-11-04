const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  onDsh: (fn) => ipcRenderer.on('dsh', (_e, msg) => fn(msg)),
  send: (msg) => ipcRenderer.invoke('to-plugin', msg),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', dx, dy),
  front: (on) => ipcRenderer.send('front', on),
  menu: () => ipcRenderer.send('menu'),
  approvals: (count) => ipcRenderer.send('approvals', count),
  clicked: () => ipcRenderer.send('pet-clicked'),
  rendered: (state) => ipcRenderer.send('rendered', state),
  pathForFile: (file) => webUtils.getPathForFile(file),
  layout: (layout) => ipcRenderer.send('pet-layout', layout),
  dragging: (on) => ipcRenderer.send('pet-dragging', on),
  scaleBy: (delta) => ipcRenderer.send('pet-scale-by', delta),
})

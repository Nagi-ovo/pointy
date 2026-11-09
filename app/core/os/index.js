// 和操作系统打交道的都在这里，各平台一份，对外的样子相同（见 win32.js 末尾的导出）。
// 屏幕坐标：Windows 是物理像素，macOS 是点；要和 Electron 的 DIP 互换就用这里的 toScreenPoint / toDipRect
module.exports = process.platform === 'darwin' ? require('./darwin') : require('./win32')

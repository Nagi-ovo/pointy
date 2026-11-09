// 和操作系统打交道的都在这里，各平台一份，对外的样子相同（见 types.ts 的 Os）。
// 屏幕坐标：Windows 是物理像素，macOS 是点；要和 Electron 的 DIP 互换就用这里的 toScreenPoint / toDipRect
import type { Os } from './types.ts'

// 运行时按平台 require 不带扩展名的路径：macOS 上不加载 win32，反之亦然
const os: Os = process.platform === 'darwin' ? require('./darwin') : require('./win32')

export default os

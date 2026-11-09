// 屏幕坐标：Windows 是物理像素，macOS 是点
import type { Os } from './types.ts'

const os: Os = process.platform === 'darwin' ? require('./darwin') : require('./win32')

export default os

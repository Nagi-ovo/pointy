// Electron 只在 Windows 上跑了（macOS 由 desktop/ 的 Go 程序接管），屏幕坐标是物理像素
import type { Os } from './types.ts'

const os: Os = require('./win32')

export default os

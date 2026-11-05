// 要不要整个藏起来：全屏应用（游戏、演示）、勿扰、测试实例。变了就通知订阅的人（卡片、胶囊、托盘）
const { settings, TEST_HIDDEN } = require('./env')

let fullscreen = false
const listeners = new Set()

const isFullscreen = () => fullscreen
const suppressed = () => fullscreen || settings.dnd || TEST_HIDDEN

function setFullscreen(on) {
  if (on === fullscreen) return
  fullscreen = on
  visibilityChanged()
}

/** 勿扰开关这类会影响 suppressed() 的设置改完后调一下 */
function visibilityChanged() {
  for (const fn of listeners) {
    try { fn(suppressed()) } catch {}
  }
}

const onVisibilityChange = (fn) => listeners.add(fn)

module.exports = { isFullscreen, suppressed, setFullscreen, visibilityChanged, onVisibilityChange }

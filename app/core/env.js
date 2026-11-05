// 进程级的共用东西：路径、环境变量、错误日志、设置。不依赖其他模块
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** app/ 目录：窗口页面（card/、pill/、notice/、intro/）都按它找 */
const APP_DIR = path.join(__dirname, '..')
const ROOT_DIR = path.join(APP_DIR, '..')

const PORT = Number(process.env.POINTY_PORT) || 47321
// POINTY_HOME 只给测试用（卸载清理的测试不能碰真的 ~/.pointy）
const HOME_DIR = process.env.POINTY_HOME || path.join(os.homedir(), '.pointy')
const SETTINGS_FILE = path.join(HOME_DIR, 'settings.json')
// 测试用：窗口不显示、不注册托盘和晃动检测，挂 global.pointyTest
const TEST_HIDDEN = process.env.POINTY_TEST_HIDDEN === '1'
// 调试用：设了这个目录，卡片渲染到关键状态时截一张图存进去
const CAPTURE_DIR = process.env.POINTY_CAPTURE
const TRAY_ICON = path.join(ROOT_DIR, 'assets', 'tray.png')

// 主进程出错只记到这里，不弹 Electron 的系统错误框（用户可能正在玩全屏游戏）
const ERROR_LOG = path.join(HOME_DIR, 'error.log')
const ERROR_LOG_MAX = 256 * 1024
function logError(kind, err) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true })
    if ((fs.statSync(ERROR_LOG, { throwIfNoEntry: false })?.size ?? 0) > ERROR_LOG_MAX) fs.rmSync(ERROR_LOG)
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} [${kind}] ${err?.stack ?? err}\n`)
  } catch {}
}

const DEFAULT_SETTINGS = { dnd: false, shake: true, shakeLevel: 'medium', welcomed: false }
/** 当前设置；改用 saveSettings，别直接赋值 */
const settings = loadSettings()

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } } catch { return { ...DEFAULT_SETTINGS } }
}

function saveSettings(patch) {
  Object.assign(settings, patch)
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

/** 版本号：插件形态从插件包的 package.json 读，开发版没有插件包就用 app 自己的 */
function installedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, '..', 'package.json'), 'utf8')).version } catch {}
  return app.getVersion()
}

module.exports = { APP_DIR, ROOT_DIR, PORT, HOME_DIR, TEST_HIDDEN, CAPTURE_DIR, TRAY_ICON, logError, settings, saveSettings, installedVersion }

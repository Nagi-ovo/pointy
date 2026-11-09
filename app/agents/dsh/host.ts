// Pointy 作为 DSH 插件跑时，跟 DSH 这个宿主有关的生命周期：
// 由插件拉起（POINTY_MANAGED=1）、DSH 关了跟着退、插件被卸载后清理自己、清掉旧版留下的启动方式
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR, ROOT_DIR, TEST_HIDDEN, logError } from '../../core/env.ts'
import os from '../../core/os/index.ts'

// 由 DSH 插件拉起（插件形态）：DSH 关了 Pointy 也跟着退
const MANAGED = process.env.POINTY_MANAGED === '1'
// 插件断开这么久没回来，就当 DSH 退出了（插件重载会马上重连）
const QUIT_GRACE_MS = 10_000
// 旧版插件按它拉起 Pointy；现在插件自带 Pointy，这个文件启动时删掉
const LAUNCH_FILE = path.join(HOME_DIR, 'launch.json')
// 插件形态下 Pointy 从插件包里的 pet/ 运行：app/ 的上两级是插件包根目录
const PLUGIN_ROOT = path.resolve(ROOT_DIR, '..')

let quitTimer: NodeJS.Timeout | undefined
let isConnected = () => false

/** 旧版留下的：开机自启项和 launch.json。现在只由 DSH 插件拉起，这两样清掉 */
function dropOldAutostart() {
  try {
    const item = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
    if (app.getLoginItemSettings(item).openAtLogin) app.setLoginItemSettings({ ...item, openAtLogin: false })
  } catch (err) { logError('login-item', err) }
  fs.rmSync(LAUNCH_FILE, { force: true })
}

/**
 * 插件拉起 Pointy 后、还没连上，DSH 就退了（比如刚装完重开 DSH 那几秒），Pointy 会一直挂着、显示 DSH 未连接。
 * 拉起它的宿主进程没了、插件也没连着，就退出；下次 DSH 启动会再拉起。
 */
function quitIfOrphaned() {
  const host = Number(process.env.POINTY_HOST_PID)
  if (isConnected() || !Number.isInteger(host) || host <= 0) return
  try { process.kill(host, 0) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') { logError('orphan', `DSH host ${host} is gone and no plugin is connected; quitting`); app.quit() }
  }
}

/** 启动时调一次。connected：插件现在连着没有 */
export function start(connected: () => boolean) {
  isConnected = connected
  if (!TEST_HIDDEN) dropOldAutostart()
  if (MANAGED) setInterval(quitIfOrphaned, 5000)
}

export function linked() {
  clearTimeout(quitTimer)
}

export function unlinked(everConnected: boolean) {
  clearTimeout(quitTimer)
  if (everConnected && MANAGED) quitTimer = setTimeout(() => { if (!isConnected()) app.quit() }, QUIT_GRACE_MS)
}

// ---------- 插件被卸载后清理自己 ----------
// DSH 卸载插件时（pnpm remove）删掉了包根目录的 package.json、src、lib，
// pet/ 因为 Pointy 还开着（Windows 上 koffi.node 被占着）删不干净。等 DSH 退出、Pointy 跟着退出时，看到包已经没了，
// 就把运行时、设置和插件残留一起删掉。DSH 没开时用命令行卸载的话 Pointy 不在运行，这条路走不到。
function pluginUninstalled() {
  // 只在确实是从 node_modules/@pointylab/dsh 里跑的时候才判断，开发版不碰
  if (!/[\\/]node_modules[\\/]@pointylab[\\/]dsh$/i.test(PLUGIN_ROOT)) return false
  return !fs.existsSync(path.join(PLUGIN_ROOT, 'package.json'))
}

function cleanUpAfterUninstall() {
  const targets = [HOME_DIR, app.getPath('userData'), PLUGIN_ROOT].filter((p) => fs.existsSync(p))
  logError('uninstall', `plugin removed; cleaning ${targets.join(', ')}`)
  try { os.removeAfterExit(targets) } catch (err) { logError('uninstall', err) }
}

/** 退出时调：插件已经被卸载了就清理 */
export function willQuit() {
  if (MANAGED && (!TEST_HIDDEN || process.env.POINTY_TEST_UNINSTALL === '1') && pluginUninstalled()) cleanUpAfterUninstall()
}

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR, ROOT_DIR, TEST_HIDDEN, logError } from '../../core/env.ts'
import os from '../../core/os/index.ts'

const MANAGED = process.env.POINTY_MANAGED === '1'
const QUIT_GRACE_MS = 10_000
const LAUNCH_FILE = path.join(HOME_DIR, 'launch.json')
const PLUGIN_ROOT = path.resolve(ROOT_DIR, '..')

let quitTimer: NodeJS.Timeout | undefined
let isConnected = () => false

function dropOldAutostart() {
  try {
    const item = { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }
    if (app.getLoginItemSettings(item).openAtLogin) app.setLoginItemSettings({ ...item, openAtLogin: false })
  } catch (err) { logError('login-item', err) }
  fs.rmSync(LAUNCH_FILE, { force: true })
}

function quitIfOrphaned() {
  const host = Number(process.env.POINTY_HOST_PID)
  if (isConnected() || !Number.isInteger(host) || host <= 0) return
  try { process.kill(host, 0) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') { logError('orphan', `DSH host ${host} is gone and no plugin is connected; quitting`); app.quit() }
  }
}

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

// DSH 卸载插件时（pnpm remove）删掉了包根目录的 package.json、src、lib，
// pet/ 因为 Pointy 还开着（Windows 上 koffi.node 被占着）删不干净。
function pluginUninstalled() {
  if (!/[\\/]node_modules[\\/]@pointylab[\\/]dsh$/i.test(PLUGIN_ROOT)) return false
  return !fs.existsSync(path.join(PLUGIN_ROOT, 'package.json'))
}

function cleanUpAfterUninstall() {
  const targets = [HOME_DIR, app.getPath('userData'), PLUGIN_ROOT].filter((p) => fs.existsSync(p))
  logError('uninstall', `plugin removed; cleaning ${targets.join(', ')}`)
  try { os.removeAfterExit(targets) } catch (err) { logError('uninstall', err) }
}

export function willQuit() {
  if (MANAGED && (!TEST_HIDDEN || process.env.POINTY_TEST_UNINSTALL === '1') && pluginUninstalled()) cleanUpAfterUninstall()
}

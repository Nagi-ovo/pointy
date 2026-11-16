import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PET_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pet')
export const PLUGIN_ROOT = path.dirname(PET_APP_DIR)
export const APP_DIR = path.join(os.homedir(), '.pointy', 'app')
const RUNTIME_DIR = path.join(os.homedir(), '.pointy', 'runtime')
const MAC_APP = path.join(PET_APP_DIR, 'Pointy.app')
/** The package carries one Pointy.exe per architecture, beside the pages they share in pet/. */
const WINDOWS_DIRS: Record<string, string | undefined> = { x64: 'win32-x64', arm64: 'win32-arm64' }
const SHARED_DIRS = ['app', 'assets', 'extension'] as const
export const READY_MARKER = '.ready'
export const MAX_REPLACE_ATTEMPTS = 3

export type Logger = Pick<Console, 'info' | 'warn'>
/** How the plugin starts Pointy: run exe with args in cwd. */
export interface Launch { exe: string, args: string[], cwd: string }
export type PeerAction = 'use' | 'quit' | 'wait' | 'give-up'

/**
 * Pointy is the Go app the package carries. On macOS LaunchServices starts
 * it, not this process, so macOS asks the user to trust Pointy rather than
 * DSH, and the app inherits this environment. On Windows the bundle is staged
 * outside node_modules first so a running Pointy.exe never blocks pnpm when
 * DSH updates the plugin in place. log is the file Pointy's output goes to.
 */
export function petLaunch(logger: Logger, log: string, version: string): Launch {
  const launch = launchOf(log, version)
  removeElectron(logger)
  return launch
}

function launchOf(log: string, version: string): Launch {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(path.join(MAC_APP, 'Contents', 'MacOS', 'Pointy'))) throw new Error(`${MAC_APP} is missing; reinstall the plugin`)
    return { exe: '/usr/bin/open', args: ['-n', '-g', '--stdout', log, '--stderr', log, MAC_APP], cwd: PET_APP_DIR }
  }
  if (process.platform === 'win32') {
    if (version && version !== '?') {
      const staged = stageWindowsApp(PET_APP_DIR, APP_DIR, version, process.arch)
      return { exe: staged.exe, args: [], cwd: staged.cwd }
    }
    const dir = WINDOWS_DIRS[process.arch]
    if (!dir) throw new Error(`Pointy runs on Windows x64 and arm64, not ${process.arch}`)
    const exe = path.join(PET_APP_DIR, dir, 'Pointy.exe')
    if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; reinstall the plugin`)
    return { exe, args: [], cwd: PET_APP_DIR }
  }
  throw new Error(`Pointy runs on Windows and macOS, not ${process.platform}`)
}

/**
 * Atomically stages the Windows runtime for version under appRoot/<version>,
 * keeping the pet/ layout so Pointy's resourceRoot() finds app/, assets/ and
 * extension/ two levels above Pointy.exe.
 */
export function stageWindowsApp(srcDir: string, appRoot: string, version: string, arch: string): { exe: string, cwd: string } {
  const winDir = WINDOWS_DIRS[arch]
  if (!winDir) throw new Error(`Pointy runs on Windows x64 and arm64, not ${arch}`)
  const dest = path.join(appRoot, version)
  const exeOf = (dir: string) => path.join(dir, winDir, 'Pointy.exe')
  const isReady = (dir: string) => fs.existsSync(path.join(dir, READY_MARKER)) && fs.existsSync(exeOf(dir))
  if (isReady(dest)) return { exe: exeOf(dest), cwd: dest }

  const srcExe = exeOf(srcDir)
  if (!fs.existsSync(srcExe)) throw new Error(`${srcExe} is missing; reinstall the plugin`)

  fs.mkdirSync(appRoot, { recursive: true })
  if (fs.existsSync(dest) && !isReady(dest)) {
    fs.rmSync(dest, { recursive: true, force: true })
  }

  const tmp = path.join(appRoot, `${version}.tmp-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    for (const sub of SHARED_DIRS) {
      fs.cpSync(path.join(srcDir, sub), path.join(tmp, sub), { recursive: true })
    }
    const dstExe = exeOf(tmp)
    fs.mkdirSync(path.dirname(dstExe), { recursive: true })
    fs.copyFileSync(srcExe, dstExe)
    fs.writeFileSync(path.join(tmp, READY_MARKER), `${version}\n`)
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw error
  }

  try {
    fs.renameSync(tmp, dest)
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!isReady(dest)) throw error
  }
  return { exe: exeOf(dest), cwd: dest }
}

/**
 * Best-effort cleanup of other staged versions under appRoot. Locked files from
 * a still-exiting Pointy are skipped until the next launch.
 */
export function cleanOldApps(appRoot: string, currentVersion: string) {
  if (!currentVersion || currentVersion === '?' || !fs.existsSync(appRoot)) return
  let entries: string[]
  try {
    entries = fs.readdirSync(appRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === currentVersion) continue
    try {
      fs.rmSync(path.join(appRoot, entry), { recursive: true, force: true })
    } catch {
      // Locked by a running Pointy (EPERM/EBUSY); leave for next start.
    }
  }
}

/**
 * Decides whether a Go Pointy already holding the port should be replaced.
 * Managed instances from another version get a quit message; 0.5.0 and earlier
 * Go builds sent no version and exit on their own after the plugin disconnects.
 */
export function peerAction(
  peer: { version?: unknown, managed?: unknown },
  pluginVersion: string,
  attempts: number,
): PeerAction {
  if (!pluginVersion || pluginVersion === '?') return 'use'
  let want: 'quit' | 'wait' | undefined
  if (typeof peer.version === 'string') {
    if (peer.version !== pluginVersion && peer.managed === true) want = 'quit'
  } else {
    want = 'wait'
  }
  if (!want) return 'use'
  return attempts < MAX_REPLACE_ATTEMPTS ? want : 'give-up'
}

/**
 * A Pointy this plugin started can come back unmanaged when macOS reopens it
 * without our environment; sending our PID lets it adopt us as its host.
 */
export function readyMessage(
  pluginVersion: string,
  peer: { managed?: unknown },
  launchedPet: boolean,
  hostPid: number,
): { type: 'ready', plugin: string, hostPid?: number } {
  return {
    type: 'ready',
    plugin: pluginVersion,
    ...(launchedPet && peer.managed === false ? { hostPid } : {}),
  }
}

/**
 * Earlier builds downloaded Electron into RUNTIME_DIR. The rest of ~/.pointy
 * holds the user's settings and stays. Windows keeps a running Electron's
 * files locked, so a failure waits for the next start.
 */
function removeElectron(logger: Logger) {
  if (!fs.existsSync(RUNTIME_DIR)) return
  try {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true, maxRetries: 5 })
    logger.info(`pointy: removed the Electron runtime in ${RUNTIME_DIR}`)
  } catch (error) {
    logger.warn(`pointy: could not remove ${RUNTIME_DIR} yet: ${(error as Error).message}`)
  }
}

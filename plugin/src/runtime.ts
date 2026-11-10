import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PET_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pet')
const RUNTIME_DIR = path.join(os.homedir(), '.pointy', 'runtime')
const MAC_APP = path.join(PET_APP_DIR, 'Pointy.app')
/** The package carries one Pointy.exe per architecture, beside the pages they share in pet/. */
const WINDOWS_DIRS: Record<string, string | undefined> = { x64: 'win32-x64', arm64: 'win32-arm64' }

export type Logger = Pick<Console, 'info' | 'warn'>
/** How the plugin starts Pointy: run exe with args. */
export interface Launch { exe: string, args: string[] }

/**
 * Pointy is the Go app the package carries. On macOS LaunchServices starts
 * it, not this process, so macOS asks the user to trust Pointy rather than
 * DSH, and the app inherits this environment. log is the file Pointy's
 * output goes to.
 */
export function petLaunch(logger: Logger, log: string): Launch {
  const launch = launchOf(log)
  removeElectron(logger)
  return launch
}

function launchOf(log: string): Launch {
  if (process.platform === 'darwin') {
    if (!fs.existsSync(path.join(MAC_APP, 'Contents', 'MacOS', 'Pointy'))) throw new Error(`${MAC_APP} is missing; reinstall the plugin`)
    return { exe: '/usr/bin/open', args: ['-n', '-g', '--stdout', log, '--stderr', log, MAC_APP] }
  }
  if (process.platform === 'win32') {
    const dir = WINDOWS_DIRS[process.arch]
    if (!dir) throw new Error(`Pointy runs on Windows x64 and arm64, not ${process.arch}`)
    const exe = path.join(PET_APP_DIR, dir, 'Pointy.exe')
    if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; reinstall the plugin`)
    return { exe, args: [] }
  }
  throw new Error(`Pointy runs on Windows and macOS, not ${process.platform}`)
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

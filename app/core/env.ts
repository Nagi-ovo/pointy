import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const APP_DIR = path.join(__dirname, '..')
export const ROOT_DIR = path.join(APP_DIR, '..')

export const PORT = Number(process.env.POINTY_PORT) || 47321
export const HOME_DIR = process.env.POINTY_HOME || path.join(os.homedir(), '.pointy')
const SETTINGS_FILE = path.join(HOME_DIR, 'settings.json')
export const TEST_HIDDEN = process.env.POINTY_TEST_HIDDEN === '1'
export const CAPTURE_DIR = process.env.POINTY_CAPTURE
export const TRAY_ICON = path.join(ROOT_DIR, 'assets', 'tray.png')

const ERROR_LOG = path.join(HOME_DIR, 'error.log')
const ERROR_LOG_MAX = 256 * 1024
export function logError(kind: string, err: unknown) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true })
    if ((fs.statSync(ERROR_LOG, { throwIfNoEntry: false })?.size ?? 0) > ERROR_LOG_MAX) fs.rmSync(ERROR_LOG)
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} [${kind}] ${(err as { stack?: unknown } | undefined)?.stack ?? err}\n`)
  } catch {}
}

export type ShakeLevel = 'low' | 'medium' | 'high'
export interface Settings {
  dnd: boolean
  shake: boolean
  shakeLevel: ShakeLevel
  welcomed: boolean
  welcomedVersion?: string
  debugPick?: boolean
}

const DEFAULT_SETTINGS: Settings = { dnd: false, shake: true, shakeLevel: 'medium', welcomed: false }
export const settings = loadSettings()

function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } } catch { return { ...DEFAULT_SETTINGS } }
}

export function saveSettings(patch: Partial<Settings>) {
  Object.assign(settings, patch)
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

export function installedVersion(): string {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, '..', 'package.json'), 'utf8')).version } catch {}
  return app.getVersion()
}

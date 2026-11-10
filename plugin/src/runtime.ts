import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PET_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pet')
const RUNTIME_DIR = path.join(os.homedir(), '.pointy', 'runtime')

// npmmirror first: GitHub release downloads are often slow or blocked in mainland China.
const MIRRORS = [
  'https://npmmirror.com/mirrors/electron/',
  'https://github.com/electron/electron/releases/download/',
]
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const TARGET = `${process.platform}-${process.arch}`

export type Logger = Pick<Console, 'info' | 'warn'>
/** How the plugin starts Pointy: run exe with args. */
export interface Launch { exe: string, args: string[] }
interface Pin { version: string, sha256: string }
interface Target {
  exes: string[]
  stock: string
  unzip(zip: string, dir: string): Promise<void>
  brand(dir: string, zip: string, logger: Logger): Promise<void>
}

export function pinnedRuntime(target = TARGET): Pin | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PET_APP_DIR, 'package.json'), 'utf8'))
    const { version, sha256 } = pkg.pointy?.electron ?? {}
    const hex = sha256?.[target]
    if (typeof version === 'string' && /^[0-9a-f]{64}$/.test(hex ?? '')) return { version, sha256: hex }
  } catch {}
  return undefined
}

const zipName = (version: string) => `electron-v${version}-${TARGET}.zip`
const runtimeDir = (version: string) => path.join(RUNTIME_DIR, `electron-v${version}-${TARGET}`)

export function installedRuntime(pin = pinnedRuntime()): string | undefined {
  const target = TARGETS[TARGET]
  if (!pin || !target) return undefined
  return target.exes.map((exe) => path.join(runtimeDir(pin.version), exe)).find((exe) => fs.existsSync(exe))
}

async function download(url: string, file: string, logger: Logger) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(file)
  let got = 0
  let nextLog = 0.25
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      got += chunk.length
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r))
      if (total && got / total >= nextLog) {
        logger.info(`pointy: downloading Electron ${Math.round((got / total) * 100)}%`)
        nextLog += 0.25
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(r))
  }
  return hash.digest('hex')
}

function run(file: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited with ${code}`))))
  })
}

/**
 * The official signature no longer matches afterwards, so it is
 * dropped; Windows does not check signatures of programs started by another
 * program.
 */
async function brandWindows(dir: string, zip: string, logger: Logger) {
  const from = path.join(dir, 'electron.exe')
  const to = path.join(dir, 'Pointy.exe')
  try {
    const ResEdit = await import('resedit')
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(from), { ignoreCert: true })
    const res = ResEdit.NtExecutableResource.from(exe)
    const icoFile = path.join(PET_APP_DIR, 'assets', 'pointy.ico')
    if (fs.existsSync(icoFile)) {
      const icons = ResEdit.Data.IconFile.from(fs.readFileSync(icoFile)).icons.map((icon) => icon.data)
      for (const group of ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)) {
        ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icons)
      }
    }
    for (const vi of ResEdit.Resource.VersionInfo.fromEntries(res.entries)) {
      for (const lang of vi.getAllLanguagesForStringValues()) {
        vi.setStringValues(lang, { FileDescription: 'Pointy', ProductName: 'Pointy', InternalName: 'Pointy', OriginalFilename: 'Pointy.exe' })
      }
      vi.outputToResourceEntries(res.entries)
    }
    res.outputResource(exe)
    fs.writeFileSync(to, Buffer.from(exe.generate()))
    fs.rmSync(from)
  } catch (error) {
    logger.warn(`pointy: could not rebrand electron.exe (${(error as Error).message}); using it renamed`)
    fs.rmSync(to, { force: true })
    fs.renameSync(from, to)
  }
}

// Windows 10+ ships bsdtar, which reads zip archives.
const unzipWindows = (zip: string, dir: string) => run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir])
const TARGETS: Record<string, Target | undefined> = {
  'win32-x64': { exes: ['Pointy.exe'], stock: 'electron.exe', unzip: unzipWindows, brand: brandWindows },
}

const MAC_APP = path.join(PET_APP_DIR, 'Pointy.app')

/**
 * On macOS Pointy is the Go app the package carries. LaunchServices starts
 * it, not this process, so macOS asks the user to trust Pointy rather than
 * DSH, and the app inherits this environment.
 */
function macLaunch(log: string, logger: Logger): Launch {
  if (!fs.existsSync(path.join(MAC_APP, 'Contents', 'MacOS', 'Pointy'))) throw new Error(`${MAC_APP} is missing; reinstall the plugin`)
  removeElectron(logger)
  return { exe: '/usr/bin/open', args: ['-n', '-g', '--stdout', log, '--stderr', log, MAC_APP] }
}

/** Earlier builds ran Electron on macOS from RUNTIME_DIR. The rest of ~/.pointy holds the user's settings and stays. */
function removeElectron(logger: Logger) {
  if (!fs.existsSync(RUNTIME_DIR)) return
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true })
  logger.info(`pointy: removed the Electron runtime in ${RUNTIME_DIR}`)
}

let installing: Promise<string | undefined> | undefined
/** log is the file Pointy's output goes to. */
export async function ensureRuntime(logger: Logger, log: string): Promise<Launch> {
  if (process.platform === 'darwin') return macLaunch(log, logger)
  const target = TARGETS[TARGET]
  if (!target) throw new Error(`Pointy supports Windows x64 and macOS, not ${TARGET}`)
  const pin = pinnedRuntime()
  if (!pin) throw new Error(`no pinned Electron for ${TARGET} in ${PET_APP_DIR}`)
  let exe = installedRuntime(pin)
  if (!exe) {
    installing ??= install(pin, target, logger).finally(() => { installing = undefined })
    exe = await installing
  }
  if (!exe) throw new Error(`Electron ${pin.version} did not install`)
  return { exe, args: [PET_APP_DIR] }
}

async function install(pin: Pin, target: Target, logger: Logger) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  for (const name of fs.readdirSync(RUNTIME_DIR)) {
    const full = path.join(RUNTIME_DIR, name)
    if (name.startsWith('tmp-') && Date.now() - fs.statSync(full).mtimeMs > 3600_000) fs.rmSync(full, { recursive: true, force: true })
  }
  const tmp = fs.mkdtempSync(path.join(RUNTIME_DIR, 'tmp-'))
  try {
    const zip = path.join(tmp, zipName(pin.version))
    let lastError: unknown
    for (const mirror of MIRRORS) {
      const url = `${mirror}v${pin.version}/${zipName(pin.version)}`
      try {
        logger.info(`pointy: downloading Electron ${pin.version} from ${url}`)
        const sha = await download(url, zip, logger)
        if (sha !== pin.sha256) throw new Error(`checksum mismatch (${sha})`)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        logger.warn(`pointy: ${url} failed: ${(error as Error).message}`)
        fs.rmSync(zip, { force: true })
      }
    }
    if (lastError) throw lastError
    const unpacked = path.join(tmp, 'unpacked')
    fs.mkdirSync(unpacked)
    await target.unzip(zip, unpacked)
    if (!fs.existsSync(path.join(unpacked, target.stock))) throw new Error(`${target.stock} missing from the zip`)
    await target.brand(unpacked, zip, logger)
    const dest = runtimeDir(pin.version)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(unpacked, dest)
    logger.info(`pointy: Electron ${pin.version} ready in ${dest}`)
    for (const name of fs.readdirSync(RUNTIME_DIR)) {
      const full = path.join(RUNTIME_DIR, name)
      if (full !== dest && /^electron-v/.test(name)) fs.rmSync(full, { recursive: true, force: true })
    }
    return installedRuntime(pin)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

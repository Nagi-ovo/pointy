/**
 * Pointy needs a full Electron runtime (windows, tray, screenshots), which the
 * DSH plugin host does not have: it runs DSH's own binary in node mode. So the
 * plugin carries Pointy's code in ../pet and, the first time, downloads the
 * stock Electron build that Pointy was tested with into ~/.pointy/runtime.
 *
 * The zip is checked against the SHA-256 pinned in pet/package.json at pack
 * time, so a mirror can only be slow, never substitute a different binary.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Compiled to build/src/runtime.js; pet/ sits next to build/ in the package.
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
/** This platform's Electron zip as pinned in pet/package.json. */
interface Pin { version: string, sha256: string }
/** How one platform's runtime is laid out, unpacked and branded. */
interface Target {
  /** Executables inside the runtime dir, branded first. */
  exes: string[]
  /** The file that proves the zip unpacked. */
  stock: string
  unzip(zip: string, dir: string): Promise<void>
  brand(dir: string, zip: string, logger: Logger): Promise<void>
}

/** This platform's Electron zip pinned by tools/pack-plugin.ts, or undefined (dev checkout, unsupported platform). */
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

/** The executable of the pinned runtime if it is already unpacked: the branded one, else the stock fallback. */
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
 * Rename electron.exe to Pointy.exe and rewrite its version strings and icon.
 * Task Manager's process list shows the FileDescription, its details tab the
 * file name. The official signature no longer matches afterwards, so it is
 * dropped; Windows does not check signatures of programs started by another
 * program. If the resource edit fails, the renamed stock binary still runs.
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

const plist = (file: string, key: string, type: string, value: string) => run('/usr/bin/plutil', ['-replace', key, type, value, file])

/**
 * Turn Electron.app into Pointy.app: the Accessibility and Screen Recording
 * prompts, Activity Monitor and the menu bar show the bundle's name and icon.
 * Editing the bundle breaks Electron's signature, and Apple silicon refuses to
 * run unsigned code, so the result is re-signed ad hoc. The zip comes from
 * fetch, not a browser, so it carries no quarantine flag for Gatekeeper to check.
 * If any step fails, the bundle is unpacked again and the stock Electron.app is used.
 */
async function brandMac(dir: string, zip: string, logger: Logger) {
  const app = path.join(dir, 'Pointy.app')
  const contents = path.join(app, 'Contents')
  try {
    fs.renameSync(path.join(dir, 'Electron.app'), app)
    fs.renameSync(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', 'Pointy'))
    const info = path.join(contents, 'Info.plist')
    for (const key of ['CFBundleExecutable', 'CFBundleName', 'CFBundleDisplayName']) await plist(info, key, '-string', 'Pointy')
    await plist(info, 'CFBundleIdentifier', '-string', 'lab.pointy.app')
    await plist(info, 'LSUIElement', '-bool', 'true')
    const icns = path.join(PET_APP_DIR, 'assets', 'pointy.icns')
    if (fs.existsSync(icns)) {
      fs.copyFileSync(icns, path.join(contents, 'Resources', 'pointy.icns'))
      await plist(info, 'CFBundleIconFile', '-string', 'pointy.icns')
    }
    await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
  } catch (error) {
    logger.warn(`pointy: could not rebrand Electron.app (${(error as Error).message}); using it as is`)
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    await unzipMac(zip, dir)
  }
}

// Windows 10+ ships bsdtar, which reads zip archives.
const unzipWindows = (zip: string, dir: string) => run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir])
// ditto keeps the symlinks inside Electron Framework.framework, which a plain unzip would flatten.
const unzipMac = (zip: string, dir: string) => run('/usr/bin/ditto', ['-x', '-k', zip, dir])

const MAC: Target = {
  exes: ['Pointy.app/Contents/MacOS/Pointy', 'Electron.app/Contents/MacOS/Electron'],
  stock: 'Electron.app/Contents/MacOS/Electron',
  unzip: unzipMac,
  brand: brandMac,
}
const TARGETS: Record<string, Target | undefined> = {
  'win32-x64': { exes: ['Pointy.exe'], stock: 'electron.exe', unzip: unzipWindows, brand: brandWindows },
  'darwin-arm64': MAC,
  'darwin-x64': MAC,
}

let installing: Promise<string | undefined> | undefined
/**
 * Make sure the pinned Electron is unpacked; returns the path of its executable.
 * One download at a time per DSH run; older runtimes are removed afterwards.
 */
export function ensureRuntime(logger: Logger): Promise<string | undefined> {
  const target = TARGETS[TARGET]
  if (!target) return Promise.reject(new Error(`Pointy supports Windows x64 and macOS (arm64, x64), not ${TARGET}`))
  const pin = pinnedRuntime()
  if (!pin) return Promise.reject(new Error(`no pinned Electron for ${TARGET} in ${PET_APP_DIR}`))
  const ready = installedRuntime(pin)
  if (ready) return Promise.resolve(ready)
  installing ??= install(pin, target, logger).finally(() => { installing = undefined })
  return installing
}

async function install(pin: Pin, target: Target, logger: Logger) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  // Leftovers of a download that was cut off (DSH closed midway).
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

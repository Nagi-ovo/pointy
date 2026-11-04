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

export const PET_APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pet')
const RUNTIME_DIR = path.join(os.homedir(), '.pointy', 'runtime')

// npmmirror first: GitHub release downloads are often slow or blocked in mainland China.
const MIRRORS = [
  'https://npmmirror.com/mirrors/electron/',
  'https://github.com/electron/electron/releases/download/',
]
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
/** electron.exe is renamed and rebranded so Task Manager shows "Pointy", not "Electron". */
const EXE_NAME = 'Pointy.exe'

/** `{ version, sha256 }` of the Electron zip pinned by tools/pack-plugin.mjs, or undefined in a dev checkout. */
export function pinnedRuntime() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PET_APP_DIR, 'package.json'), 'utf8'))
    const { version, sha256 } = pkg.pointy?.electron ?? {}
    if (typeof version === 'string' && /^[0-9a-f]{64}$/.test(sha256 ?? '')) return { version, sha256 }
  } catch {}
  return undefined
}

const zipName = (version) => `electron-v${version}-win32-x64.zip`
const runtimeDir = (version) => path.join(RUNTIME_DIR, `electron-v${version}-win32-x64`)

/** electron.exe for the pinned version if it is already unpacked. */
export function installedRuntime(pin = pinnedRuntime()) {
  if (!pin) return undefined
  const exe = path.join(runtimeDir(pin.version), EXE_NAME)
  return fs.existsSync(exe) ? exe : undefined
}

async function download(url, file, logger) {
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
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      if (total && got / total >= nextLog) {
        logger.info(`pointy: downloading Electron ${Math.round((got / total) * 100)}%`)
        nextLog += 0.25
      }
    }
  } finally {
    await new Promise((r) => out.end(r))
  }
  return hash.digest('hex')
}

function unzip(zip, dir) {
  // Windows 10+ ships bsdtar, which reads zip archives.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xf', zip, '-C', dir], { stdio: 'ignore', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))))
  })
}

/**
 * Rename electron.exe to Pointy.exe and rewrite its version strings and icon.
 * Task Manager's process list shows the FileDescription, its details tab the
 * file name. The official signature no longer matches afterwards, so it is
 * dropped; Windows does not check signatures of programs started by another
 * program. If the resource edit fails, the renamed stock binary still runs.
 */
async function brand(dir, logger) {
  const from = path.join(dir, 'electron.exe')
  const to = path.join(dir, EXE_NAME)
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
        vi.setStringValues(lang, { FileDescription: 'Pointy', ProductName: 'Pointy', InternalName: 'Pointy', OriginalFilename: EXE_NAME })
      }
      vi.outputToResourceEntries(res.entries)
    }
    res.outputResource(exe)
    fs.writeFileSync(to, Buffer.from(exe.generate()))
    fs.rmSync(from)
  } catch (error) {
    logger.warn(`pointy: could not rebrand electron.exe (${error.message}); using it renamed`)
    fs.rmSync(to, { force: true })
    fs.renameSync(from, to)
  }
}

let installing
/**
 * Make sure the pinned Electron is unpacked; returns the path of electron.exe.
 * One download at a time per DSH run; older runtimes are removed afterwards.
 */
export function ensureRuntime(logger) {
  const pin = pinnedRuntime()
  if (!pin) return Promise.reject(new Error(`no pinned Electron in ${PET_APP_DIR}`))
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.reject(new Error('Pointy only supports Windows x64'))
  const ready = installedRuntime(pin)
  if (ready) return Promise.resolve(ready)
  installing ??= install(pin, logger).finally(() => { installing = undefined })
  return installing
}

async function install(pin, logger) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  // Leftovers of a download that was cut off (DSH closed midway).
  for (const name of fs.readdirSync(RUNTIME_DIR)) {
    const full = path.join(RUNTIME_DIR, name)
    if (name.startsWith('tmp-') && Date.now() - fs.statSync(full).mtimeMs > 3600_000) fs.rmSync(full, { recursive: true, force: true })
  }
  const tmp = fs.mkdtempSync(path.join(RUNTIME_DIR, 'tmp-'))
  try {
    const zip = path.join(tmp, zipName(pin.version))
    let lastError
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
        logger.warn(`pointy: ${url} failed: ${error.message}`)
        fs.rmSync(zip, { force: true })
      }
    }
    if (lastError) throw lastError
    const unpacked = path.join(tmp, 'unpacked')
    fs.mkdirSync(unpacked)
    await unzip(zip, unpacked)
    if (!fs.existsSync(path.join(unpacked, 'electron.exe'))) throw new Error('electron.exe missing from the zip')
    await brand(unpacked, logger)
    const dest = runtimeDir(pin.version)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(unpacked, dest)
    logger.info(`pointy: Electron ${pin.version} ready in ${dest}`)
    for (const name of fs.readdirSync(RUNTIME_DIR)) {
      const full = path.join(RUNTIME_DIR, name)
      if (full !== dest && /^electron-v/.test(name)) fs.rmSync(full, { recursive: true, force: true })
    }
    return path.join(dest, EXE_NAME)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

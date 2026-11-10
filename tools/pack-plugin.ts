import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ResEdit from 'resedit'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.join(root, 'plugin')
const pet = path.join(plugin, 'pet')
const build = path.join(root, 'build')
const desktop = path.join(root, 'desktop')
const appOut = path.join(root, 'dist', 'mygo')

// Pointy.app is built and signed on macOS. --windows-only packs the Windows
// executables alone, for testing the package on Windows.
const windowsOnly = process.argv.includes('--windows-only')
if (process.platform !== 'darwin' && !windowsOnly) throw new Error('Pointy.app is built and signed on macOS: pack on a Mac, take the package from the macOS workflow, or pass --windows-only')

execFileSync(process.execPath, [path.join(root, 'tools', 'build.ts')], { cwd: root, stdio: 'inherit' })

// The Windows executables run from pet/win32-<arch>/ and read the pages
// from pet/; Pointy.app carries its own copy.
fs.rmSync(pet, { recursive: true, force: true })
fs.mkdirSync(pet)
for (const dir of ['app', 'assets', 'extension']) {
  fs.cpSync(path.join(build, dir), path.join(pet, dir), { recursive: true, filter: (src) => !src.startsWith(path.join(build, 'assets', 'sprites')) })
}

const windows: Record<string, string> = { amd64: 'win32-x64', arm64: 'win32-arm64' }
const platforms = Object.keys(windows).map((arch) => `windows/${arch}`)
if (!windowsOnly) platforms.unshift('darwin/universal')
fs.rmSync(appOut, { recursive: true, force: true })
const mygoArgs = ['tool', 'mygo', 'build', '-platform', platforms.join(','), '-skip-build-command', '-skip-installer', '-o', appOut]
// The disk image exists only to be notarized; the stapled app is what ships.
if (!process.env.APPLE_NOTARY_PROFILE) mygoArgs.push('-skip-dmg')
execFileSync('go', mygoArgs, { cwd: desktop, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } })

for (const [arch, dir] of Object.entries(windows)) {
  const exe = path.join(pet, dir, 'Pointy.exe')
  fs.mkdirSync(path.dirname(exe))
  fs.writeFileSync(exe, runAsInvoker(fs.readFileSync(path.join(appOut, `windows-${arch}`, 'Pointy.exe'))))
}

if (!windowsOnly) {
  execFileSync('/usr/bin/ditto', [path.join(appOut, 'darwin-universal', 'Pointy.app'), path.join(pet, 'Pointy.app')])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(pet, 'Pointy.app')], { stdio: 'inherit' })
}

for (const f of ['LICENSE', 'ASSETS.md']) fs.copyFileSync(path.join(root, f), path.join(plugin, f))
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/(["(])media\//g, '$1https://raw.githubusercontent.com/pointylab/pointy/main/media/')
fs.writeFileSync(path.join(plugin, 'README.md'), readme)

const dist = path.join(root, 'dist')
fs.mkdirSync(dist, { recursive: true })
// npm is npm.cmd on Windows, which only a shell runs.
const out = execFileSync('npm', ['pack', '--pack-destination', dist], { cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32' })
console.log(path.join(dist, out.trim().split('\n').pop()!))

/**
 * mygo's manifest makes Pointy per-monitor DPI aware but requests no
 * execution level, so Windows would treat it as a legacy app. asInvoker runs
 * it with the rights of whoever starts it, as the Electron build did.
 */
function runAsInvoker(bin: Buffer) {
  const RT_MANIFEST = 24
  const exe = ResEdit.NtExecutable.from(bin)
  const res = ResEdit.NtExecutableResource.from(exe)
  const entry = res.entries.find((e) => e.type === RT_MANIFEST)
  if (!entry) throw new Error('Pointy.exe has no manifest')
  const xml = Buffer.from(entry.bin).toString('utf8')
  if (!xml.includes('PerMonitorV2')) throw new Error('Pointy.exe is not per-monitor DPI aware')
  if (!xml.includes('requestedExecutionLevel')) {
    const trust = '  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">\n    <security>\n      <requestedPrivileges>\n        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>\n      </requestedPrivileges>\n    </security>\n  </trustInfo>\n'
    const patched = Buffer.from(xml.replace('</assembly>', `${trust}</assembly>`), 'utf8')
    entry.bin = patched.buffer.slice(patched.byteOffset, patched.byteOffset + patched.byteLength)
  }
  res.outputResource(exe)
  return Buffer.from(exe.generate())
}

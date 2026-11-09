import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.join(root, 'plugin')
const pet = path.join(plugin, 'pet')
const build = path.join(root, 'build')

execFileSync(process.execPath, [path.join(root, 'tools', 'build.ts')], { cwd: root, stdio: 'inherit' })

const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const targets = ['win32-x64', 'darwin-arm64', 'darwin-x64']
const sums = await fetch(`https://github.com/electron/electron/releases/download/v${electronVersion}/SHASUMS256.txt`).then((r) => {
  if (!r.ok) throw new Error(`SHASUMS256.txt: HTTP ${r.status}`)
  return r.text()
})
const sumOf = new Map(sums.split('\n').map((l) => l.trim().split(/\s+\*?/).reverse() as [string, string]))
const sha256 = Object.fromEntries(targets.map((target) => {
  const zip = `electron-v${electronVersion}-${target}.zip`
  const hex = sumOf.get(zip)
  if (!/^[0-9a-f]{64}$/.test(hex ?? '')) throw new Error(`no checksum for ${zip}`)
  return [target, hex]
}))

fs.rmSync(pet, { recursive: true, force: true })
fs.mkdirSync(pet)
for (const dir of ['app', 'assets', 'extension']) {
  fs.cpSync(path.join(build, dir), path.join(pet, dir), { recursive: true, filter: (src) => !src.startsWith(path.join(build, 'assets', 'sprites')) })
}

const pngs = ['assets/tray.png', 'assets/tray@2x.png'].map((f) => fs.readFileSync(path.join(root, f)))
const header = Buffer.alloc(6 + 16 * pngs.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(pngs.length, 4)
let offset = header.length
pngs.forEach((png, i) => {
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  const e = 6 + 16 * i
  header.writeUInt8(w >= 256 ? 0 : w, e)
  header.writeUInt8(h >= 256 ? 0 : h, e + 1)
  header.writeUInt16LE(1, e + 4)
  header.writeUInt16LE(32, e + 6)
  header.writeUInt32LE(png.length, e + 8)
  header.writeUInt32LE(offset, e + 12)
  offset += png.length
})
fs.writeFileSync(path.join(pet, 'assets', 'pointy.ico'), Buffer.concat([header, ...pngs]))
// Pointy.app 的图标：ICNS 也能直接装 PNG。icp5 = 32px，ic11 = 16@2x，ic12 = 32@2x（64px）。icp6 是 48px，不用。
// 纯 JS 拼，打包可能在 Windows 上跑，没有 iconutil。
const icnsEntries = ([['icp5', pngs[0]], ['ic11', pngs[0]], ['ic12', pngs[1]]] as const).map(([type, png]) => {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(8 + png.length, 4)
  return Buffer.concat([head, png])
})
const icnsHead = Buffer.alloc(8)
icnsHead.write('icns', 0, 'ascii')
icnsHead.writeUInt32BE(8 + icnsEntries.reduce((n, e) => n + e.length, 0), 4)
fs.writeFileSync(path.join(pet, 'assets', 'pointy.icns'), Buffer.concat([icnsHead, ...icnsEntries]))
// koffi 和 ws 直接放进包里（pet/vendor），插件就没有 npm 依赖：
// pnpm 默认拦依赖的安装脚本（koffi 有一个），拦了 dsh plugin add 就报错。
// koffi 只要支持的平台的预编译 .node，安装脚本本来也只是挑其中一个。
const vendor = path.join(pet, 'vendor')
const nm = path.join(root, 'node_modules')
for (const f of ['index.js', 'indirect.js', 'LICENSE.txt']) fs.cpSync(path.join(nm, 'koffi', f), path.join(vendor, 'koffi', f))
for (const target of targets) {
  const dir = target.replace('-', '_')
  fs.cpSync(path.join(nm, 'koffi', 'build', 'koffi', dir), path.join(vendor, 'koffi', 'build', 'koffi', dir), { recursive: true })
}
const koffiPkg = JSON.parse(fs.readFileSync(path.join(nm, 'koffi', 'package.json'), 'utf8'))
delete koffiPkg.scripts
delete koffiPkg.devDependencies
fs.writeFileSync(path.join(vendor, 'koffi', 'package.json'), JSON.stringify(koffiPkg, null, 2))
for (const f of ['index.js', 'wrapper.mjs', 'package.json', 'LICENSE']) fs.cpSync(path.join(nm, 'ws', f), path.join(vendor, 'ws', f))
fs.cpSync(path.join(nm, 'ws', 'lib'), path.join(vendor, 'ws', 'lib'), { recursive: true })
fs.writeFileSync(path.join(pet, 'boot.js'), `// 生成的文件（tools/pack-plugin.ts）：让 require('koffi') / require('ws') 找到 vendor 里的副本
const path = require('node:path')
const Module = require('node:module')
process.env.NODE_PATH = [path.join(__dirname, 'vendor'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
require('./app/main.js')
`)
fs.writeFileSync(path.join(pet, 'package.json'), JSON.stringify({
  name: 'pointy',
  private: true,
  main: 'boot.js',
  pointy: { electron: { version: electronVersion, sha256 } },
}, null, 2) + '\n')

for (const f of ['LICENSE', 'ASSETS.md']) fs.copyFileSync(path.join(root, f), path.join(plugin, f))
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/(["(])media\//g, '$1https://raw.githubusercontent.com/pointylab/pointy/main/media/')
fs.writeFileSync(path.join(plugin, 'README.md'), readme)

const dist = path.join(root, 'dist')
fs.mkdirSync(dist, { recursive: true })
const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', dist], { cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32' })
console.log(`Electron ${electronVersion}`, sha256)
console.log(path.join(dist, out.trim().split('\n').pop()!))

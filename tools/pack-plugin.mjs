// 打 DSH 插件包：把 Pointy 本体（app、assets、extension）抄进 plugin/pet，
// 钉住要下载的 Electron 版本和 SHA-256，再 npm pack 到 dist/。
//   node tools/pack-plugin.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.join(root, 'plugin')
const pet = path.join(plugin, 'pet')

const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const zip = `electron-v${electronVersion}-win32-x64.zip`
// 校验和从 GitHub 官方发布页取，镜像下载下来的 zip 要和它一致
const sums = await fetch(`https://github.com/electron/electron/releases/download/v${electronVersion}/SHASUMS256.txt`).then((r) => {
  if (!r.ok) throw new Error(`SHASUMS256.txt: HTTP ${r.status}`)
  return r.text()
})
const sha256 = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === zip)?.[0]
if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error(`no checksum for ${zip}`)

fs.rmSync(pet, { recursive: true, force: true })
fs.mkdirSync(pet)
// assets/sprites 是旧桌宠立绘（作者的 OC，不公开，界面也早就不显示了），不进包
for (const dir of ['app', 'assets', 'extension']) {
  fs.cpSync(path.join(root, dir), path.join(pet, dir), { recursive: true, filter: (src) => !src.startsWith(path.join(root, 'assets', 'sprites')) })
}

// Pointy.exe 的图标（插件下载完 Electron 后换上，runtime.js 的 brand）：PNG 直接装进 ICO
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
// koffi 和 ws 直接放进包里（pet/vendor），插件就没有 npm 依赖：
// pnpm 默认拦依赖的安装脚本（koffi 有一个），拦了 dsh plugin add 就报错。
// koffi 只要 Windows x64 的预编译 .node，安装脚本本来也只是挑这个文件。
const vendor = path.join(pet, 'vendor')
const nm = path.join(root, 'node_modules')
for (const f of ['index.js', 'indirect.js', 'LICENSE.txt']) fs.cpSync(path.join(nm, 'koffi', f), path.join(vendor, 'koffi', f))
fs.cpSync(path.join(nm, 'koffi', 'build', 'koffi', 'win32_x64'), path.join(vendor, 'koffi', 'build', 'koffi', 'win32_x64'), { recursive: true })
const koffiPkg = JSON.parse(fs.readFileSync(path.join(nm, 'koffi', 'package.json'), 'utf8'))
delete koffiPkg.scripts
delete koffiPkg.devDependencies
fs.writeFileSync(path.join(vendor, 'koffi', 'package.json'), JSON.stringify(koffiPkg, null, 2))
for (const f of ['index.js', 'wrapper.mjs', 'package.json', 'LICENSE']) fs.cpSync(path.join(nm, 'ws', f), path.join(vendor, 'ws', f))
fs.cpSync(path.join(nm, 'ws', 'lib'), path.join(vendor, 'ws', 'lib'), { recursive: true })
// 入口：先把 vendor 加进模块搜索路径，再进 Pointy 本体
fs.writeFileSync(path.join(pet, 'boot.js'), `// 生成的文件（tools/pack-plugin.mjs）：让 require('koffi') / require('ws') 找到 vendor 里的副本
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

// npm 页面显示的是包里的 README；LICENSE 也一起带上
for (const f of ['LICENSE', 'ASSETS.md']) fs.copyFileSync(path.join(root, f), path.join(plugin, f))
// README 里的图是仓库根目录 media/ 的相对路径，包里没有 media/，换成 GitHub 上的地址
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/(["(])media\//g, '$1https://raw.githubusercontent.com/pointylab/pointy/main/media/')
fs.writeFileSync(path.join(plugin, 'README.md'), readme)

const dist = path.join(root, 'dist')
fs.mkdirSync(dist, { recursive: true })
const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', dist], { cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32' })
console.log(`Electron ${electronVersion} ${sha256}`)
console.log(path.join(dist, out.trim().split('\n').pop()))

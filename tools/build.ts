import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const build = path.join(root, 'build')
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const PROJECTS = ['app/tsconfig.json', 'app/tsconfig.renderer.json', 'extension/tsconfig.json', 'extension/tsconfig.pick.json', 'plugin/tsconfig.json', 'tools/tsconfig.json']

fs.rmSync(build, { recursive: true, force: true })
fs.rmSync(path.join(root, 'plugin', 'build'), { recursive: true, force: true })
for (const project of PROJECTS) execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' })

const isCode = (file: string) => /\.(ts|mts|cts)$/.test(file) || path.basename(file).startsWith('tsconfig')
for (const dir of ['app', 'extension', 'assets']) {
  fs.cpSync(path.join(root, dir), path.join(build, dir), {
    recursive: true,
    filter: (src) => fs.statSync(src).isDirectory() || !isCode(src),
  })
}

const catalog = (lang: string) => JSON.parse(fs.readFileSync(path.join(root, 'locales', `${lang}.json`), 'utf8'))
const catalogs = { 'zh-CN': catalog('zh-CN'), en: catalog('en') }
fs.writeFileSync(path.join(build, 'app', 'i18n', 'catalogs.js'), `export default ${JSON.stringify(catalogs)}\n`)

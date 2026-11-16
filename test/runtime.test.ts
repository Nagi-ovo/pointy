import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanOldApps, MAX_REPLACE_ATTEMPTS, peerAction, READY_MARKER, readyMessage, stageWindowsApp } from '../plugin/src/runtime.ts'

function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

function makeTempDir(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pointy-runtime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeSamplePet(src: string, versionTag = 'v1') {
  writeTree(src, {
    'app/card/index.html': `<html>${versionTag}</html>`,
    'assets/tray@2x.png': `png-${versionTag}`,
    'extension/manifest.json': `{"v":"${versionTag}"}`,
    'win32-x64/Pointy.exe': `x64-${versionTag}`,
    'win32-arm64/Pointy.exe': `arm64-${versionTag}`,
    'Pointy.app/Contents/MacOS/Pointy': `mac-${versionTag}`,
  })
}

test('stageWindowsApp copies required layout without Pointy.app or other arches', (t) => {
  const tmp = makeTempDir(t)
  const src = path.join(tmp, 'pet')
  const appRoot = path.join(tmp, 'app')
  makeSamplePet(src)

  const launch = stageWindowsApp(src, appRoot, '0.5.2', 'x64')
  const staged = path.join(appRoot, '0.5.2')
  assert.equal(launch.cwd, staged)
  assert.equal(launch.exe, path.join(staged, 'win32-x64', 'Pointy.exe'))
  assert.equal(fs.readFileSync(launch.exe, 'utf8'), 'x64-v1')
  assert.equal(fs.readFileSync(path.join(staged, 'app', 'card', 'index.html'), 'utf8'), '<html>v1</html>')
  assert.equal(fs.readFileSync(path.join(staged, 'assets', 'tray@2x.png'), 'utf8'), 'png-v1')
  assert.equal(fs.readFileSync(path.join(staged, 'extension', 'manifest.json'), 'utf8'), '{"v":"v1"}')
  assert.equal(fs.existsSync(path.join(staged, READY_MARKER)), true)
  assert.equal(fs.existsSync(path.join(staged, 'Pointy.app')), false)
  assert.equal(fs.existsSync(path.join(staged, 'win32-arm64')), false)
  assert.deepEqual(fs.readdirSync(appRoot), ['0.5.2'])
})

test('stageWindowsApp reuses a complete directory and recopies an incomplete one', (t) => {
  const tmp = makeTempDir(t)
  const src = path.join(tmp, 'pet')
  const appRoot = path.join(tmp, 'app')
  makeSamplePet(src, 'v1')

  const first = stageWindowsApp(src, appRoot, '0.5.2', 'arm64')
  assert.equal(fs.readFileSync(first.exe, 'utf8'), 'arm64-v1')

  // Once marked ready, staging again does not overwrite existing files.
  makeSamplePet(src, 'v2')
  const second = stageWindowsApp(src, appRoot, '0.5.2', 'arm64')
  assert.equal(fs.readFileSync(second.exe, 'utf8'), 'arm64-v1')

  // Without the completion marker (interrupted copy), staging starts fresh.
  fs.rmSync(path.join(second.cwd, READY_MARKER))
  fs.writeFileSync(path.join(second.cwd, 'leftover.tmp'), 'stale')
  const third = stageWindowsApp(src, appRoot, '0.5.2', 'arm64')
  assert.equal(fs.readFileSync(third.exe, 'utf8'), 'arm64-v2')
  assert.equal(fs.existsSync(path.join(third.cwd, 'leftover.tmp')), false)
  assert.equal(fs.existsSync(path.join(third.cwd, READY_MARKER)), true)
})

test('cleanOldApps removes other versions and keeps the active version', (t) => {
  const tmp = makeTempDir(t)
  const appRoot = path.join(tmp, 'app')
  writeTree(appRoot, {
    '0.5.0/win32-x64/Pointy.exe': 'old',
    '0.5.1/win32-x64/Pointy.exe': 'prev',
    '0.5.2/win32-x64/Pointy.exe': 'current',
  })

  cleanOldApps(appRoot, '?')
  assert.equal(fs.readdirSync(appRoot).length, 3)

  cleanOldApps(appRoot, '0.5.2')
  assert.deepEqual(fs.readdirSync(appRoot), ['0.5.2'])
  assert.equal(fs.readFileSync(path.join(appRoot, '0.5.2', 'win32-x64', 'Pointy.exe'), 'utf8'), 'current')
})

test('peerAction decides when and how to replace an existing Go Pointy', () => {
  // Different version + managed -> send quit.
  assert.equal(peerAction({ version: '0.5.1', managed: true }, '0.5.2', 0), 'quit')

  // Missing version (0.5.0 and earlier) -> disconnect and wait for grace quit.
  assert.equal(peerAction({}, '0.5.2', 0), 'wait')

  // Same version, unmanaged (dev build), or unknown plugin version -> use as is.
  assert.equal(peerAction({ version: '0.5.2', managed: true }, '0.5.2', 0), 'use')
  assert.equal(peerAction({ version: '0.5.1', managed: false }, '0.5.2', 0), 'use')
  assert.equal(peerAction({ version: '', managed: false }, '0.5.2', 0), 'use')
  assert.equal(peerAction({ version: '0.5.1', managed: true }, '?', 0), 'use')
  assert.equal(peerAction({}, '?', 0), 'use')

  // Caps replacement attempts at MAX_REPLACE_ATTEMPTS (3), then gives up with a warning.
  assert.equal(peerAction({ version: '0.5.1', managed: true }, '0.5.2', MAX_REPLACE_ATTEMPTS - 1), 'quit')
  assert.equal(peerAction({}, '0.5.2', MAX_REPLACE_ATTEMPTS - 1), 'wait')
  assert.equal(peerAction({ version: '0.5.1', managed: true }, '0.5.2', MAX_REPLACE_ATTEMPTS), 'give-up')
  assert.equal(peerAction({}, '0.5.2', MAX_REPLACE_ATTEMPTS), 'give-up')
  assert.equal(peerAction({ version: '0.5.2', managed: true }, '0.5.2', MAX_REPLACE_ATTEMPTS), 'use')
})

test('readyMessage sends hostPid only to an unmanaged Pointy this plugin started', () => {
  assert.deepEqual(readyMessage('0.5.2', { managed: false }, true, 4321), { type: 'ready', plugin: '0.5.2', hostPid: 4321 })
  assert.deepEqual(readyMessage('0.5.2', { managed: true }, true, 4321), { type: 'ready', plugin: '0.5.2' })
  assert.deepEqual(readyMessage('0.5.2', { managed: false }, false, 4321), { type: 'ready', plugin: '0.5.2' })
})

import fs from 'node:fs'
import path from 'node:path'

const plugin = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'plugin', 'package.json'), 'utf8'))

// Without APPLE_SIGNING_IDENTITY the app is signed ad hoc. APPLE_NOTARY_PROFILE
// names a `notarytool store-credentials` profile, in NOTARY_KEYCHAIN when set.
const notary = process.env.APPLE_NOTARY_PROFILE

export default {
  name: 'Pointy',
  identifier: 'lab.pointy.app',
  version: plugin.version,
  icon: '../plugin/icon.png',
  bindings: '../app/bridge/mygo.ts',
  resources: ['../build'],
  macos: {
    signingIdentity: process.env.APPLE_SIGNING_IDENTITY || '-',
    notarize: notary ? { keychainProfile: notary, keychain: process.env.NOTARY_KEYCHAIN } : undefined,
    infoPlist: {
      LSUIElement: true,
      NSAccessibilityUsageDescription: 'Pointy reads the text and controls you point at, so it can ask DeepSeek Harness about them.',
      NSScreenCaptureUsageDescription: 'Pointy takes a picture of the part of a window you point at, to show it with your question.',
    },
  },
}

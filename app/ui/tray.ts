import { app, Menu, Tray, nativeImage } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { TRAY_ICON, settings, saveSettings, logError } from '../core/env.ts'
import { suppressed, visibilityChanged } from '../core/state.ts'
import type { Agent } from '../agents/index.ts'

export interface TrayDeps {
  agent(): Agent
  extensionCount(): number
  showExtensionGuide(): void
  showWelcome(): void
}

let tray: Tray | undefined
let notifyClick: (() => void) | undefined
let deps = {} as TrayDeps

export function update() {
  if (!tray) return
  const agent = deps.agent()
  const { connected, pendingApprovals } = agent.status()
  const extensions = deps.extensionCount()
  const status = [
    pendingApprovals > 0 ? `${pendingApprovals} 个操作等你批准` : '',
    settings.dnd ? '勿扰中' : '',
    connected ? '' : `${agent.name} 未连接`,
    extensions ? '' : '浏览器扩展未连接',
  ].filter(Boolean).join('\n')
  tray.setToolTip(status ? `Pointy\n${status}` : 'Pointy')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '晃一下鼠标指认',
      submenu: [
        { label: '关', type: 'radio', checked: !settings.shake, click: () => { saveSettings({ shake: false }); update() } },
        ...([['low', '低：要晃得明显'], ['medium', '中'], ['high', '高：轻晃就行']] as const).map(([value, label]): MenuItemConstructorOptions => ({
          label, type: 'radio', checked: settings.shake && settings.shakeLevel === value, click: () => { saveSettings({ shake: true, shakeLevel: value }); update() },
        })),
      ],
    },
    extensions
      ? { label: `浏览器扩展已连接（${extensions}）`, enabled: false }
      : { label: '浏览器扩展未连接，点这里安装…', click: () => deps.showExtensionGuide() },
    { type: 'separator' },
    { label: '使用说明…', click: () => deps.showWelcome() },
    { label: '勿扰模式', type: 'checkbox', checked: settings.dnd, click: (item) => { saveSettings({ dnd: item.checked }); visibilityChanged() } },
    { type: 'separator' },
    { label: '退出 Pointy', click: () => app.quit() },
  ]))
}

export function notify(title: string, content: string, onClick?: () => void) {
  if (!tray || suppressed()) return
  notifyClick = onClick
  try { tray.displayBalloon({ title, content, iconType: 'none', icon: nativeImage.createFromPath(TRAY_ICON), noSound: true }) } catch (err) { logError('balloon', err) }
}

export function create(d: TrayDeps) {
  deps = d
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  tray.on('balloon-click', () => { const f = notifyClick; notifyClick = undefined; f?.() })
  update()
}

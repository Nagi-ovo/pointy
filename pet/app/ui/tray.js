// 托盘：图标、悬停提示、菜单、气泡通知
const { app, Menu, Tray, nativeImage } = require('electron')
const { TRAY_ICON, settings, saveSettings, logError } = require('../core/env')
const { suppressed, visibilityChanged } = require('../core/state')

let tray
let notifyClick
let deps = {} // { agent(), extensionCount(), showExtensionGuide(), showWelcome() }

function update() {
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
        ...[['low', '低：要晃得明显'], ['medium', '中'], ['high', '高：轻晃就行']].map(([value, label]) => ({
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

/** 托盘气泡通知（收起的任务做完、agent 要批准都靠它） */
function notify(title, content, onClick) {
  if (!tray || suppressed()) return
  notifyClick = onClick
  try { tray.displayBalloon({ title, content, iconType: 'none', icon: nativeImage.createFromPath(TRAY_ICON), noSound: true }) } catch (err) { logError('balloon', err) }
}

function create(d) {
  deps = d
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON))
  tray.on('balloon-click', () => { const f = notifyClick; notifyClick = undefined; f?.() })
  update()
}

module.exports = { create, update, notify }

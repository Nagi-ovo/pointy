// 托盘：图标、悬停提示、菜单、气泡通知
const { app, Menu, Notification, Tray, nativeImage } = require('electron')
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
  if (process.platform === 'darwin') {
    // macOS 没有托盘气泡，走系统通知
    const n = new Notification({ title, body: content, silent: true })
    n.on('click', () => onClick?.())
    n.show()
    return
  }
  notifyClick = onClick
  try { tray.displayBalloon({ title, content, iconType: 'none', icon: nativeImage.createFromPath(TRAY_ICON), noSound: true }) } catch (err) { logError('balloon', err) }
}

/** macOS 菜单栏图标是 18 点高：拿 64 像素那张缩到 36 像素，当 2 倍图用 */
function trayImage() {
  if (process.platform !== 'darwin') return nativeImage.createFromPath(TRAY_ICON)
  const big = nativeImage.createFromPath(TRAY_ICON.replace(/\.png$/, '@2x.png')).resize({ width: 36, height: 36, quality: 'best' })
  const img = nativeImage.createEmpty()
  img.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: big.toPNG() })
  return img
}

function create(d) {
  deps = d
  tray = new Tray(trayImage())
  tray.on('balloon-click', () => { const f = notifyClick; notifyClick = undefined; f?.() })
  update()
}

module.exports = { create, update, notify }

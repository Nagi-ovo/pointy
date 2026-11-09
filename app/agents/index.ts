// 卡片背后接的是哪个 agent。现在只有 DSH；以后加 Claude Code、Codex 等，在这里登记、按设置选一个。
//
// 每个 agent 模块对外的样子（见 dsh/index.js）：
//   name                    显示用的名字（卡片、托盘、引导里的"问 XX""在 XX 里继续"）
//   init(deps)              deps: { toCards(msg), onTask(msg), notify(title, content, onClick), showHint(text), focusTab(origin), onChange() }
//   attach(ws)              本机服务认证通过一条 agent 桥连接时调用，返回 { onMessage, onClose }
//   request(msg) -> bool    卡片发来的请求：sessions-request / sessions-search / suggest-request / ask；false = 没连上
//   open(sessionId?)        把 agent 叫到前台（有 sessionId 就切到那个会话）
//   status()                { connected, version?, pendingApprovals }
//   willQuit()              Pointy 退出前
//
// 发给卡片的消息（toCards）：sessions、suggestions、title、ask-accepted / ask-step / ask-delta / ask-activity（带 text）/ ask-done / ask-error。
// 标题已经是能显示的（agent 自己的临时标题要在适配里滤掉）。
const dsh = require('./dsh')

const current = dsh

module.exports = { current: () => current }

const $ = (id) => document.getElementById(id)

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' })
  $('status').textContent = !s.paired ? '还没配对' : s.connected ? '已连接 Pointy' : '已配对，Pointy 没在运行'
  $('pair-box').hidden = s.paired
  $('unpair').hidden = !s.paired
}

$('pair').addEventListener('click', async () => {
  $('msg').textContent = '去 Pointy 那边点「允许」……'
  const r = await chrome.runtime.sendMessage({ type: 'pair' })
  $('msg').textContent = r.ok ? '已连接' : r.error
  setTimeout(refresh, 800)
})

$('unpair').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' })
  refresh()
})

chrome.storage.local.get('port').then(({ port }) => { $('port').value = port ?? 47321 })
$('port').addEventListener('change', async () => {
  const port = Number($('port').value)
  if (Number.isInteger(port) && port > 0 && port < 65536) await chrome.storage.local.set({ port })
  else await chrome.storage.local.remove('port')
  $('msg').textContent = '端口已保存'
})

refresh()

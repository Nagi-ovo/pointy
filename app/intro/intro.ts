// 开场动画：量出文字卡片的大小，光环弹到比它大一圈；放完通知 main.js 关窗
const word = document.getElementById('word')!
window.intro.onInit(({ version }) => {
  if (version) document.getElementById('sub')!.textContent = `Pointy ${version} 已就位`
  const r = word.getBoundingClientRect()
  document.documentElement.style.setProperty('--w', `${Math.round(r.width + 36)}px`)
  document.documentElement.style.setProperty('--h', `${Math.round(r.height + 28)}px`)
  document.body.classList.add('play')
  setTimeout(() => window.intro.done(), 4500)
})

export {}

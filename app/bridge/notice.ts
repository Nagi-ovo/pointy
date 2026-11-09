const goNotice = goService('Notice')

window.notice = {
  onInit: (fn) => {
    goNotice.init().then((d) => fn({ ...d, body: d.body.map((p): NoticeParagraph => (p.copy?.length ? { text: p.text, copy: p.copy } : p.text)) }))
  },
  choose: (id) => { goNotice.choose(id) },
  resize: (height) => { goNotice.resize(height) },
  copy: (text) => { goNotice.copy(text) },
} satisfies NoticeApi

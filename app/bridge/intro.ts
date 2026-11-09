const goIntro = goService('Intro')

window.intro = {
  onInit: (fn) => { goIntro.init().then(fn) },
  done: () => { goIntro.done() },
} satisfies IntroApi

// 2D 精灵渲染器。以后的 3D 渲染器（three.js + GLB/VRM）实现同样的接口：
// setState(state) / setOffline(bool) / poke() / alarm() / dispose()

const FRAME_OF = {
  idle: 'idle',
  thinking: 'thinking',
  running: 'working',
  editing: 'working',
  reading: 'working',
  web: 'working',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
  sleep: 'sleep',
}

export class Sprite2DRenderer {
  constructor(el, base = '../../assets/sprites/') {
    this.el = el
    this.img = document.createElement('img')
    this.img.alt = ''
    el.appendChild(this.img)
    this.frames = {}
    for (const name of new Set([...Object.values(FRAME_OF), 'blink'])) {
      const img = new Image()
      img.src = `${base}${name}.png`
      this.frames[name] = img.src
    }
    this.state = 'idle'
    this.show('idle')
    this.scheduleBlink()
  }

  show(frame) {
    this.img.src = this.frames[frame]
  }

  setState(state) {
    this.state = state
    this.show(FRAME_OF[state] ?? 'idle')
  }

  setOffline(offline) {
    this.el.classList.toggle('offline', offline)
  }

  // idle 时随机眨眼
  scheduleBlink() {
    this.blinkTimer = setTimeout(() => {
      if (this.state === 'idle') {
        this.show('blink')
        setTimeout(() => { if (this.state === 'idle') this.show('idle') }, 160)
      }
      this.scheduleBlink()
    }, 2500 + Math.random() * 3500)
  }

  replay(cls) {
    this.el.classList.remove(cls)
    void this.el.offsetWidth
    this.el.classList.add(cls)
  }

  poke() { this.replay('hop') }
  alarm() { this.replay('shake') }

  dispose() {
    clearTimeout(this.blinkTimer)
    this.img.remove()
  }
}

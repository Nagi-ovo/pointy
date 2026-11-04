// 内置台词：DSH 没连上、模型超时或被限频时用
const LINES = {
  idle: ['主人，今天也要加油哦', '有活儿就叫我~', '发呆中……'],
  thinking: ['让我想想……', '嗯……这个有点意思', '在想了在想了'],
  running: ['敲命令中，别催', '终端启动！', '跑起来跑起来'],
  editing: ['改文件中，别眨眼', '这里要改一下', '动手了哦'],
  reading: ['翻翻文件……', '我看看写了啥', '找找在哪'],
  web: ['上网查一下', '搜索中……'],
  waiting: ['主人，要批准一下吗？', '等你点头哦', '这步要你同意才行'],
  error: ['呜，出错了……', '啊，失败了', '不、不是我的错！'],
  done: ['搞定啦！', '收工~', '做完了，夸我'],
  sleep: ['Zzz……', '好困……'],
  poke: ['干、干嘛啦', '别戳了！', '在呢在呢', '嗯？'],
  files: ['收到文件啦', '交给我吧'],
  offline: ['DSH 没连上……', '主人，DSH 开了吗？'],
}

let last
export function pickLine(kind) {
  const pool = LINES[kind] ?? LINES.idle
  let line
  do { line = pool[Math.floor(Math.random() * pool.length)] } while (pool.length > 1 && line === last)
  last = line
  return line
}

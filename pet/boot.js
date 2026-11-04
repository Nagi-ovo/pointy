// 生成的文件（tools/pack-plugin.mjs）：让 require('koffi') / require('ws') 找到 vendor 里的副本
const path = require('node:path')
const Module = require('node:module')
process.env.NODE_PATH = [path.join(__dirname, 'vendor'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
require('./app/main.js')

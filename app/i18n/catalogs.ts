import en from '../../locales/en.json' with { type: 'json' }
import zhCN from '../../locales/zh-CN.json' with { type: 'json' }

// tools/build.ts replaces this module with the catalogs inlined: WebKit
// before Safari 17.2 loads no JSON modules.
export default { 'zh-CN': zhCN, en }

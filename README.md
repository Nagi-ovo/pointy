# Pointy

DeepSeek Harness（DSH）插件。在电脑上**晃一下鼠标**，指到网页、文档、聊天窗口里的任意内容，点一下就能问 DSH，回答在原地的小卡片里流出来。只支持 Windows 10/11 x64。

## 安装

**图形界面**：DSH 里打开「插件管理」→ 安装第三方插件，在安装框里填包名：

```
@pointylab/dsh
```

**命令行**：

```bash
dsh plugin --profile desktop add @pointylab/dsh
```

用 web 版 DSH 的把 `desktop` 换成 `web`。

装完**重新打开 DSH**。第一次启用时插件会下载 Pointy 用的运行时（Electron，下载约 150 MB、解压后约 370 MB，国内走 npmmirror 镜像，按官方 SHA-256 校验），放在 `%USERPROFILE%\.pointy\runtime`，只下一次。下完托盘里出现鲸鱼图标，右下角弹出使用说明。之后 Pointy 随 DSH 启动、随 DSH 退出。

### 浏览器扩展（推荐）

没装扩展也能在浏览器里用，网页按截图处理。装了扩展能指认到网页里具体的段落、图片，还多一个右键「问 Pointy」。

1. 托盘鲸鱼图标 → 「安装浏览器扩展（推荐）…」，会打开扩展所在的文件夹 `%USERPROFILE%\.pointy\extension`。
2. Chrome 打开 `chrome://extensions`（Edge 是 `edge://extensions`），打开右上角「开发者模式」，点「加载已解压的扩展程序」，选这个文件夹。
3. 扩展会自己连上 Pointy，屏幕右下角弹窗问是否允许，点「允许」。

## 用法

- 晃一下鼠标进入指认，指到的内容会框出来，点一下弹出卡片；Esc 取消。
- 程序里读不到文字的地方（QQ、网易云这类整窗都是一张图的），指认时是一个虚线小框，滚轮调大小，截框里的图发过去。
- 卡片上的 × 或 Esc：问过问题的卡片缩成右下角的小胶囊，点胶囊回到卡片；↗ 跳到 DSH 里对应的会话。
- 托盘菜单：晃动灵敏度、勿扰模式、浏览器扩展、退出。
- 以管理员身份运行的程序读不到，会提示。

## 卸载

DSH「插件管理」里删掉 @pointylab/dsh，或者：

```bash
dsh plugin --profile desktop remove @pointylab/dsh
```

卸载后关掉 DSH，Pointy 退出时会把自己的运行时、设置和扩展配对信息（`%USERPROFILE%\.pointy`、`%APPDATA%\pointy`）一起删掉。如果是在 DSH 没开的时候用命令行卸载的，Pointy 没机会清理，这两个文件夹要手动删。

---

## 开发

- `app\`：Pointy 本体（Electron）。托盘、晃动检测、指认、卡片、胶囊；在 `127.0.0.1:47321` 开 WebSocket，DSH 插件和浏览器扩展都连这里。
- `plugin\`：DSH 插件 `@pointylab/dsh`。宿主那一半（`src\node.js`）把会话状态、回答推给 Pointy，必要时下载运行时并拉起 Pointy（`src\runtime.js`）；网页那一半（`lib\client.js`）负责切会话。
- `extension\`：Chrome / Edge 扩展。

DSH 的插件宿主是 DSH 自己的程序以 node 模式跑的子进程，开不了窗口，所以 Pointy 仍是单独的 Electron 进程，只是由插件带着、由插件拉起。

### 直接跑开发版

```bash
npm install
npm start
```

开发版和插件拉起的那份共用 `%USERPROFILE%\.pointy` 和单实例锁：开发版开着时，插件发现 47321 端口已有 Pointy，就直接连它，不再拉起自带的。

### 打包插件

```bash
node tools/pack-plugin.mjs
```

把 `app`、`assets`、`extension` 抄进 `plugin\pet`，koffi（只留 Windows x64 的预编译文件）和 ws 放进 `plugin\pet\vendor`，钉住 Electron 版本和官方 SHA-256，`npm pack` 出 `dist\pointylab-dsh-<版本>.tgz`。koffi 不作为 npm 依赖：pnpm 默认拦依赖的安装脚本，koffi 有一个，拦了 `dsh plugin add` 会报错。插件唯一的依赖是 resedit（纯 JS），下载完 Electron 后用它把 electron.exe 改成 Pointy.exe、换描述和图标。

本地试装：`dsh plugin --profile <profile> add file:<tgz 的绝对路径>`。每次改完先把 `plugin\package.json` 的版本号加一，同名同版本 pnpm 可能用缓存；不要用 `link:`（`remove` 会连源码目录一起删）。

### 测试用的环境变量

- `POINTY_PORT`：改端口，Pointy 和插件两边都认。
- `POINTY_TEST_HIDDEN=1`：不显示任何窗口、不装托盘，配合 `--inspect` 和 `global.pointyTest` 测试。插件拉起 Pointy 时这两个变量会传下去。
- `npm run fake`：不开 DSH，冒充插件推一遍状态。

## 许可

代码是 MIT（[LICENSE](LICENSE)）。鲸鱼娘的图片是同人作品，按 CC BY-NC-SA 4.0 授权，不能商用，详见 [ASSETS.md](ASSETS.md)。

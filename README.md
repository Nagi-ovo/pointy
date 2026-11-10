<div align="center">

<img src="media/logo.png" alt="Pointy 的头像：扒着鼠标箭头的像素鲸鱼娘" width="160">

# Pointy

**DeepSeek Harness 插件：晃一下鼠标，指住屏幕上的任何内容，直接问 DSH。**

指到的内容自动带上，回答在原地的小卡片里流出来，不用切窗口，也不用复制粘贴。

<p>
  <img alt="内测中" src="https://img.shields.io/badge/%E7%8A%B6%E6%80%81-%E5%86%85%E6%B5%8B%E4%B8%AD-E8A33D?style=flat-square&labelColor=1C2033">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-4D6BFE?style=flat-square&logo=windows&logoColor=white&labelColor=1C2033">
  <img alt="macOS 12+" src="https://img.shields.io/badge/macOS-12%2B-4D6BFE?style=flat-square&logo=apple&logoColor=white&labelColor=1C2033">
  <img alt="DeepSeek Harness 插件" src="https://img.shields.io/badge/DeepSeek%20Harness-%E6%8F%92%E4%BB%B6-4D6BFE?style=flat-square&labelColor=1C2033">
  <a href="LICENSE"><img alt="许可证 MIT" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-4D6BFE?style=flat-square&labelColor=1C2033"></a>
  <a href="https://github.com/pointylab/pointy/stargazers"><img alt="GitHub Star 数" src="https://img.shields.io/github/stars/pointylab/pointy?style=flat-square&logo=github&label=Star&color=4D6BFE&labelColor=1C2033"></a>
</p>

[安装](#安装说明) · [三种界面](#三种界面) · [浏览器扩展](#浏览器扩展) · [隐私](#隐私) · [许可](#许可)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/hero-dark.png">
  <img src="media/hero-light.png" alt="Pointy：晃一下鼠标，指哪问哪" width="100%">
</picture>

</div>

<p align="center">在 DSH 里打开「插件」→「添加插件」，填入下面这一行，点「安装」，装完重新打开 DSH。</p>

```
github:pointylab/pointy#release
```

<p align="center"><sub>Pointy 目前处于内测阶段，功能和界面还会调整。首次启用会下载一次运行时，详见<a href="#安装说明">安装说明</a>。</sub></p>

<br>

<a id="三种界面"></a>
<h3 align="center">三种界面，都能指</h3>

<p align="center">晃一下鼠标进入指认，框住你要问的那一块，点一下，卡片就弹在旁边。</p>

<table>
  <tr>
    <td align="center" width="33%"><b>网页</b><br><sub>指到一段话、一条评论、一张图。<br>需要浏览器扩展。</sub></td>
    <td align="center" width="33%"><b>普通程序</b><br><sub>指到一个按钮、一个选项、一段文字。<br>按 <kbd>[</kbd> <kbd>]</kbd> 调大调小范围。</sub></td>
    <td align="center" width="33%"><b>只能截图的程序</b><br><sub>QQ、网易云这类读不到文字的程序，<br>用滚轮调虚线框，发框里的截图。</sub></td>
  </tr>
</table>

<p align="center"><sub>右键或 <kbd>Esc</kbd> 取消指认。先选中文字再晃，直接问选中的文字。全屏游戏、演示时不会触发。</sub></p>

<br>

<h3 align="center">回答就在原地</h3>

<p align="center">只需要打问题。<b>快答</b>几句话说清楚，<b>完整</b>让 DSH 放开查资料、跑工具。<br>可以接着刚才的对话问，也可以开新任务；模型和思考强度在卡片上直接换。</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/card-dark.png">
    <img src="media/card-light.png" width="430" alt="Pointy 卡片：引用指到的段落，流式显示回答">
  </picture>
</p>

<br>

<h3 align="center">收起来，接着干</h3>

<p align="center">还没答完就关掉，卡片缩成右下角的一条胶囊，DSH 在后台继续。<br>蓝点表示进行中，绿点表示完成，点一下放回卡片接着问。</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/pills-dark.png">
    <img src="media/pills-light.png" width="300" alt="右下角的任务胶囊">
  </picture>
</p>

<br>

<a id="浏览器扩展"></a>
<h3 align="center">浏览器扩展：网页里看得更全</h3>

<p align="center">装上 Pointy 的浏览器扩展（Chrome、Edge），在网页里能指到具体的一段、一条评论、一张图，<br>DSH 收到的也不只是正文：网址、页面、作者、时间、链接一起带上。还多一个右键「问 Pointy」。</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/browser-dark.png">
    <img src="media/browser-light.png" width="100%" alt="左：装扩展的引导卡片；右：指住一条 GitHub 评论后 DSH 收到的内容">
  </picture>
</p>

<p align="center"><sub>Chrome 应用商店和 Edge 加载项商店正在上架。上架之前，从托盘的鲸鱼图标打开「安装浏览器扩展」，按卡片上的三步手动加载。<br>不装扩展也能在浏览器里用，网页按普通程序处理。</sub></p>

<br>

<a id="安装说明"></a>

## 安装说明

**系统要求**：Windows 10 / 11（x64 和 Arm 都支持，要有 WebView2 运行时，Windows 11 自带），或 macOS 12 及以上（Apple 芯片和 Intel 都支持）。

**安装**：DSH 里「插件」→「添加插件」，填 `github:pointylab/pointy#release`，点「安装」。装新版之前，先在「插件」里卸载旧版。也可以用命令行：

```bash
dsh plugin --profile desktop add github:pointylab/pointy#release
```

用 web 版 DSH 的，把 `desktop` 换成 `web`。

**首次启用**：装完重启 DSH。Pointy 随插件安装，不用另外下载：Windows 上是插件里的 Pointy.exe，macOS 上是 Pointy.app。以前装过的版本下载的运行时（`~/.pointy/runtime`）会被删除，设置保留。准备好后，托盘里出现鲸鱼图标，屏幕中间播放一段开场，就可以开始用了。之后 Pointy 随 DSH 启动、随 DSH 退出。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/intro-dark.gif">
    <img src="media/intro-light.gif" width="420" alt="首次启用时的开场：晃一下鼠标，指哪问哪">
  </picture>
</p>

**macOS 权限**：第一次晃鼠标时，系统会请你允许 Pointy 使用「辅助功能」（读取指到的内容、拦下指认时的点击）；第一次截图时会请你允许「屏幕录制」。都在「系统设置 → 隐私与安全性」里打开，改完重新打开 DSH。macOS 上 Pointy 的图标在菜单栏，下文的「托盘」都指这里。

**浏览器扩展**：托盘鲸鱼图标 →「安装浏览器扩展（推荐）…」，按弹出的卡片操作。扩展加载后会自动连接 Pointy，屏幕右下角会询问是否允许，点「允许」即可。

**托盘菜单**：调整晃动灵敏度、开关勿扰模式、安装浏览器扩展、退出。

<a id="隐私"></a>

## 隐私

- 晃动检测只读取光标位置，不安装鼠标钩子，也不记录轨迹。
- 只有在你指认并确认之后，Pointy 才读取那一块内容；浏览器扩展同样只在被调用时读取页面。截图只保存在内存中，随第一个问题一起发出。
- 指到的内容和你的问题只交给本机的 DSH，再由 DSH 发给你在 DSH 中配置的模型。Pointy 本身不联网。
- Pointy、DSH 插件和浏览器扩展之间只通过本机 `127.0.0.1` 通信，连接需要认证；浏览器扩展需要你在弹窗中点「允许」才能连接。
- 在密码管理器、系统登录与授权弹窗，以及标题像登录、密码、网银、支付页面的窗口中，晃动不会触发指认。
- Windows 上以管理员身份运行的程序无法读取，指认时会给出提示。

## 卸载

在 DSH「插件」里删除 Pointy，或使用命令行：

```bash
dsh plugin --profile desktop remove @pointylab/dsh
```

卸载后关闭 DSH，Pointy 退出时会删除自己的运行时、设置和浏览器扩展配对信息（Windows 是 `%USERPROFILE%\.pointy`、`%APPDATA%\pointy`，macOS 是 `~/.pointy`、`~/Library/Application Support/pointy`）。如果是在 DSH 未运行时用命令行卸载，Pointy 没有机会清理，请手动删除这两个文件夹。

<details>
<summary><b>开发</b></summary>

<br>

```
desktop/         Pointy 本体，Go 写的，跑在 mygo 上
  main.go        只负责把下面几块接起来
  internal/desktop/   和系统打交道的部分，darwin/ 和 windows/ 各一份，对外的样子相同
  internal/pick/      晃一下鼠标、取选区、普通程序里的指认（Windows 用 UI Automation，macOS 用辅助功能接口），对外只交出"抓到的东西"
  internal/browser/   浏览器扩展：配对、认证、网页里的指认、切标签页
  internal/agent/     卡片背后的 agent（DSH），以及 Pointy 随 DSH 启动和退出
  internal/ui/        卡片和胶囊、提示窗和开场、托盘
  internal/server/    127.0.0.1:47321 的 WebSocket 服务，DSH 插件和浏览器扩展都连这里
app/             各个窗口的页面（card、pill、notice、intro、pick/overlay），TypeScript 写的，通过 bridge/ 和 Go 通信
locales/         页面和 Go 共用的文案
plugin/          DSH 插件 @pointylab/dsh：把会话、回答推给 Pointy，必要时拉起 Pointy
extension/       Chrome / Edge 扩展
media/           README 用的截图和动图
```

DSH 的插件宿主是 DSH 自己的程序以 node 模式运行的子进程，无法打开窗口，因此 Pointy 是单独的进程，由插件携带并拉起：`desktop/` 里的 Go 程序，Windows 上是 Pointy.exe，macOS 上是 Pointy.app。

**运行开发版**

```bash
npm install
npm run build
cd desktop && go run .
```

开发版从仓库的 `build/` 读页面。它和插件拉起的那份共用 `~/.pointy` 和单实例锁：开发版运行时，插件发现 47321 端口已有 Pointy，就直接连接，不再拉起自带的那份。

**打包插件**

```bash
node tools/pack-plugin.ts
```

要在装了 Go 的 Mac 上运行。它把 `app`、`assets`、`extension` 复制进 `plugin/pet`，用 `go tool mygo build` 生成 Apple 芯片和 Intel 通用的 `plugin/pet/Pointy.app`（带页面资源，默认 ad hoc 签名），再交叉编译 Windows 的 `plugin/pet/win32-x64/Pointy.exe` 和 `plugin/pet/win32-arm64/Pointy.exe`（不用 cgo；图标和按显示器感知 DPI 的清单由 mygo 生成，打包时再在清单里写上 `asInvoker`），最后 `npm pack` 生成 `dist/pointylab-dsh-<版本>.tgz`。macOS 上插件通过 `open` 启动包里的 Pointy.app，这样系统把辅助功能和屏幕录制权限记在 Pointy 名下；Windows 上插件直接启动对应架构的 Pointy.exe，它读 `plugin/pet` 里的页面。以前装过的 `~/.pointy/runtime`（Electron）会被删除，设置保留。在 Windows 或 Linux 上可以用 `node tools/pack-plugin.ts --windows-only` 打一个只有 Windows 程序的包，用来测试。

签名和公证是可选的：设了 `APPLE_SIGNING_IDENTITY` 就用这个 Developer ID 签名，再设 `APPLE_NOTARY_PROFILE`（`xcrun notarytool store-credentials` 存的配置名）就公证并装订。`.github/workflows/macos.yml` 在 macOS 上跑检查并打包，产物是同一个 tgz；仓库配了 `APPLE_CERTIFICATE` 等 secrets 时才签名和公证，没配就 ad hoc。插件没有 npm 依赖。

本地试装：`dsh plugin --profile <profile> add file:<tgz 的绝对路径>`。每次修改后先把 `plugin/package.json` 的版本号加一，同名同版本 pnpm 可能使用缓存；不要用 `link:`（`remove` 会连同源码目录一起删除）。

**测试用的环境变量**

- `POINTY_PORT`：修改端口，Pointy 和插件两边都识别。
- `npm run fake`：不启动 DSH，模拟插件推送一遍状态。

</details>

<a id="许可"></a>

## 许可

本项目源代码依 [MIT 许可证](LICENSE) 发布。

仓库中的鲸鱼娘形象素材（卡片旁的像素形象、指认光标、托盘与扩展图标，以及 `media/` 中包含这些形象的截图和动图）不适用 MIT 许可证，而依 [知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议（CC BY-NC-SA 4.0）](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) 授权。原作者为上善无形，像素重绘为 ZipZipPipe。使用、修改或再发布这些素材前，请阅读 [ASSETS.md](ASSETS.md)。

Pointy 是社区开发的第三方插件，与 DeepSeek 不存在隶属、合作或背书关系。「DeepSeek」及相关名称和标识归其权利人所有。

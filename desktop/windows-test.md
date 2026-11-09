# Windows 测试清单（Go 版 Pointy，平台层）

这个分支把 Electron 版的 Windows 平台层（`app/core/os/win32.ts`、`app/pick/native/uia-selection.ps1`）移植到了 Go，代码在 `desktop/internal/desktop/windows/`。写的时候没有 Windows 机器，只在 macOS 上交叉编译、跑了纯逻辑的单测。下面每一项都要在真机上过一遍。

注意：抖动指认的流程（PR4）还不在这个分支上，所以现在还不能「抖一下、指一下、出卡片」。这里测的是平台层的每个调用，靠的是自检模式。

## 准备

需要 Go 1.27.3 或更新的版本，在仓库根目录执行：

```powershell
cd desktop
go build -ldflags "-H windowsgui" -o out\Pointy.exe .
```

ARM 的机器加上 `$env:GOARCH = 'arm64'`。也可以直接下载 CI 产物 `pointy-desktop-windows`，里面有 `Pointy.exe` 和 `Pointy-arm64.exe`。

自检的跑法：先打开要测的程序，再执行下面这几行，然后在 5 秒内点一下那个程序的窗口，让它到最前面。接下来大约 30 秒别碰鼠标，自检会自己移动鼠标、点击、滚动。

```powershell
$env:POINTY_ROOT = (Resolve-Path ..).Path          # 让它找到 assets\cursor 里的光标
$env:POINTY_SELFCHECK = "$PWD\out\selfcheck.txt"
$env:POINTY_SELFCHECK_WAIT = 5
$env:POINTY_SELFCHECK_TEXT = '文档里的某一行原文'   # 可以不设；设了会多检查读到的文字
Start-Process out\Pointy.exe -Wait
Get-Content out\selfcheck.txt
```

结果文件里每行是 `PASS`、`FAIL`、`INFO` 或 `SKIP`。截图存在同一个目录（`window-*.png`、`capture-target.png`）。每跑一轮，把 `out\` 整个打包发回来就行。

## 按风险从高到低

### 1. 透明窗口（最先测）

mygo 的网页窗口在 Windows 上可能把透明的地方画成黑色。现在用的修法是 spike #9 里的方案 B：DWM blur-behind，区域设成空的。

- 跑一次自检，对着记事本就行。
- 看这几行：`transparent corners show what is behind`、`the page paints`、`click-through window keeps transparent corners`、`clicks pass through`。
- 打开 `window-shown.png`：应该看到一个蓝色圆角块，四周是记事本原来的样子，不能是黑边或白边。
- 如果角是黑的：把 `internal\desktop\windows\window.go` 里的 `const transparency = blurBehind` 改成 `stockWindow`，重新编译再跑一次，两次的截图都发回来。两种都不行的话，说明要用方案 C，那得改窗口的创建方式（`internal/ui`），回来再商量。
- 在「设置 → 个性化 → 颜色」里把透明效果关掉，再跑一次。

### 2. UI Automation 读控件

UIA 是直接按 COM 的 vtable 调的，槽位错一个，程序就会直接崩掉。所以结果文件如果中途截断，或者 `out\` 里只有 exe 没有 txt，多半就是这里出了问题。

依次对这些程序跑自检，每个程序都把鼠标放在正文上：

- 记事本：`PointAt` 的第一个控件应该是 `ControlType.Document` 或 `ControlType.Edit`。设了 `POINTY_SELFCHECK_TEXT` 的话，`ElementAt reads the target's text` 应该是 PASS。
- 记事本里先全选再跑：`Grab reads the selection` 应该读到选中的文字。
- Windows Terminal：顶层窗口里的文字控件走的是 `textChildAt` 这条路，`ElementAt` 的文字应该是屏幕上看得到的那部分。
- QQ 或微信：控件链大概只有一个 `Chrome_RenderWidgetHostHWND` 的外壳，这是正常的。只要不崩、`PointAt` 有返回就算过。
- 设置或资源管理器：控件链应该有好几层，名字能对上。
- 看 `PointAt #1/#2/#3` 的耗时。旧版的 PowerShell 第一次要好几百毫秒，这里应该在几十毫秒以内。

### 3. 鼠标钩子

- 自检里的三行 `hook reports ...`、`hooked clicks never reach the target`、`after Close a click reaches the target` 都要是 PASS。最后一行证明钩子关掉以后点击能正常传过去，前面那行「没传过去」才有意义。
- 跑完以后随便点点别的程序，确认鼠标完全正常，左键、右键、滚轮都要试。万一被吞了，按 Ctrl+Alt+Del 再取消就能恢复，然后把结果发回来。

### 4. DPI 和多显示器

- 在 100%、125%、150% 缩放下各跑一次。`ToDIP agrees with mygo` 和 `UnitsPerDIP agrees with mygo` 都要是 PASS。
- 有第二块屏幕的话，把它设成不同的缩放，把记事本拖到那块屏上再跑一次。
- 150% 下看 `capture-target.png`，应该是清晰的、物理像素大小的记事本截图。

### 5. 系统光标

- 看 `SwapCursor changes the arrow` 和 `RestoreCursor brings the arrow back`。
- 跑完以后在桌面、记事本和浏览器里看一眼，鼠标应该是你自己平时用的箭头和 I 形光标，不能还是 Pointy 的鲸鱼。
- 如果你用了自定义的光标方案，也测一下，恢复时走的是重新加载注册表里的方案。

### 6. 跟随来源窗口和真卡片

自检只检查了窗口的 owner 设对了没有（`owner is the target's top-level window`），叠放顺序得用真卡片来看：

1. 先退出 DSH，让 Electron 版的 Pointy 停掉，免得两个抢 47321 端口。
2. 在仓库根目录执行 `npm ci`，再执行 `node tools/build.ts`，生成 `build\app`。
3. 运行 `desktop\out\Pointy.exe`，不要设 `POINTY_SELFCHECK`。用的是同一个 `~\.pointy`，浏览器扩展会自己连上。
4. 在 Chrome 里选中一段字，右键选「问 Pointy：…」，会弹出一张卡片。
5. 检查这几点：卡片的四个圆角是透明的；卡片浮在 Chrome 上面；点一下别的程序，卡片会被那个程序盖住，不会一直置顶；切回 Chrome，卡片又回到 Chrome 上面；拖动 Chrome 的时候，卡片跟着走。

### 7. 以管理员身份运行的窗口、全屏、卸载清理

- 用管理员身份开一个记事本，把鼠标放上去跑自检：`ElevatedUnderCursor` 应该是 `true`。
- 全屏放一个视频，或者开一个 PowerPoint 放映，在它上面跑自检：`FullscreenActive` 应该是 `true`。最大化的普通窗口（任务栏还看得见）应该是 `false`。
- 结果文件最后的 `RemoveAfterExit` 会给出一个临时目录。Pointy 退出后大约 15 秒，这个目录应该被删掉了。

## 发回来的东西

- 每轮的 `out\` 目录（`selfcheck.txt` 和所有截图）。
- 系统版本、缩放比例、有几块屏幕。结果文件开头的 `INFO system` 已经写了大部分。
- 第 1 项如果两种方案都试了，两次的截图都要。

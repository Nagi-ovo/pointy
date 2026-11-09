# Windows 测试清单（Go 版 Pointy）

这个分支把 Electron 版的 Windows 平台层（`app/core/os/win32.ts`、`app/pick/native/uia-selection.ps1`）移植到了 Go，代码在 `desktop/internal/desktop/windows/`。它接在 macOS 那条线后面，抖动指认的整套流程（`desktop/internal/pick`）是两边共用的，所以现在 Windows 上已经能「抖一下、指一下、出卡片、提问」。

写的时候手边没有 Windows 机器：只在 macOS 上交叉编译了 amd64 和 arm64，跑了不依赖系统的单测。下面每一项都没在真机上跑过，都要过一遍。

## 准备

需要 Go 1.27.3 或更新的版本，以及 Node。在仓库根目录执行：

```powershell
npm ci
node tools/build.ts          # 生成 build\app 里的卡片、浮层等页面，Pointy.exe 会自己找到它
cd desktop
go build -ldflags "-H windowsgui" -o out\Pointy.exe .
```

ARM 的机器在 `go build` 前加一句 `$env:GOARCH = 'arm64'`。也可以直接下载 CI 产物 `pointy-desktop-windows`，里面有 `Pointy.exe` 和 `Pointy-arm64.exe`，但页面还是要用上面的 `node tools/build.ts` 生成。

## 第一步：自检

自检会把每个平台调用跑一遍，最后用共用的状态机真的指认一次：把鼠标移到目标程序的正文上，盖上一层浮层，自己点一下确认，再检查卡片会拿到什么。

跑法：先打开要测的程序，然后在 `desktop` 目录里执行下面几行，接着在 5 秒内点一下那个程序的窗口，让它到最前面。之后大约 40 秒别碰鼠标，自检会自己移动鼠标、点击、滚动。

```powershell
$env:POINTY_ROOT = (Resolve-Path ..).Path          # 让它找到 assets\cursor 里的光标
$env:POINTY_SELFCHECK = "$PWD\out\selfcheck.txt"
$env:POINTY_SELFCHECK_WAIT = 5
$env:POINTY_SELFCHECK_TEXT = '文档里的某一行原文'   # 可以不设；设了会多检查读到的文字
Start-Process out\Pointy.exe -Wait
Get-Content out\selfcheck.txt
```

结果文件里每行是 `PASS`、`FAIL`、`INFO` 或 `SKIP`。截图存在同一个目录。每跑一轮，把 `out\` 整个打包发回来就行。CI 每次也会对着记事本跑一遍同样的自检。

跟指认有关的几行：

- `pick starts pointing`、`the overlay shows above the target`、`pointing draws the control under the mouse`：浮层盖上来以后，UIA 还能读到它下面的控件。
- `pick opens a card`、`the card holds the target's text`：点一下以后，卡片拿到的是记事本里的文字。
- `the pick's picture leaves the overlay out`：自检的浮层在目标正中画了一块洋红色，`pick-picture.png` 里不能有它。真的浮层也是这样，Pointy 截图时会把自己的窗口排除在外。这要求 Windows 10 2004 或更新的版本。
- `the confirming click never reaches the target`、`pointing puts the cursor back`、`the card lets the held box go`：确认的那一下点击被拦住了，光标换回来了，卡片放手后框也消失了。

## 第二步：完整流程

### 先换掉 Electron 版

DSH 的插件只在 47321 端口没人应答时才去启动 Electron 版的 Pointy，所以要先让 Go 版占住端口：

1. 退出 DSH，在任务管理器里确认没有 `Pointy.exe` 还在跑。
2. 运行 `desktop\out\Pointy.exe`，不要设 `POINTY_SELFCHECK` 和 `POINTY_ROOT`。托盘里应该出现 Pointy 的图标。
3. 再打开 DSH。插件会连上已经在跑的 Go 版 Pointy，托盘菜单里应该显示已连接。

用的还是原来的 `~\.pointy`，设置、扩展配对都沿用。想让它把每次指认的诊断写进日志，可以在 `~\.pointy\settings.json` 里加上 `"debugPick": true`，日志在 `~\.pointy\error.log`。

### 记事本

1. 打开一个有几段文字的记事本。
2. 选中一句话，然后快速左右晃动鼠标。应该直接弹出卡片，里面是选中的那句话。
3. 取消选中，再晃一次。这次光标会变成鲸鱼，屏幕上出现一个跟着鼠标走的框，框上写着控件类型和名字。
   - 按 `]` 框会往外扩一层，按 `[` 缩回来。
   - 按 Esc 或右键取消，光标要变回原来的样子，点击要能正常传给记事本。
4. 再晃一次，把框停在正文上，左键点一下（或按空格）。卡片弹出来，里面有正文。记事本里的光标位置不能因为这一下点击而改变。
5. 卡片开着的时候，框应该一直画在记事本上面。切到别的程序，框要被那个程序盖住；关掉卡片，框也跟着消失。
6. 对着工具栏这类没有文字的地方指认一次，卡片里应该附带一张截图。打开截图看一眼，里面不能有 Pointy 的框或者其他 Pointy 窗口。

### Chrome

1. 扩展已连接（Chrome 已经装了 Pointy 扩展，托盘菜单里能看到它）：在网页上晃鼠标，应该由扩展在网页里指认，点一段文字，卡片里是这段文字和网页地址。如果卡片说「浏览器扩展没连上」，到 `chrome://extensions` 里把 Pointy 扩展重新加载一下。
2. 扩展没连上：在 `chrome://extensions` 里先把扩展关掉，再晃鼠标。这时走的是和记事本一样的指认，框上会多一行「浏览器扩展未连接」；第一次出卡片时，卡片上会说这次按普通程序指认。网页正文应该能读到，链接会带上地址。
3. 测完把扩展打开。

### 提问

在上面任何一张卡片里输入一个问题并发送，应该能看到 DSH 的回答一点点出来。如果没有反应，看一下托盘菜单里是不是显示已连接，再把 `~\.pointy\error.log` 发回来。

## 按风险从高到低

### 1. 透明窗口（最先测）

mygo 的网页窗口在 Windows 上可能把透明的地方画成黑色。现在用的修法是 spike #9 里的方案 B：DWM blur-behind，区域设成空的。

- 跑一次自检，对着记事本就行。
- 看这几行：`Capture leaves Pointy's windows out`、`transparent corners show what is behind`、`the page paints, and Capture showed it to recorders again`、`click-through window keeps transparent corners`、`clicks pass through`。
- 打开 `window-shown.png`：应该看到一个蓝色圆角块，四周是记事本原来的样子，不能是黑边或白边。`window-captured.png` 里只有记事本，没有蓝块。
- 如果角是黑的：把 `internal\desktop\windows\window.go` 里的 `const transparency = blurBehind` 改成 `stockWindow`，重新编译再跑一次，两次的截图都发回来。两种都不行的话，说明要用方案 C，那得改窗口的创建方式（`internal/ui`），回来再商量。
- 在「设置 → 个性化 → 颜色」里把透明效果关掉，再跑一次。

### 2. 截图时排除 Pointy 自己的窗口

确认指认时浮层还在屏幕上，Windows 上的截图是从整个屏幕上截的，所以截图前会给 Pointy 的窗口临时设上 `WDA_EXCLUDEFROMCAPTURE`，截完马上恢复。

- 自检里的 `the pick's picture leaves the overlay out` 和 `Capture leaves Pointy's windows out` 要是 PASS。
- 如果开着 OBS 或者 Teams 共享屏幕，指认那一瞬间 Pointy 的框可能会在录像里闪一下，这是预期的。其余时间录像里应该能正常看到 Pointy。
- Windows 10 2004 之前的系统没有这个开关，截图里会带上框。这种机器现在很少，遇到了告诉我。

### 3. UI Automation 读控件

UIA 是直接按 COM 的 vtable 调的，槽位错一个，程序就会直接崩掉。所以结果文件如果中途截断，或者 `out\` 里只有 exe 没有 txt，多半就是这里出了问题。

依次对这些程序跑自检，每个程序都把鼠标放在正文上：

- 记事本：`PointAt` 的第一个控件应该是 `ControlType.Document` 或 `ControlType.Edit`。设了 `POINTY_SELFCHECK_TEXT` 的话，`ElementAt reads the target's text` 应该是 PASS。
- 记事本里先全选再跑：`Grab reads the selection` 应该读到选中的文字。
- Windows Terminal：顶层窗口里的文字控件走的是 `textChildAt` 这条路，`ElementAt` 的文字应该是屏幕上看得到的那部分。
- QQ 或微信：控件链大概只有一个 `Chrome_RenderWidgetHostHWND` 的外壳，这是正常的。只要不崩、`PointAt` 有返回就算过。真指认的时候它会被当成「程序界面」，卡片里带一张截图，滚轮可以放大缩小截图的范围。
- 设置或资源管理器：控件链应该有好几层，名字能对上。
- 看 `PointAt #1/#2/#3` 的耗时。旧版的 PowerShell 第一次要好几百毫秒，这里应该在几十毫秒以内。

### 4. 鼠标钩子

- 自检里的 `hook leaves the wheel alone until SetWheel`、三行 `hook reports ...`、`hooked clicks never reach the target`、`after Close a click reaches the target` 都要是 PASS。最后一行证明钩子关掉以后点击能正常传过去，前面那行「没传过去」才有意义。
- 跑完以后随便点点别的程序，确认鼠标完全正常，左键、右键、滚轮都要试。万一被吞了，按 Ctrl+Alt+Del 再取消就能恢复，然后把结果发回来。

### 5. DPI 和多显示器

- 在 100%、125%、150% 缩放下各跑一次。`ToDIP agrees with mygo` 和 `UnitsPerDIP agrees with mygo` 都要是 PASS。
- 有第二块屏幕的话，把它设成不同的缩放，把记事本拖到那块屏上再跑一次，再手动指认一次：框要正好套住控件，不能偏。
- 150% 下看 `capture-target.png`，应该是清晰的、物理像素大小的记事本截图。

### 6. 系统光标

- 看 `SwapCursor changes the arrow`、`RestoreCursor brings the arrow back` 和 `pointing puts the cursor back`。
- 跑完以后在桌面、记事本和浏览器里看一眼，鼠标应该是你自己平时用的箭头和 I 形光标，不能还是 Pointy 的鲸鱼。
- 如果你用了自定义的光标方案，也测一下，恢复时走的是重新加载注册表里的方案。

### 7. 以管理员身份运行的窗口、全屏、卸载清理

- 用管理员身份开一个记事本，把鼠标放上去跑自检：`ElevatedUnderCursor` 应该是 `true`。真指认时应该弹出提示「这个程序以管理员身份运行，Pointy 读不到」。
- 全屏放一个视频，或者开一个 PowerPoint 放映，在它上面跑自检：`FullscreenActive` 应该是 `true`，这时晃鼠标不会触发指认。最大化的普通窗口（任务栏还看得见）应该是 `false`。
- 结果文件最后的 `RemoveAfterExit` 会给出一个临时目录。Pointy 退出后大约 15 秒，这个目录应该被删掉了。

## 发回来的东西

- 每轮的 `out\` 目录（`selfcheck.txt` 和所有截图）。
- 完整流程里哪一步不对，附上 `~\.pointy\error.log`，最好开着 `debugPick`。
- 系统版本、缩放比例、有几块屏幕。结果文件开头的 `INFO system` 已经写了大部分。
- 第 1 项如果两种方案都试了，两次的截图都要。

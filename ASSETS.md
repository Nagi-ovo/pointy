# 图片素材

Pointy 的代码以 MIT 发布（见 [LICENSE](LICENSE)），但下面这些美术素材**不在 MIT 授权范围内**。

鲸鱼娘形象是 DeepSeek 鲸鱼娘的同人创作：原作 上善无形，像素重绘 ZipZipPipe，按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) 授权。使用时要署名，不能用于商业用途，改编后的作品要用相同协议发布。

你可以为了构建、测试和运行本仓库而使用它们。如果以修改版或衍生作品的身份再发布，请遵守上面的授权条件，或者换成自己的素材。

| 素材 | 位置 | 来源 |
|---|---|---|
| 卡片旁边的像素鲸鱼娘 | `app/card/mascot/` | 鲸鱼娘同人（上善无形 原作，ZipZipPipe 像素重绘） |
| 指认时的鼠标光标 | `assets/cursor/`、`extension/cursor-*.png` | 由上面的鲸鱼娘形象改成光标 |
| 托盘图标、Pointy.exe 的图标 | `assets/tray.png`、`assets/tray@2x.png`（打包时拼成 `pointy.ico`） | 同上 |
| 浏览器扩展图标 | `extension/icon.png` | 由 `assets/tray@2x.png` 放大 |
| DSH 插件管理里显示的图标 | `plugin/icon.png` | 由 README 头像（`media/logo.png` 的原图）裁出 |
| README 里的头像、截图和动图 | `media/` | 头像由上面的鲸鱼娘形象做成；截图是 Pointy 的界面，画面里有上面这些形象，网页部分来自截图里写明的网站 |

这些鲸鱼娘形象是非官方的同人形象，和 DeepSeek 没有关系，也不代表 DeepSeek。如果权利人提出要求，我们会替换。

光标由 `assets/cursor/make_cursor.py` 从 `assets/cursor/source.png` 生成，脚本本身和其他源码一样以 MIT 发布。

第三方代码：随插件包分发的 [koffi](https://koffi.dev)（MIT）和 [ws](https://github.com/websockets/ws)（MIT）保留各自的许可证，在 `pet/vendor/` 下；插件下载的 [Electron](https://www.electronjs.org)（MIT）是官方原版，只改了程序名、描述和图标。

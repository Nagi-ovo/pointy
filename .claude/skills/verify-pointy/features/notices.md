# Notices

Notices are cards in the bottom-right corner that ask the user something: the welcome on first start, the browser extension guide with its copy buttons, and the prompt to let a browser extension connect.

## Sub-features

- `notice-welcome` shows how to point and offers the extension guide.
- `notice-guide` lists the steps, with copy buttons for `chrome://extensions` and the extension path.
- `notice-pair` asks whether to let a browser's extension connect, with Allow and Don't Allow.

## How to get to it (user POV)

- The tray's 使用说明… (How to Use…), and the welcome's 安装浏览器扩展 button.
- The tray's "浏览器扩展未连接，点这里安装…" item.
- Installing the extension, which then asks to pair.

## Driving it with verify-pointy

Preconditions:

- A run is up. No extension is connected, so the tray offers the install item.

- **Welcome.** Run `zsh .claude/skills/verify-pointy/scripts/tray.sh welcome 使用说明…`. `has notice.html` succeeds, and `js $(win notice.html) "return document.getElementById('box').innerText"` says `Pointy 已就位`.
- **Guide.** Run `js $(win notice.html) "document.querySelector('#buttons .primary').click(); return 'ok'"`. The next notice reads `安装浏览器扩展（推荐）`. Click a copy chip with `js`, then `pbpaste` prints `chrome://extensions`.
- **Close.** Run `js $(win notice.html) "document.getElementById('x').click(); return 'ok'"`. `has notice.html` fails.

## Gotchas

- One notice at a time. A new notice replaces the one on screen.
- The pairing prompt needs a socket with an extension's Origin (`chrome-extension://…`). See `desktop/internal/browser/pair.go`.

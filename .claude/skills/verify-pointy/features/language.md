# Language

Pointy shows Simplified Chinese or English. By default it follows the system's languages, which is English on a Mac that lists `en-US` first. The tray's 语言 / Language menu overrides that and keeps the choice in `settings.json` as `locale`. Go draws the tray menu and tooltip, the hints and the notifications in the new language at once. Pages opened after the switch (notices, cards, pills) say the texts that are in `locales/` in that language. Page texts not yet in the catalog stay Chinese.

## Sub-features

- `lang-default` follows the system on a home without `locale`.
- `lang-choose` switches the tray menu and tooltip at once and saves `locale`.
- `lang-pages` shows the next notice or card in the chosen language. Windows already open keep theirs.
- `lang-system` goes back to the system's language with 跟随系统 / Same as System.

## How to get to it (user POV)

- Click the whale in the menu bar, then 语言 > English, or Language > 简体中文, or the system item.

## Driving it with verify-pointy

Preconditions:

- A run started with `up.sh zh-CN`.

- **Chinese menu.** Run `zsh .claude/skills/verify-pointy/scripts/tray.sh zh`. `run.log` lists `晃一下鼠标指认`, `使用说明…`, `勿扰模式`, `语言` and `退出 Pointy`, and the icon tooltip starts with `Pointy\n`, followed by Chinese status lines.
- **Switch.** Run `zsh .claude/skills/verify-pointy/scripts/tray.sh switch 语言 English`. `$VP_RUN/home/.pointy/settings.json` then has `"locale": "en"`.
- **English menu.** Run `zsh .claude/skills/verify-pointy/scripts/tray.sh en`. The items read `Shake the Mouse to Point`, `How to Use…`, `Do Not Disturb`, `Language` and `Quit Pointy`, and the tooltip says `Browser extension not connected`.
- **English page.** Run `zsh .claude/skills/verify-pointy/scripts/tray.sh guide "How to Use…"`, then `js $(win notice.html) "return document.getElementById('box').innerText"`. The notice says `Pointy is ready` and `Shake the mouse`. Screenshot it with `pa screenshot --window $(win notice.html) $EV/en-notice.png`, then close it with `js $(win notice.html) "document.getElementById('x').click(); return 'ok'"`.
- **Back.** Run `tray.sh back Language "Same as System"`. `locale` leaves `settings.json`.

## Gotchas

- The menu is read through accessibility at points down its middle. A menu item without a title (a separator) has no row.
- macOS 26 hosts the menu bar icon in Control Center. `drive extras PID` finds it, and `drive windows PID` does not list it.
- The language is fixed when a page opens. Don't expect an open card or pill to change.

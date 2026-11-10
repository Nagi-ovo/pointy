---
name: verify-pointy
description: Drive the Go (mygo) build of Pointy on macOS the way a user does, against an isolated DSH with a mock model, and capture screenshots and logs as proof. Use to verify any change to the desktop runtime, the pages (card, pill, notices, overlay), the plugin, or the language of Pointy's texts before calling it done.
---

# verify-pointy

Pointy is a menu bar app: shake the mouse over any window, point at something, and a card asks DSH about it. The Go runtime in `desktop/` draws the tray, hints and notifications and opens web pages from `build/app/` (card, pill, notice, overlay). The DSH plugin in `plugin/` relays between DSH and Pointy over `127.0.0.1:$POINTY_PORT`.

A run here starts its own Pointy, DSH and model on scratch homes and ports, and never touches Jesse's: his Pointy (47321), his DSH (3080) and his `~/.pointy` stay as they are. The Windows build is not covered; this skill is macOS only.

## Safety rules

These were learned from runs that went wrong. Every script enforces them; keep them when you add one.

- **Never send synthetic keystrokes.** A previous run's typing landed in Jesse's apps. Text goes into pages through `mygo-automation eval`, never `type` or `key`, never `osascript ... keystroke`.
- **Wait until the user has been idle for at least 30 s, and abort otherwise.** `guard` in `scripts/env.sh` does this before every batch of mouse input. It waits up to 15 min (`VP_WAIT`), then gives up. If it gives up, report that and stop. Don't lower `VP_IDLE` to get a run through.
- **Wait while the screen is locked.** `guard` checks `CGSSessionScreenIsLocked` (`drive locked`). WebKit paints nothing while the screen is locked, so screenshots come out blank and page heights read 0.
- **Move the mouse only over windows the run created.** `mine X Y PID` checks the window owner before each click. The tray icon sits in a Control Center window on macOS 26, so `tray.sh` checks it through accessibility (`drive extras PID`) instead.
- **Space is a global shortcut while pointing.** If the user types during a pick, their Space confirms the pick, and their `[`/`]`/Esc reach Pointy instead of their app. Keep picks short and always run `guard` first.
- **Kill only processes the run started, by PID.** `down.sh` kills the PIDs `up.sh` recorded and their children. It never kills by name.

## Launch

Run once per session from the repo root. Needs Go, Node 24+, `dsh` on PATH (or `DSH=/path/to/dsh`), Accessibility and Screen Recording granted to the terminal, and ports 47397, 47398 and 3093 free.

```sh
eval "$(zsh .claude/skills/verify-pointy/scripts/up.sh zh-CN)"   # or "en", or "" to follow the system
```

`up.sh` does the following:

1. Makes `VP_RUN=/tmp/verify-pointy.XXXXXX`.
2. Builds the pages and the plugin (`node tools/build.ts`), the e2e build of Pointy, `desktop/cmd/drive` and `mygo-automation`, and packs the plugin with `npm pack ./plugin`.
3. Seeds a DSH workspace and a Pointy `settings.json` whose `locale` is the argument.
4. Installs the plugin into `DSH_HOME=$VP_RUN/dsh-home` with `HOME=$VP_RUN/home`.
5. Starts `tools/mock-llm.ts` on 47398, then Pointy on 47397 with `MYGO_AUTOMATION=$VP_RUN/a.sock`, then `dsh web --port 3093`.

It is ready when it prints `export VP_RUN=...`, which means the plugin connected (`dsh-ui` in `$VP_RUN/home/.pointy/error.log`). Pointy must be up before DSH. Otherwise the plugin starts the Pointy.app it carries.

Two traps `up.sh` already handles:

- `settings.json` gets `welcomedVersion` set to the repo's `package.json` version. Otherwise Pointy plays a full-screen intro, which covers every window for 8 s, and `mine` refuses to click.
- `VP_RUN` is the resolved path (`/private/tmp/...`). DSH refuses a workspace whose path is a symlink to the session's cwd.

Pointy reads `locale` from `settings.json` only at start. Jesse's Mac lists `en-US` first, so `""` shows English there. Pass `zh-CN` to check the Chinese UI.

## Doctor

```sh
zsh .claude/skills/verify-pointy/scripts/doctor.sh
```

Read-only. It checks that the three processes live, that each port is held by this run's PID, that the plugin connected, that the automation socket answers, that the binary is newer than `go.mod`, and that the screen is unlocked. Run it first whenever anything looks off.

## Drive

Every script sources `scripts/env.sh`, which needs `VP_RUN` and gives `pa` (mygo-automation on this run's session), `js <window> <script>`, `win <page>`, `has <page>`, `drive`, `guard`, `mine` and `log`.

| Script | Does |
| --- | --- |
| `pick.sh <name>` | Opens `fixture.txt` as a new TextEdit document, shakes over it, clicks its first paragraph, and prints the card's window id. |
| `ask.sh <card> <name> <question> [keep]` | Asks in full mode through the card page and logs every progress line. With `keep`, closes the card mid-task and follows the pill to done. |
| `tray.sh <name> [item [subitem]]` | Opens the tray menu with a real click, logs its items (read through AX) and the icon's tooltip, then chooses `item` > `subitem` or closes the menu. |

Page windows are `[page]` lines in `pa windows`, as `w3 [page] "Pointy" url=.../card/card.html`. Read page state with `js`, for example `js $(win card.html) "return document.getElementById('activity').innerText"`. Grab data comes from `js $cw "return window.mygo.call('Card.Init')"`.

Desktop input goes only through `$VP_RUN/bin/drive` (`move`, `shake`, `click`, `chain`, `at`, `windows`, `extras`, `idle`, `locked`). Page input goes only through `eval`. The e2e build also binds `E2E.OpenGrab`, `E2E.ShowWelcome` and others (`desktop/automation_e2e.go`), which `pa eval --window <the e2e window> "mygo.call('E2E.ShowWelcome')"` reaches. They skip the user path, so use them only to set up a state the feature under test does not cover.

## Evidence

Everything goes to `$VP_RUN/evidence/`. `run.log` gets every logged step, `mock.jsonl` gets every model request, and each script adds its `<name>-*.png` screenshots. A proof:

- Takes the user path: a shake and a click, the card's own buttons, the tray menu. It does not use test hooks or internal setters.
- Records the action and the state it led to. For example, the progress lines the card showed, the pill before and after the task finished, and the menu before and after the language switch.
- Checks side effects next to what is visible: `settings.json` after a tray choice, `mock.jsonl` for what DSH sent the model, `error.log` for Pointy's own account.
- Mocks only the model. DSH, the plugin and Pointy are real.

## Cleanup

```sh
zsh .claude/skills/verify-pointy/scripts/down.sh
```

Kills the recorded PIDs and their children and closes the fixture documents the run opened. Deletes the scratch homes, the binaries and the socket. `$VP_RUN/evidence` stays. Run it after every run, failed ones too.

## Feature map

`features/README.md` lists what to drive and how to tell that it worked. Before you call a change verified, cover every entry point the map lists for the feature you touched.

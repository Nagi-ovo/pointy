# Pointy verification map

This directory is the maintained source for verifying what Pointy's users see on macOS. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- A run is up: `eval "$(zsh .claude/skills/verify-pointy/scripts/up.sh zh-CN)"`, and `doctor.sh` prints no `FAIL`.
- Ports 47397 (Pointy), 47398 (mock model) and 3093 (DSH) belong to this run, and Jesse's Pointy on 47321 and DSH on 3080 stay untouched.
- The screen is unlocked and the user has been idle for 30 s before any mouse input (`guard`).

## Driving conventions

- Desktop input goes only through `$VP_RUN/bin/drive`, and only over windows this run created. Page input goes only through `mygo-automation eval`. Never send keystrokes.
- Prefer element ids in pages (`#activity`, `#target-label`, `.pill`) and accessibility names in native menus over coordinates.
- One run at a time on the Mac: every lane shares the mouse.

## Proof and skip reporting

- Capture the action and the state it led to, with the screenshots and `run.log` lines the scripts write to `$VP_RUN/evidence`.
- Check side effects: `settings.json`, `mock.jsonl`, `error.log`.
- If `guard` gives up because the user stayed active or the screen stayed locked, report the lane as not run, with that reason. Don't report it as verified some other way.

## Feature entry contract

Each feature file starts with an H1 title and a paragraph on what the user sees. It then has four H2 sections, in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-pointy`, `Gotchas`.

## Features

- [Ask from a card](./card-ask.md) covers sending a question, the progress lines, the answer and the session title.
- [Keep a task as a pill](./pill.md) covers closing a running card into a pill, its title and dot, and restoring it.
- [Language](./language.md) covers the tray's Language menu and which texts follow it.
- [Point at a control](./pick.md) covers shaking, the pointing overlay, clicking, and the card it opens.
- [Notices](./notices.md) covers the welcome, the extension guide and the pairing prompt.

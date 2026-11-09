# Keep a task as a pill

Closing a card while DSH still works on it shrinks the card into a pill in the bottom-right corner. A blue dot means DSH is still working and a green dot means it finished. The pill shows the session's title, or "新任务" while the task has none. Clicking the pill puts the card back.

## Sub-features

- `pill-keep` closes a running card into a pill.
- `pill-state` turns the dot from `run` to `done` or `error` as DSH finishes.
- `pill-title` follows DSH's title unless the card was asked in an existing session.
- `pill-restore` puts the card back on click. The × button drops the pill and its card.

## How to get to it (user POV)

- Press the card's × (or Esc) while it is still answering.
- Click the pill to restore the card.

## Driving it with verify-pointy

Preconditions:

- A card is open from `pick.sh`.

- **Keep mid-task.** Run `zsh .claude/skills/verify-pointy/scripts/ask.sh $cw kept 这段话在说什么 keep`. `pill while running:` in `run.log` shows class `pill run` and a tooltip that starts with `在后台做：`. The screenshot is `kept-pill-run.png`.
- **Done.** `pill when done:` shows class `pill done`, the title `Mock 标题`, and a tooltip that starts with `做完了：`. The screenshot is `kept-pill-done.png`.
- **Restore.** Run `js $(win pill.html) "document.querySelector('.pill').click(); return 'ok'"`. `has card.html` succeeds, and the pill window goes once no pill is left.

## Gotchas

- A card closed before DSH accepted the ask just closes. There is no session to keep.
- The pill window is one window for all pills. Read `.pill` elements, not windows.

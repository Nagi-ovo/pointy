# Point at a control

Shaking the mouse over another app starts pointing. An overlay boxes the control under the mouse and labels it with its type and name, such as "文字：…". Clicking opens a card on it. If the user selected text first, the card opens on the selection straight away. Right-click or Esc cancels.

## Sub-features

- `pick-shake` starts pointing at the configured shake sensitivity.
- `pick-box` boxes and labels the control under the mouse. `[` and `]` change the level.
- `pick-click` opens a card on the control, with its text, or a screenshot when the text is thin.
- `pick-selection` opens a card on selected text without pointing.
- `pick-blocked` keeps out of password fields, login windows and blocked apps.

## How to get to it (user POV)

- Shake the mouse left and right over any window, then click.

## Driving it with verify-pointy

Preconditions:

- TextEdit can open a new document (`fixture.txt`). The run closes it in `down.sh`.

- **Shake and click.** Run `cw=$(zsh .claude/skills/verify-pointy/scripts/pick.sh first)`. `run.log` shows `pointing at X,Y:` with the overlay's label, then `card wN:` with method `uia-pick` and the fixture's first paragraph. The screenshots are `first-pointing.png` and `first-card.png`.
- **Overlay.** While pointing, `js $(win overlay.html) "return document.getElementById('what').textContent"` returns the label.

## Gotchas

- Pointing registers Space, `[`, `]` and Esc as global shortcuts. Never run a pick unless `guard` passed.
- `mine` refuses to click when the window at the point is not the fixture's. If TextEdit opened the document behind another window, the run stops there.
- A Retina display doubles the screenshot pixels. Compare sizes in points.
- TextEdit opens a second document as a tab of the first, and the click then lands on the tab bar. `pick.sh` closes the run's earlier fixtures first.
- Once pointing starts, Pointy's overlay is the top window everywhere. Check the owner before the shake, not only before the click.

# Ask from a card

A card quotes what the user pointed at. The user types a question and sends it in quick or full mode. The card shows what DSH is doing ("发给 DSH 了", "在想", "正在搜索「…」", "正在写"), streams the answer, and names the session once DSH titles it.

## Sub-features

- `ask-send` sends the question to a new task or to the session picked in the target menu.
- `ask-progress` shows the current step. In full mode it also lists the last three tool steps and the elapsed time.
- `ask-answer` streams the answer, keeps the thread pinned to the newest text, and shows the copy and "在 DSH 里继续" row.
- `ask-title` shows the session's title in the header, or the question while DSH has none.

## How to get to it (user POV)

- Shake and click to open a card (see [pick](./pick.md)), type in "想问点什么…", press Enter or the send button.
- Click a suggestion chip under the input.
- Ask again in the same card after an answer.

## Driving it with verify-pointy

Preconditions:

- A card is open: `cw=$(zsh .claude/skills/verify-pointy/scripts/pick.sh first)`.
- The mock model calls the web search tool once per question, so a full-mode ask always shows one tool step.

- **Ask in full mode.** Run `zsh .claude/skills/verify-pointy/scripts/ask.sh $cw first 这段话在说什么`. `run.log` shows `progress:` with a step line in the form `正在搜索「pointy 指认工具」`, then `lines shown:`, which lists the lines in order: `发给 DSH 了`, `在想`, the search, `正在写`.
- **Answer.** `first-answer.png` shows "这是一段模拟回答。", and `#status` is `done`.
- **Title.** `card title:` in `run.log` reads `Mock 标题`, DSH's title from the mock.
- **Side effect.** The last user message in `$VP_RUN/evidence/mock.jsonl` holds the question and the `<抓取内容>` block with the fixture's paragraph.

## Gotchas

- The `.step` list appears only in full mode, and only after a second step replaces a tool step.
- `lines shown` comes from a MutationObserver, which sees only the text at the end of each batch. `发给 DSH 了` can be gone before the first batch, when DSH answers within the same frame.
- `#target-label` reads `…` until the session list loads. `pick.sh` waits for it, so wait for it too if you open a card some other way.
- An `ask-done` with a reason other than `completed` shows `结束（reason）`, which means DSH or the mock failed. Read `$VP_RUN/dsh.log`.

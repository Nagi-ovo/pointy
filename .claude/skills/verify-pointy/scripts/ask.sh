#!/bin/zsh
# usage: ask.sh <card window> <name> <question> [keep]
# Asks DSH in full mode from the card, through its page, and records every
# progress line it shows. With keep, closes the card while DSH works and
# follows the pill until the task is done. Touches only Pointy's windows.
set -u
source ${0:A:h}/env.sh
cw=$1 name=$2 question=$3 keep=${4:-}
js $cw "window.__shown = []; const a = document.getElementById('activity'); new MutationObserver(() => { const t = a.innerText.trim(); if (t && window.__shown.at(-1) !== t) window.__shown.push(t) }).observe(a, { childList: true, subtree: true, characterData: true }); return 'watching'" > /dev/null
js $cw "document.querySelector('#mode button[data-mode=deep]').click(); const i = document.getElementById('input'); i.value = $(print -r -- "$question" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8").trim()))'); i.dispatchEvent(new Event('input')); document.getElementById('send').click(); return 'sent'" > /dev/null
wait_until 60 "a tool step in the card" js $cw "if (!document.querySelector('#activity .step')) throw 'no step yet'"
pa screenshot --window $cw "$EV/$name-progress.png" > /dev/null
log "progress: $(js $cw "return document.getElementById('activity').innerText")"
if [ -n "$keep" ]; then
  js $cw "document.getElementById('close').click(); return 'closed'" > /dev/null
  wait_until 10 "a pill" has pill.html
  pw=$(win pill.html)
  log "pill while running: $(js $pw "return [...document.querySelectorAll('.pill')].map(p => p.className + ' | ' + p.innerText + ' | ' + p.title)")"
  pa screenshot --window $pw "$EV/$name-pill-run.png" > /dev/null
  wait_until 60 "the pill to turn done" js $pw "if (!document.querySelector('.pill.done')) throw 'running'"
  log "pill when done: $(js $pw "return [...document.querySelectorAll('.pill')].map(p => p.className + ' | ' + p.innerText + ' | ' + p.title)")"
  pa screenshot --window $pw "$EV/$name-pill-done.png" > /dev/null
else
  wait_until 60 "the answer" js $cw "if (document.getElementById('status').className !== 'done') throw 'running'"
  pa screenshot --window $cw "$EV/$name-answer.png" > /dev/null
fi
log "card title: $(js $cw "return document.getElementById('title').textContent") | lines shown: $(js $cw "return window.__shown")"

#!/bin/zsh
# usage: pick.sh <name>   opens a fixture document in TextEdit, shakes the
# mouse over it and clicks its first paragraph; prints the card's window id.
# Moves the mouse only over that document's window.
set -u
source ${0:A:h}/env.sh
name=$1
doc=$VP_RUN/fixture-$name.txt
cp "$SKILL/fixture.txt" "$doc"
# One fixture at a time: TextEdit would open the next as a tab of this one.
for old in $(cat "$VP_RUN/fixtures" 2>/dev/null); do
  osascript -e "tell application \"TextEdit\" to close (every document whose path is \"$old\") saving no" > /dev/null 2>&1
done
print -r -- "${doc:A}" >> "$VP_RUN/fixtures"
# Opening activates TextEdit, so it waits for an idle user like the mouse does.
guard
open -a TextEdit "$doc"
te=$(pgrep -nx TextEdit)
wait_until 10 "the fixture window" osascript -e "tell application \"System Events\" to tell process \"TextEdit\" to get position of window \"${doc:t}\""
IFS=', ' read wx wy ww wh <<< "$(osascript -e "tell application \"System Events\" to tell process \"TextEdit\" to get {position, size} of window \"${doc:t}\"")"
X=$(( wx + 200 )) Y=$(( wy + 50 ))

for x in $(( X - 70 )) $X $(( X + 70 )); do mine $x $Y $te; done
# The screenshot shows only the fixture's rect, and only when no other app's
# window covers any of it, so it never captures the user's windows.
shoot=1
for gx in $(seq $(( wx + 5 )) $(( (ww - 10) / 6 )) $(( wx + ww - 5 ))); do
  for gy in $(seq $(( wy + 5 )) $(( (wh - 10) / 5 )) $(( wy + wh - 5 ))); do
    o=$(drive at $gx $gy); [ "$o" = $te ] || [ "$o" = $(pid pointy) ] || shoot=
  done
done
guard
drive move $X $Y; sleep 0.2
drive shake $X $Y
wait_until 5 "the pointing overlay" has overlay.html
sleep 0.6
ow=$(win overlay.html)
log "pointing at $X,$Y: $(js $ow "return document.getElementById('what').textContent")"
if [ -n "$shoot" ]; then screencapture -x -R $wx,$wy,$ww,$wh "$EV/$name-pointing.png"
else log "no $name-pointing.png: another app's window covers part of the fixture"; fi
mine $X $Y $te $(pid pointy)
drive click $X $Y
wait_until 10 "a card" has card.html
cw=$(win card.html)
wait_until 15 "the card's sessions" js $cw "if (['…', ''].includes(document.getElementById('target-label').textContent)) throw 'loading'"
log "card $cw: $(js $cw "return window.mygo.call('Card.Init').then(i => ({ method: i.grab.method, text: i.grab.text, note: i.grab.note }))")"
pa screenshot --window $cw "$EV/$name-card.png" > /dev/null
print $cw

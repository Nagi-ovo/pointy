#!/bin/zsh
# usage: tray.sh <name> [item [subitem]]
# Clicks the run's Pointy icon in the menu bar and logs the menu's items,
# read through accessibility. With items, chooses them, as "语言" then
# "English"; without, closes the menu by clicking the icon again. Moves the
# mouse only over the icon and the menus it opens, which are Pointy's.
set -u
source ${0:A:h}/env.sh
name=$1; shift
p=$(pid pointy)
windows() { drive windows $p; }
# rows <window json>: "y<TAB>name" for each menu item down the window's middle.
rows() {
  python3 -c '
import json, subprocess, sys
w, drive = json.loads(sys.argv[1]), sys.argv[2]
x, seen = w["X"] + w["W"] / 2, None
for y in range(int(w["Y"]) + 3, int(w["Y"] + w["H"]) - 2, 3):
    out = subprocess.run([drive, "chain", str(x), str(y)], capture_output=True, text=True).stdout
    try: item = json.loads(out)["chain"][0]
    except Exception: continue
    if item.get("control") != "ControlType.MenuItem" or not item.get("name"): continue
    r = item["rect"]
    if item["name"] != seen: print(f"{r[1] + r[3] / 2:.0f}\t{item['"'"'name'"'"']}")
    seen = item["name"]
' "$1" "$BIN/drive"
}
menus() { windows | python3 -c 'import json,sys; [print(json.dumps(w)) for w in json.load(sys.stdin) if w["Layer"] == 101]'; }

# The icon sits in a window of Control Center's; accessibility says it is ours.
icon=$(drive extras $p | python3 -c 'import json,sys; ws=json.load(sys.stdin) or []; print(json.dumps(ws[0]) if ws else "")')
[ -n "$icon" ] || die "Pointy's menu bar icon is not on screen (hidden behind the notch or by a menu bar manager?)"
log "tray icon tooltip ($name): $(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["Name"])' "$icon")"
read ix iy <<< "$(python3 -c 'import json,sys; w=json.loads(sys.argv[1]); print(round(w["X"]+w["W"]/2), round(w["Y"]+w["H"]/2))' "$icon")"
icon_is_mine() { drive extras $p | python3 -c 'import json,sys; x,y=float(sys.argv[1]),float(sys.argv[2]); sys.exit(0 if any(w["X"]<=x<w["X"]+w["W"] and w["Y"]<=y<w["Y"]+w["H"] for w in json.load(sys.stdin) or []) else 1)' $ix $iy || die "the menu bar icon at $ix,$iy is no longer Pointy's"; }

guard
icon_is_mine
drive click $ix $iy
wait_until 5 "the tray menu" sh -c "$BIN/drive windows $p | grep -q '\"Layer\":101'"
sleep 0.3
menu=$(menus | head -1)
items=$(rows "$menu")
log "tray menu ($name):"$'\n'"$items"
screencapture -x -R "$(python3 -c 'import json,sys; w=json.loads(sys.argv[1]); print(",".join(str(round(w[k])) for k in "XYWH"))' "$menu")" "$EV/$name-tray.png"

mx=$(python3 -c 'import json,sys; w=json.loads(sys.argv[1]); print(w["X"]+w["W"]/2)' "$menu")
if (( $# == 0 )); then icon_is_mine; drive click $ix $iy; exit 0; fi
y=$(print -r -- "$items" | awk -F'\t' -v n="$1" '$2 == n {print $1}')
[ -n "$y" ] || { icon_is_mine; drive click $ix $iy; die "the tray menu has no item \"$1\""; }
mine $mx $y $p
if (( $# == 1 )); then drive click $mx $y; exit 0; fi
drive move $mx $y
wait_until 5 "the submenu" sh -c "[ \$($BIN/drive windows $p | grep -o '\"Layer\":101' | wc -l) -ge 2 ]"
sleep 0.3
sub=$(menus | python3 -c 'import json,sys; m=json.loads(sys.argv[1]); print(next(l for l in sys.stdin if json.loads(l)["ID"] != m["ID"]).strip())' "$menu")
subitems=$(rows "$sub")
log "submenu \"$1\":"$'\n'"$subitems"
sx=$(python3 -c 'import json,sys; w=json.loads(sys.argv[1]); print(w["X"]+w["W"]/2)' "$sub")
sy=$(print -r -- "$subitems" | awk -F'\t' -v n="$2" '$2 == n {print $1}')
[ -n "$sy" ] || { icon_is_mine; drive click $ix $iy; die "the submenu has no item \"$2\""; }
mine $sx $y $p
drive move $sx $y
mine $sx $sy $p
drive click $sx $sy
log "chose $1 > $2"

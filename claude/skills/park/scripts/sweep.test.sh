#!/bin/bash
# shellcheck disable=SC2016,SC2034,SC2329 # each check is single-quoted and run by eval in ok()
# Runnable check for sweep.sh. Usage: /bin/bash claude/skills/park/scripts/sweep.test.sh
# Builds a throwaway sandbox: a fake HOME, a repo with a bare "origin", linked
# worktrees, a fake harness (a symlink to sleep named claude). Never touches
# the real HOME, git config, or a real repo. Also checks that task-anchor.sh
# still maps a linked worktree to the main checkout after the anchor-lib move.

here=$(cd "$(dirname "$0")" && pwd)
SWEEP="$here/sweep.sh"
HOOKS=$(cd "$here/../../../hooks" && pwd)
# pwd -P: mktemp says /var, git says /private/var
TMP=$(cd "$(mktemp -d)" && pwd -P)
ln -s /bin/sleep "$TMP/claude"
"$TMP/claude" 300 & H=$!
bash -c 'exit 0' & DEAD=$!
wait "$DEAD"
trap 'kill $H 2>/dev/null; wait $H 2>/dev/null; rm -rf "$TMP"' EXIT
export HOME="$TMP/home" GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
export ANCHOR_LIB="$HOOKS/anchor-lib.sh" LANE_TS="$HOOKS/lanes/lane.ts"
unset LANES_ROOT CLAUDE_PROJECT_DIR CLAUDE_PID
P="$TMP/proj"

# --- sandbox (any failure here stops the script) ---
set -e
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global user.email me@example.com
git config --global user.name me
git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$P" 2>/dev/null
c() { echo "$2 $RANDOM" >> "$1/f.txt"; git -C "$1" add -A; git -C "$1" commit -q -m "$2"; }
c "$P" init
git -C "$P" push -q origin main
# merged: its commit is on origin/main
git -C "$P" worktree add -q -b feat/merged "$TMP/wt-merged" main
c "$TMP/wt-merged" m1
git -C "$P" merge -q --ff-only feat/merged
git -C "$P" push -q origin main
# unmerged: a commit only on the branch
git -C "$P" worktree add -q -b feat/unmerged "$TMP/wt-unmerged" main
c "$TMP/wt-unmerged" u1
# dirty: one modified file, one untracked file
git -C "$P" worktree add -q -b feat/dirty "$TMP/wt-dirty" main
echo change >> "$TMP/wt-dirty/f.txt"
echo new > "$TMP/wt-dirty/new.txt"
# gone: the folder was deleted by hand; git still lists it
git -C "$P" worktree add -q -b feat/gone "$TMP/wt-gone" main
rm -rf "$TMP/wt-gone"

slug=$(printf '%s' "$P" | sed 's/[^A-Za-z0-9]/-/g')
AD="$HOME/.claude/task-anchors/$slug"
LD="$HOME/.claude/lanes/$slug"
mkdir -p "$AD" "$LD"
iso() { date +%Y-%m-%dT%H:%M:%S%z; }
HB_NOW=$(iso | sed 's/\([0-9][0-9]\)$/:\1/')   # the colon form of the offset
HB_OLD=$(date -v-5H +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || date -d '5 hours ago' +%Y-%m-%dT%H:%M:%S%z)
LONG="read the whole long design document and then write a summary of every open question in it"
task() { # task <slug> <next> [extra lines]: a task file and its INDEX row
  local s=$1 n=$2
  shift 2
  { echo "STATE 2026-11-01 | PARKED | next: $n | step 2/3"; echo "prose"; printf '%s\n' "$@"; } > "$AD/$s.md"
  echo "- $s | PARKED | next: $n" >> "$AD/INDEX.md"
}
task live-pid "keep going" "owner: aaaaaaaa-1111-2222" "pid: $H"
task live-hb "keep going too" "owner: bbbbbbbb-1111-2222" "heartbeat: $HB_NOW"
task stale-pid "old pid" "owner: cccccccc-1111" "pid: $DEAD"
task stale-hb "old heartbeat" "owner: dddddddd-1111" "heartbeat: $HB_OLD"
task plain "$LONG"
task merged "ship it" "worktree: $TMP/wt-merged"
task unmerged "review it" "worktree: $TMP/wt-unmerged"
task dirty "commit it" "worktree: $TMP/wt-dirty"
task gone "prune it" "worktree: $TMP/wt-gone"
echo "- ghost | PARKED | next: nothing" >> "$AD/INDEX.md"
printf 'STATE 2026-11-01 | PARKED | next: orphan work\n' > "$AD/orphan.md"
set +e

# --- checks ---
FAILED=0
N=0
ok() { # ok <name> <shell test>
  N=$((N + 1))
  if eval "$2"; then echo "PASS $N $1"; else echo "FAIL $N $1"; FAILED=1; fi
}
sweep() { # sweep <dir> [args]: output in $out, exit code in $rc
  local d=$1
  shift
  out=$(cd "$d" && /bin/bash "$SWEEP" "$@" 2>&1)
  rc=$?
}
row() { printf '%s\n' "$out" | grep "^$1 "; }
snap() { find "$AD" "$LD" -type f -exec cksum {} + | sort; git -C "$P" worktree list; git -C "$P" branch; }

# task-anchor.sh after the anchor-lib move: the project_root: line, from the
# main checkout and from a linked worktree (which maps to the main checkout).
hook() { printf '{"hook_event_name":"UserPromptSubmit","cwd":"%s","session_id":"x"}' "$1" | bash "$HOOKS/task-anchor.sh" 2>&1; }
ok "hook: main checkout gives project_root: $P" '[[ "$(hook "$P")" == *"project_root: $P (anchor dir $AD)"* ]]'
ok "hook: linked worktree maps to the main checkout" '[[ "$(hook "$TMP/wt-unmerged")" == *"project_root: $P (anchor dir $AD)"* ]]'

# dry run
before=$(snap)
sweep "$P"
echo "--- dry run output ---"; printf '%s\n' "$out"; echo "---"
ok "dry run: exit 0" '[ "$rc" = 0 ]'
ok "dry run: changes nothing" '[ "$(snap)" = "$before" ]'
ok "dry run: header" '[[ "$(printf "%s\n" "$out" | head -1)" == "slug "*claim*worktree*branch*next*mark ]]'
ok "live pid: live, no candidate" '[[ "$(row live-pid)" == *" live "* ]] && [[ "$(row live-pid)" != *candidate ]]'
ok "live heartbeat (colon offset): live" '[[ "$(row live-hb)" == *" live "* ]]'
ok "dead pid: free, candidate" '[[ "$(row stale-pid)" == *" free "*candidate ]]'
ok "5h heartbeat: free, candidate" '[[ "$(row stale-hb)" == *" free "*candidate ]]'
ok "no worktree: none, -, next cut to 60 chars" '[[ "$(row plain)" == *" none "*" - "*"read the whole long design document and then write a summ..."*candidate ]]'
ok "merged: clean, merged, candidate" '[[ "$(row merged)" == *" clean "*" merged "*"ship it"*candidate ]]'
ok "unmerged: clean, unmerged, no candidate" '[[ "$(row unmerged)" == *" clean "*" unmerged "*"review it" ]]'
ok "dirty: dirty (2 files), no candidate" '[[ "$(row dirty)" == *" dirty (2 files) "*"commit it" ]]'
ok "gone: gone, -, candidate" '[[ "$(row gone)" == *" gone "*" - "*"prune it"*candidate ]]'
ok "next stops before | step" '[[ "$(row merged)" != *step* ]]'
ok "drift: INDEX row with no task file" '[[ "$out" == *"drift: INDEX row with no task file: ghost"* ]]'
ok "drift: task file with no INDEX row" '[[ "$out" == *"drift: task file with no INDEX row: orphan"* ]]'
ok "drift: nothing else" '[ "$(printf "%s\n" "$out" | grep -c "^drift")" = 2 ]'
dry=$out
sweep "$TMP/wt-unmerged"
ok "dry run from a linked worktree: same table" '[ "$out" = "$dry" ]'

# close: refusals
sweep "$P" close live-pid
ok "live pid: refused with owner and pid, exit 1" '[ "$rc" = 1 ] && [ "$out" = "not closed live-pid: live claim (owner aaaaaaaa, pid $H)" ] && [ -f "$AD/live-pid.md" ]'
sweep "$P" close live-hb
ok "live heartbeat: refused" '[ "$rc" = 1 ] && [[ "$out" == "not closed live-hb: live claim (owner bbbbbbbb, pid none)" ]]'
sweep "$P" close dirty
ok "dirty: refused, dirty files listed, worktree kept" '[ "$rc" = 1 ] && [[ "$out" == *"not closed dirty: worktree $TMP/wt-dirty is dirty"* ]] && [[ "$out" == *"M f.txt"* ]] && [[ "$out" == *"?? new.txt"* ]] && [ -d "$TMP/wt-dirty" ] && [ -f "$AD/dirty.md" ]'
sweep "$P" close nosuch
ok "no task file: refused" '[ "$rc" = 1 ] && [ "$out" = "not closed nosuch: no task file" ]'
sweep "$P" close ../INDEX
ok "not a slug: refused, INDEX.md kept" '[ "$rc" = 1 ] && [ "$out" = "not closed ../INDEX: not a task slug" ] && [ -f "$AD/INDEX.md" ]'

# close: the ritual
sweep "$P" close merged
ok "merged: closed" '[ "$rc" = 0 ] && [ "$out" = "closed merged" ]'
ok "merged: task file and INDEX row gone" '[ ! -e "$AD/merged.md" ] && ! grep -q "^- merged | " "$AD/INDEX.md"'
ok "merged: worktree removed" '[ ! -d "$TMP/wt-merged" ] && ! git -C "$P" worktree list | grep -q wt-merged'
ok "merged: branch deleted" '! git -C "$P" rev-parse -q --verify refs/heads/feat/merged >/dev/null'
ok "merged: lane log line" 'grep -q "^closed: .* closed by sweep 20" "$LD/merged/log"'
sweep "$P" close unmerged
ok "unmerged: closed, branch kept and named" '[ "$rc" = 0 ] && [[ "$out" == *"kept branch feat/unmerged"* ]] && [[ "$out" == *"closed unmerged" ]] && git -C "$P" rev-parse -q --verify refs/heads/feat/unmerged >/dev/null && [ ! -d "$TMP/wt-unmerged" ]'
sweep "$P" close gone
ok "gone: closed, pruned from git worktree list" '[ "$rc" = 0 ] && [ "$out" = "closed gone" ] && ! git -C "$P" worktree list | grep -q wt-gone'
sweep "$P" close stale-pid live-pid stale-hb
ok "mixed: free ones closed, live one refused, exit 1" '[ "$rc" = 1 ] && [ "$out" = "closed stale-pid
not closed live-pid: live claim (owner aaaaaaaa, pid $H)
closed stale-hb" ]'

# the last task file: INDEX.md and the folder go too
for s in live-pid live-hb; do grep -v '^owner:' "$AD/$s.md" > "$TMP/t" && mv "$TMP/t" "$AD/$s.md"; done
git -C "$TMP/wt-dirty" checkout -q -- f.txt; rm "$TMP/wt-dirty/new.txt"
sweep "$P" close live-pid live-hb dirty plain orphan
ok "last ones: all closed" '[ "$rc" = 0 ] && [ "$(printf "%s\n" "$out" | grep -c "^closed ")" = 5 ]'
ok "last ones: INDEX.md and folder removed" '[ ! -e "$AD" ]'
ok "last ones: dirty branch (no own commits, so merged) deleted" '! git -C "$P" rev-parse -q --verify refs/heads/feat/dirty >/dev/null'
sweep "$P"
ok "no anchor folder: one line, exit 0" '[ "$rc" = 0 ] && [ "$out" = "no anchor folder for $P ($AD)" ]'
sweep "$P" close plain
ok "no anchor folder, close: exit 0" '[ "$rc" = 0 ] && [[ "$out" == "no anchor folder"* ]]'
mkdir -p "$TMP/plain-dir"
sweep "$TMP/plain-dir"
ok "not a git repo: exit 0" '[ "$rc" = 0 ] && [ "$out" = "no anchor folder for $TMP/plain-dir ($HOME/.claude/task-anchors/$(printf "%s" "$TMP/plain-dir" | sed "s/[^A-Za-z0-9]/-/g"))" ]'
sweep "$P" bogus
ok "unknown command: usage, exit 2" '[ "$rc" = 2 ] && [[ "$out" == usage:* ]]'
sweep "$P" close
ok "close with no slug: usage, exit 2" '[ "$rc" = 2 ] && [[ "$out" == usage:* ]]'

# fetch fails: warning, merged is checked against local main
Q="$TMP/noremote"
git init -q "$Q"; c "$Q" init
git -C "$Q" worktree add -q -b feat/q "$TMP/wt-q" main
qd="$HOME/.claude/task-anchors/$(printf '%s' "$Q" | sed 's/[^A-Za-z0-9]/-/g')"
mkdir -p "$qd"
printf 'STATE 2026-11-01 | PARKED | next: q\nworktree: %s\n' "$TMP/wt-q" > "$qd/q.md"
echo "- q | PARKED | next: q" > "$qd/INDEX.md"
sweep "$Q"
ok "fetch fails: warning, merged against local main" '[[ "$out" == "warning: git fetch origin failed"* ]] && [[ "$(row q)" == *" merged "*candidate ]]'

echo "$N checks"
exit $FAILED

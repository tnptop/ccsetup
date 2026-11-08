#!/bin/bash
# sweep: close finished task anchors in bulk, with no model turn and no claim.
#   sweep.sh                  dry run: one row per task file; changes nothing
#   sweep.sh close <slug>...  the /park closed ritual for each slug safe to close
# Run from inside the project: ! ~/.claude/skills/park/scripts/sweep.sh
# A row marked candidate is a hint only; the human decides a task is finished.
# Writes no worklog line: the lane log line is the only record.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../../../hooks/anchor-lib.sh
. "${ANCHOR_LIB:-$HOME/.claude/hooks/anchor-lib.sh}"
LANE_TS="${LANE_TS:-$HOME/.claude/hooks/lanes/lane.ts}"

usage() { echo "usage: sweep.sh [close <slug>...]" >&2; exit 2; }
case "${1:-}" in
  '') ;;
  close) [ $# -gt 1 ] || usage ;;
  *) usage ;;
esac

# Windows (Git Bash): /c/... as task-anchor.sh keys it (C:\...), one slug.
here=$PWD
case "${OSTYPE:-}" in
  msys*|cygwin*) here=$(cygpath -w "$PWD") ;;
esac
root=$(project_root "$here")
rslug=$(printf '%s' "$root" | sed 's/[^A-Za-z0-9]/-/g')
dir="$HOME/.claude/task-anchors/$rslug"
lanes="${LANES_ROOT:-$HOME/.claude/lanes}/$rslug"
if [ ! -d "$dir" ]; then
  echo "no anchor folder for $root ($dir)"
  exit 0
fi

# Fetch once per run, and only when some task has a worktree to check.
base=origin/main
if grep -q '^worktree:' "$dir"/*.md 2>/dev/null; then
  if ! git -C "$root" fetch -q origin 2>/dev/null; then
    echo "warning: git fetch origin failed; merged is checked against local main"
    base=main
  fi
fi

# Heartbeat (date +%Y-%m-%dT%H:%M:%S%z, offset with or without a colon) to
# epoch seconds; empty when it does not parse. BSD date first, then GNU.
iso_epoch() {
  local v='' e=''
  [ -n "$1" ] || return 0
  v=$(printf '%s' "$1" | sed 's/:\([0-9][0-9]\)$/\1/')
  e=$(date -j -f %Y-%m-%dT%H:%M:%S%z "$v" +%s 2>/dev/null) || e=$(date -d "$v" +%s 2>/dev/null) || e=''
  case "$e" in ''|*[!0-9]*) ;; *) printf '%s' "$e" ;; esac
}

# facts <task file>: sets owner pid claim wt wt_state dirty branch br_state next.
# Claim = the claim-task skill section 3 lease rule.
facts() {
  local f=$1 hb='' e=''
  owner=$(extract_field "$f" owner)
  pid=$(extract_field "$f" pid)
  claim=free
  if [ -n "$owner" ]; then
    if [ -n "$pid" ]; then
      if is_harness "$pid"; then claim=live; fi
    else
      hb=$(extract_field "$f" heartbeat)
      e=$(iso_epoch "$hb")
      if [ -n "$e" ] && [ $(( ($(date +%s) - e) / 3600 )) -lt 4 ]; then claim=live; fi
    fi
  fi
  wt=$(extract_field "$f" worktree)
  wt_state=none; dirty=''; branch=''; br_state=-
  if [ -n "$wt" ] && [ ! -d "$wt" ]; then
    wt_state=gone
  elif [ -n "$wt" ]; then
    dirty=$(git -C "$wt" status --porcelain 2>/dev/null) || dirty=''
    wt_state=clean
    if [ -n "$dirty" ]; then wt_state="dirty ($(printf '%s\n' "$dirty" | awk 'END { print NR }') files)"; fi
    branch=$(git -C "$wt" branch --show-current 2>/dev/null) || branch=''
    if [ -n "$branch" ]; then
      br_state=unmerged
      if git -C "$root" merge-base --is-ancestor "$branch" "$base" 2>/dev/null; then br_state=merged; fi
    fi
  fi
  parse_state_fields "$(head -1 "$f")"
  next=$state_next
  if [ ${#next} -gt 60 ]; then next="${next:0:57}..."; fi
}

# has_row <slug>: INDEX.md has a line starting "- <slug> | " (literal match).
has_row() {
  awk -v p="- $1 | " 'index($0, p) == 1 { f = 1 } END { exit !f }' "$dir/INDEX.md" 2>/dev/null
}

sedi() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

# no <slug> <reason>: print the refusal; the caller returns 1.
no() { echo "not closed $1: $2"; }

# close_one <slug>: park SKILL.md sections 3a, 3b, 3d, then its section 5
# CLOSED oracle. Returns 1 when the slug is not closed.
close_one() {
  local s=$1 f="$dir/$1.md" g='' left=0
  case "$s" in ''|*[!A-Za-z0-9_-]*) no "$s" "not a task slug"; return 1 ;; esac
  if [ ! -f "$f" ]; then no "$s" "no task file"; return 1; fi
  facts "$f"
  if [ "$claim" = live ]; then no "$s" "live claim (owner ${owner:0:8}, pid ${pid:-none})"; return 1; fi
  case "$wt_state" in
    dirty*)
      no "$s" "worktree $wt is dirty"
      printf '%s\n' "$dirty" | sed 's/^/  /'
      return 1
      ;;
    clean)
      if ! git -C "$root" worktree remove "$wt"; then no "$s" "git worktree remove $wt failed"; return 1; fi
      ;;
    gone) git -C "$root" worktree prune ;;
  esac
  if [ "$br_state" = merged ]; then
    if ! git -C "$root" branch -d "$branch" >/dev/null; then echo "  kept branch $branch: branch -d refused"; fi
  elif [ "$br_state" = unmerged ]; then
    echo "  kept branch $branch (not merged into $base)"
  fi
  if [ -d "$lanes" ]; then
    if ! node "$LANE_TS" close "$root" "$s" "closed by sweep $(date +%Y-%m-%d)"; then
      no "$s" "lane log write failed; task file kept"
      return 1
    fi
  fi
  rm "${f:?}"
  if [ -f "$dir/INDEX.md" ]; then sedi "/^- ${s} | /d" "$dir/INDEX.md"; fi
  for g in "$dir"/*.md; do
    if is_task_file "$g"; then left=1; fi
  done
  if [ "$left" = 0 ]; then
    rm -f "$dir/INDEX.md"
    rmdir "$dir" || echo "  warning: $dir not empty, kept"
  fi
  if [ -e "$f" ]; then no "$s" "task file still there"; return 1; fi
  if has_row "$s"; then no "$s" "INDEX row still there"; return 1; fi
  if [ -n "$wt" ] && git -C "$root" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $wt"; then
    no "$s" "lane not removed: $wt still in git worktree list"
    return 1
  fi
}

if [ "${1:-}" = close ]; then
  shift
  failed=0
  for s in "$@"; do
    if close_one "$s"; then echo "closed $s"; else failed=1; fi
  done
  exit "$failed"
fi

# Dry run: a table, then drift. Changes nothing.
rows=$(printf 'slug\tclaim\tworktree\tbranch\tnext\tmark')
n=0
for f in "$dir"/*.md; do
  is_task_file "$f" || continue
  facts "$f"
  mark=''
  case "$claim/$wt_state/$br_state" in
    free/none/merged|free/none/-|free/gone/merged|free/gone/-|free/clean/merged|free/clean/-) mark=candidate ;;
  esac
  rows="$rows"$'\n'"$(basename "$f" .md)"$'\t'"$claim"$'\t'"$wt_state"$'\t'"$br_state"$'\t'"$next"$'\t'"$mark"
  n=$((n + 1))
done
if [ "$n" = 0 ]; then
  echo "no task files in $dir"
else
  printf '%s\n' "$rows" | awk -F'\t' '
    { for (i = 1; i <= NF; i++) { c[NR, i] = $i; if (length($i) > w[i]) w[i] = length($i) } }
    END { for (r = 1; r <= NR; r++) { s = ""; for (i = 1; i < 6; i++) s = s sprintf("%-" w[i] "s  ", c[r, i]); s = s c[r, 6]; sub(/ +$/, "", s); print s } }'
fi
if [ -f "$dir/INDEX.md" ]; then
  awk '/^- / { s = substr($0, 3); i = index(s, " | "); if (i) print substr(s, 1, i - 1) }' "$dir/INDEX.md" |
    while read -r s; do
      if [ ! -f "$dir/$s.md" ]; then echo "drift: INDEX row with no task file: $s"; fi
    done
fi
for f in "$dir"/*.md; do
  is_task_file "$f" || continue
  s=$(basename "$f" .md)
  if ! has_row "$s"; then echo "drift: task file with no INDEX row: $s"; fi
done

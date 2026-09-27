#!/bin/bash
# SessionStart hook: hold a display-sleep assertion (caffeinate -d) for as long
# as the parent Claude Code process lives. On macOS 15 this also blocks the
# screen saver and therefore the screen lock. No-op on other platforms.
# Verified 2026-09-06: idle reached 343s past a 300s saver setting, no lock.
[ "$(uname)" = Darwin ] || exit 0
command -v caffeinate >/dev/null || exit 0

# Find the claude process: walk up the ancestry (hook shell -> claude).
pid=$PPID
for _ in 1 2 3 4 5; do
  cmd=$(ps -o command= -p "$pid" 2>/dev/null)
  case "${cmd%% *}" in */claude|claude) break ;; esac
  next=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$next" ] && [ "$next" != 1 ] || { pid=$PPID; break; }
  pid=$next
done

# One assertion per claude process (SessionStart also fires on resume/clear/compact).
pgrep -f "caffeinate -d -w $pid\$" >/dev/null && exit 0

nohup caffeinate -d -w "$pid" >/dev/null 2>&1 </dev/null &
disown 2>/dev/null
exit 0

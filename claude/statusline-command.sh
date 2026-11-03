#!/bin/bash
# Claude Code status line: model | dir | context usage (k tokens) | task anchor
input=$(cat)

model=$(printf '%s' "$input" | jq -r '.model.display_name // "?"')
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // "?"')
dir="$(basename "$(dirname "$cwd")")/$(basename "$cwd")"

used_tokens=$(printf '%s' "$input" | jq -r '.context_window.total_input_tokens // 0')
window_size=$(printf '%s' "$input" | jq -r '.context_window.context_window_size // 0')
case "$used_tokens" in ''|*[!0-9]*) used_tokens=0 ;; esac
case "$window_size" in ''|*[!0-9]*) window_size=0 ;; esac
used_k=$(( (used_tokens + 500) / 1000 ))
total_k=$(( (window_size + 500) / 1000 ))
ctx="${used_k}k/${total_k}k"

# Task anchor: show the task file owned by THIS session (owner: == session_id).
# Searched across every anchor dir, not just the cwd's: a session in a worktree
# can own a task under its project dir (the hook keys on CLAUDE_PROJECT_DIR).
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
anchors="$HOME/.claude/task-anchors"
owned=""
[ -n "$session_id" ] && owned=$(grep -rlE --include='*.md' \
  "^owner:[[:space:]]*${session_id}[[:space:]]*$" "$anchors" 2>/dev/null | head -1)
if [ -n "$owned" ]; then
  # "STATE <date> | ACTIVE | next: x" -> "ACTIVE | next: x"
  line1=$(head -1 "$owned" | sed 's/^STATE [^|]*| *//')
  task="$(basename "$owned" .md) | $line1"
else
  project_dir=$(printf '%s' "$input" | jq -r '.workspace.project_dir // empty')
  project_slug=$(printf '%s' "${project_dir:-$cwd}" | sed 's/[^A-Za-z0-9]/-/g')
  count=$(find "$anchors/$project_slug" -maxdepth 1 -name '*.md' ! -name INDEX.md 2>/dev/null | wc -l | tr -d ' ')
  task="no task claimed (${count} in index)"
fi
if [ ${#task} -gt 70 ]; then
  task="${task:0:67}..."
fi

printf '\033[36m%s\033[0m \033[34m%s\033[0m \033[33m%s\033[0m \033[35m%s\033[0m\n' \
  "$model" "$dir" "$ctx" "$task"

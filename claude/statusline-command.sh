#!/bin/bash
# Claude Code status line: model | dir | context usage (k tokens) | task anchor
input=$(cat)

model=$(printf '%s' "$input" | jq -r '.model.display_name // "?"')
cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // "?"')
dir=$(basename "$cwd")

used_tokens=$(printf '%s' "$input" | jq -r '.context_window.total_input_tokens // 0')
window_size=$(printf '%s' "$input" | jq -r '.context_window.context_window_size // 0')
case "$used_tokens" in ''|*[!0-9]*) used_tokens=0 ;; esac
case "$window_size" in ''|*[!0-9]*) window_size=0 ;; esac
used_k=$(( (used_tokens + 500) / 1000 ))
total_k=$(( (window_size + 500) / 1000 ))
ctx="${used_k}k/${total_k}k"

# Task anchor: show the task file owned by THIS session (owner: == session_id).
# Supports legacy flat file and v2 per-task directory layout.
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
cwd_slug=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')
anchor_legacy="$HOME/.claude/task-anchors/${cwd_slug}.md"
anchor_dir="$HOME/.claude/task-anchors/${cwd_slug}"
task="no task claimed"
if [ -s "$anchor_legacy" ]; then
  task=$(head -1 "$anchor_legacy")
elif [ -d "$anchor_dir" ]; then
  owned=""
  count=0
  for f in "$anchor_dir"/*.md; do
    [ -f "$f" ] || continue
    slug=$(basename "$f" .md)
    [ "$slug" = "INDEX" ] && continue
    count=$((count + 1))
    if [ -n "$session_id" ] && [ -z "$owned" ]; then
      owner=$(grep -m1 '^owner:' "$f" 2>/dev/null | sed 's/^owner:[[:space:]]*//' | tr -d '[:space:]')
      [ "$owner" = "$session_id" ] && owned="$f"
    fi
  done
  if [ -n "$owned" ]; then
    line1=$(head -1 "$owned")
    # "STATE <date> | ACTIVE | next: x" -> "ACTIVE | next: x"
    line1=$(printf '%s' "$line1" | sed 's/^STATE [^|]*| *//')
    task="$(basename "$owned" .md) | $line1"
  else
    task="no task claimed (${count} in index)"
  fi
fi
if [ ${#task} -gt 70 ]; then
  task="${task:0:67}..."
fi

printf '\033[36m%s\033[0m \033[34m%s\033[0m \033[33m%s\033[0m \033[35m%s\033[0m\n' \
  "$model" "$dir" "$ctx" "$task"

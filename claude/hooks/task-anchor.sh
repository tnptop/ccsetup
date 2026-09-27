#!/bin/bash
# task-anchor: inject the declared task so Claude can flag sidetracks.
# v1 (legacy): ~/.claude/task-anchors/<cwd-slug>.md
# v2 (dir):    ~/.claude/task-anchors/<cwd-slug>/{INDEX.md,<task-slug>.md}
input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
slug=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
anchor_dir="$HOME/.claude/task-anchors/$slug"
legacy_file="$HOME/.claude/task-anchors/$slug.md"

OWNED_INSTRUCTION='Compare this prompt against the anchor. If it diverges, say so in one line and ask: park it or switch the anchor? When the user declares a new task: read ~/.claude/skills/park/SKILL.md and run its switch flavor. When the task finishes: read ~/.claude/skills/park/SKILL.md and run its closed flavor (close ritual, delete task file, drop INDEX row). Never rewrite the STATE line to CLOSED by hand and never leave a task file whose line 1 says CLOSED.'
SESSION_LINE="session_id: ${session_id} (use this exact value as owner: when /claim-task writes a claim; do not derive it from transcript files)"
UNOWNED_INSTRUCTION='No claimed task in this session. If the request matches a claimed row with a live lease: stop and ask the user (continue in that session, or steal). If it matches a free or stale row: run /claim-task <slug>. If it matches nothing: run /claim-task new "<task text>". If unsure, run /claim-task with no argument.'

iso_now() {
  date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
}

parse_iso_datetime_epoch() {
  local val="$1" result= stripped=
  [ -z "$val" ] && return
  result=$(date -j -f "%Y-%m-%dT%H:%M:%S%z" "$val" +%s 2>/dev/null) || true
  case "$result" in
    ''|*[!0-9]*)
      stripped=$(printf '%s' "$val" | sed 's/\([+-][0-9][0-9]\):\([0-9][0-9]\)$/\1\2/')
      result=$(date -j -f "%Y-%m-%dT%H:%M:%S%z" "$stripped" +%s 2>/dev/null) || true
      ;;
  esac
  case "$result" in
    ''|*[!0-9]*)
      result=$(date -d "$val" +%s 2>/dev/null) || true
      ;;
  esac
  case "$result" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$result" ;;
  esac
}

parse_iso_date_epoch() {
  local val="$1" result=
  [ -z "$val" ] && return
  result=$(date -j -f "%Y-%m-%d" "$val" +%s 2>/dev/null) || true
  case "$result" in
    ''|*[!0-9]*)
      result=$(date -d "$val" +%s 2>/dev/null) || true
      ;;
  esac
  case "$result" in
    ''|*[!0-9]*) ;;
    *) printf '%s' "$result" ;;
  esac
}

extract_field() {
  local file="$1" key="$2" line=
  line=$(grep -E "^${key}:" "$file" 2>/dev/null | head -1) || true
  line=$(printf '%s' "$line" | tr -d '\r')
  line="${line#${key}:}"
  line="${line# }"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf '%s' "$line"
}

rewrite_heartbeat() {
  local file="$1" new_hb="$2"
  if grep -q '^heartbeat:' "$file" 2>/dev/null; then
    if sed --version >/dev/null 2>&1; then
      sed -i "s/^heartbeat:.*/heartbeat: ${new_hb}/" "$file"
    else
      sed -i '' "s/^heartbeat:.*/heartbeat: ${new_hb}/" "$file"
    fi
  else
    printf 'heartbeat: %s\n' "$new_hb" >> "$file"
  fi
}

file_size_bytes() {
  local file="$1" anchor_len=
  anchor_len=$(stat -f %z "$file" 2>/dev/null || stat -c %s "$file" 2>/dev/null || true)
  case "$anchor_len" in
    ''|*[!0-9]*)
      anchor_len=$(wc -c < "$file" | tr -d '[:space:]')
      ;;
  esac
  case "$anchor_len" in
    ''|*[!0-9]*) anchor_len=0 ;;
  esac
  printf '%s' "$anchor_len"
}

file_mtime_epoch() {
  local file="$1" mtime_epoch=
  mtime_epoch=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || true)
  printf '%s' "$mtime_epoch"
}

hours_since() {
  local then_epoch="$1" age_h=0
  case "$then_epoch" in
    ''|*[!0-9]*)
      printf '0'
      return
      ;;
  esac
  age_h=$(( (now_epoch - then_epoch) / 3600 ))
  case "$age_h" in
    -*) age_h=0 ;;
  esac
  printf '%s' "$age_h"
}

parse_step_from_line() {
  step_n=
  step_m=
  case "$1" in
    "STATE "*)
      if [[ "$1" =~ step\ ([0-9]+)/([0-9]+) ]]; then
        step_n="${BASH_REMATCH[1]}"
        step_m="${BASH_REMATCH[2]}"
      fi
      ;;
  esac
}

parse_state_fields() {
  local line="$1" rest= after= nrest=
  state_date=
  state_status=
  state_next=
  case "$line" in
    "STATE "*) ;;
    *) return ;;
  esac
  rest="${line#STATE }"
  state_date="${rest%% *}"
  case "$rest" in
    *" | "*)
      after="${rest#* | }"
      state_status="${after%% | *}"
      state_status="${state_status%% *}"
      ;;
  esac
  case "$line" in
    *next:*)
      nrest="${line#*next:}"
      nrest="${nrest# }"
      case "$nrest" in
        *" | "*)
          state_next="${nrest%% | *}"
          ;;
        *)
          state_next="$nrest"
          ;;
      esac
      ;;
  esac
}

build_nudges() {
  nudges=
  if [ "$ctx_tokens" -ge 150000 ]; then
    ctx_k=$(( ctx_tokens / 1000 ))
    nudges="⚠ context ~${ctx_k}k — run /park next at the end of the current step, do not start a new step in this session."
    if [ -n "$step_n" ] && [ -n "$step_m" ] && [ "$step_n" -lt "$step_m" ]; then
      nudges="${nudges} ($(( step_m - step_n )) steps remain.)"
    fi
  fi
  if [ "$anchor_age_h" -ge 4 ]; then
    age_line="⚠ anchor STATE last written ${anchor_age_h}h ago — update it at the next checkpoint."
    if [ -n "$nudges" ]; then
      nudges="${nudges}"$'\n'"${age_line}"
    else
      nudges="${age_line}"
    fi
  fi
  if [ "$anchor_len" -gt 1500 ]; then
    len_line="⚠ anchor is ${anchor_len} bytes — /park will condense it to a STATE line + ≤800 chars."
    if [ -n "$nudges" ]; then
      nudges="${nudges}"$'\n'"${len_line}"
    else
      nudges="${len_line}"
    fi
  fi
}

emit_json() {
  local ctx="$1"
  jq -n --arg ctx "$ctx" \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
}

claim_state_for() {
  local file="$1" owner= hb= hb_epoch= age_h= owner8=
  owner=$(extract_field "$file" "owner")
  if [ -z "$owner" ]; then
    printf '%s' "free"
    return
  fi
  owner8=$(printf '%s' "$owner" | cut -c1-8)
  hb=$(extract_field "$file" "heartbeat")
  hb_epoch=$(parse_iso_datetime_epoch "$hb")
  case "$hb_epoch" in
    ''|*[!0-9]*)
      printf 'stale (owner %s, ?h ago)' "$owner8"
      return
      ;;
  esac
  age_h=$(hours_since "$hb_epoch")
  case "$age_h" in
    ''|*[!0-9]*) age_h=4 ;;
  esac
  if [ "$age_h" -ge 4 ]; then
    printf 'stale (owner %s, %sh ago)' "$owner8" "$age_h"
  else
    printf 'claimed by %s, %sh ago' "$owner8" "$age_h"
  fi
}

is_task_file() {
  local file="$1" base=
  [ -f "$file" ] || return 1
  base=$(basename "$file")
  [ "$base" = "INDEX.md" ] && return 1
  case "$base" in
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

ctx_tokens=0
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  usage_line=$(tail -c 400000 "$transcript_path" | grep '"cache_read_input_tokens"' | tail -1) || true
  if [ -n "$usage_line" ]; then
    parsed=$(printf '%s' "$usage_line" | jq -r '.message.usage | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)' 2>/dev/null) || true
    case "$parsed" in
      ''|*[!0-9]*) ;;
      *) ctx_tokens=$parsed ;;
    esac
  fi
fi

now_epoch=$(date +%s)

if [ -d "$anchor_dir" ]; then
  owned_file=
  for f in "$anchor_dir"/*.md; do
    is_task_file "$f" || continue
    owner=$(extract_field "$f" "owner")
    if [ -n "$session_id" ] && [ "$owner" = "$session_id" ]; then
      owned_file=$f
      break
    fi
  done

  if [ -n "$owned_file" ]; then
    # Park guard (office hours 2026-09-26): a slash command typed mid-sentence is prose —
    # the CLI never runs it and the model imitates the park by hand. Block the prompt
    # (exit 2 = erased, stderr shown) so the user re-sends /park as its own message.
    # Only while this session owns a claim; a /park inside backticks is not matched.
    prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null)
    case "$prompt" in
      /*) ;;
      *)
        if printf '%s' "$prompt" | grep -Eq '(^|[[:space:]])/park([[:space:]]|$)'; then
          printf '%s\n' "NOT SENT — /park only runs as the first character of a message; typed mid-sentence it is prose and the skill never runs." "Send the note first, then /park <flavor> alone. Your message was:" "$prompt" >&2
          exit 2
        fi
        ;;
    esac
    rewrite_heartbeat "$owned_file" "$(iso_now)"
    anchor=$(head -c 2500 "$owned_file")
    line1=$(head -1 "$owned_file")
    parse_step_from_line "$line1"
    parse_state_fields "$line1"
    state_epoch=$(parse_iso_date_epoch "$state_date")
    anchor_age_h=$(hours_since "$state_epoch")
    case "$anchor_age_h" in
      ''|*[!0-9]*) anchor_age_h=0 ;;
    esac
    anchor_len=$(file_size_bytes "$owned_file")
    build_nudges
    ctx="DECLARED TASK ANCHOR ($owned_file): $anchor
session_id: ${session_id}
${OWNED_INSTRUCTION}"
    if [ -n "$nudges" ]; then
      ctx="${ctx}
${nudges}"
    fi
    emit_json "$ctx"
    exit 0
  fi

  index_lines=
  for f in "$anchor_dir"/*.md; do
    is_task_file "$f" || continue
    task_slug=$(basename "$f" .md)
    line1=$(head -1 "$f")
    parse_state_fields "$line1"
    row_claim=$(claim_state_for "$f")
    row="- ${task_slug} | ${state_status} | next: ${state_next} | ${row_claim}"
    if [ -n "$index_lines" ]; then
      index_lines="${index_lines}"$'\n'"${row}"
    else
      index_lines="$row"
    fi
  done

  if [ -n "$index_lines" ]; then
    ctx="TASK ANCHOR INDEX (${anchor_dir}):
${index_lines}
${SESSION_LINE}
${UNOWNED_INSTRUCTION}"
  else
    ctx="${SESSION_LINE}
${UNOWNED_INSTRUCTION}"
  fi
  # No owned anchor: only the context-size nudge applies.
  step_n=; step_m=; anchor_age_h=0; anchor_len=0
  build_nudges
  if [ -n "$nudges" ]; then
    ctx="${ctx}
${nudges}"
  fi
  emit_json "$ctx"
  exit 0
fi

# Legacy flat file — v1 path, unchanged behaviour
anchor_file="$legacy_file"
if [ ! -s "$anchor_file" ]; then
  # No anchor dir and no legacy file: still hand Claude the claim instruction and the context nudge.
  if [ -n "$session_id" ]; then
    ctx="${SESSION_LINE}
${UNOWNED_INSTRUCTION}"
  else
    ctx="${UNOWNED_INSTRUCTION}"
  fi
  step_n=; step_m=; anchor_age_h=0; anchor_len=0
  build_nudges
  if [ -n "$nudges" ]; then
    ctx="${ctx}
${nudges}"
  fi
  emit_json "$ctx"
  exit 0
fi
anchor=$(head -c 2500 "$anchor_file")

mtime_epoch=$(file_mtime_epoch "$anchor_file")
anchor_age_h=0
case "$mtime_epoch" in
  ''|*[!0-9]*) ;;
  *) anchor_age_h=$(( (now_epoch - mtime_epoch) / 3600 )) ;;
esac

anchor_len=$(file_size_bytes "$anchor_file")

step_n=
step_m=
line1=$(head -1 "$anchor_file")
parse_step_from_line "$line1"

build_nudges

ctx="DECLARED TASK ANCHOR ($anchor_file): $anchor
${OWNED_INSTRUCTION}"
if [ -n "$nudges" ]; then
  ctx="${ctx}
${nudges}"
fi

emit_json "$ctx"

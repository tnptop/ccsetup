#!/bin/bash
# task-anchor: inject the declared task so Claude can flag sidetracks.
# Anchors: ~/.claude/task-anchors/<cwd-slug>/{INDEX.md,<task-slug>.md}
# Lanes (uniichat lane design section 3): on in Claude Code; also Stop,
# SessionEnd and SessionStart (arg view|last) call this.
input=$(cat)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)
# Key by project root, not .cwd: a Bash `cd` moves .cwd (lane design F5).
cwd="${CLAUDE_PROJECT_DIR:-}"
[ -z "$cwd" ] && cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
slug=$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
anchor_dir="$HOME/.claude/task-anchors/$slug"
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
lanes_dir="${LANES_ROOT:-$HOME/.claude/lanes}/$slug"
LANE_TS="${LANE_TS:-$HOME/.claude/hooks/lanes/lane.ts}"

# Lanes off (omp until its port, or no node): the old /park flavors.
OWNED_INSTRUCTION='Compare this prompt against the anchor. If it diverges, say so in one line and ask: park it or switch the anchor? When the user declares a new task: read ~/.claude/skills/park/SKILL.md and run its switch flavor. When the task finishes: read ~/.claude/skills/park/SKILL.md and run its closed flavor (close ritual, delete task file, drop INDEX row). Never rewrite the STATE line to CLOSED by hand and never leave a task file whose line 1 says CLOSED.'
# Lanes on: no /park next, /park or /park switch (design section 3); /clear
# resets context and the lane comes back on its own.
LANE_INSTRUCTION='Compare this prompt against the anchor. If it diverges, say so in one line and ask: stay on this lane, or take the other task to its own window (/claim-task there)? For context, tell the user to type /clear; this lane comes back on its own. When the task finishes: read ~/.claude/skills/park/SKILL.md and run its closed flavor (close ritual, delete task file, drop INDEX row). Never rewrite the STATE line to CLOSED by hand and never leave a task file whose line 1 says CLOSED.'
SESSION_LINE="session_id: ${session_id} (use this exact value as owner: when /claim-task writes a claim; do not derive it from transcript files)"
UNOWNED_INSTRUCTION='No claimed task in this session. If the request matches a claimed row with a live lease: stop and ask the user (continue in that session, or steal). If it matches a free or stale row: run /claim-task <slug>. If it matches nothing: run /claim-task new "<task text>". If unsure, run /claim-task with no argument.'

iso_now() {
  date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
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

rewrite_field() {
  local file="$1" key="$2" val="$3"
  if grep -q "^${key}:" "$file" 2>/dev/null; then
    if sed --version >/dev/null 2>&1; then
      sed -i "s/^${key}:.*/${key}: ${val}/" "$file"
    else
      sed -i '' "s/^${key}:.*/${key}: ${val}/" "$file"
    fi
  else
    printf '%s: %s\n' "$key" "$val" >> "$file"
  fi
}

drop_field() {
  if sed --version >/dev/null 2>&1; then
    sed -i "/^$2:/d" "$1"
  else
    sed -i '' "/^$2:/d" "$1"
  fi
}

# Lanes on: Claude Code (not omp: its transcript is synthetic, usage-only)
# and node runs lane.ts. lane_add makes the project's lanes dir.
lanes_on() {
  [ -z "${OMPCODE:-}" ] && command -v node >/dev/null 2>&1
}

# A live harness: kill -0 works and the first word of args is claude or omp.
# Not comm: Claude Code's comm can be its versioned binary (2.1.306).
is_harness() {
  local a=
  kill -0 "$1" 2>/dev/null || return 1
  a=$(ps -p "$1" -o args= 2>/dev/null) || return 1
  a=${a%% *}
  a=${a##*/}
  [ "$a" = claude ] || [ "$a" = omp ]
}

# The claim's pid: CLAUDE_PID, else (omp sets none) the first harness
# ancestor of this hook.
harness_pid() {
  local p=$PPID
  if [ -n "${CLAUDE_PID:-}" ]; then
    printf '%s' "$CLAUDE_PID"
    return
  fi
  while [ "${p:-1}" -gt 1 ] 2>/dev/null; do
    if is_harness "$p"; then
      printf '%s' "$p"
      return
    fi
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
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
  local limit=150000 say="run /park next at the end of the current step, do not start a new step in this session."
  nudges=
  if lanes_on; then
    limit=200000
    say="finish this step, then tell the user to type /clear (you cannot run it)."
  fi
  if [ "$ctx_tokens" -ge "$limit" ]; then
    ctx_k=$(( ctx_tokens / 1000 ))
    nudges="⚠ context ~${ctx_k}k — ${say}"
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
  jq -n --arg ctx "$ctx" --arg ev "${2:-UserPromptSubmit}" \
    '{hookSpecificOutput:{hookEventName:$ev,additionalContext:$ctx}}'
}

claim_state_for() {
  local file="$1" owner= owner8= pid=
  owner=$(extract_field "$file" "owner")
  if [ -z "$owner" ]; then
    printf '%s' "free"
    return
  fi
  owner8=$(printf '%s' "$owner" | cut -c1-8)
  # Live = pid: is a live harness; the heartbeat: line is not read.
  pid=$(extract_field "$file" "pid")
  if [ -n "$pid" ] && is_harness "$pid"; then
    printf 'claimed by %s, pid %s live' "$owner8" "$pid"
  else
    printf 'stale (owner %s, no live pid)' "$owner8"
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

# Context tokens of the transcript's last usage line; arg 2 (Stop) adds its
# output tokens.
ctx_tokens_of() {
  local tp="$1" out="${2:+ + (.output_tokens // 0)}" usage_line= parsed=
  if [ -n "$tp" ] && [ -f "$tp" ]; then
    usage_line=$(tail -c 400000 "$tp" | grep '"cache_read_input_tokens"' | tail -1) || true
    if [ -n "$usage_line" ]; then
      parsed=$(printf '%s' "$usage_line" | jq -r ".message.usage | (.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0)${out}" 2>/dev/null) || true
      case "$parsed" in
        ''|*[!0-9]*) ;;
        *) printf '%s' "$parsed"; return ;;
      esac
    fi
  fi
  printf '0'
}

# The task file this session owns, if any.
owned_task() {
  local f= owner=
  for f in "$anchor_dir"/*.md; do
    is_task_file "$f" || continue
    owner=$(extract_field "$f" "owner")
    if [ -n "$session_id" ] && [ "$owner" = "$session_id" ]; then
      printf '%s' "$f"
      return
    fi
  done
}

# Log this session's transcript in lane $1, once (lane.ts add).
lane_add() {
  [ -n "$session_id" ] && [ -n "$transcript_path" ] || return 0
  grep -q "^${session_id}	" "$lanes_dir/$1/log" 2>/dev/null && return 0
  mkdir -p "$lanes_dir"
  node "$LANE_TS" add "$cwd" "$1" "$session_id" "$transcript_path" >/dev/null 2>&1
}

# Stop (owned claim): refresh the lease pid, keep the last exchange (from the
# hook input: the transcript may not be flushed yet), start the build
# detached, ask for /clear at 200k.
on_stop() {
  local f= lane= d= pid= k=
  f=$(owned_task)
  [ -n "$f" ] || return 0
  pid=$(harness_pid)
  [ -n "$pid" ] && rewrite_field "$f" pid "$pid"
  lane=$(basename "$f" .md)
  d="$lanes_dir/$lane"
  lane_add "$lane"
  [ -d "$d" ] || return 0
  if printf '%s' "$input" | jq --arg prompt "$(cat "$d/prompt" 2>/dev/null)" --arg date "$(iso_now)" \
    '{prompt:$prompt, message:(.last_assistant_message // ""), transcript:(.transcript_path // ""), date:$date}' > "$d/last.json.$$"; then
    mv "$d/last.json.$$" "$d/last.json"
  else
    rm -f "$d/last.json.$$"
  fi
  (
    unset CLAUDE_PID CLAUDECODE CLAUDE_CODE_SESSION_ID
    nohup node "$LANE_TS" build "$cwd" "$lane" </dev/null >/dev/null 2>>"$d/build.out" &
  )
  k=$(ctx_tokens_of "$transcript_path" out)
  if [ "$k" -ge 200000 ]; then
    jq -nc --arg m "context ~$(( k / 1000 ))k: type /clear now; lane ${lane} comes back on its own" '{systemMessage:$m}'
  fi
}

# SessionEnd: release the owned claim, keeping the session for resume; not
# on /clear (the same window re-claims by pid).
on_end() {
  local f=
  [ "$(printf '%s' "$input" | jq -r '.reason // empty')" = clear ] && return 0
  f=$(owned_task)
  [ -n "$f" ] || return 0
  drop_field "$f" owner
  drop_field "$f" heartbeat
  drop_field "$f" pid
  rewrite_field "$f" last_session "$session_id"
}

# The task file a starting session takes over. clear/compact: the same
# process, so the one whose pid: is this harness. resume: a new process, so
# the one this session owns, or released and no one has claimed since, unless
# another live window holds it. startup/fork: none.
find_lane() {
  local f= me= pid= owner= last=
  me=$(harness_pid)
  for f in "$anchor_dir"/*.md; do
    is_task_file "$f" || continue
    pid=$(extract_field "$f" "pid")
    case "$1" in
      clear|compact)
        [ -n "$me" ] && [ "$pid" = "$me" ] || continue
        ;;
      resume)
        owner=$(extract_field "$f" "owner")
        last=$(extract_field "$f" "last_session")
        [ -n "$session_id" ] || return 0
        [ "$owner" = "$session_id" ] || [ "$last" = "$session_id" ] || continue
        # never auto-steal: a later session's claim, even a dead one, wins
        [ -z "$owner" ] || [ "$owner" = "$session_id" ] || continue
        [ -z "$pid" ] || [ "$pid" = "$me" ] || ! is_harness "$pid" || continue
        ;;
      *) return 0 ;;
    esac
    printf '%s' "$f"
    return 0
  done
}

# D4: wait until every indexed message has its leaf in tree.jsonl, at most
# LANE_WAIT s (20); never on merges or the build lock. The last exchange
# covers a leaf not built yet.
wait_leaves() {
  local d="$1" n= l= end=$(( $(date +%s) + ${LANE_WAIT:-20} ))
  [ -f "$d/index.jsonl" ] || return 0
  while :; do
    n=$(grep -c . "$d/index.jsonl" 2>/dev/null)
    l=$(grep -c '^{"l":0,' "$d/tree.jsonl" 2>/dev/null)
    [ "${l:-0}" -ge "${n:-0}" ] && return 0
    [ "$(date +%s)" -ge "$end" ] && return 0
    sleep 0.5
  done
}

# SessionStart, arg view: re-claim (under the claim-task lock), then on
# clear/compact print the view. Arg last: print the last exchange.
on_start() {
  local src= f= lane= pid= ctx=
  src=$(printf '%s' "$input" | jq -r '.source // empty')
  f=$(find_lane "$src")
  [ -n "$f" ] || return 0
  lane=$(basename "$f" .md)
  case "$1" in
    view)
      mkdir "$anchor_dir/$lane.lock" 2>/dev/null || return 0
      rewrite_field "$f" owner "$session_id"
      pid=$(harness_pid)
      [ -n "$pid" ] && rewrite_field "$f" pid "$pid"
      rmdir "$anchor_dir/$lane.lock"
      [ "$src" = resume ] && return 0
      wait_leaves "$lanes_dir/$lane"
      ctx=$(node "$LANE_TS" inject view "$cwd" "$lane")
      ;;
    last)
      ctx=$(node "$LANE_TS" inject last "$cwd" "$lane")
      ;;
  esac
  [ -n "$ctx" ] && emit_json "$ctx" SessionStart
}

# Lane events: only when lanes are on; quiet, always exit 0 (exit 2 on Stop
# blocks the stop). UserPromptSubmit (and omp, which sends no event) go on.
case "$event" in
  Stop|SessionEnd|SessionStart)
    if lanes_on && [ -d "$anchor_dir" ]; then
      case "$event" in
        Stop) on_stop ;;
        SessionEnd) on_end ;;
        SessionStart) on_start "$1" ;;
      esac 2>/dev/null
    fi
    exit 0
    ;;
esac

ctx_tokens=$(ctx_tokens_of "$transcript_path")

now_epoch=$(date +%s)

if [ -d "$anchor_dir" ]; then
  owned_file=$(owned_task)

  if [ -n "$owned_file" ]; then
    # Park guard (office hours 2026-09-26): a slash command typed mid-sentence is prose —
    # the CLI never runs it and the model imitates the park by hand. Block the prompt
    # (exit 2 = erased, stderr shown) so the user re-sends /park as its own message.
    # Only while this session owns a claim; a /park inside backticks is not matched.
    # Not on harness-wrapped prompts (<agent-message, <task-notification, ...): never
    # typed, and a block erases a subagent's report.
    prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null)
    case "$prompt" in
      /*|'<'*) ;;
      *)
        if printf '%s' "$prompt" | grep -Eq '(^|[[:space:]])/park([[:space:]]|$)'; then
          printf '%s\n' "NOT SENT — /park only runs as the first character of a message; typed mid-sentence it is prose and the skill never runs." "Send the note first, then /park <flavor> alone. Your message was:" "$prompt" >&2
          exit 2
        fi
        ;;
    esac
    # Lease liveness key (lane design section 3): is_harness on this pid.
    pid=$(harness_pid)
    [ -n "$pid" ] && rewrite_field "$owned_file" pid "$pid"
    instruction=$OWNED_INSTRUCTION
    if lanes_on; then
      instruction=$LANE_INSTRUCTION
      lane=$(basename "$owned_file" .md)
      lane_add "$lane"
      [ -d "$lanes_dir/$lane" ] && printf '%s' "$prompt" > "$lanes_dir/$lane/prompt"
    fi
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
${instruction}"
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

# No anchor dir: still hand Claude the claim instruction and the context nudge.
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

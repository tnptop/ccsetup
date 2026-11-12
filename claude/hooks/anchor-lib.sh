# shellcheck shell=bash disable=SC2034 # state_* are read by the sourcing script
# anchor-lib: task-anchor helpers shared by hooks/task-anchor.sh and
# skills/park/scripts/sweep.sh. Functions only; sourcing runs nothing.

# The key for $1: inside a linked git worktree, the main checkout plus the
# same subdirectory (a worktree's own folder is orphaned when it is removed,
# and EnterWorktree leaves CLAUDE_PROJECT_DIR on the main checkout). Else
# (main checkout, submodule, not git, no git) $1 unchanged.
project_root() {
  local out='' gd='' cd='' prefix='' root=''
  out=$(git -C "$1" rev-parse --path-format=absolute --git-dir --git-common-dir --show-prefix 2>/dev/null) || out=
  { read -r gd; read -r cd; read -r prefix; } <<< "$out"
  if [ -z "$gd" ] || [ -z "$cd" ] || [ "$gd" = "$cd" ]; then
    printf '%s' "$1"
    return
  fi
  root=$cd
  [ "$(basename "$cd")" = .git ] && root=$(dirname "$cd")
  prefix=${prefix%/}
  printf '%s' "$root${prefix:+/$prefix}"
}

# The first "key:" line; no grep, head or tr (forks are slow on Windows).
extract_field() {
  local file="$1" key="$2" line='' cr=$'\r'
  {
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in "${key}:"*) break ;; esac
      line=''
    done < "$file"
  } 2>/dev/null
  line="${line//$cr/}"
  line="${line#"${key}":}"
  line="${line# }"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf '%s' "$line"
}

# A live harness: kill -0 works and the first word of args, or else the
# basename of comm, is claude or omp. Args first: Claude Code's comm can be its
# versioned binary (2.1.306). Comm second: the desktop app's path has a space
# (Application Support), so the first word of args stops early; comm keeps the
# whole path.
is_harness() {
  local a=''
  case "${OSTYPE:-}" in
    msys*|cygwin*)
      is_harness_windows "$1"
      return
      ;;
  esac
  kill -0 "$1" 2>/dev/null || return 1
  a=$(ps -p "$1" -o args= 2>/dev/null) || return 1
  a=${a%% *}
  a=${a##*/}
  if [ "$a" = claude ] || [ "$a" = omp ]; then return 0; fi
  a=$(ps -p "$1" -o comm= 2>/dev/null) || return 1
  a=${a##*/}
  [ "$a" = claude ] || [ "$a" = omp ]
}

# Windows: CLAUDE_PID is a Windows pid, which kill -0 and /proc do not see; a
# process started from Git Bash has a Cygwin pid, which tasklist does not. A
# number can be in both, so a Cygwin process that is no harness does not decide.
is_harness_windows() {
  local a=''
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  if kill -0 "$1" 2>/dev/null && IFS= read -r -d '' a 2>/dev/null < "/proc/$1/cmdline"; then
    is_harness_name "$a" && return 0
  fi
  # tasklist prints "claude.exe","2144",... or, with no such pid, a sentence.
  a=$(MSYS2_ARG_CONV_EXCL='*' tasklist /FI "PID eq $1" /NH /FO CSV 2>/dev/null) || return 1
  a=${a%%,*}
  is_harness_name "${a//\"/}"
}

# Arg: a Windows program path or name.
is_harness_name() {
  local a=${1##*[/\\]}
  a=${a%.[eE][xX][eE]}
  [ "$a" = claude ] || [ "$a" = omp ]
}

is_task_file() {
  local file="$1" base=
  [ -f "$file" ] || return 1
  base=${file##*/}
  [ "$base" = "INDEX.md" ] && return 1
  case "$base" in
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Line 1 of a task file: STATE <date> | <status> | next: <action> | step <N/M>
# Sets state_date, state_status, state_next (empty when not a STATE line).
parse_state_fields() {
  local line="$1" rest='' after='' nrest=''
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

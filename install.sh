#!/usr/bin/env bash
# ccsetup: copies Claude Code config between this repo and $HOME.
# Files in $HOME stay real files. Nothing in $HOME points at this repo.
#
# Usage:
#   ./install.sh                 copy repo -> $HOME (backs up files it overwrites)
#   ./install.sh sync            copy $HOME -> repo (run before you commit)
#   ./install.sh --check         list files that differ between repo and $HOME
#   ./install.sh --dry-run       with install or sync: print, touch nothing
#   ./install.sh plugins         add marketplaces and install plugins via `claude`
#   ./install.sh --rollback [d]  restore a backup dir (default: the newest one)
#
# Paths derive from $HOME, so the same script works for any username.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
AGENTS="$HOME/.agents"
BACKUP_ROOT="$CLAUDE/backups"
BACKUP="$BACKUP_ROOT/ccsetup-$(date +%Y%m%d-%H%M%S)"
EXCLUDES=(--exclude .DS_Store --exclude '*.bak')

# Skills present in dot-agents/skills that get NO ~/.claude/skills entry.
SKIP_SKILLS="critique-plan-implementation microsoft-foundry to-issues to-prd"

DRY=0; MODE="install"; ROLLBACK_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY=1 ;;
    --check)    MODE="check" ;;
    sync)       MODE="sync" ;;
    plugins)    MODE="plugins" ;;
    --rollback) MODE="rollback"
                if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then ROLLBACK_DIR="$2"; shift; fi ;;
    -h|--help)  sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then log "  dry: $*"; else "$@"; fi; }

# Emits "repo-relative-path|absolute-home-path" lines.
pairs() {
  echo "claude/CLAUDE.md|$CLAUDE/CLAUDE.md"
  echo "claude/settings.json|$CLAUDE/settings.json"
  echo "claude/statusline-command.sh|$CLAUDE/statusline-command.sh"
  echo "claude/hooks|$CLAUDE/hooks"
  echo "dot-agents/skills|$AGENTS/skills"
  echo "dot-agents/.skill-lock.json|$AGENTS/.skill-lock.json"
  echo "workspace/colleague-output-style.md|$HOME/workspace/colleague-output-style.md"
  local f n d
  for f in "$REPO"/claude/agents/*.md; do
    n=$(basename "$f")
    if [ "$n" = cursor-worker.md ] && ! command -v cursor-agent >/dev/null 2>&1; then
      log "  skip $CLAUDE/agents/$n (cursor-agent not on PATH)" >&2
      continue
    fi
    echo "claude/agents/$n|$CLAUDE/agents/$n"
  done
  for d in "$REPO"/claude/skills/*/; do
    n=$(basename "$d")
    echo "claude/skills/$n|$CLAUDE/skills/$n"
  done
}

same() { # same <a> <b>: true when file/dir contents match
  local a="$1" b="$2"
  [ -e "$a" ] && [ -e "$b" ] || return 1
  if [ -d "$a" ]; then
    [ -d "$b" ] && diff -rq -x .DS_Store -x '*.bak' "$a" "$b" >/dev/null 2>&1
  else
    [ -f "$b" ] && cmp -s "$a" "$b"
  fi
}

copy() { # copy <src> <dst>: rsync, with a backup of dst when it differs
  local src="$1" dst="$2"
  if same "$src" "$dst"; then log "  ok   $dst"; return; fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    local bak="$BACKUP${dst#"$HOME"}"
    log "  back $dst -> $bak"
    run mkdir -p "$(dirname "$bak")"
    run cp -R "$dst" "$bak"
    [ -L "$dst" ] && run rm "$dst"   # never copy into a symlink's target
  fi
  log "  copy $src -> $dst"
  run mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    run rsync -a "${EXCLUDES[@]}" "$src/" "$dst/"
  else
    run rsync -a "$src" "$dst"
  fi
}

# settings.json: the repo copy has no autoMode block (it is machine-specific).
# Install keeps the machine's existing autoMode; sync strips it.
install_settings() {
  local src="$REPO/claude/settings.json" dst="$CLAUDE/settings.json" tmp
  if [ -f "$dst" ] && [ ! -L "$dst" ] && jq -e '.autoMode' "$dst" >/dev/null 2>&1; then
    tmp=$(mktemp)
    jq -s '.[0] + {autoMode: .[1].autoMode}' "$src" "$dst" > "$tmp"
    copy "$tmp" "$dst"; rm -f "$tmp"
  else
    copy "$src" "$dst"
  fi
}
sync_settings() {
  local src="$CLAUDE/settings.json" dst="$REPO/claude/settings.json" tmp
  tmp=$(mktemp)
  jq 'del(.autoMode)' "$src" > "$tmp"
  copy "$tmp" "$dst"; rm -f "$tmp"
}

# ~/.claude/skills/<name> -> ../../.agents/skills/<name> (relative, inside $HOME)
link_skills() {
  local d n dst
  for d in "$REPO"/dot-agents/skills/*/; do
    n=$(basename "$d")
    case " $SKIP_SKILLS " in *" $n "*) continue ;; esac
    dst="$CLAUDE/skills/$n"
    if [ -L "$dst" ] && [ "$(readlink "$dst" | sed 's:/*$::')" = "../../.agents/skills/$n" ]; then continue; fi
    if [ -e "$dst" ] || [ -L "$dst" ]; then
      log "  back $dst -> $BACKUP${dst#"$HOME"}"
      run mkdir -p "$BACKUP/.claude/skills"
      run mv "$dst" "$BACKUP/.claude/skills/$n"
    fi
    log "  link $dst -> ../../.agents/skills/$n"
    run mkdir -p "$CLAUDE/skills"
    run ln -s "../../.agents/skills/$n" "$dst"
  done
}

install_memory() {
  # Memory is per-machine and Claude writes to it, so copy once; never overwrite.
  local slug dst src="$REPO/memory/workspace-personal"
  slug=$(printf '%s' "$HOME/workspace/personal" | sed 's/[^A-Za-z0-9]/-/g')
  dst="$CLAUDE/projects/$slug/memory"
  if [ -e "$dst/MEMORY.md" ]; then
    log "  ok   $dst (exists, not touched)"
  else
    log "  copy $src -> $dst"
    run mkdir -p "$dst"
    run cp -R "$src/." "$dst/"
  fi
}

preflight() {
  local missing=0 t
  for t in jq rsync claude git; do
    if ! command -v "$t" >/dev/null 2>&1; then log "  missing tool: $t"; missing=1; fi
  done
  [ "$missing" = 0 ] || { log "install the missing tools first (brew install jq gh node uv; then the Claude installer)"; exit 1; }
}

# Walk a backup tree and put every entry back where it came from.
restore_tree() {
  local dir="$1" e rel dst
  for e in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    rel="${e#"$ROLLBACK_DIR"}"; dst="$HOME$rel"
    if [ -L "$dst" ]; then
      log "  unlink $dst"; run rm "$dst"
      log "  restore $dst"; run mv "$e" "$dst"
    elif [ ! -e "$dst" ]; then
      log "  restore $dst"; run mv "$e" "$dst"
    elif [ -d "$dst" ] && [ -d "$e" ] && [ ! -L "$e" ]; then
      restore_tree "$e"
    else
      log "  restore $dst (overwrite)"; run rm -rf "$dst"; run mv "$e" "$dst"
    fi
  done
}

case "$MODE" in
  install)
    log "preflight"; preflight
    log "installing repo -> \$HOME (backups: $BACKUP)"
    while IFS='|' read -r src dst; do
      case "$src" in claude/settings.json) install_settings ;; *) copy "$REPO/$src" "$dst" ;; esac
    done < <(pairs)
    log "skill links"; link_skills
    log "memory"; install_memory
    log "done. Next: ./install.sh plugins, then in claude run /doctor and /reload-skills"
    ;;
  sync)
    BACKUP="$REPO/.sync-backup"   # repo side is under git; no backup needed
    log "syncing \$HOME -> repo"
    while IFS='|' read -r src dst; do
      [ -e "$dst" ] || { log "  skip $dst (missing on this machine)"; continue; }
      case "$src" in claude/settings.json) sync_settings ;; *) copy "$dst" "$REPO/$src" ;; esac
    done < <(pairs)
    rm -rf "$REPO/.sync-backup"
    log "done. Review with: git status && git diff"
    ;;
  check)
    while IFS='|' read -r src dst; do
      if [ -L "$dst" ]; then log "  LINK    $dst (symlink; expected a real file)"
      elif [ "$src" = claude/settings.json ] && [ -f "$dst" ] \
           && cmp -s <(jq -S 'del(.autoMode)' "$dst") <(jq -S . "$REPO/$src"); then log "  ok      $dst"
      elif same "$REPO/$src" "$dst"; then log "  ok      $dst"
      elif [ -e "$dst" ]; then log "  DIFF    $dst"
      else log "  MISSING $dst"; fi
    done < <(pairs)
    ;;
  plugins)
    for m in warpdotdev/claude-code-warp openai/codex-plugin-cc; do
      log "marketplace add $m"; run claude plugin marketplace add "$m" || true
    done
    for p in frontend-design@claude-plugins-official warp@claude-code-warp codex@openai-codex; do
      log "plugin install $p"; run claude plugin install "$p" || true
    done
    log "codex CLI (if not installed): npm i -g @openai/codex && codex login"
    ;;
  rollback)
    if [ -z "$ROLLBACK_DIR" ]; then
      ROLLBACK_DIR=$(find "$BACKUP_ROOT" -maxdepth 1 -name 'ccsetup-*' 2>/dev/null | sort | tail -1 || true)
    fi
    [ -n "$ROLLBACK_DIR" ] && [ -d "$ROLLBACK_DIR" ] || { log "no backup dir found"; exit 1; }
    ROLLBACK_DIR="$(cd "$ROLLBACK_DIR" && pwd)"
    log "rolling back from $ROLLBACK_DIR"
    restore_tree "$ROLLBACK_DIR"
    log "done. Leftover (should be empty):"; find "$ROLLBACK_DIR" -mindepth 1 | head
    ;;
esac

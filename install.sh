#!/usr/bin/env bash
# ccsetup installer: links Claude Code config from this repo into $HOME.
#
# Usage:
#   ./install.sh            link everything (backs up whatever it replaces)
#   ./install.sh --dry-run  print what would change, touch nothing
#   ./install.sh --check    report drift: which targets no longer point here
#   ./install.sh plugins    add marketplaces and install plugins via `claude`
#
# Paths are derived from $HOME, so the same script works for any username.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
AGENTS="$HOME/.agents"
BACKUP="$CLAUDE/backups/ccsetup-$(date +%Y%m%d-%H%M%S)"

# Skills present in dot-agents/skills that get NO ~/.claude/skills entry.
SKIP_SKILLS="critique-plan-implementation microsoft-foundry to-issues to-prd"

DRY=0; MODE="link"
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --check)   MODE=check ;;
    plugins)   MODE=plugins ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

log() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then log "  dry: $*"; else "$@"; fi; }

# Emits "repo-relative-src|absolute-target" lines.
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
  for d in "$REPO"/dot-agents/skills/*/; do
    n=$(basename "$d")
    case " $SKIP_SKILLS " in *" $n "*) continue ;; esac
    echo "dot-agents/skills/$n|$CLAUDE/skills/$n"
  done
}

link_one() {
  local src="$REPO/$1" dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    log "  ok   $dst"; return
  fi
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    local bak="$BACKUP${dst#"$HOME"}"
    log "  move $dst -> $bak"
    run mkdir -p "$(dirname "$bak")"
    run mv "$dst" "$bak"
  fi
  run mkdir -p "$(dirname "$dst")"
  log "  link $dst -> $src"
  run ln -s "$src" "$dst"
}

check_one() {
  local src="$REPO/$1" dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    log "  ok     $dst"
  elif [ -e "$dst" ]; then
    log "  DRIFT  $dst is a real file/dir, not a link into the repo"
  else
    log "  MISSING $dst"
  fi
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
  for t in jq claude git; do
    if ! command -v "$t" >/dev/null 2>&1; then log "  missing tool: $t"; missing=1; fi
  done
  [ "$missing" = 0 ] || { log "install the missing tools first (brew install jq gh node uv; then the Claude installer)"; exit 1; }
}

case "$MODE" in
  link)
    log "preflight"; preflight
    log "linking (backups go to $BACKUP)"
    while IFS='|' read -r src dst; do link_one "$src" "$dst"; done < <(pairs)
    log "memory"; install_memory
    log "done. Next: ./install.sh plugins, then in claude run /doctor and /reload-skills"
    ;;
  check)
    while IFS='|' read -r src dst; do check_one "$src" "$dst"; done < <(pairs)
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
esac

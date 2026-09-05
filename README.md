# ccsetup

Claude Code configuration, shared across machines. This repo is the source of truth.
`install.sh` links the files into `$HOME`, so an edit on any machine is a commit here.

## Layout

| Repo path | Links to | Notes |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | Global instructions |
| `claude/settings.json` | `~/.claude/settings.json` | Machine-specific `autoMode.environment` is stripped |
| `claude/hooks/` | `~/.claude/hooks/` | Both hooks need `jq` |
| `claude/statusline-command.sh` | `~/.claude/statusline-command.sh` | Needs `jq` |
| `claude/agents/*.md` | `~/.claude/agents/*.md` | `cursor-worker.md` is linked only when `cursor-agent` is on PATH |
| `claude/skills/{park,claim-task}` | `~/.claude/skills/...` | Hand-written skills that live in `~/.claude/skills` |
| `dot-agents/skills/` | `~/.agents/skills/` | Skills installed with the `skills` CLI, plus 4 hand-written ones |
| `dot-agents/.skill-lock.json` | `~/.agents/.skill-lock.json` | Lets `npx skills update` keep working |
| `workspace/colleague-output-style.md` | `~/workspace/colleague-output-style.md` | Referenced by CLAUDE.md |
| `memory/workspace-personal/` | `~/.claude/projects/<slug>/memory/` | Copied once, never overwritten |

Not in the repo on purpose: `~/.claude.json` (login, machine ID), `settings.local.json`,
`task-anchors/`, session history, plugin caches.

## New Mac (about 30 minutes)

1. Tools:

   ```sh
   brew install jq gh node uv
   curl -fsSL https://claude.ai/install.sh | bash
   claude   # log in once, then exit
   ```

2. Clone and link:

   ```sh
   git clone git@github.com:tnptop/ccsetup.git ~/workspace/personal/ccsetup
   cd ~/workspace/personal/ccsetup
   ./install.sh --dry-run   # review
   ./install.sh
   ./install.sh plugins
   ```

3. Verify inside `claude`: run `/doctor`, `/reload-skills`, then send one prompt.
   The statusline and the TASK ANCHOR block in the prompt confirm the hooks work.

## Day to day

- Edit files under `~/.claude` as usual. They are symlinks, so `git status` here shows the change.
- `./install.sh --check` reports any target that stopped being a link (for example after a tool rewrote `settings.json` in place). Re-run `./install.sh` to relink.
- `npx skills update` (in `~`) updates the third-party skills; commit the result.

## Windows

Not wired yet. `docs/2026-07-25-mac-to-windows-sync.md` is the last manual sync.
Changes since then: task-anchor v2 (hook rewrite, `park` and `claim-task` skills, statusline),
CLAUDE.md edits of 2026-08-26, `effortLevel: high`, `tui: fullscreen`, and the skills
`archify`, `show-me`, `thermo-nuclear-code-quality-review`. Plan: an `install.ps1` that mirrors
`install.sh` using junctions, with hooks running under Git Bash.

# ccsetup

This repo is the shared Claude Code setup standard. `install.sh` copies its files into
`$HOME`. Nothing in `$HOME` points back at the repo, so moving or deleting the repo never
breaks Claude. The copy in `$HOME` is allowed to deviate per machine — that's expected.
When a local change should apply on every machine, promote only that path back into the
repo with `./install.sh promote <path>` or the `/promote-to-shared` skill, then review,
commit, and push.

## Layout

| Repo path | Copied to | Notes |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | Global instructions |
| `claude/settings.json` | `~/.claude/settings.json` | Machine-specific `autoMode.environment` is stripped |
| `claude/hooks/` | `~/.claude/hooks/` | Both hooks need `jq` |
| `claude/statusline-command.sh` | `~/.claude/statusline-command.sh` | Needs `jq` |
| `claude/agents/*.md` | `~/.claude/agents/*.md` | All agents are copied |
| `claude/skills/{park,claim-task,promote-to-shared}` | `~/.claude/skills/...` | Hand-written skills that live in `~/.claude/skills` |
| `dot-agents/skills/` | `~/.agents/skills/` | Skills installed with the `skills` CLI, plus 4 hand-written ones. `~/.claude/skills/<name>` gets a relative symlink to each |
| `dot-agents/.skill-lock.json` | `~/.agents/.skill-lock.json` | Lets `npx skills update` keep working |
| `workspace/colleague-output-style.md` | `~/workspace/colleague-output-style.md` | Referenced by CLAUDE.md |
| `memory/<name>/` | `~/.claude/projects/<slug>/memory/` | `workspace` and `workspace-personal` today; `-` in the name means `/` under `$HOME`. Copied once, never overwritten. `sync` does not copy memory back; refresh by hand with `rsync` before a migration |

Not in the repo on purpose: `~/.claude.json` (login, machine ID), `settings.local.json`,
the `autoMode` block of `settings.json` (machine-specific; on the 2026 work Mac it also carries a `soft_deny` list, copy that by hand),
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

- Edit files under `~/.claude` as usual.
- `./install.sh --check` lists files that differ between `~/.claude` and the repo.
- `./install.sh promote <path>...` copies only those paths from `$HOME` into the repo (new files included).
- `./install.sh sync` copies everything from `$HOME` into the repo at once. Use it for a full re-baselining, not for day-to-day sharing — `promote` is for that.
- On the other machine: `git pull`, then `./install.sh`. Files it overwrites are backed up under `~/.claude/backups/ccsetup-<timestamp>/`.
- A full `./install.sh` overwrites this machine's local deviations (backups land under `~/.claude/backups/ccsetup-<timestamp>/`), so after `git pull`, prefer copying single files by hand when this machine has intentional deviations.
- `./install.sh --rollback` restores the newest backup.
- `npx skills update` (in `~`) updates the third-party skills; then `sync` and commit.

`settings.json` is special: the `autoMode` block is machine-specific. `sync` strips it,
`install` keeps whatever the machine already has.

## Windows

Not wired yet. `docs/2026-07-25-mac-to-windows-sync.md` is the last manual sync.
Changes since then: task-anchor v2 (hook rewrite, `park` and `claim-task` skills, statusline),
CLAUDE.md edits of 2026-08-26, `effortLevel: high`, `tui: fullscreen`, and the skills
`archify`, `show-me`, `thermo-nuclear-code-quality-review`. Plan: an `install.ps1` that mirrors
`install.sh` using junctions, with hooks running under Git Bash.

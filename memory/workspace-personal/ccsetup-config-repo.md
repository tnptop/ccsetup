---
name: ccsetup-config-repo
description: "Claude Code config now lives in git repo tnptop/ccsetup (local ~/workspace/personal/ccsetup); new personal Mac is user tnptop on host tnptopmbp, no Cursor; Windows machine still unsynced."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9d6f0999-7746-449f-bd5d-80899aa69b89
  modified: 2026-09-05T08:50:41.219Z
---

On 2026-09-05 the user's Claude Code setup was turned into a git repo: github.com/tnptop/ccsetup (private), local clone at `~/workspace/personal/ccsetup`. `install.sh` is copy-mode by user choice (symlink mode was tried and rolled back on 2026-09-05): `install` copies repo to `$HOME` with backups, `sync` copies `$HOME` back to the repo, plus `--check`, `--dry-run`, `--rollback`, `plugins`. Skipped on purpose: `~/.claude.json`, `settings.local.json`, task-anchors, the work-specific `autoMode` block.

New personal Mac: username `tnptop`, hostname `tnptopmbp`, no Cursor license there (cursor-worker agent is skipped by install.sh when `cursor-agent` is absent).

The Windows machine was last synced by hand on 2026-07-25 and is behind (task-anchor v2, park/claim-task, CLAUDE.md 2026-08-26 edits, new skills). Planned: `install.ps1` in the same repo.

**How to apply:** after editing global Claude config, remind the user to run `./install.sh sync` in the repo, then commit and push. Related: [[shared-claude-setup-with-fluke]].

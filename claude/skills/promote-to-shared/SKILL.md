---
name: promote-to-shared
description: Promote selected parts of the local Claude Code setup (~/.claude, ~/.agents) into the ccsetup shared-standard repo when the user decides a change should apply on every machine. Use when the user says "this should be everywhere", "share this config", "promote to the repo", or "sync this to ccsetup".
argument-hint: "[<path>...]"
---

Repo = `~/workspace/personal/ccsetup`.

## 1. Check the repo

Stop with a message if `~/workspace/personal/ccsetup` is missing.
Run `git -C ~/workspace/personal/ccsetup status --short`.
If it shows existing uncommitted changes, tell the user and ask whether to
continue before touching anything.

## 2. Pick the paths

No arguments: run `./install.sh --check` from the repo. List every `DIFF`
and `MISSING` line. Also list local files with no repo counterpart yet:
- `~/.claude/agents/*.md` not present under `claude/agents/`
- real, non-symlink directories in `~/.claude/skills/` not under `claude/skills/`
- directories in `~/.agents/skills/` not under `dot-agents/skills/`

Ask the user with AskUserQuestion (multiSelect) which of these to promote.
With arguments given: use them as the list, skip the question.

## 3. Review each path for machine-specific content

For each chosen path, show the diff: `diff -u <repo path> <home path>`.
If the repo has no copy yet, say "new file" and show the file head instead.

Ask the user to confirm the content is machine-neutral:
- no machine-specific absolute paths
- no assumptions about which CLIs or subscriptions exist on this machine
- no rules that only make sense for one account

If anything machine-specific shows up, stop. Ask the user to edit the local
file first, before promoting it.

## 4. Promote

Run `./install.sh promote <paths>` from the repo root. Then show:
- `git -C ~/workspace/personal/ccsetup status --short`
- `git -C ~/workspace/personal/ccsetup diff --stat`

## 5. Stage and hand off

Stage only the promoted paths: `git add <paths>`.
Run the `generate-commit-message` skill.
Stop there. The user runs `git commit` and `git push` themselves.

## Rules

- Never run `./install.sh` (repo -> home) or `./install.sh sync` as part of
  this skill.
- Never run `git commit` or `git push`.
- Promote only the paths the user chose.
- `settings.json` is promoted through the script, so `autoMode` is stripped
  automatically. Still show its diff first.

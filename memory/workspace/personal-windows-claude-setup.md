---
name: personal-windows-claude-setup
description: Claude Code setup successfully replicated to personal Windows machine 2026-07-23; skills source of truth is ~/.agents/skills (symlinked)
metadata: 
  node_type: memory
  type: project
  originSessionId: 686cd5e9-1a22-41d8-8aed-844a021bfe53
  modified: 2026-07-23T12:40:28.325Z
---

On 2026-07-23 the user replicated this machine's Claude setup (CLAUDE.md, agents/, hooks/, skills/, settings.json, workspace/colleague-output-style.md) to a personal **Windows** machine (Claude Code desktop UI). Transfer and extraction confirmed working.

Gotcha learned: everything under `~/.claude/skills/` on this machine is a **symlink into `~/.agents/skills/`** — that's the source of truth. Any future packaging/sync must use `tar -h` (dereference) or package from `~/.agents/skills/` directly, or only symlinks get copied.

Remaining destination-side items the user handles themselves: cursor-agent CLI, Codex CLI, new GitHub SSH key (deliberately not reusing this machine's), set `defaultMode: bypassPermissions`, prune work-specific CLAUDE.md bits, verify hooks fire under Git for Windows.

Memory files were deliberately NOT copied — this machine remains the source if any are wanted later.

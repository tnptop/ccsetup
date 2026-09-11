---
name: context-engineering-revamp-2026-07
description: "2026-07-25 setup revamp per Claude 5 context-engineering article — what moved where, and the skill-listing truncation gotcha"
metadata: 
  node_type: memory
  type: project
  originSessionId: a843db9b-44f8-4210-9d5c-1e9b3b2d9d02
  modified: 2026-07-25T03:29:25.471Z
---

2026-07-25 revamp (article: "New Rules of Context Engineering for Claude 5"): CLAUDE.md Orchestration slimmed — routing detail now lives ONLY in `~/.claude/agents/*.md` descriptions (incl. the haiku-override clause in efficient-worker); Blind Spot Pass procedure lives in the `blind-spot-pass` skill with a trigger line in CLAUDE.md. 7 unused skills + figma plugin disabled via `~/.claude/settings.json`.

**Why:** the skill listing has a ~1% context budget; before cleanup it truncated 9 of 16 enabled user skills out of routing. Figma plugin alone cost ~2k est. resident tokens.

**How to apply:** when adding skills/plugins, watch for enabled skills missing from the session listing — that's budget truncation, fix by disabling unused items or shortening descriptions. Re-enable figma via `/plugin` when Figma work returns. Windows sync spec: `~/workspace/claude-setup-sync-2026-07-25.md`. Related: [[haiku-routing-rationale]], [[personal-windows-claude-setup]].

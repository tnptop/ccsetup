---
name: project-detection-via-claude-sessions
description: "Feedback 2026-08-03 — detect projects from Claude session cwds (leaf nodes), not directory-depth heuristics"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1b108b2a-f8fb-4472-bf61-54e66922c83e
  modified: 2026-08-03T07:25:07.625Z
---

When enumerating the user's projects, use Claude session locations (`~/.claude/projects/*/`) as ground truth, not a fixed-depth directory walk.

**Why:** real project leaves sit at varying depths (`tripetch/skynet/dealer-agent`, `scooby-doo/backend/msc-service-v2`); any depth heuristic lumps subtrees into fake projects or splits real ones. A session cwd is a place the user actually worked.

**How to apply:** resolve each slug dir via `sessions-index.json` `projectPath` (preferred), else `"cwd"` in the newest `*.jsonl`, else decode the slug by matching against existing filesystem paths (dashes are ambiguous — never decode blindly). A session path with descendant session paths is meta/hub, not a leaf ([[deferred-meta-work-audit-line]]). Used by [[workspace-project-dashboard]].

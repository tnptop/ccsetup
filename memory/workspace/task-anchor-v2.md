---
name: task-anchor-v2
description: Multi-session task anchors (index + per-task files, 4h lease, /claim-task, /park v2) built 2026-08-22; layout and conventions
metadata:
  type: project
---

Task anchor v2 shipped 2026-08-22. Layout: `~/.claude/task-anchors/<cwd-slug>/INDEX.md` + `<task-slug>.md` per task (line 1 `STATE <date> | ACTIVE|PARKED|CLOSED | next: ... | step N/M`, optional `owner:`/`heartbeat:`/`worktree:`). Claim = owner + heartbeat; lease 4h (morning/afternoon halves). Atomic claim via `mkdir <slug>.lock`. Spec: `~/workspace/task-anchor-v2-spec.md`.

Pieces: hook `~/.claude/hooks/task-anchor.sh` (owned → inject that file, refresh heartbeat; unowned → inject index with free/stale/claimed rows; legacy flat file → v1 behaviour), skill `/claim-task` (model-invocable; no-arg → AskUserQuestion picker; `steal` only with user confirmation), `/park` (releases claim on every flavor, maintains INDEX).

**Why:** one anchor per folder blocked concurrent sessions on different tasks.
**How to apply:** other projects still on v1 flat files migrate on their first `/claim-task` there. Environment (worktrees) stays the user's responsibility — suggest only. Session id = newest `<uuid>.jsonl` under `~/.claude/projects/<cwd-slug>/`. Related: [[workspace-project-dashboard]].

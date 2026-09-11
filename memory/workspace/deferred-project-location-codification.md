---
name: deferred-project-location-codification
description: "Open thread deferred 2026-07-22: codify where projects and Claude sessions live on disk (feeds the meta/object work classifier)"
metadata: 
  node_type: memory
  type: project
  originSessionId: ee75009f-a3a3-430e-b24d-f102f4a789e9
  modified: 2026-07-22T14:12:53.364Z
---

Deferred on 2026-07-22, to be pulled up in its own session when the user asks about organizing project locations.

**Goal:** define and enforce a directory taxonomy under `~/workspace` so project location becomes a declared label rather than an inferred signal — primarily to strengthen the deterministic meta/object work classifier planned for the Friday audit (see [[deferred-colleague-output-style-discussion]] for the sibling SWOT thread).

**Current state (2026-07-22):** ad hoc — `~/workspace/tripetch/**` (work, mostly Skynet repos), `~/workspace/personal/**`, plus loose sessions at the `~/workspace` root and `~` where meta-work tends to happen. The user's usage tracker lives under `tripetch/token-usage/` despite being meta by nature — an example misfiling to resolve.

**Open questions for that session:** the taxonomy itself (work / personal / meta as top level? where do scratch experiments and one-off analyses go?); how worktrees inherit classification; whether to enforce with a SessionStart hook that warns when cwd is outside a codified root.

**Decided 2026-07-22:** the user plans to migrate existing sessions and project folders once the taxonomy is codified (not grandfathering) — migration mechanics are deliberately out of scope until the codification work actually starts.

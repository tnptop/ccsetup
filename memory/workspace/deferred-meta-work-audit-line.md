---
name: deferred-meta-work-audit-line
description: "Open thread deferred 2026-07-22: add a meta-vs-object work line to the Friday weekly audit, backed by a deterministic session classifier"
metadata: 
  node_type: memory
  type: project
  originSessionId: ee75009f-a3a3-430e-b24d-f102f4a789e9
  modified: 2026-07-22T14:14:30.639Z
---

Deferred on 2026-07-22, to be pulled up in its own session when the user asks about the meta-work audit line or classifier.

**Goal:** make meta-work spend visible instead of felt — one line in the Friday weekly audit (runs at the subscription reset, Friday 7 PM local): time/tokens on meta-work (changing how the user works: config, skills, hooks, memory, trackers) vs object-work (changing what they ship). This mitigates the "meta-work gravity" weakness from the 2026-07-22 SWOT over session history.

**Agreed design (2026-07-22):** deterministic classifier over session transcripts in `~/.claude/projects/*/`, no LLM judgment. Ordered rules, counting only: (1) majority of tool calls touching meta-paths (`~/.claude/**`, `**/CLAUDE.md`, `.claude/agents|hooks|skills/**`, memory dir) → meta; (2) any company marker (`SKYN-\d+`, Atlassian MCP calls, work GitLab remote) or majority object-path touches → object; (3) neither → unclassified — refuse to guess; acceptable if <~10% of sessions. Validate by hand-labeling ~20 sessions before trusting the number. Natural home: the user's existing ccusage-based usage tracker (join on session ID, one new column).

**Dependency, not blocker:** [[deferred-project-location-codification]] (thread #2) will promote project location to the primary declarative signal and shrink the unclassified bucket — but a rough split from current signals (files-touched + company markers) is useful immediately; don't wait for codification.

Sibling SWOT thread: [[deferred-colleague-output-style-discussion]].

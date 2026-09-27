---
name: opus-pin-for-delegated-work
description: "User pins delegated Opus-tier work (deep-rational-thinker, claude-implementer-opus) to the explicit id claude-opus-5-5 since 2026-09-23; before that claude-opus-4-8 over Opus 5. Always pin an explicit id, never the opus alias."
metadata:
  node_type: memory
  type: user
  originSessionId: db40e345-239d-4968-9284-07062f812d68
  modified: 2026-09-23T02:10:55.162Z
---

On 2026-09-22 the user pinned `model: claude-opus-4-8` in agent frontmatter as a deliberate choice: they preferred Opus 4.8's work over Opus 5 at the same price and planned to re-evaluate at the next Opus release. Opus 5.5 (`claude-opus-5-5`, $4/$20 per MTok vs $5/$25 for 4.8) shipped on 2026-09-22, and on 2026-09-23 the user moved both pins to `claude-opus-5-5`.

**Why:** an explicit id keeps subagent behaviour stable across Claude Code's alias updates; the user wants to choose each model upgrade themselves.

**How to apply:** when creating or editing agents that need an Opus-tier model, pin `claude-opus-5-5` explicitly; do not use the `opus` alias and do not swap models without asking. Opus 5.5 notes: thinking cannot be disabled and default effort is medium. Related: [[ccsetup-config-repo]], [[cursor-worker-retirement]].

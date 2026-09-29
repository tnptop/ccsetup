---
name: cursor-worker-retirement
description: cursor-worker agent retired 2026-09-22 because the Claude Code auto-mode classifier denied ~1 in 3 headless cursor-agent launches; replaced by a two-tier claude-implementer (sonnet) + claude-implementer-opus (claude-opus-5-5); opus is the default route since 2026-09-28.
metadata:
  type: project
---

On 2026-09-22 the user retired the cursor-worker agent. Transcript analysis of 76 runs (2026-09-15 to 2026-09-22) showed the auto-mode classifier denying about 1 in 3 `cursor-agent -p` launches with reasons `[Create Unsafe Agents]` and `Blocked by classifier`; dropping `--force`, adding `--trust`, and a `Bash(cursor-agent:*)` allow rule did not change the rate. Docs confirm the classifier only exists in auto mode, allow rules do not bypass it there, and subagent frontmatter cannot change permission mode. Codex launches under a read-only sandbox were never denied.

Replacement: `claude-implementer` (sonnet) and `claude-implementer-opus` (pinned `claude-opus-5-5`). Sonnet was the default route until 2026-09-28. Since 2026-09-28 Opus is the default route and sonnet takes only small changes (at most 2 files, no port, no refactor); the user chose this after a 29-minute sonnet port run, as an experiment to measure over the next runs. CLAUDE.md sibling route is claude-implementer ↔ claude-implementer-opus.

**Why:** headless external agents with auto-approval are exactly what the classifier is built to stop; the honest alternative (switching permission mode before each spawn) was too much friction.

**How to apply:** do not propose cursor-agent as a subagent again while auto mode is the default. If Cursor is ever wanted for a second implementation opinion, use `--mode plan` (read-only), which the classifier passes. Related: [[opus-pin-for-delegated-work]], [[ccsetup-config-repo]].

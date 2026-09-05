# Claude setup sync — 2026-07-25 (Mac → Windows, manual)

Changes from the context-engineering revamp (article: "The New Rules of Context Engineering for Claude 5 Generation Models") plus `/doctor` cleanup. Apply each to the Windows machine, adjusting paths to its layout. On the Mac, skills physically live in `~/.agents/skills/` with symlinks from `~/.claude/skills/`.

## 1. `~/.claude/settings.json` — disable unused skills + Figma plugin

Why: skill listing was over its ~1% context budget; 9 enabled skills were truncated out of Claude's routing. These items had zero or stale use in a 25-day / 50-session window.

Add to `skillOverrides` (merge with existing entries):

```json
"to-spec": "off",
"to-tickets": "off",
"wayfinder": "off",
"grill-me": "off",
"grill-with-docs": "off",
"setup-matt-pocock-skills": "off",
"improve": "off"
```

Change in `enabledPlugins`:

```json
"figma@claude-plugins-official": false
```

Note: `grill-me` / `grill-with-docs` were 3-line launchers for `/grilling`, which is untouched and self-contained.

## 2. `~/.claude/agents/efficient-worker.md` — description line

Two changes: stale `composer-worker` → `cursor-worker`, and the haiku-override clause moved here from CLAUDE.md (rule now lives where the spawn decision is made).

Before:

```
description: Use for formatting, extraction, uploads, renumbering, batches of ≥5 homogeneous operations, and tests-only additions that follow existing patterns. Production code plus its tests goes to composer-worker. Execute efficiently.
```

After:

```
description: Use for formatting, extraction, uploads, renumbering, batches of ≥5 homogeneous operations, and tests-only additions that follow existing patterns. Production code plus its tests goes to cursor-worker. Runs on sonnet; override the spawn to haiku only when the spec is exact (literal strings or schema given, zero judgment) and verification is mechanical. Execute efficiently.
```

## 3. `~/.claude/agents/claude-implementer.md` — description line

One word, end of the description:

```
Sibling of composer-worker.  →  Sibling of cursor-worker.
```

## 4. `~/.claude/CLAUDE.md` — two sections replaced

### 4a. Blind Spot Pass (procedure moved to a skill; trigger stays resident)

Before:

```
# Blind Spot Pass

Before working in a technology or high-stakes subject domain (money, personal or regulated data, security and cryptography, legal, time zones and i18n, irreversible operations) that is absent from the repo, the conversation, and memory: list at most 5 unknown unknowns, mark which are load-bearing, and resolve those with me before implementing.

To skip the pass, verify my familiarity first — an explicit statement in the conversation or in memory, or ask. Absence of evidence is not familiarity. Record stated familiarity in my persistent memory, never in project files. A grill session covers the pass for its topic.
```

After:

```
# Blind Spot Pass

Before implementing in a technology or high-stakes subject domain (money, regulated data, security/crypto, legal, time zones/i18n, irreversible operations) that is absent from the repo, the conversation, and memory: load the `blind-spot-pass` skill and run it. Verified familiarity or a grill session on the topic skips it — absence of evidence is not familiarity.
```

### 4b. Orchestration (routing table cut — it duplicated the agent descriptions; rituals cut — trusted to judgment)

Before: the full section with the four-bullet routing table, "state the cap check" clause, standalone compaction/unavailable-worker lines, and the three-condition spot-check paragraph.

After (full replacement text):

```
# Orchestration

Main conversation only; subagents follow their own task instructions.

Plan, delegate, synthesize. Direct implementation is capped at 2 files / ~50 lines per task; beyond the cap — and for everything delegable after the first context compaction — delegate. Route by the agent descriptions; never spawn a default agent when a named route fits. If a routed worker is unavailable, say so and ask — never silently implement directly.

High-stakes (compliance, security, data-loss, money, or ≥3 modules): run 2 independent `deep-rational-thinker` agents in parallel, never shown each other's answers; synthesize.

Verification: delegated work stays unverified until checked against an oracle the worker didn't produce — the strongest the artifact affords (repo verify gate; else empirical reconciliation against inputs or a live source; else run/render and inspect; when only human judgment can accept, present the evidence and ask). Downgrade to a spot check only for reversible, non-production work that stays on my machine — any spot-check error escalates back to full. A worker's "done" is a claim, not evidence.
```

Net: 5,702 → 4,115 chars. Nothing lost — routing criteria live in the agent descriptions (verified each carries its rules); the haiku clause is in efficient-worker.md; the pass procedure is in the skill.

## 5. New skill: `blind-spot-pass`

Real file at `~/.agents/skills/blind-spot-pass/SKILL.md`, symlink at `~/.claude/skills/blind-spot-pass` (Mac layout — mirror however Windows wires skills). Full content:

```
---
name: blind-spot-pass
description: Pre-implementation unknown-unknowns check. Load BEFORE implementing in a technology or high-stakes subject domain (money, personal or regulated data, security and cryptography, legal, time zones and i18n, irreversible operations) that is absent from the repo, the conversation, and memory.
---

# Blind Spot Pass

Before implementing in an unfamiliar technology or high-stakes subject domain:

1. List at most 5 unknown unknowns for this task.
2. Mark which are load-bearing (a wrong guess breaks correctness, safety, money, or compliance).
3. Resolve the load-bearing ones with me before implementing.

Skipping the pass:

- Verify my familiarity first — an explicit statement in the conversation or in memory, or ask. Absence of evidence is not familiarity.
- Record stated familiarity in my persistent memory, never in project files.
- A grill session covers the pass for its topic.
```

## 6. Non-file steps (done on Mac; repeat on Windows if wanted)

- `/mcp` → Gmail connector disabled (zero use in 25 days; per-project toggle).
- Shell alias `claude --dangerously-skip-permissions` — being removed on Mac; check whether Windows has an equivalent (auto mode is already the default in settings, which travels with settings.json).
- After syncing: run `/reload-skills` and confirm `blind-spot-pass`, `handoff`, and `teach` appear in the listing.

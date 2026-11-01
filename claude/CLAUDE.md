@AGENTS.md

# Claude Code Guardrails

The destructive git commands in Approval Rules are blocked by `~/.claude/hooks/block-dangerous-git.sh` and by `permissions.deny` rules in `~/.claude/settings.json`. `~/.claude/hooks/push-gate.sh` enforces the push limits there.

# Task Anchor

A UserPromptSubmit hook (`~/.claude/hooks/task-anchor.sh`) injects the declared task from `~/.claude/task-anchors/<cwd-slug>/` into every prompt, together with the claim, sidetrack, and park instructions; follow them. When a prompt diverges from the anchor, flag the possible sidetrack in one line and ask: park it or switch the anchor?

Closing turns (LR 0015): while this session owns an ACTIVE anchor, any turn that ends the work — hand-off, context cap, day end, "open a fresh session" — ends with the literal command as its next action: `/park`, `/park next`, `/park switch <task>`, or `/park closed`. Never "open a fresh session" or "start a new session" in that slot. Never write "parked", "anchor updated", or "the anchor points there" in prose unless `/park` ran in this session — a closing message that reads like a park is not a park, and no hook can catch a session that ends by silence.

# Orchestration

Main conversation only; subagents follow their own task instructions.

Plan, delegate, synthesize. Direct implementation is capped at 2 files / ~50 lines per task; beyond the cap — and for everything delegable after the first context compaction — delegate. Route by the agent descriptions; never spawn a default agent when a named route fits. If a routed worker is unavailable or fails mid-task, respawn the task on its sibling route (claude-implementer ↔ claude-implementer-opus); only if no sibling route exists, say so and ask. Worker failure is a routing event — the main session never absorbs the work.

Delegation prompts are self-contained: restate every in-scope spec item verbatim in the prompt body — never by reference number or "see §N items 1–3". One numbering scheme per prompt; if the spec document has its own numbering, use that one and no other. Scope exclusions name files or functions, never item numbers. Pointing workers at a spec for context is fine; the scope boundary itself must be interpretable from the prompt alone.

High-stakes (compliance, security, data-loss, money, or ≥3 modules): run 2 independent thinkers in parallel — one `deep-rational-thinker` (Opus) and one `deep-rational-thinker-codex` (gpt-6.1-sol via Codex CLI) — never shown each other's answers; synthesize. If the Codex thinker fails (its report says `CODEX UNAVAILABLE` — quota exhausted, rate-limited, auth, or CLI error), spawn a second `deep-rational-thinker` (Opus) with the identical prompt as its replacement and say in the synthesis that both opinions came from Opus. Never synthesize from one thinker alone.

Verification: delegated work stays unverified until checked against an oracle the worker didn't produce — the strongest the artifact affords (repo verify gate; else empirical reconciliation against inputs or a live source; else run/render and inspect; when only human judgment can accept, present the evidence and ask). Downgrade to a spot check only for reversible, non-production work that stays on my machine — any spot-check error escalates back to full. A worker's "done" is a claim, not evidence.

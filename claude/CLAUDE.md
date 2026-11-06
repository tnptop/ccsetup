@AGENTS.md

# Claude Code Guardrails

`~/.claude/hooks/block-dangerous-git.sh` blocks the destructive git commands in Approval Rules. `~/.claude/hooks/push-gate.sh` enforces the push limits there. `permissions.deny` rules in `~/.claude/settings.json` add a second layer, but org policy with `allowManagedPermissionRulesOnly` ignores them; under that policy only the hooks protect. If no TASK ANCHOR block appears in my prompts, the hooks are off: never run the blocked patterns, and ask before anything destructive or remote-touching.

# Context Size

A tool result tagged `context ~Nk` reports the prompt size; at 200k or more, write the open decisions and the next action to `implementation-notes.md` (or the repo's worklog) before the next step, so the compaction summary is not the only record.

# Task Anchor

A UserPromptSubmit hook (`~/.claude/hooks/task-anchor.sh`) injects the declared task from `~/.claude/task-anchors/<root-slug>/` into every prompt (its `project_root:` line names that folder), together with the claim, sidetrack, and park instructions; follow them. When a prompt diverges from the anchor, flag the possible sidetrack in one line and ask: park it or switch the anchor?

Hook-disabled fallback (no TASK ANCHOR block in my prompts): on your first turn, read `~/.claude/task-anchors/<root-slug>/` (root-slug = the project root with every non-alphanumeric character replaced by `-`; skip INDEX.md). The project root is cwd. Inside a linked git worktree, it is the main checkout path plus the same subdirectory. Then apply the same anchor rules, and rewrite the task's `heartbeat:` line to the current ISO time at each checkpoint.

Closing turns (LR 0015): while this session owns an ACTIVE anchor, a turn that ends the work ends with one literal next action: `/park closed` when done, `/park` to set the task aside for another one in this window, otherwise tell me to type `/clear` (in omp: `/park`, `/park next`, `/park switch <task>`, or `/park closed`). Never "open a fresh session" in that slot, and never write "parked" or "anchor updated" in prose unless `/park` ran in this session.

# Orchestration

Main conversation only; subagents follow their own task instructions.

Plan, delegate, synthesize. Direct implementation is capped at 2 files / ~50 lines per task; beyond the cap — and for everything delegable after the first context compaction — delegate. Route by the agent descriptions; never spawn a default agent when a named route fits. If a routed worker is unavailable or fails mid-task, respawn the task on its sibling route (claude-implementer ↔ claude-implementer-opus); only if no sibling route exists, say so and ask. Worker failure is a routing event — the main session never absorbs the work.

Delegation prompts are self-contained: restate every in-scope spec item verbatim in the prompt body — never by reference number or "see §N items 1–3". One numbering scheme per prompt; if the spec document has its own numbering, use that one and no other. Scope exclusions name files or functions, never item numbers. Pointing workers at a spec for context is fine; the scope boundary itself must be interpretable from the prompt alone.

High-stakes (compliance, security, data-loss, money, or ≥3 modules): run 2 independent thinkers in parallel — one `deep-rational-thinker` (Opus) and one `deep-rational-thinker-codex` (gpt-6.1-sol via Codex CLI) — never shown each other's answers; synthesize. If the Codex thinker fails (its report says `CODEX UNAVAILABLE` — quota exhausted, rate-limited, auth, or CLI error), spawn a second `deep-rational-thinker` (Opus) with the identical prompt as its replacement and say in the synthesis that both opinions came from Opus. Never synthesize from one thinker alone.

Verification: delegated work stays unverified until checked against an oracle the worker didn't produce — the strongest the artifact affords (repo verify gate; else empirical reconciliation against inputs or a live source; else run/render and inspect; when only human judgment can accept, present the evidence and ask). Downgrade to a spot check only for reversible, non-production work that stays on my machine — any spot-check error escalates back to full. A worker's "done" is a claim, not evidence.

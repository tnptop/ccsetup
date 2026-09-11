---
name: haiku-routing-rationale
description: "Why efficient-worker's haiku override is criterion-gated and phrased default-first (cost analysis, 2026-07-21)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f812f8d-9cea-4d67-a9f0-7deac77f3128
  modified: 2026-07-22T12:52:39.841Z
---

The CLAUDE.md rule "efficient-worker runs on sonnet; override the spawn to haiku only when the spec is exact and verification is mechanical" came from a cost analysis, not a target routing rate.

**Why:** Haiku is ~3× cheaper than Sonnet per identical task (~$0.07 vs ~$0.20 for a typical ~40k-token exact-spec batch edit), but efficient-worker is a minority of fleet spend — the Fable orchestrator and Opus deep-rational-thinker dominate — so even 75% routing saves only ~5–10% fleet-wide. Retry break-even tolerates ~65% Haiku failure on pure task cost, but drops to ~25–30% once the Fable orchestrator's re-dispatch overhead (~$0.15/failure) counts. So only near-zero-failure tasks (exact spec, mechanical verification) should downgrade. Sonnet's intro pricing (through 2026-08-31) halves the savings until then.

**How to apply:** Never target a haiku percentage — the criterion sets the rate (~30–50% of efficient-worker volume naturally). Phrase routing rules default-first ("runs on sonnet; override only when…"), never exception-first: the user confirmed this ordering because the first clause dominates under skimming (fails safe to sonnet) and a salient exception-first clause overtriggers the downgrade. The default-first preference generalizes to any rule written for this user.

Confirmed generalized 2026-07-22: the CLAUDE.md verification dial (full oracle by default; spot check only when reversible + not prod + not leaving the machine) was deliberately phrased the same way — the user caught an exception-first draft and asked for the haiku-style ordering. Pattern for this user: safe tier is the unmarked default, cheap tier is a criterion-gated downgrade with an escalate-on-error clause.

---
name: critique-plan-implementation
description: Review an implementation against a plan document. Use when Codex needs to critique, audit, or find bugs and pitfalls in work described by a plan file and implemented in a repository, especially when the user asks for evidence-backed findings with code snippets, exact locations, severity, impact, and recommendations.
---

# Critique Plan Implementation

## Review Posture

Work in read-only mode unless the user explicitly asks for fixes. Treat the task as a code review against a written plan: verify claims from source artifacts, prioritize behavioral risks, and ground every finding in exact code.

Prefer narrow, concrete findings over broad commentary. Do not trust completed checklist items until the implementation and verification artifacts support them.

## Workflow

1. Read the plan.
   - Extract the stated goal, files in scope, out-of-scope boundaries, validation strategy, and execution checklist.
   - Note any explicit invariants, fallback rules, migration constraints, or "do not change" requirements.
   - Identify what behavior the implementation is supposed to preserve.

2. Inspect the repo state.
   - Run read-only commands such as `git status --short`, `git branch --show-current`, `git diff --stat`, `git diff`, and `rg`.
   - Compare against the intended base branch when it is clear from local context.
   - Read the changed files named by the plan before judging the design.

3. Trace runtime paths.
   - Find public callers, validation paths, tests, scripts, docs, and operational entrypoints that touch the changed behavior.
   - Check both direct unit-level behavior and pipeline-level behavior.
   - Look for places where a helper is correct in isolation but used too early, too late, or with different inputs in production.

4. Compare intent to implementation.
   - Look for false rejects, false accepts, silent data loss, stale documentation, brittle parsing, shared-oracle assumptions, validation blind spots, missing cleanup, and behavior that contradicts the plan's scope.
   - Treat parity with a reference implementation as useful but insufficient when the reference can share the same flawed assumption as the new code.
   - Distinguish confirmed bugs from plausible risks. Use lower severity for risks that require upstream drift or unusual inputs.

5. Verify selectively.
   - Prefer lightweight read-only evidence first.
   - Run tests or scripts only when allowed by the repo instructions and user approval context.
   - If a command is skipped because it may modify state, say so in the final review.

6. Write the critique.
   - Put findings first, ordered by severity.
   - For each finding, include severity, title, exact file location, minimal code snippet, failure mode, impact, and narrow recommendation.
   - After findings, add brief notes on what was checked, assumptions, and commands not run.

## Severity Guide

- `P0`: Critical data loss, security issue, or production outage is likely.
- `P1`: High-confidence bug that breaks a main workflow or corrupts important behavior.
- `P2`: Real bug or strong pitfall affecting important edge cases, validation, data quality, or maintainability.
- `P3`: Lower-risk issue, verifier gap, brittle assumption, stale doc, or future drift concern.

## Evidence Rules

- Include file links with line numbers for every finding.
- Keep snippets small: only the lines needed to prove the point.
- Explain why the snippet is wrong in this implementation, not just why it could be improved.
- Avoid style-only findings unless they can hide or cause a behavioral problem.
- If no issues are found, say that clearly and mention remaining test gaps or residual risk.

## Output Template

Use the template in [references/finding-template.md](references/finding-template.md) when the user wants a detailed critique with embedded snippets. For shorter reviews, keep the same fields but compress the prose.

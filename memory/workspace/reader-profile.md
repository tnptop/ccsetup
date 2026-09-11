---
name: reader-profile
description: "How to write for this user (ADHD, fatigue from long text) and for their Thai L2 colleagues"
metadata: 
  node_type: memory
  type: user
  originSessionId: eb99f1d5-0d91-47af-bb7e-64f0afdedb7c
  modified: 2026-07-21T13:24:34.518Z
---

The user is fluent in English (immersed most of their life) and has ADHD; long dense responses cause reading fatigue. Their global CLAUDE.md Output Style + the `i-have-adhd` skill encode the rules: answer first, short paragraphs, headers, skimmable emphasis.

Their colleagues are primarily Thai L2 English readers. Text meant for colleagues follows the STE-flavored rules in `~/workspace/colleague-output-style.md`: common words, no idioms/phrasal verbs, one term per concept, depth via structure not dense wording.

The action-shaping rules are distilled directly in CLAUDE.md Output Style (always on); the `i-have-adhd` skill is now reference depth for long/complex responses only.

**Verified familiarity** (for the Blind Spot Pass): Facebook ads compliance domain — the user runs the DMC UAT/calibration loop for fb-ads-improvement, works the Meta Graph API pipeline, and writes judge prompts in Thai (evidenced 2026-07-21 from the "v1.6 Rules UAT with DMC" session).

Context: the old ASD-STE100 rule and the original i-have-adhd skill setup were deliberate tests by the user (2026-07-21 session). The user validates config changes by observing whether responses actually get easier to parse.

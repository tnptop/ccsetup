---
name: codex-cli-gpt6-astra-bridge
description: deep-rational-thinker-codex is a Codex CLI bridge (gpt-6-astra, effort high, read-only) run in parallel with the Opus deep-rational-thinker; Codex version and sandbox gotchas
metadata:
  type: project
---

Since 2026-09-08 `~/.claude/agents/deep-rational-thinker-codex.md` delegates to OpenAI Codex CLI (`codex exec -m gpt-6-astra -c model_reasoning_effort="high" -s read-only`). It is an independent PEER of the unchanged Opus `deep-rational-thinker`, not a replacement: the user wants both run in parallel for a second opinion (see [[ccsetup-config-repo]]).

**Why:** user asked for "another agent in parallel, not replacing Opus with astra"; Codex CLI and ChatGPT app are installed and logged in via ChatGPT.

**How to apply:**
- `gpt-6-astra` needs codex-cli >= 0.153. Global npm package under nvm was upgraded 0.144.6 -> 0.153.4; fallback binary: `/Applications/ChatGPT.app/Contents/Resources/codex`.
- `codex exec resume` accepts neither `-s` nor `--color`; pass `-c sandbox_mode="read-only"` or it silently uses config default `danger-full-access`.
- `~/.codex/config.toml` already defaults model gpt-6-astra / effort high / sandbox danger-full-access; figma MCP throws auth noise, disable via `-c mcp_servers.figma.enabled=false`.
- Agent files are not yet in the ccsetup repo; sync when convenient.
- CLAUDE.md high-stakes rule (2026-09-08): pair = Opus `deep-rational-thinker` + `deep-rational-thinker-codex`; on `CODEX UNAVAILABLE` (quota etc.) fallback = second Opus thinker, same prompt, disclosed in synthesis.

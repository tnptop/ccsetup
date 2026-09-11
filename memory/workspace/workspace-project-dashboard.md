---
name: workspace-project-dashboard
description: v1 workspace dashboard built 2026-08-03 at ~/workspace/tools/project-dashboard; chosen over Obsidian; v1.1 tweak list open
metadata: 
  node_type: memory
  type: project
  originSessionId: 1b108b2a-f8fb-4472-bf61-54e66922c83e
  modified: 2026-08-18T15:07:57.208Z
---

Built 2026-08-03: `python3 ~/workspace/tools/project-dashboard/scan.py` regenerates `dashboard.html` (graph + list view of all workspace projects; status = active/aging/dormant by git+mtime recency; manual edges/stages via `links.json`).

Decision: auto-generated dashboard chosen over Obsidian — user's mental image was a word-cloud-with-edges, but manual note upkeep would decay; graph view satisfies the image with derived data. Related: [[deferred-project-location-codification]] — the scanner's project-detection rule is a hardcoded guess pending that taxonomy.

v1.1 (2026-08-03, user feedback): detection reworked to Claude-session cwds per [[project-detection-via-claude-sessions]]. v1.2 (same day): Codex CLI rollouts added as second source (~/.codex/sessions + archived_sessions, first-line `payload.cwd`; worktree cwds under ~/.codex/worktrees/<id>/<name> attributed by unique basename), separate Claude/Codex counts in list+tooltip, graph fills viewport. 39 projects (18 session, 21 disk-only). Remaining quirk: center labels overlap until zoomed/panned; cleaned Claude JSONLs make some old projects show claude=0 (wakatime heartbeats deliberately uncounted).

v1.3 (2026-08-18): force-layout spread done — labels no longer clump at center (collision radius covers label width, viewport-scaled charge, weak forceX/forceY). Implemented by Cursor Grok 4.6 Fast via cursor-worker; minor leftovers: topmost node can clip viewport edge, 2-3 label pairs still touch. Remaining candidates (parked, none chosen): distinct visual state for once-had-sessions-now-cleaned projects (mcp-bridge, magic-mirror-be) vs never-touched disk repos; user hasn't written links.json yet (manual edges/stages unused); revisit detection rule once [[deferred-project-location-codification]] settles. Full decision log: ~/workspace/tools/project-dashboard/implementation-notes.md.

Verification note: headless rendering via `/Applications/Helium.app/Contents/MacOS/Helium --headless=new --screenshot=...` works well for checking local HTML (user's default browser is Zen; Chrome extension was not connected).

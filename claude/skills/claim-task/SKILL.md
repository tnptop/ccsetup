---
name: claim-task
description: Claim a task anchor for this session (claim existing / create new / steal with confirmation). The model may invoke this when the hook's TASK ANCHOR INDEX says no task is claimed.
argument-hint: "[<slug> | new \"<task text>\" | steal <slug>]"
---

Arg = first token: none → pick from INDEX, `<slug>` → claim if free, `new "<task text>"` → create then claim, `steal <slug>` → overwrite lease after confirmation. Model may invoke none / `<slug>` / `new` on its own; `steal` never without the user saying so.

## 1. Paths
cwd-slug = cwd with every non-alphanumeric char replaced by `-`.
Dir = `~/.claude/task-anchors/<cwd-slug>/`.
- `INDEX.md` rows: `- <task-slug> | <ACTIVE|PARKED> | next: <one action>`
- `<task-slug>.md` line 1 (hook parses it; `step` field only when a plan file gives a denominator):
  `STATE <ISO date> | <ACTIVE|PARKED|CLOSED> | next: <one action> | step <N/M>`
  Lines 2+: prose, ≤ 800 chars. Optional lines: `owner: <session_id>`, `heartbeat: <ISO datetime with timezone offset>`, `worktree: <path>`.
- Session id = the value on the `session_id:` line that the task-anchor hook injects into every prompt (inside the TASK ANCHOR block). Use it verbatim. Fallback only when no such line exists in this prompt (hook disabled): read the newest file under `~/.claude/projects/<cwd-slug>/` whose name matches `<uuid>.jsonl` and use that uuid; if two such files were modified within the last 5 minutes, ask the user which session this is instead of guessing.

## 2. Migration
Run before argument handling.
- Dir missing, legacy flat file `~/.claude/task-anchors/<cwd-slug>.md` exists: create the dir, move that file's content as-is to `<dir>/<slug-derived-from-its-first-task-words>.md` (first 5 words of the task text / `next:` field → kebab-case `a-z0-9-`), create `INDEX.md` with one row for it (`- <slug> | <status from STATE> | next: <...>`), then continue.
- Neither dir nor legacy file: `mkdir -p` the dir and write an empty `INDEX.md`.

## 3. Lease
Live-claimed = has an `owner:` line AND a `heartbeat:` line less than 4 hours old (whole hours, same rule as the hook). Otherwise free (no owner, or heartbeat stale/missing). Age label: first 8 chars of owner, `<N>h ago`.

## 4. No argument
AskUserQuestion. Options = INDEX rows, newest first by STATE date, max 3 shown. Label each `<slug> — <status> — next: <...>`. Live-claimed rows append `claimed by <owner first 8 chars>, <N>h ago`. Always include an Other / free-text option so the user can type a slug or new task text.
- Choosing a live-claimed row = explicit steal confirmation → §7.
- Choosing a free/stale row (or this session already owns it) → §5.
- Typed slug → §5; typed new task text → §6.
- More than 3 rows total: a second AskUserQuestion with the rest, or accept free text instead.
Empty INDEX: skip the list; Other / new-text only.

## 5. `<slug>` argument
If the task is live-claimed by a **different** session: do NOT claim it. Print the owner (first 8 chars) and the age, and ask whether to steal it or create a new task instead.
Else (free, stale, or already owned by this session): run §8 Claim write, then set that task's INDEX.md row status to ACTIVE:
`sed -i '' "s/^- ${slug} | [A-Z]* | /- ${slug} | ACTIVE | /" "$dir/INDEX.md"`
(GNU sed: drop the `''` after `-i`, same `if sed --version` branch as §8.)

## 6. `new "<task text>"` argument
Derive a kebab-case slug from the text: first 5 words, lowercase, characters `a-z0-9-` only (other chars → `-`, collapse repeats). If `<dir>/<slug>.md` already exists, append `-2`, `-3`, … until unique.

**Lane check** (runs before the task file is written):
a. Check every OTHER row in INDEX.md: live-claimed = has an `owner:` line AND a `heartbeat:` line less than 4 hours old (whole hours, same rule as the hook).
b. None live-claimed: proceed as today, no question.
c. At least one live-claimed: ask the user ONE question naming the live task(s) (slug + age), with three options: "sandbox lane (review: session stays here, worktree at ../<repo>-<slug>)", "feature lane (EnterWorktree, session moves into .claude/worktrees/<slug>)", "no lane".
d. Sandbox lane: `<ref>` = a branch, MR head, or commit the task text names; if it names none, ask the user for `<ref>` (default `origin/main` after `git fetch`). repo-basename = `basename "$(git rev-parse --show-toplevel)"`. Run `git worktree add --detach ../<repo-basename>-<slug> <ref>`. Once the task file below exists, add the line `worktree: <absolute path>` to it, after any `owner:`/`heartbeat:` lines. Continue the claim in the current cwd's anchor dir.
e. Feature lane: call `EnterWorktree(name=<slug>)`. Do the task file write, INDEX.md row, and §8 Claim write below in the NEW cwd's anchor dir (recompute cwd-slug after the switch). Also append one pointer row to the ORIGINAL cwd's INDEX.md: `- <slug> | LANE | .claude/worktrees/<slug>` so a reader of the origin INDEX sees the lane exists.
f. No lane: proceed as today.

Write the new task file:
```
STATE <today's ISO date> | ACTIVE | next: <first concrete action, derived from the task text>
<task text verbatim>
```
Today's date: `date +%Y-%m-%d`. Add `- <slug> | ACTIVE | next: <same next>` to INDEX.md. Then run §8 Claim write. If the lane check chose the sandbox lane (d), append the `worktree:` line to the task file now.

The skill creates lanes only via steps d and e above, and never removes them; removal belongs to `/park`.

## 7. `steal <slug>` argument
Only proceed if the user already confirmed stealing in this conversation (choosing a live-claimed row in §4 counts). Otherwise refuse and ask the user to confirm first.
If confirmed: run §8 Claim write (it overwrites any existing `owner:` / `heartbeat:` lines).

## 8. Claim write (atomic)
Set `dir`, `slug`, `session_id`, `file="$dir/$slug.md"`, then run as-is (macOS bash; GNU/BSD `sed -i` split matches the hook's `rewrite_heartbeat`):

```bash
if ! mkdir "${dir:?}/${slug:?}.lock"; then
  echo "another session is claiming this right now"
  # STOP — do not edit the task file
else
  if sed --version >/dev/null 2>&1; then
    sed -i '/^owner:/d' "$file"
    sed -i '/^heartbeat:/d' "$file"
  else
    sed -i '' '/^owner:/d' "$file"
    sed -i '' '/^heartbeat:/d' "$file"
  fi
  printf 'owner: %s\n' "$session_id" >> "$file"
  printf 'heartbeat: %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" >> "$file"
  rmdir "${dir:?}/${slug:?}.lock"
fi
```

`date +%Y-%m-%dT%H:%M:%S%z` is the heartbeat format (offset with or without a colon; the hook's `parse_iso_datetime_epoch` accepts both). Lock is a directory; plain `mkdir` (not `-p`) fails if `<dir>/<slug>.lock` already exists.

## 9. Close
Every successful path ends here. Print one line: `Claimed <slug> | next: <...>`. Remind the user that `/park` releases the claim.
Oracle: re-read the task file and confirm the `owner:` line equals this session's id. If it does not match, say "not claimed" and state why (lock contention, write failure).

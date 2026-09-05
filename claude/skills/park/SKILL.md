---
name: park
description: Close the current session cleanly — persist decisions to disk, rewrite the owned task file and INDEX, release the claim, prep the commit, print the resume recipe. Flavors - park (tomorrow), park next (same task, fresh session now), park switch <new task> (new task via /claim-task new), park closed (task finished: close ritual — remove lane, delete task file + INDEX row).
argument-hint: "[next | switch <new task text> | closed]"
disable-model-invocation: true
---

Flavor = first word of the argument: none → TOMORROW, `next` → NEXT, `switch` → SWITCH (rest = new task text), `closed` → CLOSED (task finished).
cwd-slug = cwd with every non-alphanumeric char replaced by `-`.
Dir = `~/.claude/task-anchors/<cwd-slug>/`.
Target = the task file in that dir whose `owner:` line equals this session's id.
Session id = the value on the `session_id:` line that the task-anchor hook injects into every prompt (inside the TASK ANCHOR block). Use it verbatim. Fallback only when no such line exists in this prompt (hook disabled): read the newest file under `~/.claude/projects/<cwd-slug>/` whose name matches `<uuid>.jsonl` and use that uuid; if two such files were modified within the last 5 minutes, ask the user which session this is instead of guessing.
If the dir exists but no file is owned by this session: print "no claimed task in this session — use /handoff or /claim-task first" and stop.
Dir missing + legacy flat file: see Legacy at the end.
Non-repo work (scratch dir, no worklog): use `/handoff` instead and say so.
Live-claimed = has an `owner:` line AND a `heartbeat:` line less than 4 hours old (whole hours, same rule as the hook). Age label: first 8 chars of owner, `<N>h ago`.

## 1. Flavor check (before writing anything)
Gather: target line 1, `git status --short`, open questions in this conversation, any background process or log path mentioned (LR 0009 rule), local time.
Challenge the flavor with ONE AskUserQuestion only if evidence conflicts:
- TOMORROW but anchor status ACTIVE with a known next step and time < 17:00 → "did you mean `/park next`?"
- NEXT or TOMORROW but the task is finished (no next step left) → "did you mean `/park closed`?"
- CLOSED but the STATE line names a real next step, or `git status --short` shows uncommitted work belonging to this task → "task not finished — plain `/park` instead?"
- SWITCH with uncommitted work belonging to the current anchor → "checkpoint current task first?"
- SWITCH where the new-task text matches an existing task file in the dir (slug from first 5 words, same kebab-case rule as claim-task §6) that is live-claimed by a different session → "steal that claim, or create a new task?"
- Any running watcher without a named log path → "record log path before close".
No conflict → proceed silently.

## 2. Persist decisions
Write to the repo's worklog (or `implementation-notes.md` if no worklog convention): decisions + rationale, open questions, what only this conversation knows. Reference artifacts by path; do not duplicate them. CLOSED too: write the closing line (outcome + where the artifacts live) — after the task file is deleted the worklog is the only record.

## 3. Rewrite the anchor
TOMORROW and NEXT: STATE status = PARKED. SWITCH: park the current task the same way, then invoke `/claim-task new "<text>"` (or `/claim-task steal <slug>` if §1 chose steal). CLOSED: run the close ritual in §3a, then delete the task file and drop the INDEX row (§3b). No `Parked:` line inside any file.

### 3a. Task file
Line 1, exact form (the hook parses it; `step` field only when a plan file gives a denominator):
`STATE <ISO date> | <ACTIVE|PARKED|CLOSED> | next: <one action> | step <N/M>`
Lines 2+: prose, ≤ 800 chars. Keep any `worktree:` line.

Then release the claim on EVERY flavor that keeps the file (TOMORROW, NEXT, SWITCH):

```bash
if sed --version >/dev/null 2>&1; then
  sed -i '/^owner:/d' "$file"
  sed -i '/^heartbeat:/d' "$file"
else
  sed -i '' '/^owner:/d' "$file"
  sed -i '' '/^heartbeat:/d' "$file"
fi
```

CLOSED → before deleting the file, run the close ritual:
- Task file has a `worktree:` line: run `git worktree remove <path>`. If git refuses because the worktree is dirty, list the dirty files (`git -C <path> status --short`) and ask the user "remove anyway (--force) or keep?" — never pass `--force` without that answer. If the worktree was on a named branch (not detached) and `git merge-base --is-ancestor <branch> main` succeeds, run `git branch -d <branch>`; otherwise report the branch name as kept.
- Task file has no `worktree:` line but the session is inside an EnterWorktree lane (cwd under `.claude/worktrees/`): call `ExitWorktree(action="remove")` — it refuses on dirty state; if it refuses, ask the user the same "remove anyway (--force) or keep?" question. Then delete the matching `- <slug> | LANE | …` pointer row from the origin repo's INDEX.md (origin cwd = the repo root two levels above `.claude/worktrees/<name>`).

Then delete the task file (`rm "$file"`). Do not run the release sed and do not rewrite line 1 — a CLOSED task has no file. Never leave a file whose line 1 says CLOSED.

### 3b. INDEX.md
Set `slug` to the task file's basename without `.md`. Update that task's row to `- <slug> | <PARKED|ACTIVE> | next: <same next as the STATE line>` (TOMORROW and NEXT → PARKED; SWITCH previous → PARKED). If the row is missing, append it.

Status field (GNU sed: drop the `''` after `-i`, same `if sed --version` branch as §3a):

```bash
sed -i '' "s/^- ${slug} | [A-Z]* | /- ${slug} | PARKED | /" "$dir/INDEX.md"
```

If `next:` on the row differs from the STATE line, rewrite the whole row to `- <slug> | PARKED | next: <same next>`. If grep finds no `^- ${slug} | ` row, append:
`printf -- '- %s | PARKED | next: %s\n' "$slug" "$next" >> "$dir/INDEX.md"`

CLOSED → remove the row (same GNU/BSD split):

```bash
sed -i '' "/^- ${slug} | /d" "$dir/INDEX.md"
```

### 3c. SWITCH
After §3a–3b on the previous task: invoke `/claim-task new "<text>"`. Do not write a `Parked:` line. If §1 chose steal: invoke `/claim-task steal <slug>` instead.

### 3d. Empty dir
If after CLOSED the dir has no task files left (`*.md` other than INDEX.md): delete INDEX.md and the dir.

## 4. Commit prep
List unstaged files, stage the ones belonging to this task, run the `generate-commit-message` skill, then stop — the user commits.

## 5. Resume recipe + oracle
Print: cwd, target line 1, `worktree:` path if the task file has one, log paths of anything still running, and the first command for the next session.
NEXT and TOMORROW: first command is `/claim-task <slug>`. CLOSED: first command is `/claim-task` with no argument (pick the next task from INDEX).
Verify and report plainly: target mtime is now; `git status` is clean OR every dirty file is named in the worklog; the task file (if it still exists) has no `owner:` line; the INDEX row status matches the STATE line. If the owner line remains or the INDEX status does not match STATE, say "not parked" and what is missing.
Also: if the task file still exists and has a `worktree:` line, verify the path exists and report it. If the flavor was CLOSED, verify `git worktree list` no longer shows the path; if it still shows, say "lane not removed".
CLOSED oracle: the task file no longer exists, `grep "^- <slug> | " INDEX.md` finds nothing, and the lane path (if any) is absent from `git worktree list`. If any of the three still holds, say "not closed" and name which.

## Legacy (v1 flat file)
Dir missing and `~/.claude/task-anchors/<cwd-slug>.md` exists: do not migrate. Rewrite that single file as before — line 1 STATE form, lines 2+ prose ≤ 800, SWITCH puts the previous task on a `Parked:` line and describes the new task on line 1, CLOSED with nothing parked deletes the file. No INDEX, no owner/heartbeat. Resume first command is the next action, not `/claim-task`.

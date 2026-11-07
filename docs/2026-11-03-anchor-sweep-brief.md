# Brief: anchor sweep script — 2026-11-03

## Goal

Build `claude/skills/park/scripts/sweep.sh`. It closes finished task anchors in bulk, with no model turn and no claim.

The user runs it with `! ~/.claude/skills/park/scripts/sweep.sh` from inside a project. The output costs one short block in the chat.

## Why

Today, closing a stale anchor means `/claim-task <slug>`, then `/park closed`. That costs two model turns and a lot of tokens for each anchor. On 2026-11-03, the fb-ads-improvement project had 6 stale anchors. Most of the close ritual is mechanical. Only one step needs judgment: "is this task finished?" The script prints the facts, and the human makes that call.

## Behaviour

| Command | What it does |
|---|---|
| `sweep.sh` | Dry run. Prints one row for each task file in the anchor folder. Changes nothing. |
| `sweep.sh close <slug>...` | Runs the close ritual for each slug that is safe to close. Skips the others and prints the reason. |

Columns of the dry-run table:

1. `slug`
2. `claim`: `live` or `free`. Use the lease rule in `claude/skills/claim-task/SKILL.md` §3 (the `pid:` check first, then the 4-hour `heartbeat:` fallback).
3. `worktree`: `none`, `gone`, `clean`, or `dirty (N files)`.
4. `branch`: `merged`, `unmerged`, or `-`. "Merged" means `git merge-base --is-ancestor <branch> origin/main` succeeds after `git fetch -q origin`. If the fetch fails, print a warning and use the local `main`.
5. `next`: the `next:` part of line 1 of the task file, cut to about 60 characters.

Mark a row `candidate` when the claim is `free`, the worktree is `none`, `gone`, or `clean`, and the branch is `merged` or `-`. The mark is a hint only. Do not close anything without an explicit `close <slug>`.

## Close ritual (same as `/park closed`, `claude/skills/park/SKILL.md` §3a, §3b, §3d)

For each slug, in this order:

1. Refuse if the claim is `live`. Print the owner (first 8 characters) and the pid.
2. Refuse if the worktree is `dirty`. List the dirty files. Never pass `--force`.
3. If the worktree exists, run `git -C <project_root> worktree remove <path>`. If the path is gone, run `git -C <project_root> worktree prune`.
4. If the branch is merged, run `git -C <project_root> branch -d <branch>`. Never use `-D`. If the branch is not merged, keep it and print the branch name.
5. If `~/.claude/lanes/<root-slug>/` exists, run `node "${LANE_TS:-$HOME/.claude/hooks/lanes/lane.ts}" close "<project_root>" "<slug>" "closed by sweep <ISO date>"`.
6. Delete the task file with `rm "${file:?}"`.
7. Delete the INDEX row: the line that starts with `- <slug> | `. Use the GNU and BSD `sed -i` split from the park skill.
8. If no task files are left, delete `INDEX.md` and the folder (§3d).

After each slug, check the close oracle from park §5: the task file is gone, the INDEX row is gone, and the worktree path is not in `git worktree list`. Print `closed <slug>` or `not closed <slug>: <reason>`.

## Paths

- Project root: the main checkout of the current git repo. Inside a linked worktree, use the main checkout path (the same rule as `claude/hooks/task-anchor.sh`). Reuse that code if you can; do not write a second version of the rule.
- Anchor folder: `~/.claude/task-anchors/<root-slug>/`, where root-slug is the project root with every non-alphanumeric character replaced by `-`.
- Also report drift: an INDEX row with no task file, or a task file with no INDEX row. Report only; do not fix it.

## Rules

- Start with `set -euo pipefail`. The script must pass `shellcheck`.
- It must run on macOS bash 3.2. No associative arrays and no `mapfile`. Do not put an apostrophe in a heredoc inside `$( )`.
- It needs only `git`, `sed`, `awk`, and `node` (for the lane log). Do not add `jq` unless the lane code needs it.
- The worklog closing line that `/park closed` writes is out of scope. The lane log line is the only record. Say this in the park skill.

## Done when

1. `sweep.sh` and `sweep.sh close` work against a test anchor folder in a temporary git repo. Cover these cases: a live claim, a dirty worktree, a gone worktree, a merged branch, an unmerged branch, and the last task file in the folder.
2. `shellcheck` passes.
3. The park skill has one line about the script: what it does, and the command to run it.
4. The README layout table still holds, because `install.sh` already copies `claude/skills/park/` as a folder. Check that the copy includes `scripts/`.

## Check first

The `fix/anchor-main-root` branch (worktree `ccsetup-anchor-main-root`) changes how the anchor main root is found. Read it before you write the path code, so the two do not conflict.

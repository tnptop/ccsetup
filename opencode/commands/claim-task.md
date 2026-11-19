---
description: Claim a task anchor for this session (runs the claim-task skill from ~/.claude/skills)
---
/claim-task $ARGUMENTS

Read ~/.claude/skills/claim-task/SKILL.md and follow it. Its argument is the text after /claim-task on the line above (none when that is empty).
This is OpenCode, not Claude Code: tools that the skill names, such as AskUserQuestion, EnterWorktree or ExitWorktree, may not exist here. Ask a plain question in your reply instead of AskUserQuestion, and run `git worktree` in the shell instead of EnterWorktree or ExitWorktree.

---
name: generate-commit-message
description: Draft a project-compliant git commit message from the current branch name and staged or unstaged changes. Use when the user asks to generate, suggest, draft, or refine a commit message, summarize a git diff for committing, or produce the required AI and Human contribution breakdown for a commit.
---

# Generate Commit Message

## Overview

Generate a commit message without committing anything. Inspect the current git state, infer the commit type and ticket from the branch name, and return a ready-to-review message in the project's format.

## Workflow

1. Gather git context.
   - Run `git branch --show-current`.
   - Run `git diff --cached --stat` and `git diff --cached`.
   - If nothing is staged, run `git diff --stat` and `git diff` instead, and note that the changes still need to be staged before committing.

2. Extract branch metadata.
   - Expect branch names in the form `type/ticket-id-slug`.
   - Extract `type` such as `feat`, `fix`, `refactor`, `chore`, `docs`, or `test`.
   - Extract `ticket-id` such as `GL-340`.
   - If the branch does not match the convention, keep going with the best available summary and explicitly call out the missing or ambiguous branch metadata.

3. Write the commit title.
   - Format it as `type: ticket-id description`.
   - Keep it concise and aim for about 72 characters or fewer.
   - Use imperative mood such as `add`, `fix`, `update`, or `refactor`.
   - Base the description on the actual diff, not just the branch slug.

4. Write the commit body.
   - Use this structure:

```text
AI: x% | Human: y%

AI:
  - ...

Human:
  - ...
```

   - Always include the `Human:` section.
   - If the human contribution is only prompts or followups, summarize those prompts.
   - If the prompts are not available, use `- Provide prompts and/or followups`.
   - Keep percentages in 5 percent increments and make them add up to 100.

5. Return the full commit message.
   - Present the final title and body in a fenced code block.
   - **Also copy the exact message to the clipboard** so it can be pasted without the fence or
     markdown-indent artifacts. Pass the raw message (title + blank line + body, fence excluded)
     through a quoted heredoc or single-quoted here-string, preserving the body's two-space
     indents verbatim. Use the first clipboard command that exists on this machine:
     - macOS: `pbcopy`
     - Windows: `clip.exe` (from Git Bash), else PowerShell `Set-Clipboard -Value @' … '@`
     - Linux: `wl-copy`, else `xclip -selection clipboard`
     If a command fails, try the next one once. If none works, say so and skip the copy.
   - Do not run `git commit`. Stop here and let the user commit.

## Quality Bar

- Prefer staged changes over unstaged changes when both exist.
- Mention when no files are staged so the user does not mistake the message for a ready-to-commit result.
- Reflect the highest-signal change in the title and reserve supporting details for the body.
- Keep the wording specific to the repo changes rather than generic.

## Example

For a branch such as `fix/GL-340-agent-instructions-syntax`, produce a title shaped like:

```text
fix: GL-340 fix agent instructions markdown syntax
```

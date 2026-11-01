#!/bin/bash
# token-limit.sh: PreToolUse hook on Write and Edit.
# Blocks a call that would push a file past TOKEN_LIMIT_TOKENS (default 5000;
# tokens = bytes/4). A file already over the limit stays editable; split it by hand.
#
# Exclusions are OR'ed from three layers:
#   core     the regex below; true on every machine (binaries, lockfiles, vendored code)
#   machine  ~/.claude/hooks/token-limit-exclude   (carried on the machine branch)
#   project  <git root>/.claude/token-limit-exclude (committed with that repo)
# Overlay format: one extended regex per line, matched case-insensitively
# against the full path. Blank lines and lines starting with # are ignored.
set -u

LIMIT_TOKENS=${TOKEN_LIMIT_TOKENS:-5000}
LIMIT_BYTES=$((LIMIT_TOKENS * 4))

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

if [ "$TOOL" != "Write" ] && [ "$TOOL" != "Edit" ]; then exit 0; fi
if [ -z "$FILE_PATH" ]; then exit 0; fi

CORE='(^|/)(vendor|node_modules|dist|build)/'
CORE+='|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|cargo\.lock|gemfile\.lock|go\.sum|\.skill-lock\.json)$'
CORE+='|(^|/)generated[-_][^/]*$'
CORE+='|\.(lock|png|jpg|jpeg|gif|webp|svg|ico|pdf|ttf|otf|woff|woff2|csv|min\.js|min\.css)$'

d=$(dirname "$FILE_PATH")
while [ ! -d "$d" ]; do d=$(dirname "$d"); done
ROOT=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)
EXCLUDE=$CORE
for f in "$HOME/.claude/hooks/token-limit-exclude" ${ROOT:+"$ROOT/.claude/token-limit-exclude"}; do
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    case "$line" in ''|'#'*) continue ;; esac
    EXCLUDE+="|$line"
  done < "$f"
done

echo "$FILE_PATH" | grep -qiE "$EXCLUDE"; rc=$?
if [ "$rc" -eq 2 ]; then
  echo "token-limit: bad regex in an exclude file; applying core rules only" >&2
  echo "$FILE_PATH" | grep -qiE "$CORE"; rc=$?
fi
if [ "$rc" -eq 0 ]; then exit 0; fi

CURRENT=0
if [ -f "$FILE_PATH" ]; then CURRENT=$(wc -c < "$FILE_PATH" | tr -d ' '); fi

if [ "$TOOL" = "Write" ]; then
  PROJECTED=$(echo "$INPUT" | jq -r '.tool_input.content // "" | utf8bytelength')
else
  # ponytail: replace_all counted as one occurrence; count matches if it ever matters
  NEW=$(echo "$INPUT" | jq -r '.tool_input.new_string // "" | utf8bytelength')
  OLD=$(echo "$INPUT" | jq -r '.tool_input.old_string // "" | utf8bytelength')
  PROJECTED=$((CURRENT + NEW - OLD))
fi

# Only block crossings; files already over the limit stay editable (retrospective splitting is manual).
if [ "$PROJECTED" -gt "$LIMIT_BYTES" ] && [ "$CURRENT" -le "$LIMIT_BYTES" ]; then
  cat >&2 <<MSG
BLOCKED: $FILE_PATH would be about $((PROJECTED / 4)) tokens (bytes/4). The limit is $LIMIT_TOKENS tokens, about $LIMIT_BYTES bytes.
Files this large are expensive for agents to read and edit. Split it before writing:
1. Find 2 or more cohesive sections in the content (a group of related functions, a class, a reference section of a document).
2. Move each section into its own sibling file next to the original. Name each file after what it holds.
3. Keep the original as the entry point: import or re-export the moved code, or link each moved document section with one line.
4. Write each piece as its own Write call. Keep every file under $LIMIT_TOKENS tokens.
5. Do not retry the same write unchanged. Do not bypass this hook.
Excluded automatically: lockfiles, generated or vendored code, build output, binaries, fonts.
If this path is a log, fixture, or data file, say so to the user. They can list it in <git root>/.claude/token-limit-exclude.
MSG
  exit 2
fi

exit 0

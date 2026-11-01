#!/bin/bash
# Runnable check for token-limit.sh. Usage: bash claude/hooks/token-limit.test.sh

HOOK="$(cd "$(dirname "$0")" && pwd)/token-limit.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILED=0
unset TOKEN_LIMIT_TOKENS
H="$TMP/empty"  # HOME for each hook run; never the real ~/.claude
LIMIT=""       # TOKEN_LIMIT_TOKENS for each hook run; empty = unset
mkdir -p "$H"

bytes() { head -c "$1" /dev/zero | tr '\0' 'a'; }
write_json() { jq -n --arg p "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$p,content:$c}}'; }
edit_json() { jq -n --arg p "$1" --arg o "$2" --arg n "$3" '{tool_name:"Edit",tool_input:{file_path:$p,old_string:$o,new_string:$n}}'; }

# check <n> <expected exit> <json> [stderr substring...]
check() {
  local n=$1 want=$2 json=$3; shift 3
  local err code
  err=$(echo "$json" | env HOME="$H" ${LIMIT:+TOKEN_LIMIT_TOKENS="$LIMIT"} bash "$HOOK" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$want" ]; then echo "FAIL $n: exit $code, want $want"; FAILED=1; return; fi
  for s in "$@"; do
    case "$err" in *"$s"*) ;; *) echo "FAIL $n: stderr lacks '$s'"; FAILED=1; return ;; esac
  done
  echo "PASS $n"
}

BIG=$(bytes 25000)
mkdir -p "$TMP/docs/worklogs"
bytes 19000 > "$TMP/near.txt"
bytes 30000 > "$TMP/over.txt"
THAI=""; for _ in $(seq 1700); do THAI+="ทดสอบ"; done  # 15 bytes x 1700 = 25500 bytes, 8500 chars

check 1 0 "$(write_json "$TMP/small.txt" "$(bytes 10)")"
check 2 2 "$(write_json "$TMP/big.txt" "$BIG")" BLOCKED "$TMP/big.txt"
check 3 2 "$(write_json "$TMP/docs/worklogs/x.md" "$BIG")"
check 4 0 "$(write_json "$TMP/uv.lock" "$BIG")"
check 5 2 "$(edit_json "$TMP/near.txt" "$(bytes 10)" "$(bytes 2000)")"
check 6 0 "$(edit_json "$TMP/over.txt" "$(bytes 10)" "$(bytes 2000)")"
check 7 0 "$(edit_json "$TMP/near.txt" "$(bytes 2000)" "$(bytes 10)")"
check 8 0 "$(jq -n --arg p "$TMP/big.txt" --arg c "$BIG" '{tool_name:"Read",tool_input:{file_path:$p,content:$c}}')"
check 9 2 "$(write_json "$TMP/thai.txt" "$THAI")" BLOCKED

# 10: machine overlay under $HOME exempts docs/worklogs
H="$TMP/home"; mkdir -p "$H/.claude/hooks"
printf '# worklogs are append-only logs\n\n  /docs/worklogs/  \n' > "$H/.claude/hooks/token-limit-exclude"
check 10 0 "$(write_json "$TMP/docs/worklogs/x.md" "$BIG")"
H="$TMP/empty"

# 11: project overlay at the git root; target directory does not exist yet
git init -q "$TMP/repo"; mkdir -p "$TMP/repo/.claude"
echo '/tests/(golden|fixtures)/' > "$TMP/repo/.claude/token-limit-exclude"
check 11a 0 "$(write_json "$TMP/repo/tests/golden/x.json" "$BIG")"
check 11b 2 "$(write_json "$TMP/repo/src/x.json" "$BIG")" BLOCKED

# 12: TOKEN_LIMIT_TOKENS overrides the default limit
LIMIT=100 check 12a 2 "$(write_json "$TMP/env.txt" "$(bytes 500)")" "limit is 100 tokens"
check 12b 0 "$(write_json "$TMP/env.txt" "$(bytes 500)")"

# 13: a bad regex in an overlay falls back to core rules, does not crash
echo '(' > "$TMP/repo/.claude/token-limit-exclude"
check 13a 2 "$(write_json "$TMP/repo/src/y.py" "$BIG")" "bad regex" BLOCKED
check 13b 0 "$(write_json "$TMP/repo/src/y.py" "$(bytes 10)")"

exit $FAILED

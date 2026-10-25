#!/bin/bash
# Offline tests of the lane hooks (phase3-plan.md, tests 1-5): temp HOME,
# LANES_ROOT and CLAUDE_PROJECT_DIR, fake JSON on stdin, a fake harness
# (a symlink to sleep named claude). Prints PASS/FAIL per case; exits 1 on any
# FAIL. Test 1's oracle is the live hook, run read-only on the temp HOME.
#   bash ~/.claude/hooks/lanes/hooks.test.sh [hook]   (default: ../task-anchor.sh)
here=$(cd "$(dirname "$0")" && pwd)
HOOK="${1:-$here/../task-anchor.sh}"
ORACLE="${ORACLE:-$HOME/.claude/hooks/task-anchor.sh}"
LANE_JS="$here/lane.ts"
tmp=$(mktemp -d)
# a symlink, not the plan's cp: macOS kills a copied system binary (SIGKILL,
# code signing)
ln -s /bin/sleep "$tmp/claude"
"$tmp/claude" 300 & H=$!
"$tmp/claude" 300 & H2=$!
bash -c 'exit 0' & DEAD=$!
wait "$DEAD"
trap 'kill $H $H2 2>/dev/null; wait $H $H2 2>/dev/null; rm -rf "$tmp"' EXIT

P="$tmp/proj"
mkdir -p "$P"
slug=$(printf '%s' "$P" | sed 's/[^A-Za-z0-9]/-/g')
AD="$tmp/home/.claude/task-anchors/$slug"
LD="$tmp/lanes/$slug"
fails=0

t() {
  local name=$1
  shift
  if eval "$@"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    fails=$((fails + 1))
    return 1
  fi
}

# run <hook> <json> [arg]: the hook in the temp world; harness pid $H
run() {
  local s=$1 j=$2
  shift 2
  printf '%s' "$j" | HOME="$tmp/home" LANES_ROOT="$tmp/lanes" CLAUDE_PROJECT_DIR="$P" CLAUDE_PID="${PID_OF:-$H}" \
    LANE_TS="${LANE_TS_T:-$LANE_JS}" bash "$s" "$@"
}

a=$(ps -p "$H" -o args=)
t "fake harness is live, args start with claude" 'kill -0 $H && kill -0 $H2 && [ "$(basename "${a%% *}")" = claude ] && ! kill -0 $DEAD 2>/dev/null'

sedi() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
iso() { date +%Y-%m-%dT%H:%M:%S%z; }

# usage line: input cache_read output
usage() {
  printf '{"type":"assistant","message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0,"output_tokens":%s}}}\n' "$1" "$2" "$3" > "$4"
}
T160="$tmp/t160.jsonl"; usage 1000 159000 500 "$T160"
T210="$tmp/t210.jsonl"; usage 1000 194000 15000 "$T210"
T10="$tmp/t10.jsonl"; usage 1000 9000 100 "$T10"

# the anchor dir: t1 (owned by $1 when given), t2 claimed live elsewhere,
# t3 stale; INDEX.md
anchors() {
  rm -rf "$tmp/home" "$tmp/lanes"
  mkdir -p "$AD"
  printf -- '- t1 | ACTIVE | next: do x\n- t2 | ACTIVE | next: do y\n- t3 | PARKED | next: do z\n' > "$AD/INDEX.md"
  printf 'STATE 2026-10-20 | ACTIVE | next: do x | step 2/5\nprose one\n' > "$AD/t1.md"
  [ -n "$1" ] && printf 'owner: %s\nheartbeat: %s\npid: %s\n' "$1" "$(iso)" "$H" >> "$AD/t1.md"
  printf 'STATE 2026-10-21 | ACTIVE | next: do y\nowner: S0-other\nheartbeat: %s\npid: %s\n' "$(iso)" "$H2" > "$AD/t2.md"
  printf 'STATE 2026-10-01 | PARKED | next: do z\nowner: S7-gone\nheartbeat: 2026-10-01T10:00:00+07:00\n' > "$AD/t3.md"
}

# every file under the temp HOME and lanes root, heartbeats masked
snap() {
  (cd "$tmp" && find home lanes -type f 2>/dev/null | sort | while read -r f; do echo "== $f"; cat "$f"; done) |
    sed -E 's/heartbeat: [0-9T:+-]+/heartbeat: X/'
}

# heartbeats, and the STATE age: macOS `date -j -f %Y-%m-%d` takes today's
# time of day, so a whole-day age is N*24h minus 0 or 1 s, and both hooks
# flip between Nh and N-1h at a second boundary
mask() { sed -E -e 's/heartbeat: [0-9T:+-]+/heartbeat: X/' -e 's/last written [0-9]+h ago/last written Nh ago/'; }

ups() { printf '{"hook_event_name":"UserPromptSubmit","session_id":"%s","prompt":"%s","cwd":"%s","transcript_path":"%s"}' "$1" "$2" "$P" "$3"; }

# Test 1: golden. Lanes off (OMPCODE=1, with and without a lanes dir): the
# prompt hook's output and files match the live hook's; the lane events do
# nothing.
golden() {
  local name=$1 setup=$2 json=$3 a= b= sa= sb=
  eval "$setup"
  a=$(run "$ORACLE" "$json" | mask); sa=$(snap)
  eval "$setup"
  b=$(run "$HOOK" "$json" | mask); sb=$(snap)
  t "golden $name (OMPCODE=1${lanes:+, lanes dir})" '[ -n "$a" ] && [ "$a" = "$b" ] && [ "$sa" = "$sb" ]' ||
    { [ -n "$DEBUG" ] && diff <(echo "$a"; echo "$sa") <(echo "$b"; echo "$sb"); }
}

quiet() {
  local name=$1 json=$2 arg=$3 before= out=
  eval "anchors S1$lanes"
  before=$(snap)
  out=$(run "$HOOK" "$json" $arg)
  t "quiet $name (OMPCODE=1${lanes:+, lanes dir})" '[ $? -eq 0 ] && [ -z "$out" ] && [ "$(snap)" = "$before" ]'
}

export OMPCODE=1
for lanes in "" '; mkdir -p "$LD/t1"'; do
  golden "owned claim, 160k" "anchors S1$lanes" "$(ups S1 hello "$T160")"
  golden "unowned with INDEX" "anchors$lanes" "$(ups S9 hello "$T10")"
  golden "unowned, 160k" "anchors$lanes" "$(ups S9 hello "$T160")"
  golden "no anchor dir" "rm -rf \"\$tmp/home\" \"\$tmp/lanes\"; mkdir -p \"\$tmp/home\"$lanes" "$(ups S9 hello "$T10")"
  quiet "Stop" "{\"hook_event_name\":\"Stop\",\"session_id\":\"S1\",\"transcript_path\":\"$T210\",\"last_assistant_message\":\"m\"}"
  quiet "SessionEnd" '{"hook_event_name":"SessionEnd","session_id":"S1","reason":"prompt_input_exit"}'
  quiet "SessionStart view" '{"hook_event_name":"SessionStart","session_id":"S2","source":"clear"}' view
  quiet "SessionStart last" '{"hook_event_name":"SessionStart","session_id":"S2","source":"clear"}' last
done
# omp reads leases by pid too: a fresh heartbeat with a dead pid is stale
anchors
sedi "s/^pid: .*/pid: $DEAD/" "$AD/t2.md"
o=$(run "$HOOK" "$(ups S9 hi "$T10")" | jq -r .hookSpecificOutput.additionalContext)
t "INDEX (OMPCODE=1): fresh heartbeat, dead pid reads stale" 'printf %s "$o" | grep -qF "t2 | ACTIVE | next: do y | stale (owner S0-other, no live pid)"'
unset OMPCODE

# Test 2: lanes on (Claude Code, no lanes dir needed): a session with no
# claim makes no lanes dir; the prompt hook makes it, logs the session once,
# keeps the prompt, nudges at 200k (not 150k), and reads leases by pid
T250="$tmp/t250.jsonl"; usage 1000 249000 0 "$T250"
anchors
run "$HOOK" "$(ups S9 hi "$T10")" >/dev/null
run "$HOOK" "{\"hook_event_name\":\"Stop\",\"session_id\":\"S9\",\"transcript_path\":\"$T10\"}" >/dev/null
t "no claim: no lanes dir made" '[ ! -e "$tmp/lanes" ]'
anchors S1
o=$(run "$HOOK" "$(ups S1 first "$T160")")
t "owned claim, no lanes dir: lanes and lane dir made, lane instruction" '[ -d "$LD/t1" ] && printf %s "$o" | jq -r .hookSpecificOutput.additionalContext | grep -qF "(/claim-task there)"'
o=$(run "$HOOK" "$(ups S1 second "$T160")")
t "UserPromptSubmit twice: one log line" '[ "$(cat "$LD/t1/log")" = "$(printf "S1\t%s" "$T160")" ]'
t "UserPromptSubmit: prompt file written" '[ "$(cat "$LD/t1/prompt")" = second ]'
t "UserPromptSubmit lanes on: no nudge at 160k" '! printf %s "$o" | grep -q "context ~"'
o=$(run "$HOOK" "$(ups S1 third "$T250")")
t "UserPromptSubmit lanes on: /clear nudge at 250k" 'printf %s "$o" | jq -r .hookSpecificOutput.additionalContext | grep -qF "context ~250k — finish this step, then tell the user to type /clear (you cannot run it)."'
t "UserPromptSubmit lanes on: no /park next or switch, closed kept" 'c=$(printf %s "$o" | jq -r .hookSpecificOutput.additionalContext) && printf %s "$c" | grep -qF "(/claim-task there)" && printf %s "$c" | grep -qF "run its closed flavor" && ! printf %s "$c" | grep -qE "switch flavor|switch the anchor|park next"'
run "$HOOK" "$(ups S1 'note /park closed' "$T160")" >/dev/null 2>&1; rc=$?
t "park guard: typed mid-sentence /park is blocked" '[ "$rc" = 2 ]'
o=$(run "$HOOK" "$(ups S1 '<agent-message from=\"a1\">done; run /park next</agent-message>' "$T160")" 2>/dev/null); rc=$?
t "park guard: a harness-wrapped prompt passes" '[ "$rc" = 0 ] && printf %s "$o" | jq -e .hookSpecificOutput.additionalContext >/dev/null'
sedi "s/^pid: .*/pid: $DEAD/" "$AD/t2.md"
o=$(run "$HOOK" "$(ups S9 hi "$T10")" | jq -r .hookSpecificOutput.additionalContext)
t "INDEX lanes on: live pid claimed, dead or no pid stale" 'printf %s "$o" | grep -qF "t1 | ACTIVE | next: do x | claimed by S1, pid $H live" && printf %s "$o" | grep -qF "t2 | ACTIVE | next: do y | stale (owner S0-other, no live pid)" && printf %s "$o" | grep -qF "t3 | PARKED | next: do z | stale (owner S7-gone, no live pid)"'

# Test 3: Stop: last.json, a detached build, the 200k systemMessage, no node
cat > "$tmp/stub.js" <<'JS'
const fs = require("fs");
const env = ["CLAUDE_PID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].map((k) => process.env[k] ?? "").join("");
if (process.argv[2] === "build") setTimeout(() => fs.writeFileSync(process.env.STUB_MARKER, process.argv.slice(2).join(" ") + "|" + env), 5000);
JS
stop_json() { jq -nc --arg tp "$1" '{hook_event_name:"Stop",session_id:"S1",transcript_path:$tp,last_assistant_message:"reply: pick A or B\n\"quoted\" ไทย",stop_hook_active:false}'; }
anchors S1
sedi -e "s/^pid: .*/pid: $DEAD/" -e "s/^heartbeat: .*/heartbeat: 2026-01-01T00:00:00+07:00/" "$AD/t1.md"
mkdir -p "$LD/t1"
printf 'S1\t%s\n' "$T160" > "$LD/t1/log"
printf 'my prompt' > "$LD/t1/prompt"
t0=$(now)
out=$(STUB_MARKER="$tmp/marker" LANE_TS_T="$tmp/stub.js" CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=x run "$HOOK" "$(stop_json "$T160")")
rc=$?
t1=$(now)
t "Stop returns in under 1 s, exit 0, no output under 200k" '[ $rc -eq 0 ] && [ -z "$out" ] && perl -e "exit !($t1 - $t0 < 1)" && [ ! -e "$tmp/marker" ]'
t "Stop refreshes pid, leaves heartbeat" 'grep -qx "pid: $H" "$AD/t1.md" && grep -qx "heartbeat: 2026-01-01T00:00:00+07:00" "$AD/t1.md"'
t "Stop writes last.json" 'jq -e --arg tp "$T160" ".prompt == \"my prompt\" and .message == \"reply: pick A or B\n\\\"quoted\\\" ไทย\" and .transcript == \$tp and (.date | test(\"^20\"))" "$LD/t1/last.json" >/dev/null && [ ! -e "$LD/t1/last.json.tmp" ] && ! ls "$LD/t1" | grep -q "last.json\."'
for _ in $(seq 1 40); do [ -e "$tmp/marker" ] && break; sleep 0.25; done
t "Stop's build runs detached, env cleared" '[ "$(cat "$tmp/marker" 2>/dev/null)" = "build $P t1|" ]'
out=$(STUB_MARKER="$tmp/marker2" LANE_TS_T="$tmp/stub.js" run "$HOOK" "$(stop_json "$T210")")
t "Stop at 210k (output counted) prints the systemMessage" '[ "$out" = "{\"systemMessage\":\"context ~210k: type /clear now; lane t1 comes back on its own\"}" ]'
mkdir -p "$tmp/bin"
ln -s "$(command -v jq)" "$tmp/bin/jq"
out=$(PATH="$tmp/bin:/usr/bin:/bin" run "$HOOK" "$(stop_json "$T210")")
rc=$?
t "Stop with no node in PATH: exit 0, quiet" '[ $rc -eq 0 ] && [ -z "$out" ]'

# Test 4: SessionEnd releases the claim and keeps the session; clear does not
anchors S1
before2=$(cat "$AD/t2.md")
out=$(run "$HOOK" '{"hook_event_name":"SessionEnd","session_id":"S1","reason":"prompt_input_exit"}')
t "SessionEnd prompt_input_exit releases, writes last_session" '[ -z "$out" ] && ! grep -Eq "^(owner|heartbeat|pid):" "$AD/t1.md" && grep -qx "last_session: S1" "$AD/t1.md" && [ "$(head -2 "$AD/t1.md")" = "$(printf "STATE 2026-10-20 | ACTIVE | next: do x | step 2/5\nprose one")" ] && [ "$(cat "$AD/t2.md")" = "$before2" ]'
anchors S1
before=$(snap)
out=$(run "$HOOK" '{"hook_event_name":"SessionEnd","session_id":"S1","reason":"clear"}')
t "SessionEnd clear changes nothing" '[ -z "$out" ] && [ "$(snap)" = "$before" ]'

# Test 5: SessionStart: re-claim, wait for leaves, inject; never take a live
# window's claim
# lane t1's files: $1 messages indexed, $2 leaves built (~20k chars of
# view), a ~20k-char Thai last exchange
lanedata() {
  local n=$1 b=$2 i=0 x=
  mkdir -p "$LD/t1"
  x=$(printf 'x%.0s' $(seq 1 400))
  : > "$LD/t1/index.jsonl"
  : > "$LD/t1/tree.jsonl"
  while [ $i -lt "$n" ]; do
    printf '{"i":%s,"sid":"S1","line":%s,"date":"2026-10-22T10:00:00Z"}\n' $i $((i + 1)) >> "$LD/t1/index.jsonl"
    [ $i -lt "$b" ] && printf '{"l":0,"i":%s,"text":"leaf%s %s"}\n' $i $i "$x" >> "$LD/t1/tree.jsonl"
    i=$((i + 1))
  done
  jq -n --arg th "$(printf 'ภาษาไทย%.0s' $(seq 1 1500))" '{prompt:("PSTART " + $th), message:($th + " MEND"), transcript:"/t/s1.jsonl", date:"2026-10-22T11:00:00+0700"}' > "$LD/t1/last.json"
}
start() { printf '{"hook_event_name":"SessionStart","session_id":"%s","source":"%s","transcript_path":"%s"}' "$1" "$2" "$tmp/new.jsonl"; }
ctxlen() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext | length'; }

anchors S1
lanedata 50 50
before2=$(cat "$AD/t2.md")
t0=$(now)
v=$(LANE_WAIT=5 run "$HOOK" "$(start S2 clear)" view)
t1=$(now)
l=$(run "$HOOK" "$(start S2 clear)" last)
t "SessionStart clear re-claims with the new sid and the same pid" 'grep -qx "owner: S2" "$AD/t1.md" && grep -qx "pid: $H" "$AD/t1.md" && [ "$(grep -c "^owner:" "$AD/t1.md")" = 1 ] && [ ! -d "$AD/t1.lock" ]'
t "SessionStart clear leaves another live window's claim" '[ "$(cat "$AD/t2.md")" = "$before2" ]'
t "SessionStart view: SessionStart JSON, at most 10,000 chars, zoom line" '[ "$(printf %s "$v" | jq -r .hookSpecificOutput.hookEventName)" = SessionStart ] && [ "$(ctxlen "$v")" -le 10000 ] && printf %s "$v" | jq -r .hookSpecificOutput.additionalContext | grep -q "^older lines cut: zoom 0+[0-9]*$" && printf %s "$v" | grep -qF "LANE VIEW (inject view, lane t1)"'
t "SessionStart view: all leaves built, no wait" 'perl -e "exit !($t1 - $t0 < 1.5)"'
t "SessionStart last: at most 10,000 chars, prompt start, message end, transcript" '[ "$(ctxlen "$l")" -le 10000 ] && c=$(printf %s "$l" | jq -r .hookSpecificOutput.additionalContext) && case "$c" in "LANE LAST EXCHANGE (inject last, lane t1)"*"user: PSTART ภาษาไทย"*" MEND"*"/t/s1.jsonl]") true ;; *) false ;; esac'

anchors S1
lanedata 6 3
t0=$(now)
v=$(LANE_WAIT=2 run "$HOOK" "$(start S2 compact)" view)
t1=$(now)
t "SessionStart leaf wait honors the LANE_WAIT cap" 'perl -e "exit !($t1 - $t0 >= 0.9 && $t1 - $t0 < 3.5)" && printf %s "$v" | jq -r .hookSpecificOutput.additionalContext | grep -qF "5+1|(not summarized yet"'

anchors
printf 'last_session: S1\n' >> "$AD/t1.md"
lanedata 2 2
v=$(run "$HOOK" "$(start S1 resume)" view)
t "SessionStart resume re-claims a released lane, prints nothing" '[ -z "$v" ] && grep -qx "owner: S1" "$AD/t1.md" && grep -qx "pid: $H" "$AD/t1.md"'
anchors S1
sedi "s/^pid: .*/pid: $DEAD/" "$AD/t1.md"
v=$(run "$HOOK" "$(start S1 resume)" view)
t "SessionStart resume re-claims a crashed window's lane (dead pid)" '[ -z "$v" ] && grep -qx "owner: S1" "$AD/t1.md" && grep -qx "pid: $H" "$AD/t1.md"'

anchors
printf 'owner: S5\nheartbeat: %s\npid: %s\nlast_session: S1\n' "$(iso)" "$H2" >> "$AD/t1.md"
lanedata 2 2
before=$(snap)
v=$(run "$HOOK" "$(start S1 resume)" view)
l=$(run "$HOOK" "$(start S0-other resume)" view)
t "SessionStart resume leaves another live owner untouched" '[ -z "$v$l" ] && [ "$(snap)" = "$before" ]'
anchors
printf 'owner: S5\nheartbeat: %s\npid: %s\nlast_session: S1\n' "$(iso)" "$DEAD" >> "$AD/t1.md"
lanedata 2 2
before=$(snap)
v=$(run "$HOOK" "$(start S1 resume)" view)
t "SessionStart resume leaves a dead other owner's lane untouched" '[ -z "$v" ] && [ "$(snap)" = "$before" ]'
v=$(run "$HOOK" "$(start S9 clear)" view)
t "SessionStart clear with no claim on this pid does nothing" '[ -z "$v" ] && [ "$(snap)" = "$before" ]'

anchors S1
lanedata 2 2
before=$(snap)
v=$(run "$HOOK" "$(start S2 startup)" view)
l=$(run "$HOOK" "$(start S2 startup)" last)
f=$(run "$HOOK" "$(start S2 fork)" view)
t "SessionStart startup and fork do nothing" '[ -z "$v$l$f" ] && [ "$(snap)" = "$before" ]'

echo "$fails failed"
[ "$fails" -eq 0 ]

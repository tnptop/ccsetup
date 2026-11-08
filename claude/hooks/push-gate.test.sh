#!/bin/bash
# Runnable check for push-gate.sh. Usage: bash claude/hooks/push-gate.test.sh
# Builds a throwaway sandbox (bare "origin", my clone, a colleague clone, a second worktree).
# Never touches the real git config or a real repo.

HOOK="$(cd "$(dirname "$0")" && pwd)/push-gate.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
ME="$TMP/me"; COL="$TMP/col"; WT="$TMP/me-wt"

# --- sandbox (any failure here stops the script) ---
set -e
git config --global init.defaultBranch main
git config --global advice.detachedHead false
git init -q --bare "$TMP/origin.git"

mk() { # mk <dir> <email>
  git clone -q "$TMP/origin.git" "$1" 2>/dev/null
  git -C "$1" config user.email "$2"; git -C "$1" config user.name "${2%%@*}"
}
c() { # c <dir> <msg> [extra commit args]
  echo "$2 $RANDOM" >> "$1/f.txt"; git -C "$1" add -A; git -C "$1" commit -q -m "$2" "${@:3}"
}

mk "$ME" me@example.com
mk "$COL" col@example.com

c "$ME" "init";                      git -C "$ME" push -q origin main
git -C "$COL" pull -q origin main

# feat/mine: two commits by me, on the remote
git -C "$ME" checkout -q -b feat/mine;   c "$ME" m1; c "$ME" m2; git -C "$ME" push -q origin feat/mine
# main2: mine, name starts with "main"
git -C "$ME" checkout -q -b main2 main;  c "$ME" m2a;            git -C "$ME" push -q origin main2
# feat/theirs: colleague only
git -C "$COL" checkout -q -b feat/theirs; c "$COL" t1;           git -C "$COL" push -q origin feat/theirs
# feat/mixed: mine, then a colleague commit on top
git -C "$ME" checkout -q -b feat/mixed main; c "$ME" x1;         git -C "$ME" push -q origin feat/mixed
git -C "$COL" fetch -q; git -C "$COL" checkout -q feat/mixed;    c "$COL" x2; git -C "$COL" push -q origin feat/mixed
# feat/merged: colleague branch merged into main (zero unique commits)
git -C "$COL" checkout -q -b feat/merged main; c "$COL" g1;      git -C "$COL" push -q origin feat/merged
git -C "$COL" checkout -q main; git -C "$COL" merge -q --ff-only feat/merged; git -C "$COL" push -q origin main
# feat/stale: mine on remote, then a colleague adds a commit I have NOT fetched
git -C "$ME" checkout -q -b feat/stale main; c "$ME" s1;         git -C "$ME" push -q origin feat/stale
git -C "$ME" fetch -q
git -C "$COL" fetch -q; git -C "$COL" checkout -q feat/stale;    c "$COL" s2; git -C "$COL" push -q origin feat/stale
# feat/rebased: mine on remote; locally rebased (needs a forced update)
git -C "$ME" checkout -q -b feat/rebased main; c "$ME" r1;       git -C "$ME" push -q origin feat/rebased
git -C "$ME" commit -q --amend -m "r1 amended"
# feat/zero-mine: on the remote at the first commit of main (zero unique commits); locally one commit by me
git -C "$ME" checkout -q -b feat/zero-mine main;   git -C "$ME" push -q origin feat/zero-mine;   c "$ME" z1
# feat/zero-theirs: same, but the first local commit is the colleague's
git -C "$ME" checkout -q -b feat/zero-theirs main; git -C "$ME" push -q origin feat/zero-theirs; c "$ME" z2 --author="col <col@example.com>"
# feat/leased: mine, then a colleague commit on top that I fetched; my local branch does not hold it
git -C "$ME" checkout -q -b feat/leased main; c "$ME" l1;        git -C "$ME" push -q origin feat/leased
git -C "$COL" fetch -q; git -C "$COL" checkout -q feat/leased;   c "$COL" l2; git -C "$COL" push -q origin feat/leased
# feat/kept: mine, colleague, mine on the remote; locally only my last commit is amended
git -C "$ME" checkout -q -b feat/kept main; c "$ME" k1;          git -C "$ME" push -q origin feat/kept
git -C "$COL" fetch -q; git -C "$COL" checkout -q feat/kept;     c "$COL" k2; git -C "$COL" push -q origin feat/kept
git -C "$ME" pull -q --ff-only origin feat/kept; c "$ME" k3;     git -C "$ME" push -q origin feat/kept
git -C "$ME" commit -q --amend -m "k3 amended"
# feat/hijack: the colleague's branch on the remote; my local branch of that name holds only my commit
git -C "$COL" checkout -q -b feat/hijack main; c "$COL" h1;      git -C "$COL" push -q origin feat/hijack
git -C "$ME" checkout -q -b feat/hijack main; c "$ME" h2

# my clone: bring in everything except the colleague's late commit on feat/stale
git -C "$ME" fetch -q origin main feat/theirs feat/mixed feat/merged
git -C "$ME" update-ref refs/remotes/origin/main FETCH_HEAD 2>/dev/null || true
git -C "$ME" fetch -q origin '+refs/heads/main:refs/remotes/origin/main' '+refs/heads/feat/theirs:refs/remotes/origin/feat/theirs' '+refs/heads/feat/mixed:refs/remotes/origin/feat/mixed' '+refs/heads/feat/merged:refs/remotes/origin/feat/merged' '+refs/heads/feat/leased:refs/remotes/origin/feat/leased' '+refs/heads/feat/hijack:refs/remotes/origin/feat/hijack'
git -C "$ME" branch -q feat/theirs origin/feat/theirs
git -C "$ME" branch -q feat/mixed-local origin/feat/mixed 2>/dev/null || true
git -C "$ME" branch -q -f feat/mixed origin/feat/mixed
git -C "$ME" branch -q feat/merged origin/feat/merged
# local-only branch, and a tag
git -C "$ME" checkout -q -b feat/new main; c "$ME" n1
git -C "$ME" tag v1
git -C "$ME" checkout -q feat/mine
# a second worktree, like sibling worktrees
git -C "$ME" worktree add -q "$WT" feat/new
set +e

# --- fixtures ---
FAILED=0
N=0
# f <expected A|B> <cwd> <note> <command> [text the block message must hold]
#   A = exit 0, B = exit 2, any other exit fails
f() {
  local want=$1 cwd=$2 note=$3 cmd=$4 why=${5:-} err code
  N=$((N + 1))
  [ "$want" = A ] && want=0 || want=2
  err=$(jq -n --arg c "$cmd" --arg d "$cwd" '{tool_input: {command: $c}, cwd: $d}' | bash "$HOOK" 2>&1 >/dev/null); code=$?
  if [ "$code" != "$want" ]; then echo "FAIL $N: exit $code, want $want | $note | ${err:0:100}"; FAILED=1; return; fi
  case "$err" in *"$why"*) ;; *) echo "FAIL $N: blocked for another reason, want '$why' | $note | ${err:0:100}"; FAILED=1; return ;; esac
  echo "PASS $N $note"
}

HEREDOC_SCRIPT=$(cat <<'EOS'
cat > /tmp/handover.sh <<'EOF'
#!/bin/bash
# A HUMAN runs this
git push -u origin "feat/WAT-1811-agent2-recheck" && glab mr create --fill
git push --force-with-lease -u origin feat/other
EOF
chmod +x /tmp/handover.sh
EOS
)

# allow: my work, accepted shape
f A /tmp "new branch, cd + tail" "cd $ME && git push -u origin feat/new 2>&1 | tail -3"
f A "$ME" "mine on remote, cwd from hook input" "git push origin feat/mine"
f A /tmp "sibling worktree" "cd $WT && git push --set-upstream origin feat/new"
f A /tmp "rebased own branch, lease" "cd $ME && git push --force-with-lease origin feat/rebased"
f A /tmp "name starts with main" "cd $ME && git push origin main2"
f A /tmp "dry run, own branch" "cd $ME && git push --dry-run origin feat/mine"
# allow: text mentions
f A /tmp "heredoc hand-over script, phrase at line start" "$HEREDOC_SCRIPT"
f A /tmp "task-anchor next: line" 'echo "next: Thanapat runs git push origin feat/x" >> anchor.md'
f A /tmp "grep for the phrase" "grep -c 'git push' docs/mr.md"
f A /tmp "python string literal" $'python3 -c "cmds = [\'git push\', \'git log\']; print(cmds)"'
f A "$ME" "multi-line commit message" $'git commit -m "docs: gate\n\ngit push is now checked by the hook"'
f A "$ME" "stash push" 'git stash push -m "wip"'
f A /tmp "shell comment" $'# the human runs git push later\nls -la'
f A "$ME" "pre-push file, grep push" 'cat .git/hooks/pre-push; git log --oneline | grep push'
f A "$ME" "push config reads" 'git config --get push.default; git remote get-url --push origin'
# block: default branch
f B "$ME" "default branch" 'git push origin main'
f B /tmp "default branch, full shape" "cd $ME && git push -u origin main 2>&1 | tail -3"
# block: shapes outside the one accepted
f B /tmp "bare push (target depends on config)" "cd $ME && git push"
f B /tmp "HEAD" "cd $ME && git push origin HEAD"
f B /tmp "colon refspec onto main" "cd $ME && git push origin feat/new:main"
f B /tmp "--force" "cd $ME && git push --force origin feat/mine"
f B /tmp "-f" "cd $ME && git push -f origin feat/mine"
f B /tmp "+refspec" "cd $ME && git push origin +feat/mine"
f B /tmp "--no-verify (would skip lfs pre-push)" "cd $ME && git push --no-verify origin feat/mine"
f B /tmp "--delete" "cd $ME && git push --delete origin feat/mine"
f B /tmp "--tags" "cd $ME && git push origin --tags"
f B /tmp "other remote" "cd $ME && git push upstream feat/mine"
f B /tmp "git -C" "git -C $ME push origin main"
f B /tmp "git -C with quoted path" "git -C \"$ME\" push origin main"
f B "$ME" "env prefix" 'GIT_SSH_COMMAND="ssh -v" git push origin feat/mine'
f B /tmp "bash -c wrapper" "bash -c \"cd $ME && git push origin main\""
f B "$ME" "commit and push chained" 'git add -A && git commit -m "x" && git push origin feat/mine'
f B /tmp "push chained with glab" "cd $ME && git push origin feat/mine && glab mr create --fill"
f B "$ME" "path-qualified git" '/usr/bin/git push origin main'
f B "$ME" "heredoc, then a real push" $'cat > /tmp/x.md <<\'EOF\'\nnotes\nEOF\ngit push origin main'
f B /tmp "two pushes" "cd $ME && git push origin feat/mine; git push origin main"
f B /tmp "not a repo" 'cd /nonexistent/dir && git push origin feat/mine'
# ownership (first commit of the branch decides)
f B /tmp "colleague's branch" "cd $ME && git push origin feat/theirs"
f A /tmp "first commit mine, colleague commit on top" "cd $ME && git push origin feat/mixed"
f B /tmp "merged branch, zero unique commits" "cd $ME && git push origin feat/merged"
f B /tmp "remote tip not fetched" "cd $ME && git push origin feat/stale"
f B /tmp "lease, remote tip not fetched" "cd $ME && git push --force-with-lease origin feat/stale"
f B /tmp "lease on a branch not on remote" "cd $ME && git push --force-with-lease origin feat/new"
f B /tmp "tag" "cd $ME && git push origin v1"
f B /tmp "remote-tracking name" "cd $ME && git push origin origin/main"
f B /tmp "colleague's branch on origin, mine locally" "cd $ME && git push origin feat/hijack" "first commit of 'feat/hijack' on origin"
f B /tmp "lease on a colleague's branch, blocked by ownership" "cd $ME && git push --force-with-lease origin feat/hijack" "first commit of 'feat/hijack' on origin"
# A failing tool must block, never read as "no commits" or "new branch". Each stand-in fails when
# one of its arguments matches its pattern (git: FAIL_LOG_IF, only for 'git log'; awk: FAIL_AWK_IF), else runs the real tool.
SHIM="$TMP/shim"; mkdir -p "$SHIM"; REAL_GIT=$(command -v git); REAL_AWK=$(command -v awk); export REAL_GIT REAL_AWK
printf '%s\n' '#!/bin/bash' 'for a; do [ "$a" = log ] && L=1; done' \
  'if [ -n "$L" ]; then for a; do case "$a" in $FAIL_LOG_IF) exit 128 ;; esac; done; fi' \
  'exec "$REAL_GIT" "$@"' > "$SHIM/git"
printf '%s\n' '#!/bin/bash' 'for a; do case "$a" in $FAIL_AWK_IF) exit 2 ;; esac; done' \
  'exec "$REAL_AWK" "$@"' > "$SHIM/awk"; chmod +x "$SHIM/git" "$SHIM/awk"
NOLOG="git log failed"
PATH="$SHIM:$PATH" FAIL_LOG_IF=nomatch FAIL_AWK_IF=nomatch f A /tmp "stand-ins, nothing fails" "cd $ME && git push --force-with-lease origin feat/kept"
PATH="$SHIM:$PATH" FAIL_LOG_IF='*' f B /tmp "git log fails always (old gate blocked too, as 'no commits')" "cd $ME && git push origin feat/mine" "$NOLOG"
PATH="$SHIM:$PATH" FAIL_LOG_IF='[0-9a-f]*..[0-9a-f]*' f B /tmp "git log fails on the origin range only" "cd $ME && git push origin feat/hijack" "$NOLOG"
PATH="$SHIM:$PATH" FAIL_LOG_IF='refs/heads/*..*' f B /tmp "git log fails in the lease check only" "cd $ME && git push --force-with-lease origin feat/kept" "$NOLOG"
PATH="$SHIM:$PATH" FAIL_AWK_IF='r=refs/heads/*' f B /tmp "awk fails reading the remote tip" "cd $ME && git push origin feat/theirs" "cannot parse the remote listing"
# block: detection gaps (tab, line continuation, shell reading stdin)
f B "$ME" "tab between the two words" $'git\tpush origin main'
f B "$ME" "line continuation between the two words" $'git \\\n  push origin main'
f B "$ME" "comment ending in a backslash, then a real push" $'# note \\\ngit push origin main'
f B "$ME" "shell fed by a heredoc" $'bash <<\'EOF\'\ngit push origin main\nEOF'
f B "$ME" "shell fed by a pipe" "echo 'git push origin main' | bash"
f B "$ME" "shell fed by a pipe, with an option" "echo 'git push origin main' | bash -s 2>&1"
f A /tmp "|| is not a pipe into a shell" "grep -q 'git push' docs/mr.md || bash fix.sh"
f A /tmp "pipe feeds data to a script file" $'echo \'{"command":"git push"}\' | bash /tmp/hook.sh; echo rc=$?'
f A /tmp "heredoc feeds data to a script file" $'bash /tmp/hook.sh <<\'EOF\'\n{"command":"git push"}\nEOF'
# ownership: first-commit rule on the local branch, and the lease rule
f A /tmp "remote has zero unique commits, first local mine" "cd $ME && git push origin feat/zero-mine"
f B /tmp "remote has zero unique commits, first local theirs" "cd $ME && git push origin feat/zero-theirs"
f B /tmp "lease would replace a colleague commit" "cd $ME && git push --force-with-lease origin feat/leased"
f A /tmp "lease replaces only mine, colleague commit kept" "cd $ME && git push --force-with-lease origin feat/kept"

echo "$N fixtures"
exit $FAILED

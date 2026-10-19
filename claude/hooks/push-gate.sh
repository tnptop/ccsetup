#!/bin/bash
# Push gate for the Claude Code PreToolUse(Bash) hook. bash 3.2, jq, perl, git.
# Installed as ~/.claude/hooks/push-gate.sh by push-hook-lab/apply.sh; fixtures live in that lab.
# It covers the push rules only; block-dangerous-git.sh keeps reset --hard, clean, branch -D,
# checkout . and restore .

# Any failure must block. A hook that exits 1 is a non-blocking error: the push would run.
trap 'rc=$?; [ "$rc" -eq 0 ] || exit 2' EXIT

MY_EMAILS=""        # knob: extra author emails that count as "me", space separated
NET_TIMEOUT=20      # knob: seconds allowed for the remote lookup

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty') || exit 2
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty') || exit 2
SHAPE='[cd <absolute path> && ]git push [-u] [--force-with-lease] [--dry-run] origin <local-branch-name> [2>&1] [| tail -N]'
block() { printf 'BLOCKED: %s\n' "$1" >&2; exit 2; }

case "$CMD" in *push*) ;; *) exit 0 ;; esac

# 1. Skeleton: drop heredoc bodies, quoted strings and comments. What is left is what the shell runs.
#    A dropped heredoc leaves "<<" plus the rest of its line. Backslash-newline is joined last,
#    because a comment does not continue over it but a heredoc line does.
SKEL=$(printf '%s' "$INPUT" | jq -r '
  (.tool_input.command // "")
  | gsub("(?<!<)<<-?[ \\t]*[\u0027\"\\\\]?(?<d>[A-Za-z_][A-Za-z0-9_]*)[\u0027\"]?(?<rest>(?:\\\\\\n|[^\\n])*)[\\s\\S]*?\\n[ \\t]*\\k<d>(?=\\n|\\z)|\u0027[^\u0027]*\u0027|\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|(?:^|(?<=\\s))#[^\\n]*";
         (if .d then "<<" + .rest else "" end))
  | gsub("\\\\\\n"; "")') || exit 2
SKEL=${SKEL//$'\n'/ ; }
SKEL=${SKEL//git stash push/git stash}

# 2. Is a push really being run? Broad on purpose: git, anything, then the word push, in one segment.
#    Known limits, not caught: a quoted subcommand (git "push" ...) and a variable (g=git; $g push ...).
DETECT='(^|[^A-Za-z0-9_.-])git[[:space:]]([^;&|]*[[:space:]])?push([[:space:];&|)]|$)'
EVALWRAP='(^|[^A-Za-z0-9_.-])((ba|z|da)?sh[[:space:]]+-[a-z]*c|eval)([[:space:]]|$)'
# a shell reading its script from stdin: fed by a heredoc / here-string, or first command after a pipe.
# A shell with a script file operand (bash x.sh) reads data from stdin, not a script: not matched.
STDINSH='(^|[^A-Za-z0-9_.-])(ba|z|da)?sh([[:space:]]+[-+0-9>][^;&|]*)?[[:space:]]*<<|(^|[^|])\|&?[[:space:]]*([^[:space:];&|]*/)?(ba|z|da)?sh([[:space:]]*([;&|)<>]|$)|[[:space:]]+[-+0-9])'
RAWPUSH='git[[:space:]].*push'
if [[ $SKEL =~ $DETECT ]]; then
  :
elif { [[ $SKEL =~ $EVALWRAP ]] || [[ $SKEL =~ $STDINSH ]]; } && [[ $CMD =~ $RAWPUSH ]]; then
  block "a push inside sh -c / eval / a shell fed by a heredoc or a pipe cannot be checked. Run it directly as: $SHAPE"
else
  exit 0    # text mention only (heredoc, quoted string, comment, grep, stash push)
fi

# 3. Exactly one shape is accepted, matched against the whole raw command.
ALLOW='^(cd ([A-Za-z0-9_./~@+-]+) && )?git push(( (-u|--set-upstream|--force-with-lease|--dry-run))*) origin ([A-Za-z0-9][A-Za-z0-9._/-]*)( 2>&1)?( \| (tail|head)( -n)? -?[0-9]+)?$'
[[ $CMD =~ $ALLOW ]] || block "this push is not in the accepted shape. Run it alone, as: $SHAPE"
DIR=${BASH_REMATCH[2]:-$CWD}; FLAGS=${BASH_REMATCH[3]}; B=${BASH_REMATCH[6]}
case "$DIR" in "~"|"~/"*) DIR="$HOME${DIR#\~}" ;; esac
case "$DIR" in /*) ;; *) block "the push directory must be an absolute path (got '$DIR')" ;; esac
g() { git -C "$DIR" "$@"; }
g rev-parse --git-dir >/dev/null 2>&1 || block "'$DIR' is not a git repository"

# 4. Default branch: static names first (no network needed), live default after.
case "$B" in main|master) block "'$B' is a default branch. The user pushes it by hand." ;; esac
g show-ref --verify --quiet "refs/heads/$B" || block "no local branch named '$B' (tags, HEAD and remote refs are not accepted)"
URL=$(g remote get-url --push origin 2>/dev/null) && [ -n "$URL" ] || block "no remote named origin"
LS=$(GIT_TERMINAL_PROMPT=0 perl -e 'alarm shift; exec @ARGV' "$NET_TIMEOUT" git -C "$DIR" ls-remote --symref "$URL" HEAD "refs/heads/$B" 2>/dev/null) \
  || block "cannot read the remote (offline, auth, or timeout). Not pushing blind."
DEF=$(printf '%s\n' "$LS" | awk '$1=="ref:" && $3=="HEAD" {sub("^refs/heads/","",$2); print $2}')
DEFSHA=$(printf '%s\n' "$LS" | awk '$1!="ref:" && $2=="HEAD" {print $1}')
TIP=$(printf '%s\n' "$LS" | awk -v r="refs/heads/$B" '$2==r {print $1}')
[ -n "$DEF" ] && [ -n "$DEFSHA" ] || block "cannot determine the default branch of origin"
[ "$B" != "$DEF" ] || block "'$B' is the default branch of origin. The user pushes it by hand."

# 5. Ownership. Git records no branch creator, so: new on the remote, or the first commit of the
#    branch (oldest first-parent commit beyond the default branch) is authored by me. A remote
#    branch with no commits of its own gets the same test on the local branch.
LEASE=0; case "$FLAGS" in *--force-with-lease*) LEASE=1 ;; esac
if [ -z "$TIP" ]; then
  [ "$LEASE" -eq 0 ] || block "'$B' is not on origin yet. Push it without --force-with-lease."
  exit 0
fi
g cat-file -e "$TIP^{commit}" 2>/dev/null && g cat-file -e "$DEFSHA^{commit}" 2>/dev/null \
  || block "origin has commits that are not in this clone. Run 'git fetch origin', look at them, then retry."
ME=" $(g config user.email) $MY_EMAILS "
mine() { case "$ME" in *" $1 "*) return 0 ;; esac; return 1; }
ae() { g log --format=%ae "$@" | sed 's/^$/?/'; }    # author emails; an empty one prints as "?", never as "no commit"
FIRST=$(ae --first-parent --reverse "$DEFSHA..$TIP" | head -n 1); WHERE="on origin"
if [ -z "$FIRST" ]; then
  FIRST=$(ae --first-parent --reverse "$DEFSHA..refs/heads/$B" | head -n 1); WHERE="in this clone"
  [ -n "$FIRST" ] || block "'$B' has no commits of its own, on origin or locally (merged or freshly cut). Cannot prove it is the user's branch."
fi
mine "$FIRST" || block "the first commit of '$B' $WHERE is by $FIRST. Not the user's branch."

# 6. Forced update: only with a lease, and only when the lease is tied to the tip checked above.
if [ "$LEASE" -eq 1 ]; then
  [ "$(g rev-parse -q --verify "refs/remotes/origin/$B")" = "$TIP" ] \
    || block "refs/remotes/origin/$B differs from the live tip of origin. Run 'git fetch origin' and review first."
  # not yet ruled by the user; delete this block to drop it
  for a in $(ae "refs/heads/$B..$TIP" | sort -u); do
    mine "$a" || block "the forced update would replace commits by $a on origin/$B. Not the user's to overwrite."
  done
fi
exit 0

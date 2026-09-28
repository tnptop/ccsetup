# PreToolUse hook (Bash/PowerShell): hard-block any deletion command.
# Uses exit 2 (confirmed to actually block under bypassPermissions), not the
# permissionDecision:"ask" JSON path, which testing showed bypassPermissions ignores.
#
# Matching rules:
# - A deletion verb counts only in command position: start of the command, or after
#   ; & | ( { newline $( backtick, or after sudo/env/exec/xargs/-exec/then/do/else.
# - Quoted strings are ignored ('...' and "..."), so words inside grep patterns,
#   jq filters, and messages do not trigger. Exception: when the command re-evaluates
#   a string (bash -c, powershell -Command, eval, Invoke-Expression, ...), nothing is
#   ignored and any deletion word anywhere blocks, as before.
# - Exemption: non-recursive rm/rmdir/unlink/Remove-Item whose every target is under
#   ~/.claude/task-anchors/ (the /claim-task and /park skills). A target may be a
#   shell variable only when the same command mentions .claude/task-anchors.
$ErrorActionPreference = 'Stop'

$raw = [Console]::In.ReadToEnd()
$json = $raw | ConvertFrom-Json
$command = [string]$json.tool_input.command

if (-not $command) {
    exit 0
}

$verbs = 'rm|rmdir|Remove-Item|del|erase|unlink|shred|ri|rd'
$prefix = '(?:^|[;&|({\n`]|\$\(|\b(?:sudo|env|exec|xargs|then|do|else|nohup|time)\s+|-exec\s+)\s*'
$anchored = "(?im)$prefix(?:$verbs)(?=\s|$|;|\))"
$gitRm = '(?i)\bgit\s+(?:-C\s+\S+\s+)?rm\b'
$reeval = '(?i)\b(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?["'']?\s(?:[^\n;|&]*?\s)?[-/](?:c|Command|EncodedCommand)\b|\beval\b|\bInvoke-Expression\b|\biex\b|\bInvoke-Command\b|\bStart-Process\b'

function Block($why) {
    [Console]::Error.WriteLine("BLOCKED: '$command' matches dangerous deletion pattern '$why'. The user has prevented you from doing this.")
    exit 2
}

if ($command -match $reeval) {
    # Strict mode: the old rule, any deletion word anywhere.
    foreach ($p in @('\brm\b', '\brmdir\b', '\bRemove-Item\b', '\bdel\b', '\berase\b', '\bunlink\b', '\bshred\b', '\bri\b', '\brd\b', '\bgit\s+rm\b')) {
        if ($command -imatch $p) { Block "$p (command re-evaluates a string)" }
    }
    exit 0
}

$scan = $command -replace "'[^']*'", "''" -replace '"(?:[^"\\]|\\.)*"', '""'

if ($scan -match $gitRm) { Block 'git rm' }

$hits = [regex]::Matches($scan, $anchored)
if ($hits.Count -eq 0) { exit 0 }

# Exemption check for task-anchor housekeeping.
$mentionsAnchors = ($command -replace '\\', '/') -match '\.claude/task-anchors'
$segments = [regex]::Split($command, '\r?\n|;|&&|\|\||\||\{|\}|\bthen\b|\belse\b|\bdo\b')
$exempt = 0
foreach ($seg in $segments) {
    $s = $seg.Trim()
    $m = [regex]::Match($s, '(?i)^(?:sudo\s+)?(rm|rmdir|unlink|Remove-Item)\s+(.+)$')
    if (-not $m.Success) { continue }
    $tokens = [regex]::Matches($m.Groups[2].Value, "'[^']*'|""[^""]*""|\S+") | ForEach-Object { $_.Value }
    $ok = $true
    $targets = 0
    foreach ($t in $tokens) {
        if ($t -match '^(?i)(-[a-z]*r[a-z]*|-R|--recursive|-Recurse)$') { $ok = $false; break }
        if ($t -match '^-') { continue }
        $path = ($t.Trim("'", '"')) -replace '\\', '/'
        $targets++
        if ($path -match '\.claude/task-anchors/') { continue }
        if ($path -match '^\$' -and $mentionsAnchors) { continue }
        $ok = $false; break
    }
    if ($ok -and $targets -gt 0) { $exempt++ }
}

if ($exempt -eq $hits.Count) { exit 0 }

Block $hits[0].Value.Trim()

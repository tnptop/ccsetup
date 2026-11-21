// Run with: node opencode/anchor-sidebar.test.mjs
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CLEAR_AT,
  anchorsDir,
  clearWarning,
  contextTokens,
  countTasks,
  findOwnedTask,
  ownedBy,
  parseState,
  projectRoot,
  readTask,
  rootFromGit,
  slugOf,
  taskLines,
  truncateLeft,
} from "./plugins/ccsetup-anchor/sidebar.js"

// parseState
assert.deepEqual(parseState("STATE 2026-11-20 | ACTIVE | next: write the test | step 2/5"), {
  date: "2026-11-20",
  status: "ACTIVE",
  next: "write the test",
  step: "2/5",
})
assert.deepEqual(parseState("STATE 2026-11-20 | PARKED | next: a | b c"), {
  date: "2026-11-20",
  status: "PARKED",
  next: "a | b c",
  step: undefined,
})
assert.equal(parseState("Port the anchor"), null)
assert.equal(parseState(undefined), null)
assert.equal(parseState("STATE 2026-11-20 | ACTIVE | next: x step 1/3").step, "1/3")

// slug, owner match, truncation
assert.equal(slugOf("/Users/me/work/my_repo.v2"), "-Users-me-work-my-repo-v2")
assert.equal(anchorsDir("/h"), "/h/.claude/task-anchors")
assert.ok(ownedBy("a\nowner: ses_1 \nb", "ses_1"))
assert.ok(!ownedBy("owner: ses_12", "ses_1"))
assert.ok(!ownedBy("owner: ses_1", ""))
assert.ok(!ownedBy("x owner: ses_1", "ses_1"))
assert.equal(truncateLeft("/a/b/c", 10), "/a/b/c")
assert.equal(truncateLeft("~/workspace/personal/ccsetup", 12), "…nal/ccsetup")
assert.equal(truncateLeft("~/workspace/personal/ccsetup", 12).length, 12)
assert.equal(truncateLeft(undefined, 5), "")

// rootFromGit: plain checkout, linked worktree, worktree subdirectory, not a repo
assert.equal(rootFromGit("/r", "/r/.git\n/r/.git\n\n"), "/r")
assert.equal(rootFromGit("/wt", "/r/.git/worktrees/wt\n/r/.git\n\n"), "/r")
assert.equal(rootFromGit("/wt/sub", "/r/.git/worktrees/wt\n/r/.git\nsub/\n"), "/r/sub")
assert.equal(rootFromGit("/x", ""), "/x")

// taskLines
assert.deepEqual(taskLines(undefined), [])
assert.deepEqual(taskLines({ owned: false, count: 3 }), ["no task claimed (3 in index)"])
const owned = (firstLine) => ({ owned: true, slug: "t", firstLine, state: parseState(firstLine) })
assert.deepEqual(taskLines(owned("STATE d | ACTIVE | next: do x | step 1/2")), ["t · ACTIVE", "do x", "step 1/2"])
assert.deepEqual(taskLines(owned("STATE d | PARKED | next: do y")), ["t · PARKED", "do y"])
assert.deepEqual(taskLines(owned("free text")), ["t", "free text"])

// contextTokens: last assistant message with tokens after the last completed compaction; input + cache.
const tokens = (input, read, write, output = 999) => ({ input, output, reasoning: 5, cache: { read, write } })
const assistant = (t) => ({ type: "assistant", tokens: t })
assert.equal(contextTokens([assistant(tokens(3, 150_000, 2_000))]), 152_003)
assert.equal(contextTokens([assistant(tokens(1, 10, 0)), assistant(tokens(3, 200_000, 500)), { type: "user" }, { type: "assistant" }]), 200_503)
assert.equal(contextTokens([assistant(tokens(1, 250_000, 0)), { type: "compaction", status: "completed" }, { type: "user" }]), undefined)
assert.equal(contextTokens([assistant(tokens(1, 250_000, 0)), { type: "compaction", status: "running" }]), 250_001)
assert.equal(contextTokens([{ type: "compaction", status: "completed" }, assistant(tokens(2, 30_000, 0))]), 30_002)
assert.equal(contextTokens([assistant({ input: 7 })]), 7)
assert.equal(contextTokens([]), undefined)
assert.equal(contextTokens(undefined), undefined)

// clearWarning: from 200k, floored to k; nothing below or with no data.
assert.equal(CLEAR_AT, 200_000)
assert.equal(clearWarning(199_999), "")
assert.equal(clearWarning(200_000), "⚠ context ~200k — type /clear")
assert.equal(clearWarning(234_999), "⚠ context ~234k — type /clear")
assert.equal(clearWarning(undefined), "")
assert.equal(clearWarning(NaN), "")
assert.equal(clearWarning(1_500, 1_000), "⚠ context ~1k — type /clear")

// Files: owned task in another project's dir, count, readTask
const home = mkdtempSync(path.join(tmpdir(), "anchor-sidebar-"))
const dir = anchorsDir(home)
mkdirSync(path.join(dir, "-a"), { recursive: true })
mkdirSync(path.join(dir, "-b"), { recursive: true })
writeFileSync(path.join(dir, "-a", "INDEX.md"), "- one | ACTIVE | next: x\n")
writeFileSync(path.join(dir, "-a", "one.md"), "STATE d | ACTIVE | next: x\nowner: ses_other\n")
writeFileSync(path.join(dir, "-a", "two.md"), "STATE d | PARKED | next: y\n")
writeFileSync(path.join(dir, "-a", "notes.txt"), "owner: ses_me\n")
writeFileSync(path.join(dir, "-b", "mine.md"), "STATE d | ACTIVE | next: z | step 3/4\nbody\nowner: ses_me\n")
assert.deepEqual(await findOwnedTask(dir, "ses_me"), { slug: "mine", firstLine: "STATE d | ACTIVE | next: z | step 3/4" })
assert.equal(await findOwnedTask(dir, "ses_none"), undefined)
assert.equal(await findOwnedTask(dir, undefined), undefined)
assert.equal(await findOwnedTask(path.join(home, "missing"), "ses_me"), undefined)
assert.equal(await countTasks(path.join(dir, "-a")), 2)
assert.equal(await countTasks(path.join(dir, "-missing")), 0)

const mine = await readTask({ sessionID: "ses_me", directory: "/nowhere", home })
assert.deepEqual(taskLines(mine), ["mine · ACTIVE", "z", "step 3/4"])

// No owned task: count comes from the worktree-aware root of a real git repo.
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "anchor-repo-")))
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
git("init", "-q", "-b", "main")
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
const wt = `${repo}-wt`
git("worktree", "add", "-q", "-b", "side", wt)
mkdirSync(path.join(dir, slugOf(repo)), { recursive: true })
writeFileSync(path.join(dir, slugOf(repo), "INDEX.md"), "")
writeFileSync(path.join(dir, slugOf(repo), "a.md"), "STATE d | PARKED | next: a\n")
assert.equal(await projectRoot(wt), repo)
assert.equal(await projectRoot(repo), repo)
assert.equal(await projectRoot(path.join(home, "not-a-repo")), path.join(home, "not-a-repo"))
assert.deepEqual(taskLines(await readTask({ sessionID: "ses_none", directory: wt, home })), ["no task claimed (1 in index)"])
assert.deepEqual(taskLines(await readTask({ sessionID: "ses_none", home })), ["no task claimed (0 in index)"])

// projectRoot caches per directory and falls back on a git error.
let calls = 0
const fail = (_cmd, _args, _opts, done) => (calls++, done(new Error("no git")))
assert.equal(await projectRoot("/cache-test", fail), "/cache-test")
assert.equal(await projectRoot("/cache-test", fail), "/cache-test")
assert.equal(calls, 1)

console.log("anchor sidebar tests passed")

// Run with: node opencode/guardrails.test.mjs [hooks dir, default this repo's claude/hooks]
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "./plugins/ccsetup-guardrails.js"

const hooksDir = process.argv[2] ?? fileURLToPath(new URL("../claude/hooks", import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), "guardrails-"))

async function load(options) {
  let before
  await plugin.setup({
    options,
    location: { directory: dir },
    tool: { hook: async (_name, callback) => void (before = callback) },
  })
  return (tool, input) => before({ tool, input })
}

const call = await load({ hooksDir })
const blocked = (tool, input, pattern) => assert.rejects(call(tool, input), pattern)
const big = "x".repeat(25_000)

await blocked("shell", { command: "git reset --hard" }, /BLOCKED/)
await blocked("shell", { command: "cd /tmp && git clean -fd" }, /BLOCKED/)
await blocked("shell", { command: "git -C /tmp reset --hard HEAD" }, /BLOCKED/)
await blocked("shell", { command: "git branch -D topic" }, /BLOCKED/)
await blocked("shell", { command: "git push --force origin topic" }, /BLOCKED/)
await blocked("shell", { command: "git push origin main" }, /BLOCKED/)
await blocked("shell", { command: "git push origin topic" }, /BLOCKED/)
await blocked("write", { path: "big.txt", content: big }, /BLOCKED/)
await call("shell", { command: "git status" })
await call("shell", { command: "git stash push" })
await call("write", { path: "small.txt", content: "ok" })
await call("write", { path: "big.lock", content: big })
await call("read", { path: "anything" })
await call("patch", { patchText: big })

// push-gate.sh: a new branch of mine in a local sandbox passes; the cwd comes from workdir.
// The sandbox git config is isolated, and the gate only checks the command: nothing is pushed.
process.env.GIT_CONFIG_GLOBAL = path.join(dir, "gitconfig")
process.env.GIT_CONFIG_NOSYSTEM = "1"
const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
git("init", "-q", "--bare", "-b", "main", "origin.git")
git("clone", "-q", "origin.git", "clone")
const clone = path.join(dir, "clone")
git("-C", clone, "config", "user.email", "me@example.com")
git("-C", clone, "config", "user.name", "me")
git("-C", clone, "commit", "-q", "--allow-empty", "-m", "init")
git("-C", clone, "push", "-q", "origin", "HEAD:main")
git("-C", clone, "checkout", "-q", "-b", "feat/mine")
git("-C", clone, "commit", "-q", "--allow-empty", "-m", "mine")
await call("shell", { command: "git push -u origin feat/mine", workdir: clone })
await call("shell", { command: `cd ${clone} && git push origin feat/mine 2>&1 | tail -3` })
await call("shell", { command: "grep -c 'git push' notes.md" })
await blocked("shell", { command: "git push origin main", workdir: clone }, /default branch/)
await blocked("shell", { command: "git push origin feat/mine && glab mr create", workdir: clone }, /accepted shape/)

writeFileSync(path.join(dir, "edit.txt"), "a".repeat(19_990))
await blocked("edit", { path: "edit.txt", oldString: "a", newString: big }, /BLOCKED/)
await call("edit", { path: "edit.txt", oldString: "a", newString: "b" })

// Fails closed.
const missing = await load({ hooksDir: path.join(dir, "no-such-dir") })
await assert.rejects(missing("shell", { command: "git status" }), /missing/)
await assert.rejects(missing("write", { path: "a", content: "b" }), /missing/)
writeFileSync(path.join(dir, "block-dangerous-git.sh"), "#!/bin/sh\nexit 1\n")
chmodSync(path.join(dir, "block-dangerous-git.sh"), 0o755)
const failing = await load({ hooksDir: dir })
await assert.rejects(failing("shell", { command: "git status" }), /exit code 1/)

console.log("guardrails tests passed")

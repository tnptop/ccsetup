// Run with: node opencode/guardrails.test.mjs [hooks dir, default this repo's claude/hooks]
import assert from "node:assert/strict"
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

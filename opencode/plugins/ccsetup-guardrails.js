// ccsetup guardrails: runs the Claude Code PreToolUse hook scripts on OpenCode tool calls.
// OpenCode's Claude Agent provider turns Claude Code hooks off, so this is what enforces them there.
// Install copies the scripts to ../guardrails, so this does not depend on what ~/.claude holds on a machine.
// Any failure blocks: a missing script, a missing jq, a missing Git Bash on Windows, a timeout, or a non-zero exit.
// Not covered: the patch tool skips token-limit, because a patch has no single target and size.
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TIMEOUT_MS = 30_000
// A background OpenCode service may not have Homebrew on PATH, and block-dangerous-git.sh passes when jq is absent.
const PATH_ENV = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(path.delimiter)

function run(command, args, stdin, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      env: { ...process.env, PATH: PATH_ENV },
      stdio: ["pipe", "ignore", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.stdin.on("error", () => {}) // a script that exits without reading stdin is not a failure
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: error.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stderr })
    })
    child.stdin.end(stdin ?? "")
  })
}

// Windows cannot run a script from its shebang line, and the bash on a plain Windows PATH is often WSL.
// So on Windows the scripts run under Git Bash: CCSETUP_BASH if set, else bin/bash.exe three levels above `git --exec-path`.
function gitBash() {
  if (process.env.CCSETUP_BASH) return process.env.CCSETUP_BASH
  try {
    const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8", env: { ...process.env, PATH: PATH_ENV } }).trim()
    return path.resolve(execPath, "..", "..", "..", "bin", "bash.exe")
  } catch {
    return undefined
  }
}

// Translate an OpenCode tool call into the scripts to run and the Claude-shaped JSON they read.
function plan(tool, input, directory) {
  const cwd = path.resolve(directory, input?.workdir ?? ".")
  const file = input?.path ? path.resolve(directory, input.path) : undefined
  if (tool === "shell") {
    const command = input?.command ?? ""
    const scripts = ["block-dangerous-git.sh", "push-gate.sh"]
    return { cwd, scripts, payload: { tool_name: "Bash", tool_input: { command }, cwd } }
  }
  if (tool === "write") {
    const tool_input = { file_path: file, content: input?.content ?? "" }
    return { cwd, scripts: ["token-limit.sh"], payload: { tool_name: "Write", tool_input, cwd } }
  }
  if (tool === "edit") {
    const tool_input = { file_path: file, old_string: input?.oldString ?? "", new_string: input?.newString ?? "" }
    return { cwd, scripts: ["token-limit.sh"], payload: { tool_name: "Edit", tool_input, cwd } }
  }
  return undefined
}

export default {
  id: "ccsetup.guardrails",
  async setup(ctx) {
    const hooksDir = ctx.options?.hooksDir ?? fileURLToPath(new URL("../guardrails", import.meta.url))
    const directory = ctx.location?.directory ?? process.cwd()
    let jqFound = false
    let bash

    await ctx.tool.hook("execute.before", async (event) => {
      const call = plan(event.tool, event.input, directory)
      if (!call) return
      if (!jqFound) {
        jqFound = (await run("jq", ["--version"])).code === 0
        if (!jqFound) throw new Error("BLOCKED: ccsetup guardrails need jq, and jq was not found.")
      }
      if (process.platform === "win32" && !bash) {
        const found = gitBash()
        if (!found || !existsSync(found)) {
          throw new Error(`BLOCKED: ccsetup guardrails need Git Bash on Windows, and it was not found (looked for ${found ?? "git"}). Set CCSETUP_BASH to its bash.exe.`)
        }
        bash = found
      }
      const stdin = JSON.stringify(call.payload)
      for (const script of call.scripts) {
        const file = path.join(hooksDir, script)
        if (!existsSync(file)) throw new Error(`BLOCKED: guardrail script is missing: ${file}`)
        const result = bash ? await run(bash, [file], stdin, call.cwd) : await run(file, [], stdin, call.cwd)
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || `BLOCKED: ${script} failed with exit code ${result.code}.`)
        }
      }
    })
  },
}

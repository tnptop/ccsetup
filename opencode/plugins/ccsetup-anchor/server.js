// ccsetup anchor: runs the Claude Code task-anchor hook (~/.claude/hooks/task-anchor.sh) on OpenCode events.
// OpenCode's Claude Agent provider turns Claude Code hooks, CLAUDE.md and auto-memory off, so this plugin
// sends the task anchor, the Context Size and Task Anchor rules, and the memory index to the model instead.
// It fails open: any error, timeout, missing script or missing Git Bash means it does nothing, never a block.
import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { anchorDirOf, takeHandoff } from "./handoff.js"

// A background OpenCode service may not have Homebrew on PATH (task-anchor.sh needs jq).
const PATH_ENV = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(path.delimiter)
const RULES = ["Context Size", "Task Anchor"]

// run and gitBash are copied from ../ccsetup-guardrails.js. Importing that file is avoided on purpose, so each
// plugin works without the other. Changes here: stdout is kept, and the timeout and env are arguments.
function run(command, args, stdin, cwd, env, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      env: { ...process.env, PATH: PATH_ENV, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.stdin.on("error", () => {}) // a script that exits without reading stdin is not a failure
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: error.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
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

// Each char not in A-Za-z0-9 becomes "-", as Claude Code names ~/.claude/projects/<slug>.
const slug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-")
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
const read = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

// The hook's additionalContext, or "".
function context(result) {
  try {
    return JSON.parse(result?.stdout || "{}").hookSpecificOutput?.additionalContext ?? ""
  } catch {
    return ""
  }
}

// The sections of a markdown file whose "# " heading is one of names.
export function sections(text, names) {
  return text
    .split(/^(?=# )/m)
    .filter((part) => part.startsWith("# ") && names.includes(part.split("\n", 1)[0].slice(2).trim()))
    .map((part) => part.trim())
    .join("\n\n")
}

// The Claude Code memory OpenCode does not load: the rules above, how to write a memory, and MEMORY.md.
export function memory(directory) {
  const cfg = configDir()
  const claudeMd = read(path.join(cfg, "CLAUDE.md")) ?? read(path.join(os.homedir(), ".claude", "CLAUDE.md")) ?? ""
  const dir = path.join(cfg, "projects", slug(directory), "memory")
  const parts = [sections(claudeMd, RULES)]
  parts.push(
    `# Memory\n\nYour persistent memory dir is ${dir}${path.sep}. Save one fact per file there. Each file has frontmatter: ` +
      "`name`, `description`, and `metadata:` with `type: user|feedback|project|reference`. Link related memories with `[[name]]`. " +
      "Add a one-line pointer `- [Title](file.md) — hook` to MEMORY.md in that dir. Update an existing memory instead of writing a duplicate.",
  )
  const index = read(path.join(dir, "MEMORY.md"))
  if (index) {
    const head = Buffer.from(index.split("\n").slice(0, 200).join("\n")).subarray(0, 25_000).toString()
    parts.push(`Contents of ${path.join(dir, "MEMORY.md")}:\n\n${head}`)
  }
  return parts.filter(Boolean).join("\n\n")
}

const defaultDb = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db")

async function openReadOnly(file) {
  try {
    const { Database } = await import("bun:sqlite") // OpenCode runs plugins under Bun
    return new Database(file, { readonly: true })
  } catch {
    const { DatabaseSync } = await import("node:sqlite") // node runs the tests
    return new DatabaseSync(file, { readOnly: true })
  }
}

// The Claude Code transcript of an OpenCode session, or "" (none yet on a session's first prompt).
// OpenCode's kv table maps the session to the Claude session; that can change, so this runs on every event.
export async function transcript(sessionID, directory, dbPath) {
  let db
  try {
    if (!sessionID || !existsSync(dbPath)) return ""
    db = await openReadOnly(dbPath)
    const value = db.prepare("SELECT value FROM kv WHERE key LIKE '%:sessions/' || ?").get(sessionID)?.value
    const text = typeof value === "string" ? value : new TextDecoder().decode(value)
    const uuid = JSON.parse(text).claudeSessionID
    if (typeof uuid !== "string" || !/^[\w-]+$/.test(uuid)) return ""
    const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")].filter(Boolean)
    return dirs.map((dir) => path.join(dir, "projects", slug(directory), `${uuid}.jsonl`)).find((file) => existsSync(file)) ?? ""
  } catch {
    return ""
  } finally {
    try {
      db?.close()
    } catch {}
  }
}

// The last assistant text in the transcript's last 400 KB, or "".
export function lastAssistant(file) {
  let fd
  try {
    fd = openSync(file, "r")
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, 400_000))
    readSync(fd, buffer, 0, buffer.length, size - buffer.length)
    const lines = buffer.toString().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i])
        if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue
        const text = entry.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        if (text) return text
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return ""
}

const reminder = (text) => `\n\n<system-reminder>\n${text}\n</system-reminder>`
// The prompt's metadata key that holds its reminder. Metadata is saved with the message but not shown or sent.
export const KEY = "ccsetup.anchor"

// Context hook: adds each user message's saved reminder to its last text part. This changes only the model
// request, so the TUI shows the prompt as typed. A message keeps the same reminder on every turn (cache-safe).
export function addReminders(messages) {
  for (const message of messages ?? []) {
    const text = message?.metadata?.[KEY]
    if (message.role !== "user" || typeof text !== "string" || !Array.isArray(message.content)) continue
    const part = message.content.findLast((c) => c?.type === "text")
    if (part) part.text += reminder(text)
    else message.content.push({ type: "text", text: reminder(text).trimStart() })
  }
}

export default {
  id: "ccsetup.anchor",
  async setup(ctx) {
    const hooksDir = ctx.options?.hooksDir ?? path.join(os.homedir(), ".claude", "hooks")
    const dbPath = ctx.options?.dbPath ?? defaultDb()
    const directory = ctx.location?.directory ?? process.cwd()
    const script = path.join(hooksDir, "task-anchor.sh")
    const env = { CLAUDE_PID: String(process.pid), CLAUDE_PROJECT_DIR: directory }
    const memoryPut = new Map()
    let bash

    // task-anchor.sh [arg] with a Claude-shaped hook payload; undefined when it cannot run.
    async function hook(arg, payload, timeout) {
      try {
        if (!existsSync(script)) return undefined
        if (process.platform === "win32" && !bash) {
          const found = gitBash()
          if (!found || !existsSync(found)) return undefined
          bash = found
        }
        const args = arg ? [arg] : []
        const stdin = JSON.stringify({ cwd: directory, ...payload })
        return bash ? await run(bash, [script, ...args], stdin, directory, env, timeout) : await run(script, args, stdin, directory, env, timeout)
      } catch {
        return undefined
      }
    }

    async function isChild(sessionID) {
      try {
        return Boolean((await ctx.session.get({ sessionID }))?.parentID)
      } catch {
        return false
      }
    }

    async function putMemory(sessionID) {
      try {
        const value = memory(directory)
        if (memoryPut.get(sessionID) === value) return
        await ctx.session.instructions.entry.put({ sessionID, key: "ccsetup.memory", value })
        memoryPut.set(sessionID, value)
      } catch {}
    }

    // Registers a handler that never throws; a hook OpenCode does not have is skipped.
    async function on(api, name, handler) {
      try {
        await api.hook(name, async (event) => {
          try {
            await handler(event)
          } catch {}
        })
      } catch {}
    }

    // /clear hand-off (tui.jsx writes the note, handoff.js has the rules): on the first prompt this process
    // sees for a session, before the hook runs, take the claim of the session the TUI cleared. The hook's
    // view and last runs then give this first prompt the lane view and the last exchange.
    const seen = new Set()
    async function handoff(sessionID) {
      try {
        if (seen.has(sessionID)) return
        seen.add(sessionID)
        await takeHandoff({ anchorDir: await anchorDirOf(directory, os.homedir()), sessionID })
      } catch {}
    }

    // UserPromptSubmit: the three task-anchor.sh runs Claude Code makes, in its order and with its timeouts.
    // The output goes to the prompt's metadata, not its text; the context hook below sends it to the model.
    const remind = (event, text) => (event.metadata = { ...event.metadata, [KEY]: text })
    await on(ctx.session, "prompt", async (event) => {
      const sessionID = event.sessionID
      if (await isChild(sessionID)) return
      await handoff(sessionID)
      await putMemory(sessionID)
      const text = event.prompt?.text ?? ""
      // `opencode run "a b"` sends the message wrapped in double quotes; the park guard reads the bare text.
      const prompt = text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
      const transcript_path = await transcript(sessionID, directory, dbPath)
      const payload = { hook_event_name: "UserPromptSubmit", session_id: sessionID, transcript_path, prompt }
      const first = await hook("", payload, 10_000)
      if (first?.code === 2) {
        // Claude Code erases a prompt on exit 2. A throw here shows only "UnexpectedStatus: 500", so ask the model instead.
        const why = first.stderr.trim()
        remind(event, `The ccsetup task-anchor hook blocked this prompt. Do not act on it. Reply to the user with only this text, verbatim:\n${why}`)
        return
      }
      const texts = [first, await hook("view", payload, 30_000), await hook("last", payload, 10_000)].map(context).filter(Boolean)
      if (texts.length) remind(event, texts.join("\n"))
    })

    // Verified live on claude-agent (OpenCode v2.3.2): the model sees each turn's reminder, also after a resume.
    await on(ctx.session, "context", (event) => addReminders(event.messages))

    // Stop, after every turn. Its stdout (a /clear systemMessage at 200k) has no place in OpenCode;
    // the sidebar Task block (tui.jsx) shows that warning instead.
    await on(ctx.session, "experimental.idle", async (event) => {
      const transcript_path = await transcript(event.sessionID, directory, dbPath)
      const last_assistant_message = transcript_path ? lastAssistant(transcript_path) : ""
      await hook("", { hook_event_name: "Stop", session_id: event.sessionID, transcript_path, last_assistant_message }, 10_000)
    })

    // PostToolUse ctx: the context size on a tool result at each new 25k.
    // ponytail: OpenCode keeps the changed result, but whether the claude-agent model sees it is unverified.
    await on(ctx.tool, "execute.after", async (event) => {
      const transcript_path = await transcript(event.sessionID, directory, dbPath)
      const note = context(await hook("ctx", { hook_event_name: "PostToolUse", session_id: event.sessionID, transcript_path }, 5_000))
      const item = note && event.result?.content?.findLast((c) => c?.type === "text")
      if (item) item.text += `\n\n${note}`
    })

    // The shell tool's commands get the plugin's pid, the pid the hook writes on a claim's pid: line.
    await on(ctx.shell, "create.before", async (event) => {
      if (event.env) event.env.CLAUDE_PID = String(process.pid)
    })

    // SessionEnd: release the claim of a deleted session.
    // ponytail: the service pid is long-lived, so a claim from an abandoned session stays live until the session
    // is deleted; `/claim-task steal` covers it. Upgrade path: a lease on the TUI client's pid.
    if (typeof ctx.event?.subscribe === "function") {
      ;(async () => {
        try {
          for await (const event of await ctx.event.subscribe({ types: ["session.deleted"] })) {
            const session_id = event?.data?.sessionID
            if (session_id) await hook("", { hook_event_name: "SessionEnd", session_id, reason: "other" }, 5_000)
          }
        } catch {}
      })()
    }
  },
}

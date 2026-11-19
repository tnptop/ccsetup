// Run with: node opencode/anchor.test.mjs [hooks dir, default this repo's claude/hooks]
// A temp HOME and config dir: nothing reads or writes the real ~/.claude.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import plugin, { lastAssistant } from "./plugins/ccsetup-anchor/server.js"

const hooksDir = process.argv[2] ?? fileURLToPath(new URL("../claude/hooks", import.meta.url))
const tmp = mkdtempSync(path.join(tmpdir(), "anchor-"))
const proj = path.join(tmp, "proj")
const cfg = path.join(tmp, "cfg")
mkdirSync(proj)
process.env.HOME = process.env.USERPROFILE = path.join(tmp, "home")
process.env.CLAUDE_CONFIG_DIR = cfg
process.env.TMPDIR = tmp // the ctx hook's per-session state file
process.env.LANES_ROOT = path.join(tmp, "lanes")
delete process.env.OMPCODE
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, "-")
const anchors = path.join(tmp, "home", ".claude", "task-anchors", slug(proj))
const task = path.join(anchors, "t1.md")
mkdirSync(anchors, { recursive: true })

// The OpenCode database: a kv row maps ses_t to its Claude session uuid-1.
const dbPath = path.join(tmp, "opencode.db")
const db = new DatabaseSync(dbPath)
db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
db.prepare("INSERT INTO kv VALUES (?, ?)").run("plugin:claude-agent:sessions/ses_t", JSON.stringify({ claudeSessionID: "uuid-1", x: 1 }))
db.close()
const transcriptDir = path.join(cfg, "projects", slug(proj))
mkdirSync(transcriptDir, { recursive: true })
const usage = { input_tokens: 1000, cache_read_input_tokens: 129_000, cache_creation_input_tokens: 0, output_tokens: 10 }
writeFileSync(
  path.join(transcriptDir, "uuid-1.jsonl"),
  [
    { type: "assistant", message: { content: [{ type: "text", text: "the last reply" }], usage } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }], usage } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n",
)

writeFileSync(path.join(cfg, "CLAUDE.md"), "@AGENTS.md\n\n# Guardrails\n\ng\n\n# Context Size\n\nsave at 200k\n\n# Task Anchor\n\nfollow the anchor\n\n# Orchestration\n\ndelegate\n")
mkdirSync(path.join(transcriptDir, "memory"))
writeFileSync(path.join(transcriptDir, "memory", "MEMORY.md"), "# Memory Index\n\n- [Fact](fact.md) — a fact\n")

// A stub OpenCode ctx that keeps the handlers and the instruction entries.
async function load(options, parentID) {
  const hooks = {}
  const puts = []
  const api = (prefix) => ({ hook: async (name, handler) => void (hooks[prefix + name] = handler) })
  await plugin.setup({
    options: { dbPath, ...options },
    location: { directory: proj },
    session: { ...api("session."), get: async () => ({ id: "s", parentID }), instructions: { entry: { put: async (e) => void puts.push(e) } } },
    tool: api("tool."),
    shell: api("shell."),
  })
  const prompt = async (text, sessionID = "ses_t") => {
    const event = { sessionID, messageID: "m", prompt: { text, files: [] } }
    await hooks["session.prompt"](event)
    return event.prompt.text
  }
  return { hooks, puts, prompt }
}

const { hooks, puts, prompt } = await load({ hooksDir })

// Unowned: the index of the dir's tasks and this session's id.
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nprose\n")
let text = await prompt("hello")
assert.match(text, /^hello\n\n<system-reminder>\nTASK ANCHOR INDEX \(/)
assert.match(text, /session_id: ses_t /)
assert.match(text, /\n<\/system-reminder>$/)

// Memory: the two rule sections, how to write a memory, MEMORY.md; put once while unchanged.
assert.equal(puts.length, 1)
assert.equal(puts[0].sessionID, "ses_t")
assert.equal(puts[0].key, "ccsetup.memory")
assert.match(puts[0].value, /^# Context Size\n\nsave at 200k\n\n# Task Anchor\n\nfollow the anchor/)
assert.doesNotMatch(puts[0].value, /# Orchestration|# Guardrails|@AGENTS/)
assert.ok(puts[0].value.includes(path.join(transcriptDir, "memory")))
assert.match(puts[0].value, /- \[Fact\]\(fact\.md\) — a fact/)

// Owned by ses_t: the declared task, and the lease pid is this process (the plugin's).
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nowner: ses_t\npid: 1\n")
text = await prompt("go on")
assert.match(text, /DECLARED TASK ANCHOR/)
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${process.pid}$`, "m"))
assert.equal(puts.length, 1)

// A /park typed mid-sentence: the hook blocks (exit 2); the plugin does not throw, it tells the model.
text = await prompt("note this /park closed")
assert.match(text, /^note this \/park closed\n\n<system-reminder>\nThe ccsetup task-anchor hook blocked this prompt\./)
assert.match(text, /NOT SENT — \/park only runs/)

// A child session is skipped.
const child = await load({ hooksDir }, "ses_parent")
assert.equal(await child.prompt("hello"), "hello")
assert.equal(child.puts.length, 0)

// No task-anchor.sh: the prompt is unchanged.
const missing = await load({ hooksDir: path.join(tmp, "no-such-dir") })
assert.equal(await missing.prompt("hello"), "hello")

// PostToolUse ctx: the transcript from the kv row, ~130k, appended to the last text item.
const result = { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "out" }] }
await hooks["tool.execute.after"]({ tool: "shell", sessionID: "ses_t", result })
assert.equal(result.content[2].text, "out\n\ncontext ~130k")
assert.equal(result.content[0].text, "a")
const unknown = { content: [{ type: "text", text: "out" }] }
await hooks["tool.execute.after"]({ tool: "shell", sessionID: "ses_unknown", result: unknown })
assert.equal(unknown.content[0].text, "out")

// Stop: the last assistant text; the hook runs and does not throw.
assert.equal(lastAssistant(path.join(transcriptDir, "uuid-1.jsonl")), "the last reply")
await hooks["session.experimental.idle"]({ sessionID: "ses_t", background: [] })

// The shell tool gets the plugin's pid.
const shell = { command: "true", env: {} }
await hooks["shell.create.before"](shell)
assert.equal(shell.env.CLAUDE_PID, String(process.pid))

console.log("anchor tests passed")

// Run with: node opencode/anchor.test.mjs [hooks dir, default this repo's claude/hooks]
// A temp HOME and config dir: nothing reads or writes the real ~/.claude.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { noteFile, removeNote, writeNote } from "./plugins/ccsetup-anchor/handoff.js"
import { removeWindow, windowFile, windowsDir, writeWindow } from "./plugins/ccsetup-anchor/lease.js"
import plugin, { KEY, addReminders, lastAssistant } from "./plugins/ccsetup-anchor/server.js"

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
  // Returns the text the model gets. The saved prompt text must stay as typed (the TUI shows it).
  const prompt = async (text, sessionID = "ses_t") => {
    const event = { sessionID, messageID: "m", prompt: { text, files: [] }, metadata: { other: 1 } }
    await hooks["session.prompt"](event)
    assert.equal(event.prompt.text, text)
    assert.equal(event.metadata.other, 1)
    const messages = [{ role: "user", content: [{ type: "text", text }], metadata: event.metadata }]
    await hooks["session.context"]({ sessionID, messages })
    return messages[0].content[0].text
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

// Owned by ses_t, no TUI views it (opencode run): the declared task, and the claim keeps its pid.
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nowner: ses_t\npid: 1\n")
text = await prompt("go on")
assert.match(text, /DECLARED TASK ANCHOR/)
assert.match(readFileSync(task, "utf8"), /^pid: 1$/m)
assert.equal(puts.length, 1)

// Per-TUI lease: the one live TUI whose window file names ses_t gives the pid (process.ppid stands in for it).
const tui = process.ppid
const wins = windowsDir(process.env.HOME)
await writeWindow(wins, tui, "ses_t")
await prompt("go on")
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${tui}$`, "m"))
// A second live TUI on ses_t: ambiguous, so the claim keeps the pid it has.
await writeWindow(wins, process.pid, "ses_t")
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nowner: ses_t\npid: 77\n")
await prompt("go on")
assert.match(readFileSync(task, "utf8"), /^pid: 77$/m)
// That second TUI goes home: one viewer again. A dead TUI's file is deleted when read.
await writeWindow(wins, process.pid, null)
writeFileSync(windowFile(wins, 2 ** 22 + 1), JSON.stringify({ session: "ses_t", at: new Date().toISOString() }))
await prompt("go on")
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${tui}$`, "m"))
assert.ok(!existsSync(windowFile(wins, 2 ** 22 + 1)))
// Stop refreshes the claim to the viewing TUI too.
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nowner: ses_t\npid: 77\n")
await hooks["session.experimental.idle"]({ sessionID: "ses_t", background: [] })
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${tui}$`, "m"))
// A background tab finishing its turn (no window names it) keeps its pid.
await writeWindow(wins, tui, "ses_other")
writeFileSync(task, "STATE 2026-11-12 | ACTIVE | next: do x\nowner: ses_t\npid: 77\n")
await hooks["session.experimental.idle"]({ sessionID: "ses_t", background: [] })
assert.match(readFileSync(task, "utf8"), /^pid: 77$/m)
await writeWindow(wins, tui, "ses_t")
await prompt("go on")
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${tui}$`, "m"))

// A /park typed mid-sentence: the hook blocks (exit 2); the plugin does not throw, it tells the model.
text = await prompt("note this /park closed")
assert.match(text, /^note this \/park closed\n\n<system-reminder>\nThe ccsetup task-anchor hook blocked this prompt\./)
assert.match(text, /NOT SENT — \/park only runs/)

// /clear hand-off: the TUI's note names ses_new, so its first prompt owns ses_t's task before the hook runs.
// No window names ses_new yet: the moved claim keeps its pid: line, the same TUI's pid.
await writeNote(anchors, 4242, { from: "ses_t", at: Date.now(), to: "ses_new" })
text = await prompt("first prompt after /clear", "ses_new")
assert.match(text, /DECLARED TASK ANCHOR/)
assert.match(readFileSync(task, "utf8"), /^owner: ses_new$/m)
assert.match(readFileSync(task, "utf8"), new RegExp(`^pid: ${tui}$`, "m"))
assert.ok(!existsSync(noteFile(anchors, 4242)))
// A note for another session (a /new elsewhere) moves nothing.
await writeNote(anchors, 4242, { from: "ses_new", at: Date.now(), to: "ses_other" })
text = await prompt("hello", "ses_new2")
assert.match(text, /TASK ANCHOR INDEX/)
assert.match(readFileSync(task, "utf8"), /^owner: ses_new$/m)
assert.ok(existsSync(noteFile(anchors, 4242)))
await removeNote(noteFile(anchors, 4242))

// A child session is skipped.
const child = await load({ hooksDir }, "ses_parent")
assert.equal(await child.prompt("hello"), "hello")
assert.equal(child.puts.length, 0)

// No task-anchor.sh: the prompt is unchanged.
const missing = await load({ hooksDir: path.join(tmp, "no-such-dir") })
assert.equal(await missing.prompt("hello"), "hello")

// Context hook: only user messages with the key; a message with no text part gets one; no metadata is a no-op.
const msgs = [
  { role: "user", content: [{ type: "text", text: "a" }, { type: "file" }], metadata: { [KEY]: "R1" } },
  { role: "assistant", content: [{ type: "text", text: "b" }], metadata: { [KEY]: "R2" } },
  { role: "user", content: [{ type: "file" }], metadata: { [KEY]: "R3" } },
  { role: "user", content: [{ type: "text", text: "c" }] },
]
addReminders(msgs)
assert.equal(msgs[0].content[0].text, "a\n\n<system-reminder>\nR1\n</system-reminder>")
assert.equal(msgs[1].content[0].text, "b")
assert.deepEqual(msgs[2].content[1], { type: "text", text: "<system-reminder>\nR3\n</system-reminder>" })
assert.equal(msgs[3].content[0].text, "c")
addReminders(undefined)

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

// The shell tool: a command with no tool call (a user `!` command) gets the plugin's pid.
const shell = { command: "true", env: {} }
await hooks["shell.create.before"](shell)
assert.equal(shell.env.CLAUDE_PID, String(process.pid))
// A shell tool call of a session one TUI views gets that TUI's pid; tool.execute.before notes the session.
await writeWindow(wins, tui, "ses_claim")
await hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_claim", input: { command: "claim it" } })
await hooks["tool.execute.before"]({ tool: "shell", sessionID: "ses_nobody", input: { command: "claim it" } })
const claim = { command: "claim it", env: {} }
await hooks["shell.create.before"](claim)
assert.equal(claim.env.CLAUDE_PID, String(tui))
// The second note of the same text: its session (no TUI, no task) gets the plugin's pid. Each note is used once.
const again = { command: "claim it", env: {} }
await hooks["shell.create.before"](again)
assert.equal(again.env.CLAUDE_PID, String(process.pid))
const third = { command: "claim it", env: {} }
await hooks["shell.create.before"](third)
assert.equal(third.env.CLAUDE_PID, String(process.pid))
// No env, no input: no throw.
await hooks["shell.create.before"]({ command: "x" })
await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_claim", input: { path: "x" } })
await removeWindow(wins, tui)
await removeWindow(wins, process.pid)

console.log("anchor tests passed")

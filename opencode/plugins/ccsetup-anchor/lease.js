// Per-TUI claim lease: the pid task-anchor.sh writes on a claim's pid: line is the TUI window the user
// works in, so the claim goes stale when that window closes. tui.jsx publishes the root session each TUI
// views; server.js picks the pid before each hook run and each shell command.
// No OpenCode imports, so node can test it. Every function fails open: an error means the fallback pid.
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { ownedTasks } from "./handoff.js"
import { anchorsDir } from "./sidebar.js"

// A dot dir of .json files: the task readers (task-anchor.sh, sweep.sh, lane.ts, sidebar.js) only read *.md.
export const WINDOW_DIR = ".windows"
const ID = /^[\w-]+$/
const NAME = /^([1-9][0-9]*)\.json$/

export const windowsDir = (home) => path.join(anchorsDir(home), WINDOW_DIR)
export const windowFile = (dir, pid) => path.join(dir, `${pid}.json`)

// { session (root session id, or null on home), at (epoch ms) } or undefined when the text is not valid.
export function parseWindow(text) {
  try {
    const raw = JSON.parse(text)
    const at = Date.parse(raw?.at)
    if (!Number.isFinite(at)) return undefined
    if (raw.session === null) return { session: null, at }
    return typeof raw.session === "string" && ID.test(raw.session) ? { session: raw.session, at } : undefined
  } catch {
    return undefined
  }
}

// EPERM: the process exists but is not ours, so it is alive.
export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}

// tui.jsx side, on each route change: tmp + rename, so a reader never sees half a file.
export async function writeWindow(dir, pid, session, at = Date.now()) {
  const file = windowFile(dir, pid)
  await mkdir(dir, { recursive: true })
  await writeFile(`${file}.tmp`, JSON.stringify({ session: session ?? null, at: new Date(at).toISOString() }) + "\n")
  await rename(`${file}.tmp`, file)
}

// tui.jsx side, on dispose. The .windows dir stays: removing it could race another TUI's write.
export async function removeWindow(dir, pid) {
  await unlink(windowFile(dir, pid)).catch(() => {})
}

// Every window of a live TUI: [{ pid, session, at }]. The file of a dead pid is deleted.
export async function readWindows(dir, alive = isAlive) {
  const windows = []
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const m = NAME.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    if (!alive(pid)) {
      await unlink(path.join(dir, name)).catch(() => {})
      continue
    }
    const window = parseWindow(await readFile(path.join(dir, name), "utf8").catch(() => ""))
    if (window) windows.push({ pid, ...window })
  }
  return windows
}

// The pid: value of the first task (name order, as task-anchor.sh owned_task) sessionID owns, or undefined.
export async function claimPid(anchorDir, sessionID) {
  const [slug] = await ownedTasks(anchorDir, sessionID)
  if (!slug) return undefined
  const text = await readFile(path.join(anchorDir, `${slug}.md`), "utf8").catch(() => "")
  const m = /^pid:[ \t]*([0-9]+)[ \t]*$/m.exec(text)
  return m ? Number(m[1]) : undefined
}

// The rule: exactly one live TUI views the session → that TUI. Otherwise (no TUI, two TUIs on the session,
// `opencode run`, a background tab finishing its turn) the claim stays as it is: its current pid, or the
// fallback (the service pid) when the session owns no task. A missing window never makes a live claim stale.
export function pickLease({ windows, root, current, fallback }) {
  const viewing = root ? (windows ?? []).filter((w) => w.session === root) : []
  if (viewing.length === 1) return viewing[0].pid
  return current ?? fallback
}

// server.js side: the lease pid for sessionID (root = its root session, which the windows name).
export async function leasePid({ windowsDir, anchorDir, sessionID, root = sessionID, fallback, alive = isAlive }) {
  try {
    if (!ID.test(sessionID ?? "") || !ID.test(root ?? "")) return fallback
    const windows = await readWindows(windowsDir, alive)
    return pickLease({ windows, root, current: await claimPid(anchorDir, sessionID), fallback })
  } catch {
    return fallback
  }
}

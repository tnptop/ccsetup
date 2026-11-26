// Run with: node opencode/anchor-lease.test.mjs
// Temp dirs only: nothing reads or writes the real ~/.claude.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  WINDOW_DIR,
  claimPid,
  isAlive,
  leasePid,
  parseWindow,
  pickLease,
  readWindows,
  removeWindow,
  windowFile,
  windowsDir,
  writeWindow,
} from "./plugins/ccsetup-anchor/lease.js"

const T = Date.parse("2026-11-21T10:00:00.000Z")

// parseWindow: a root session id or null; bad JSON, bad ids, bad dates are not windows.
assert.deepEqual(parseWindow('{"session":"ses_a","at":"2026-11-21T10:00:00.000Z"}'), { session: "ses_a", at: T })
assert.deepEqual(parseWindow('{"session":null,"at":"2026-11-21T10:00:00.000Z"}'), { session: null, at: T })
assert.equal(parseWindow("not json"), undefined)
assert.equal(parseWindow('{"session":"../x","at":"2026-11-21T10:00:00.000Z"}'), undefined)
assert.equal(parseWindow('{"session":"ses_a","at":"yesterday"}'), undefined)
assert.equal(parseWindow('{"at":"2026-11-21T10:00:00.000Z"}'), undefined)
assert.equal(parseWindow('{"session":7,"at":"2026-11-21T10:00:00.000Z"}'), undefined)

// isAlive: this process yes; a pid far above any real one no.
assert.ok(isAlive(process.pid))
assert.ok(!isAlive(2 ** 22 + 12345))

// windowsDir: a dot dir under task-anchors, which the *.md task readers never see.
assert.equal(windowsDir("/h"), path.join("/h", ".claude", "task-anchors", WINDOW_DIR))
assert.equal(WINDOW_DIR, ".windows")

// pickLease: exactly one TUI views the root session → its pid.
const w = (pid, session) => ({ pid, session, at: T })
assert.equal(pickLease({ windows: [w(11, "ses_a"), w(12, "ses_b")], root: "ses_a", current: 99, fallback: 1 }), 11)
// Two TUIs on the same session: the claim stays as it is.
assert.equal(pickLease({ windows: [w(11, "ses_a"), w(12, "ses_a")], root: "ses_a", current: 99, fallback: 1 }), 99)
// No TUI views it (opencode run, a background tab finishing its turn): its current pid, else the fallback.
assert.equal(pickLease({ windows: [w(12, "ses_b"), w(13, null)], root: "ses_a", current: 99, fallback: 1 }), 99)
assert.equal(pickLease({ windows: [], root: "ses_a", current: undefined, fallback: 1 }), 1)
assert.equal(pickLease({ windows: undefined, root: "ses_a", fallback: 1 }), 1)
// A window on home (null) never matches.
assert.equal(pickLease({ windows: [w(13, null)], root: null, fallback: 1 }), 1)

const tmp = mkdtempSync(path.join(tmpdir(), "anchor-lease-"))
const dir = path.join(tmp, "windows")

// writeWindow / readWindows: tmp + rename, no tmp file left; home writes null.
await writeWindow(dir, process.pid, "ses_a", T)
assert.deepEqual(JSON.parse(readFileSync(windowFile(dir, process.pid), "utf8")), { session: "ses_a", at: "2026-11-21T10:00:00.000Z" })
assert.deepEqual(readdirSync(dir), [`${process.pid}.json`])
await writeWindow(dir, process.pid, null, T)
assert.deepEqual(await readWindows(dir), [{ pid: process.pid, session: null, at: T }])
await writeWindow(dir, process.pid, "ses_a", T)

// readWindows deletes a dead pid's file, skips a bad file of a live pid (kept), ignores other names.
const alive = (pid) => pid !== 222
writeFileSync(windowFile(dir, 222), JSON.stringify({ session: "ses_a", at: new Date(T).toISOString() }))
writeFileSync(windowFile(dir, 333), "half")
writeFileSync(path.join(dir, "333.json.tmp"), "x")
writeFileSync(path.join(dir, "notes.txt"), "x")
assert.deepEqual(await readWindows(dir, alive), [{ pid: process.pid, session: "ses_a", at: T }])
assert.ok(!existsSync(windowFile(dir, 222)))
assert.ok(existsSync(windowFile(dir, 333)))
assert.ok(existsSync(path.join(dir, "333.json.tmp")))
// The real isAlive: pid 333 is very likely not ours to see, but either way the call does not throw.
await readWindows(dir)
assert.deepEqual(await readWindows(path.join(tmp, "missing")), [])

// removeWindow: the file goes, the shared dir stays (another TUI may be writing into it).
await removeWindow(dir, process.pid)
assert.ok(!existsSync(windowFile(dir, process.pid)))
assert.ok(existsSync(dir))
await removeWindow(dir, process.pid) // twice is fine

// claimPid: the pid: value of the first task (name order) the session owns.
const anchorDir = path.join(tmp, "anchors")
mkdirSync(anchorDir)
writeFileSync(path.join(anchorDir, "a.md"), "STATE d | ACTIVE | next: x\nowner: ses_other\npid: 5\n")
writeFileSync(path.join(anchorDir, "b.md"), "STATE d | ACTIVE | next: x\nowner: ses_a\npid: 4242\n")
writeFileSync(path.join(anchorDir, "c.md"), "STATE d | ACTIVE | next: x\nowner: ses_a\npid: 7\n")
writeFileSync(path.join(anchorDir, "d.md"), "STATE d | ACTIVE | next: x\nowner: ses_nopid\n")
assert.equal(await claimPid(anchorDir, "ses_a"), 4242)
assert.equal(await claimPid(anchorDir, "ses_nopid"), undefined)
assert.equal(await claimPid(anchorDir, "ses_none"), undefined)
assert.equal(await claimPid(path.join(tmp, "missing"), "ses_a"), undefined)

// leasePid: the whole rule over files.
const wins = path.join(tmp, "wins")
const lease = (sessionID, extra) => leasePid({ windowsDir: wins, anchorDir, sessionID, fallback: 1, alive, ...extra })
// No windows: an owned claim keeps its pid; an unowned session gets the fallback.
assert.equal(await lease("ses_a"), 4242)
assert.equal(await lease("ses_none"), 1)
// One live TUI views it: that TUI.
await writeWindow(wins, 101, "ses_a", T)
assert.equal(await lease("ses_a"), 101)
assert.equal(await lease("ses_none"), 1)
// A subagent: the windows name its root.
assert.equal(await lease("ses_child", { root: "ses_a" }), 101)
// A second live TUI on the same session: ambiguous, the claim stays.
await writeWindow(wins, 102, "ses_a", T)
assert.equal(await lease("ses_a"), 4242)
// That TUI goes to home: one viewer again.
await writeWindow(wins, 102, null, T)
assert.equal(await lease("ses_a"), 101)
// The viewing TUI died: its file is deleted, the claim keeps its pid (now stale; the hook reports it).
assert.equal(await lease("ses_a", { alive: (pid) => pid !== 101 }), 4242)
assert.ok(!existsSync(windowFile(wins, 101)))
// Bad ids and any error give the fallback.
assert.equal(await lease("../x"), 1)
assert.equal(await lease("ses_a", { root: "a b" }), 1)
assert.equal(await lease("ses_a", { alive: () => { throw new Error("boom") } }), 1)

console.log("anchor lease tests passed")

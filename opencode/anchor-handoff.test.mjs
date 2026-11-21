// Run with: node opencode/anchor-handoff.test.mjs
// Temp dirs only: nothing reads or writes the real ~/.claude.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  MAX_AGE_MS,
  NOTE_DIR,
  isFresh,
  moveOwner,
  noteFile,
  ownedTasks,
  parseNote,
  readNotes,
  removeNote,
  selectNote,
  takeHandoff,
  transferClaim,
  writeNote,
} from "./plugins/ccsetup-anchor/handoff.js"

const T = Date.parse("2026-11-21T10:00:00.000Z")

// parseNote: valid with and without `to`; bad JSON, bad ids, bad dates are not notes.
assert.deepEqual(parseNote('{"from":"ses_a","at":"2026-11-21T10:00:00.000Z"}'), { from: "ses_a", at: T })
assert.deepEqual(parseNote('{"from":"ses_a","at":"2026-11-21T10:00:00.000Z","to":"ses_b"}'), { from: "ses_a", at: T, to: "ses_b" })
assert.equal(parseNote("not json"), undefined)
assert.equal(parseNote('{"from":"ses a","at":"2026-11-21T10:00:00.000Z"}'), undefined)
assert.equal(parseNote('{"from":"ses_a","at":"yesterday"}'), undefined)
assert.equal(parseNote('{"from":"ses_a","at":"2026-11-21T10:00:00.000Z","to":"../x"}'), undefined)
assert.equal(parseNote('{"at":"2026-11-21T10:00:00.000Z"}'), undefined)

// isFresh: up to 30 minutes old; a minute of clock skew into the future.
const note = (extra) => ({ from: "ses_a", at: T, ...extra })
assert.ok(isFresh(note(), T))
assert.ok(isFresh(note(), T + MAX_AGE_MS))
assert.ok(!isFresh(note(), T + MAX_AGE_MS + 1))
assert.ok(isFresh(note(), T - 60_000))
assert.ok(!isFresh(note(), T - 60_001))
assert.ok(!isFresh(undefined, T))

// selectNote
const n = (extra, file = "f") => ({ file, note: note(extra) })
assert.deepEqual(selectNote([n({ to: "ses_b" })], "ses_b", T), { kind: "match", file: "f", note: note({ to: "ses_b" }) })
assert.equal(selectNote([n({ to: "ses_c" })], "ses_b", T).kind, "none") // another window's new session
assert.equal(selectNote([n({})], "ses_b", T).kind, "wait") // the TUI has not named its new session yet
assert.equal(selectNote([n({ to: "ses_b" }, "1"), n({ to: "ses_b" }, "2")], "ses_b", T).kind, "none") // ambiguous
assert.equal(selectNote([n({ to: "ses_b" }, "1"), n({}, "2")], "ses_b", T).kind, "match")
assert.equal(selectNote([n({ to: "ses_b" })], "ses_b", T + MAX_AGE_MS + 1).kind, "none") // stale
assert.equal(selectNote([n({})], "ses_b", T + MAX_AGE_MS + 1).kind, "none") // stale: no wait
assert.equal(selectNote([n({ to: "ses_a" })], "ses_a", T).kind, "none") // never to itself
assert.equal(selectNote([], "ses_b", T).kind, "none")
assert.equal(selectNote(undefined, "ses_b", T).kind, "none")

// moveOwner: only an owner: line that is exactly `from`; every other line kept.
const task = "STATE d | ACTIVE | next: x\nbody owner: ses_a\nowner: ses_a\nheartbeat: h\npid: 9\n"
assert.equal(moveOwner(task, "ses_a", "ses_b"), "STATE d | ACTIVE | next: x\nbody owner: ses_a\nowner: ses_b\nheartbeat: h\npid: 9\n")
assert.equal(moveOwner("owner: ses_c\n", "ses_a", "ses_b"), undefined) // a third session's claim
assert.equal(moveOwner("owner: ses_ab\n", "ses_a", "ses_b"), undefined)
assert.equal(moveOwner("STATE d\n", "ses_a", "ses_b"), undefined) // free task
assert.equal(moveOwner(task, "ses_a", "ses b"), undefined)
assert.equal(moveOwner(task, "ses.a", "ses_b"), undefined)
assert.equal(moveOwner(undefined, "ses_a", "ses_b"), undefined)

// Files: a temp anchor dir with A's task, another free task, INDEX.md.
const home = mkdtempSync(path.join(tmpdir(), "anchor-handoff-"))
let dirs = 0
function anchorDir() {
  const dir = path.join(home, `p${dirs++}`)
  mkdirSync(dir)
  writeFileSync(path.join(dir, "INDEX.md"), "- t1 | ACTIVE | next: x\n")
  writeFileSync(path.join(dir, "t1.md"), "STATE d | ACTIVE | next: x\nowner: ses_a\nheartbeat: h\npid: 9\n")
  writeFileSync(path.join(dir, "t2.md"), "STATE d | PARKED | next: y\n")
  return dir
}
const owner = (dir, slug = "t1") => /^owner: (.*)$/m.exec(readFileSync(path.join(dir, `${slug}.md`), "utf8"))?.[1]

// writeNote / readNotes / removeNote: ISO date in the file; the empty .handoff dir goes with the last note.
let dir = anchorDir()
await writeNote(dir, 123, { from: "ses_a", at: T })
assert.deepEqual(JSON.parse(readFileSync(noteFile(dir, 123), "utf8")), { from: "ses_a", at: "2026-11-21T10:00:00.000Z" })
await writeNote(dir, 123, { from: "ses_a", at: T, to: "ses_b" })
assert.deepEqual(await readNotes(dir, T), [{ file: noteFile(dir, 123), note: { from: "ses_a", at: T, to: "ses_b" } }])
assert.deepEqual(readdirSync(path.join(dir, NOTE_DIR)), ["123.json"]) // no .tmp left
writeFileSync(path.join(dir, NOTE_DIR, "7.json"), "junk")
await writeNote(dir, 8, { from: "ses_x", at: T - MAX_AGE_MS - 1 })
assert.equal((await readNotes(dir, T)).length, 1) // junk and expired notes are deleted
assert.deepEqual(readdirSync(path.join(dir, NOTE_DIR)), ["123.json"])
await removeNote(noteFile(dir, 123))
assert.ok(!existsSync(path.join(dir, NOTE_DIR)))
assert.deepEqual(await readNotes(path.join(home, "missing"), T), [])

// ownedTasks skips INDEX.md and non-.md files.
writeFileSync(path.join(dir, "notes.txt"), "owner: ses_a\n")
assert.deepEqual(await ownedTasks(dir, "ses_a"), ["t1"])
assert.deepEqual(await ownedTasks(dir, "ses_b"), [])

// transferClaim: owner moved, other lines kept, lock dir removed, no temp file left.
assert.equal(await transferClaim(dir, "ses_a", "ses_b"), "t1")
assert.equal(readFileSync(path.join(dir, "t1.md"), "utf8"), "STATE d | ACTIVE | next: x\nowner: ses_b\nheartbeat: h\npid: 9\n")
assert.deepEqual(readdirSync(dir).sort(), ["INDEX.md", "notes.txt", "t1.md", "t2.md"])
// A no longer owns it: nothing moves.
assert.equal(await transferClaim(dir, "ses_a", "ses_c"), undefined)
assert.equal(owner(dir), "ses_b")
// B already owns a task: nothing moves.
dir = anchorDir()
writeFileSync(path.join(dir, "t2.md"), "STATE d | PARKED | next: y\nowner: ses_b\n")
assert.equal(await transferClaim(dir, "ses_a", "ses_b"), undefined)
assert.equal(owner(dir), "ses_a")
// The lock is held by someone else: nothing moves, the lock stays theirs.
dir = anchorDir()
mkdirSync(path.join(dir, "t1.lock"))
let sleeps = 0
assert.equal(await transferClaim(dir, "ses_a", "ses_b", { sleep: async () => void sleeps++ }), undefined)
assert.equal(sleeps, 5)
assert.equal(owner(dir), "ses_a")
assert.ok(existsSync(path.join(dir, "t1.lock")))
// Same session, bad ids, missing dir.
assert.equal(await transferClaim(dir, "ses_a", "ses_a"), undefined)
assert.equal(await transferClaim(dir, "ses_a", "ses b"), undefined)
assert.equal(await transferClaim(path.join(home, "missing"), "ses_a", "ses_b"), undefined)

// takeHandoff: a clock that moves 100 ms per sleep.
function clock(start = T) {
  let t = start
  return { now: () => t, sleep: async (ms) => void (t += ms) }
}

// The note names B: claim moved, note consumed.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_b" })
assert.deepEqual(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...clock(T + 5000) }), { from: "ses_a", slug: "t1" })
assert.equal(owner(dir), "ses_b")
assert.ok(!existsSync(path.join(dir, NOTE_DIR)))

// The note names another session (a /new or a prompt in another window): no move, note kept for its session.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_c" })
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...clock() }), undefined)
assert.equal(owner(dir), "ses_a")
assert.ok(existsSync(noteFile(dir, 1)))

// Two notes name B: ambiguous, no move.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_b" })
await writeNote(dir, 2, { from: "ses_x", at: T, to: "ses_b" })
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...clock() }), undefined)
assert.equal(owner(dir), "ses_a")

// Stale note (31 minutes): no move, deleted.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_b" })
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...clock(T + 31 * 60_000) }), undefined)
assert.equal(owner(dir), "ses_a")
assert.ok(!existsSync(noteFile(dir, 1)))

// A note with no `to` yet: waits, and takes it once the TUI names B.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T })
let c = clock()
let polls = 0
const named = takeHandoff({
  anchorDir: dir,
  sessionID: "ses_b",
  now: c.now,
  sleep: async (ms) => {
    c.sleep(ms)
    if (++polls === 3) await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_b" })
  },
})
assert.deepEqual(await named, { from: "ses_a", slug: "t1" })
assert.equal(owner(dir), "ses_b")

// A note that never gets `to`: gives up after 1 s, no move, note kept.
dir = anchorDir()
await writeNote(dir, 1, { from: "ses_a", at: T })
c = clock()
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...c }), undefined)
assert.equal(c.now(), T + 1000)
assert.equal(owner(dir), "ses_a")
assert.ok(existsSync(noteFile(dir, 1)))

// B owns a task already: no wait, no move.
writeFileSync(path.join(dir, "t2.md"), "STATE d | PARKED | next: y\nowner: ses_b\n")
c = clock()
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...c }), undefined)
assert.equal(c.now(), T)

// A gave the task up after the /clear: the note is consumed, nothing moves.
dir = anchorDir()
writeFileSync(path.join(dir, "t1.md"), "STATE d | ACTIVE | next: x\nowner: ses_z\n")
await writeNote(dir, 1, { from: "ses_a", at: T, to: "ses_b" })
assert.equal(await takeHandoff({ anchorDir: dir, sessionID: "ses_b", ...clock() }), undefined)
assert.equal(owner(dir), "ses_z")
assert.ok(!existsSync(noteFile(dir, 1)))

// No notes, no anchor dir, bad session id: nothing, no throw.
assert.equal(await takeHandoff({ anchorDir: anchorDir(), sessionID: "ses_b", ...clock() }), undefined)
assert.equal(await takeHandoff({ anchorDir: path.join(home, "missing"), sessionID: "ses_b", ...clock() }), undefined)
assert.equal(await takeHandoff({ anchorDir: anchorDir(), sessionID: "../x", ...clock() }), undefined)

console.log("anchor handoff tests passed")

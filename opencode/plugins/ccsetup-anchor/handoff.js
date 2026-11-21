// /clear hand-off: moves the task claim from the cleared session to the session the same TUI creates next.
// tui.jsx writes a note per TUI process; server.js reads it on the new session's first prompt.
// No OpenCode imports, so node can test it. Every function fails open: an error means no hand-off.
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { anchorsDir, ownedBy, projectRoot, slugOf } from "./sidebar.js"

// A dot dir of .json files: the "$anchor_dir"/*.md readers (task-anchor.sh, sweep.sh, lane.ts) never see it.
export const NOTE_DIR = ".handoff"
export const MAX_AGE_MS = 30 * 60 * 1000
const SKEW_MS = 60 * 1000 // a note dated a little in the future still counts
const ID = /^[\w-]+$/

export const noteFile = (anchorDir, pid) => path.join(anchorDir, NOTE_DIR, `${pid}.json`)

// The anchor dir task-anchor.sh uses for a directory: the worktree-aware project root's slug.
export const anchorDirOf = async (directory, home) => path.join(anchorsDir(home), slugOf(await projectRoot(directory)))

// { from, at (epoch ms), to? } or undefined when the text is not a valid note.
export function parseNote(text) {
  try {
    const raw = JSON.parse(text)
    const at = Date.parse(raw?.at)
    if (typeof raw?.from !== "string" || !ID.test(raw.from) || !Number.isFinite(at)) return undefined
    if (raw.to !== undefined && (typeof raw.to !== "string" || !ID.test(raw.to))) return undefined
    return raw.to === undefined ? { from: raw.from, at } : { from: raw.from, at, to: raw.to }
  } catch {
    return undefined
  }
}

export const isFresh = (note, now, maxAge = MAX_AGE_MS) => Boolean(note) && now - note.at <= maxAge && note.at - now <= SKEW_MS

// What the first prompt of sessionID does with the project's notes ([{ file, note }]):
// "match" (exactly one fresh note names it), "wait" (a fresh note has no `to` yet), or "none".
// Two notes naming it is ambiguous: none.
export function selectNote(notes, sessionID, now) {
  const fresh = (notes ?? []).filter((n) => isFresh(n.note, now) && n.note.from !== sessionID)
  const matches = fresh.filter((n) => n.note.to === sessionID)
  if (matches.length === 1) return { kind: "match", ...matches[0] }
  if (matches.length > 1) return { kind: "none" }
  return fresh.some((n) => n.note.to === undefined) ? { kind: "wait" } : { kind: "none" }
}

// The task text with `owner: from` replaced by `owner: to`; undefined when the owner is not exactly `from`.
export function moveOwner(text, from, to) {
  if (!ID.test(from ?? "") || !ID.test(to ?? "") || !ownedBy(text ?? "", from)) return undefined
  // ID allows only [A-Za-z0-9_-], so `from` needs no regex escaping.
  return text.replace(new RegExp(`^owner:[ \\t]*${from}[ \\t]*$`, "m"), `owner: ${to}`)
}

// tui.jsx side. The ISO `at` keeps the note readable; parseNote turns it back into ms.
export async function writeNote(anchorDir, pid, note) {
  const file = noteFile(anchorDir, pid)
  await mkdir(path.dirname(file), { recursive: true })
  const body = { from: note.from, at: new Date(note.at).toISOString(), ...(note.to ? { to: note.to } : {}) }
  await writeFile(`${file}.tmp`, JSON.stringify(body) + "\n")
  await rename(`${file}.tmp`, file)
}

// Deletes a note; the empty .handoff dir goes too.
export async function removeNote(file) {
  await unlink(file).catch(() => {})
  await rmdir(path.dirname(file)).catch(() => {})
}

// Every note of the anchor dir; unreadable and expired ones are deleted.
export async function readNotes(anchorDir, now) {
  const dir = path.join(anchorDir, NOTE_DIR)
  const names = await readdir(dir).catch(() => [])
  const notes = []
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, name)
    const text = await readFile(file, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const note = parseNote(text)
    if (note && now - note.at <= MAX_AGE_MS) notes.push({ file, note })
    else await removeNote(file)
  }
  return notes
}

const taskFiles = async (anchorDir) =>
  (await readdir(anchorDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "INDEX.md")
    .map((e) => e.name)
    .sort()

// Task slugs in the anchor dir whose owner is sessionID, in name order (task-anchor.sh owned_task takes the first).
export async function ownedTasks(anchorDir, sessionID) {
  const owned = []
  for (const name of await taskFiles(anchorDir)) {
    const text = await readFile(path.join(anchorDir, name), "utf8").catch(() => "")
    if (ownedBy(text, sessionID)) owned.push(name.slice(0, -3))
  }
  return owned
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Moves A's claim to B under the claim-task lock dir; returns the task slug, or undefined.
// The owner is read again under the lock: a claim A no longer holds, or a third session's, is never touched.
export async function transferClaim(anchorDir, from, to, { tries = 5, sleep = pause } = {}) {
  if (!ID.test(from ?? "") || !ID.test(to ?? "") || from === to) return undefined
  if ((await ownedTasks(anchorDir, to)).length) return undefined
  const [slug] = await ownedTasks(anchorDir, from)
  if (!slug) return undefined
  const lock = path.join(anchorDir, `${slug}.lock`)
  for (let i = 0; i < tries; i++) {
    try {
      await mkdir(lock)
    } catch (error) {
      if (error?.code !== "EEXIST") return undefined
      await sleep(100)
      continue
    }
    try {
      const file = path.join(anchorDir, `${slug}.md`)
      const next = moveOwner(await readFile(file, "utf8"), from, to)
      if (next === undefined) return undefined
      const tmp = path.join(anchorDir, `.${slug}.md.${process.pid}.tmp`)
      await writeFile(tmp, next)
      await rename(tmp, file)
      return slug
    } catch {
      return undefined
    } finally {
      await rmdir(lock).catch(() => {})
    }
  }
  return undefined
}

// server.js side, on the first prompt of root session `sessionID`: takes the one note that names it,
// waiting up to waitMs for a TUI that has not written `to` yet. Returns { from, slug } or undefined.
export async function takeHandoff({ anchorDir, sessionID, now = Date.now, waitMs = 1000, sleep = pause }) {
  try {
    if (!ID.test(sessionID ?? "") || (await ownedTasks(anchorDir, sessionID)).length) return undefined
    const end = now() + waitMs
    for (;;) {
      const pick = selectNote(await readNotes(anchorDir, now()), sessionID, now())
      if (pick.kind === "match") {
        await removeNote(pick.file)
        const slug = await transferClaim(anchorDir, pick.note.from, sessionID, { sleep })
        return slug ? { from: pick.note.from, slug } : undefined
      }
      if (pick.kind !== "wait" || now() >= end) return undefined
      await sleep(100)
    }
  } catch {
    return undefined
  }
}

// Pure helpers for the sidebar Task block (tui.jsx). No OpenCode imports, so node can test them.
// Same rules as claude/statusline-command.sh: the owned task is found in every anchor dir;
// the no-task count uses the anchor dir of the worktree-aware project root.
import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// task-anchor.sh writes to $HOME/.claude/task-anchors, whatever CLAUDE_CONFIG_DIR says.
export const anchorsDir = (home = os.homedir()) => path.join(home, ".claude", "task-anchors")

export const slugOf = (root) => root.replace(/[^A-Za-z0-9]/g, "-")

// "STATE <date> | <STATUS> | next: <text> | step <N/M>" (step optional).
// The step rule matches task-anchor.sh: "step N/M" anywhere in a STATE line.
export function parseState(line) {
  const m = /^STATE\s+([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*next:\s*(.*)$/.exec(line ?? "")
  if (!m) return null
  const step = /step ([0-9]+)\/([0-9]+)/.exec(line)
  const next = m[3].replace(/\s*\|\s*step [0-9]+\/[0-9]+\s*$/, "").trim()
  return { date: m[1], status: m[2], next, step: step ? `${step[1]}/${step[2]}` : undefined }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const ownedBy = (text, sessionID) =>
  Boolean(sessionID) && new RegExp(`^owner:[ \\t]*${escape(sessionID)}[ \\t]*$`, "m").test(text)

const list = (dir) => readdir(dir, { withFileTypes: true }).catch(() => [])

// First task file (sorted) whose owner: line equals sessionID; undefined when none.
export async function findOwnedTask(dir, sessionID) {
  if (!sessionID) return undefined
  const projects = (await list(dir)).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  for (const project of projects) {
    const files = (await list(path.join(dir, project)))
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort()
    for (const name of files) {
      const text = await readFile(path.join(dir, project, name), "utf8").catch(() => "")
      if (ownedBy(text, sessionID)) return { slug: name.slice(0, -3), firstLine: text.split("\n")[0] }
    }
  }
  return undefined
}

export async function countTasks(dir) {
  return (await list(dir)).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "INDEX.md").length
}

// Output of `git rev-parse --path-format=absolute --git-dir --git-common-dir --show-prefix`.
// Inside a linked worktree the root is the main checkout plus the same subdirectory.
export function rootFromGit(directory, output) {
  const [gd = "", cd = "", prefix = ""] = (output ?? "").split("\n")
  if (!gd || !cd || gd === cd) return directory
  const main = path.basename(cd) === ".git" ? path.dirname(cd) : cd
  const sub = prefix.replace(/\/$/, "")
  return sub ? `${main}/${sub}` : main
}

const gitArgs = ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-prefix"]
const roots = new Map()

// Cached per directory: a session's root does not change while the TUI runs.
export function projectRoot(directory, run = execFile) {
  if (!roots.has(directory)) {
    roots.set(
      directory,
      new Promise((resolve) => {
        run("git", ["-C", directory, ...gitArgs], { timeout: 3000 }, (error, stdout) =>
          resolve(error ? directory : rootFromGit(directory, String(stdout))),
        )
      }),
    )
  }
  return roots.get(directory)
}

// The block's model. Never throws: any error gives the no-task line.
export async function readTask({ sessionID, directory, home } = {}) {
  try {
    const dir = anchorsDir(home)
    const owned = await findOwnedTask(dir, sessionID)
    if (owned) return { owned: true, slug: owned.slug, firstLine: owned.firstLine, state: parseState(owned.firstLine) }
    const count = directory ? await countTasks(path.join(dir, slugOf(await projectRoot(directory)))) : 0
    return { owned: false, count }
  } catch {
    return { owned: false, count: 0 }
  }
}

// Lines for the block: [head, next text, step line]. The next text is wrapped by the renderer.
export function taskLines(model) {
  if (!model) return []
  if (!model.owned) return [`no task claimed (${model.count} in index)`]
  const s = model.state
  if (!s) return [model.slug, model.firstLine.replace(/^STATE [^|]*\|\s*/, "")].filter(Boolean)
  return [`${model.slug} · ${s.status}`, s.next, s.step && `step ${s.step}`].filter(Boolean)
}

// Keeps the end of a path, which names the folder: "…/personal/ccsetup".
export function truncateLeft(text, width) {
  if (!text || text.length <= width) return text ?? ""
  return width <= 1 ? "…".slice(0, width) : "…" + text.slice(text.length - (width - 1))
}

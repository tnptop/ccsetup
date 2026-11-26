// Sidebar part of the task anchor. OpenCode compiles .jsx plugins with Solid (no build step)
// and resolves solid-js to its own copy. The logic lives in sidebar.js and quota.js, tested with node.
import { createEffect, createMemo, createRoot, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { anchorDirOf, noteFile, ownedTasks, removeNote, writeNote } from "./handoff.js"
import { removeWindow, windowsDir, writeWindow } from "./lease.js"
import { colourFor, createPoller, fetchClaude, fetchCodex, quotaLines } from "./quota.js"
import { clearWarning, contextTokens, readTask, taskLines, truncateLeft } from "./sidebar.js"

const WIDTH = 38 // sidebar is 42 columns with 2 columns of padding on each side
const REFRESH_MS = 5000

// The session's own location, else the TUI's location.
const locationOf = (context, sessionID) => context.data.session.get(sessionID)?.location ?? context.location

function TaskBlock(props) {
  const theme = props.context.theme
  const [model, setModel] = createSignal()
  createEffect(() => {
    props.tick()
    const data = props.context.data.session
    const sessionID = data.root(props.sessionID) ?? props.sessionID
    const directory = locationOf(props.context, props.sessionID)?.directory
    let live = true
    onCleanup(() => (live = false))
    readTask({ sessionID, directory }).then((next) => live && setModel(next), () => {})
  })
  const lines = createMemo(() => taskLines(model()))
  // Only while the session owns a task: /clear carries a claimed task to the next session.
  const warning = createMemo(() => {
    if (!model()?.owned) return ""
    try {
      return clearWarning(contextTokens(props.context.data.session.message.list(props.sessionID)))
    } catch {
      return ""
    }
  })
  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Task</b>
        </text>
        <For each={lines()}>{(line) => <text fg={theme.text.muted} wrapMode="word">{line}</text>}</For>
        <Show when={warning()}>
          <text fg={colourFor(theme, "warning")} wrapMode="word">{warning()}</text>
        </Show>
      </box>
    </Show>
  )
}

// /clear hand-off (see handoff.js). A shadow `session.clear` runs first in the keymap's dispatch chain and
// returns false, so OpenCode's own session.clear runs right after it, unchanged. It notes the viewed root
// session; the next session route names the new session in the note (or deletes it for an existing one).
// /new is `session.new`, a different command, so it never hands off.
function clearHandoff(context) {
  let pending // { from, at, home?, dir? } of this TUI's last /clear, until the next session route after home
  let queue = Promise.resolve()
  const later = (task) => (queue = queue.then(task).catch(() => {}))
  const run = () => {
    try {
      const route = context.ui.router.current()
      const viewed = route?.type === "session" ? route.sessionID : undefined
      const from = viewed && (context.data.session.root(viewed) ?? viewed)
      const directory = from && locationOf(context, from)?.directory
      if (!directory) return false
      const previous = pending
      const note = { from, at: Date.now() }
      pending = note
      later(async () => {
        if (previous?.dir) await removeNote(noteFile(previous.dir, process.pid))
        const dir = await anchorDirOf(directory)
        if (pending !== note || !(await ownedTasks(dir, from)).length) return
        await writeNote(dir, process.pid, note)
        note.dir = dir
      })
    } catch {}
    return false
  }
  // Same id, slash name, title and group as the built-in: the slash list and the palette show this one.
  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    commands: [{ id: "session.clear", title: "Clear session", group: "Session", slash: { name: "clear" }, palette: true, bind: false, run }],
  }))
  return createRoot((dispose) => {
    createEffect(() => {
      const route = context.ui.router.current()
      // session.clear closes the tab first, which can show the next tab for a moment, then goes home.
      // So a session route counts only after the home screen.
      if (route?.type === "home") {
        if (pending) pending.home = true
        return
      }
      const id = route?.type === "session" ? route.sessionID : undefined
      const info = id && context.data.session.get(id) // tracked: a session not in the store yet re-runs this
      if (!info) return
      untrack(() => {
        const note = pending
        if (!note?.home) return
        pending = undefined
        const fresh = id !== note.from && !info.parentID && (info.time?.created ?? 0) >= note.at
        later(async () => {
          if (!note.dir) return
          if (fresh) await writeNote(note.dir, process.pid, { ...note, to: id })
          else await removeNote(noteFile(note.dir, process.pid))
        })
      })
    })
    return dispose
  })
}

// Per-TUI lease (see lease.js): ~/.claude/task-anchors/.windows/<this TUI's pid>.json names the root session
// this window views (null on home). server.js writes this pid on the claim's pid: line, so the claim goes
// stale when the window closes. A killed TUI leaves its file; the server deletes files of dead pids.
function publishWindow(context) {
  const dir = windowsDir()
  let queue = Promise.resolve()
  let last
  return createRoot((dispose) => {
    createEffect(() => {
      try {
        const route = context.ui.router.current()
        const id = route?.type === "session" ? route.sessionID : undefined
        const session = id ? (context.data.session.root(id) ?? id) : null // tracked: re-runs when the store knows the root
        if (session === last) return
        last = session
        queue = queue.then(() => writeWindow(dir, process.pid, session)).catch(() => {})
      } catch {}
    })
    return () => {
      dispose()
      last = undefined
      queue = queue.then(() => removeWindow(dir, process.pid)).catch(() => {})
    }
  })
}

// Polling lives in setup (one poller per provider), so this block only formats.
// tick() re-runs the memo every 5 s, which keeps the "as of" line current.
function QuotaBlock(props) {
  const theme = props.context.theme
  const lines = createMemo(() => {
    props.tick()
    const records = props.quota()
    return quotaLines([records.claude, records.codex], Date.now())
  })
  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Quota</b>
        </text>
        <For each={lines()}>
          {(line) => (
            <text fg={colourFor(theme, line.level)} wrapMode="none">
              {line.text}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

function Footer(props) {
  const context = props.context
  const location = createMemo(() => locationOf(context, props.sessionID))
  createEffect(() => {
    const loc = location()
    if (loc) Promise.resolve(context.data.location.vcs.sync(loc)).catch(() => {})
  })
  const folder = createMemo(() => {
    const loc = location()
    return loc?.directory ? truncateLeft(context.ui.format.path(loc.directory), WIDTH) : ""
  })
  const branch = createMemo(() => {
    const loc = location()
    const name = loc && context.data.location.vcs.info(loc)?.branch?.current
    return name ? truncateLeft(name, WIDTH) : ""
  })
  return (
    <box>
      <Show when={folder()}>
        <text fg={context.theme.text.muted} wrapMode="none">{folder()}</text>
      </Show>
      <Show when={branch()}>
        <text fg={context.theme.text.muted} wrapMode="none">{branch()}</text>
      </Show>
    </box>
  )
}

export default {
  id: "ccsetup.anchor-sidebar",
  setup(context) {
    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((n) => n + 1)
    const timer = setInterval(bump, REFRESH_MS)
    // Quota: own 5-minute timers with backoff, one poller per provider (see quota.js).
    const [quota, setQuota] = createSignal({})
    const pollers = [
      ["claude", fetchClaude],
      ["codex", fetchCodex],
    ].map(([name, load]) => createPoller({ load, onRecord: (record) => setQuota((q) => ({ ...q, [name]: record })) }))
    for (const poller of pollers) poller.start().catch(() => {})
    const stops = [
      publishWindow(context),
      clearHandoff(context),
      context.data.on("session.execution.succeeded", bump),
      context.data.on("session.execution.succeeded", () => {
        for (const poller of pollers) poller.event().catch(() => {})
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: (props) => <TaskBlock context={context} sessionID={props.sessionID} tick={tick} />,
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: () => <QuotaBlock context={context} tick={tick} quota={quota} />,
      }),
      context.ui.slot({
        replace: "sidebar.footer",
        render: (props) => <Footer context={context} sessionID={props.sessionID} />,
      }),
    ]
    return () => {
      clearInterval(timer)
      for (const poller of pollers) poller.stop()
      for (const stop of stops) if (typeof stop === "function") stop()
    }
  },
}

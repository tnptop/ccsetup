// Sidebar part of the task anchor. OpenCode compiles .jsx plugins with Solid (no build step)
// and resolves solid-js to its own copy. The file logic lives in sidebar.js, tested with node.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { readTask, taskLines, truncateLeft } from "./sidebar.js"

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
  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Task</b>
        </text>
        <For each={lines()}>{(line) => <text fg={theme.text.muted} wrapMode="word">{line}</text>}</For>
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
    const stops = [
      context.data.on("session.execution.succeeded", bump),
      context.ui.slot({
        append: "sidebar.content",
        render: (props) => <TaskBlock context={context} sessionID={props.sessionID} tick={tick} />,
      }),
      context.ui.slot({
        replace: "sidebar.footer",
        render: (props) => <Footer context={context} sessionID={props.sessionID} />,
      }),
    ]
    return () => {
      clearInterval(timer)
      for (const stop of stops) if (typeof stop === "function") stop()
    }
  },
}

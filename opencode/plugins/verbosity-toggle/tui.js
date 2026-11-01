// Switches transcript verbosity between low and medium with one key.
// OpenCode's session.verbosity.cycle also stops at high. Plugins have no config API,
// so this edits cli.json, which the TUI reloads when the file changes.
import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export function cliConfigPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode", "cli.json")
}

// Anything except low goes to low, so the first press from high or the default leaves those levels.
export async function toggleVerbosity(file) {
  const text = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}"
    throw error
  })
  const config = JSON.parse(text)
  const level = config.session?.verbosity === "low" ? "medium" : "low"
  config.session = { ...config.session, verbosity: level }
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
  await rename(temp, file)
  return level
}

export default {
  id: "ccsetup.verbosity-toggle",
  setup(context) {
    const run = async () => {
      try {
        const level = await toggleVerbosity(cliConfigPath())
        context.ui.toast.show({ message: `Verbosity: ${level}`, duration: 1500 })
      } catch (error) {
        context.ui.toast.show({ message: `cli.json not changed: ${error.message}`, variant: "error" })
      }
    }
    context.keymap.layer(() => ({
      commands: [
        {
          id: "ccsetup.verbosity.toggle",
          title: "Toggle verbosity (low, medium)",
          group: "Session",
          bind: "ctrl+y",
          palette: true,
          run,
        },
      ],
    }))
  },
}

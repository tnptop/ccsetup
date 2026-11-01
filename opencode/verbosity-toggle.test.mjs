// Run with: node opencode/verbosity-toggle.test.mjs
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { cliConfigPath, toggleVerbosity } from "./plugins/verbosity-toggle/tui.js"

const dir = mkdtempSync(path.join(tmpdir(), "verbosity-"))
const file = path.join(dir, "cli.json")
const read = () => JSON.parse(readFileSync(file, "utf8"))

writeFileSync(file, JSON.stringify({ plugins: ["./x"], session: { verbosity: "low", tps: true }, keybinds: { a: "b" } }))
assert.equal(await toggleVerbosity(file), "medium")
assert.deepEqual(read(), { plugins: ["./x"], session: { verbosity: "medium", tps: true }, keybinds: { a: "b" } })
assert.equal(await toggleVerbosity(file), "low")
assert.equal(read().session.verbosity, "low")

writeFileSync(file, JSON.stringify({ session: { verbosity: "high" } }))
assert.equal(await toggleVerbosity(file), "low")
writeFileSync(file, "{}")
assert.equal(await toggleVerbosity(file), "low")

const missing = path.join(dir, "missing.json")
assert.equal(await toggleVerbosity(missing), "low")

const broken = '{ "session": // comment\n }'
writeFileSync(file, broken)
await assert.rejects(toggleVerbosity(file))
assert.equal(readFileSync(file, "utf8"), broken)
assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [])

assert.equal(cliConfigPath({ XDG_CONFIG_HOME: "/x" }), "/x/opencode/cli.json")
assert.match(cliConfigPath({}), /\.config\/opencode\/cli\.json$/)

let layer
const toasts = []
plugin.setup({
  keymap: { layer: (factory) => void (layer = factory()) },
  ui: { toast: { show: (toast) => toasts.push(toast) } },
})
const [command] = layer.commands
assert.equal(typeof plugin.id, "string")
assert.equal(command.bind, "ctrl+y")
assert.equal(command.palette, true)
assert.ok(command.id)

console.log("verbosity toggle tests passed")

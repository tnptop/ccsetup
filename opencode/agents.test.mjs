// Run with: node opencode/agents.test.mjs
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"

const root = new URL("..", import.meta.url).pathname
const read = (file) => readFileSync(root + file, "utf8")
const names = (dir) => readdirSync(root + dir).filter((name) => name.endsWith(".md")).sort()

function parse(file) {
  const match = read(file).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  assert.ok(match, `${file}: no frontmatter`)
  return {
    keys: [...match[1].matchAll(/^([a-z]+):/gm)].map((found) => found[1]),
    value: (key) => match[1].match(new RegExp(`^${key}: (.*)$`, "m"))?.[1],
    frontmatter: match[1],
    body: match[2],
  }
}

const models = {
  "claude-implementer-opus.md": "claude-agent/opus#high",
  "claude-implementer.md": "claude-agent/sonnet",
  "deep-rational-thinker-codex.md": "claude-agent/sonnet",
  "deep-rational-thinker.md": "claude-agent/opus#high",
  "efficient-worker.md": "claude-agent/sonnet",
  "jack-of-all-trades.md": "claude-agent/sonnet",
}

assert.deepEqual(names("opencode/agents"), names("claude/agents"))
assert.deepEqual(names("opencode/agents"), Object.keys(models))

for (const name of names("opencode/agents")) {
  const claude = parse(`claude/agents/${name}`)
  const opencode = parse(`opencode/agents/${name}`)
  assert.equal(opencode.body, claude.body, `${name}: prompt differs`)
  assert.equal(opencode.value("description"), claude.value("description"), `${name}: description differs`)
  assert.equal(opencode.value("mode"), "subagent", `${name}: mode`)
  assert.equal(opencode.value("model"), models[name], `${name}: model`)
  // A Claude-only key such as "name" makes OpenCode read a file with no "permissions" key as v1.
  for (const key of opencode.keys) assert.ok(["description", "mode", "model", "permissions"].includes(key), `${name}: ${key}`)
}

// A shell allow rule here would come after the global rules and override the ask on git push.
const bridge = parse("opencode/agents/deep-rational-thinker-codex.md").frontmatter
assert.ok(!/action: (shell|"?\*"?)\s/.test(bridge), "codex bridge: must not set shell or wildcard rules")
assert.match(bridge, /action: edit\n\s+resource: "\*"\n\s+effect: deny/)

const codex = parse("opencode/agents/deep-rational-thinker-codex.md")
assert.match(codex.value("description"), /do not retry it/)
assert.match(codex.body, /UNREACHABLE: \$PROVIDER/)

const config = JSON.parse(read("opencode/opencode.json"))
assert.equal(config.model, "claude-agent/opus")
assert.equal(config.agents.build.model, "claude-agent/opus#high")
assert.equal(config.agents.plan.model, "claude-agent/opus#high")

console.log("agents tests passed")

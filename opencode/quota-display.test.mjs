// Poller, formatting and privacy groups. Run through: node opencode/quota.test.mjs
// (also runs on its own: node opencode/quota-display.test.mjs).
import assert from "node:assert/strict"
import {
  bar,
  colourFor,
  createPoller,
  fetchClaude,
  fetchCodex,
  fitLabel,
  formatReset,
  levelOf,
  mergeRecord,
  quotaLines,
  windowLine,
} from "./plugins/ccsetup-anchor/quota.js"
import { HOUR, NOW, claudeOpts, codexAuth, codexBody, codexOpts, fetcher } from "./quota-test-helpers.mjs"

// 4b. Poller: 5-minute timer, doubling backoff up to 30 minutes, 60 s event throttle.
{
  let clock = 0
  const timers = []
  const fake = {
    setTimer: (fn, ms) => (timers.push({ fn, ms, cleared: false }), timers.length - 1),
    clearTimer: (id) => id !== undefined && (timers[id].cleared = true),
    now: () => clock,
  }
  const answers = []
  let loads = 0
  const seen = []
  const ok = { provider: "codex", status: "ok", windows: [{ label: "5h", usedPct: 1, resetsAt: null, idle: false }], fetchedAt: new Date(0) }
  const busy = { provider: "codex", status: "error", windows: [], error: "HTTP 429", backoff: true }
  const p = createPoller({ ...fake, load: async () => (loads++, answers.shift() ?? ok), onRecord: (r) => seen.push(r) })
  const lastTimer = () => timers[timers.length - 1]

  await p.start()
  assert.equal(loads, 1)
  assert.equal(lastTimer().ms, 5 * 60 * 1000)
  assert.equal(seen[0].status, "ok")

  // An event within 60 s of the last poll is ignored; after 60 s it polls now.
  clock = 30 * 1000
  await p.event()
  assert.equal(loads, 1)
  clock = 61 * 1000
  await p.event()
  assert.equal(loads, 2)
  assert.equal(timers[0].cleared, true)

  // 429 doubles the wait: 10, 20, 30, 30 minutes. The last good rows stay, with the error noted.
  for (const expected of [10, 20, 30, 30]) {
    answers.push(busy)
    clock += 10 * 60 * 1000
    await lastTimer().fn()
    assert.equal(lastTimer().ms, expected * 60 * 1000)
  }
  assert.equal(p.delay, 30 * 60 * 1000)
  assert.equal(seen.at(-1).status, "ok")
  assert.equal(seen.at(-1).error, "HTTP 429")
  // Events are ignored while backing off.
  const before = loads
  clock += 5 * 60 * 1000
  await p.event()
  assert.equal(loads, before)
  // A good answer resets the wait to 5 minutes.
  answers.push(ok)
  await lastTimer().fn()
  assert.equal(lastTimer().ms, 5 * 60 * 1000)
  assert.equal(seen.at(-1).error, undefined)

  // stop() clears the timer, and later polls do nothing.
  p.stop()
  assert.equal(lastTimer().cleared, true)
  const afterStop = loads
  await lastTimer().fn()
  await p.event()
  assert.equal(loads, afterStop)

  // A load that throws still gives an error record and a backoff.
  const q = createPoller({ ...fake, load: async () => Promise.reject(new Error("FAKE-CLAUDE-TOKEN")), onRecord: (r) => seen.push(r) })
  await q.start()
  assert.equal(seen.at(-1).error, "failed")
  assert.equal(q.delay, 10 * 60 * 1000)
  q.stop()

  // A throwing onRecord does not stop the polling.
  const count = timers.length
  const r = createPoller({ ...fake, load: async () => ok, onRecord: () => assert.fail("render error") })
  await r.start()
  assert.equal(timers.length, count + 1)
  r.stop()
}
// mergeRecord: an error with no earlier good data replaces it; non-errors always replace.
assert.equal(mergeRecord(undefined, { status: "error", error: "timeout" }).status, "error")
assert.equal(mergeRecord({ status: "ok", windows: [] }, { status: "expired" }).status, "expired")

console.log("group 4b (poller) passed")

// 5. Formatting
assert.equal(fitLabel("5h"), "5h")
assert.equal(fitLabel("Fable"), "Fable")
assert.equal(fitLabel("Sonnet"), "Sonn…")
assert.equal(bar(0), "░░░░░░")
assert.equal(bar(32), "██░░░░")
assert.equal(bar(100), "██████")
assert.equal(bar(250), "██████")
assert.equal(formatReset(new Date(2026, 10, 20, 17, 40), NOW), "17:40")
assert.equal(formatReset(new Date(2026, 10, 21, 9, 5), NOW), "09:05")
assert.equal(formatReset(new Date(2026, 10, 23, 9, 0), NOW), "Mon")
assert.equal(formatReset(null, NOW), "")
assert.deepEqual([levelOf(79.9), levelOf(80), levelOf(94.9), levelOf(95), levelOf(100)], ["muted", "warning", "warning", "error", "error"])

const w = (label, usedPct, resetsAt, extra = {}) => ({ label, usedPct, resetsAt, idle: false, scoped: false, ...extra })
const monday = new Date(2026, 10, 23, 9, 0)
const sample = [
  {
    provider: "claude",
    status: "ok",
    fetchedAt: new Date(NOW),
    windows: [
      w("5h", 32, new Date(2026, 10, 20, 17, 40)),
      w("7d", 18, monday),
      w("Fable", 41, monday, { scoped: true }),
      w("Sonnet", 100, monday, { scoped: true }),
      w("Opus", 0, monday, { scoped: true }),
    ],
  },
  {
    provider: "codex",
    status: "ok",
    fetchedAt: new Date(NOW),
    windows: [w("5h", 0, new Date(NOW + 5 * HOUR), { idle: true }), w("7d", 85, new Date(2026, 10, 26, 8, 0))],
  },
]
const lines = quotaLines(sample, NOW)
const texts = lines.map((l) => l.text)
console.log(["Quota", ...texts].map((t) => `  |${t}|`).join("\n"))
assert.deepEqual(texts, [
  "claude 5h    ██░░░░  32% 17:40",
  "claude 7d    █░░░░░  18% Mon",
  "claude Fable ██░░░░  41% Mon",
  "claude Sonn… ██████ 100% Mon",
  "claude Opus  ░░░░░░   0% Mon",
  "codex  5h    idle",
  "codex  7d    █████░  85% Thu",
])
// Every bar (and idle) starts at the same column; every line fits in 38 columns.
const barStart = (t) => t.search(/[█░]|idle/)
assert.deepEqual(new Set(texts.map(barStart)), new Set([13]))
for (const t of texts) assert.ok(t.length <= 38, t)
// A scoped weekly row shows even at 0% ("Opus"); colours follow the thresholds.
assert.deepEqual(lines.map((l) => l.level), ["muted", "muted", "muted", "error", "muted", "muted", "warning"])

// Status lines, no-auth hidden, stale line after 15 minutes, long error cut to 38.
const statusLines = quotaLines(
  [
    { provider: "claude", status: "expired", windows: [] },
    { provider: "codex", status: "no-auth", windows: [] },
  ],
  NOW,
)
assert.deepEqual(statusLines.map((l) => l.text), ["claude token expired"])
assert.equal(quotaLines([{ provider: "codex", status: "error", error: "HTTP 429", windows: [] }], NOW)[0].text, "codex unavailable (HTTP 429)")
const stale = { ...sample[1], fetchedAt: new Date(NOW - 20 * 60 * 1000) }
assert.equal(quotaLines([stale], NOW).at(-1).text, "codex  as of 20 min ago")
assert.equal(quotaLines([{ ...stale, fetchedAt: new Date(NOW - 14 * 60 * 1000) }], NOW).length, 2)
assert.equal(quotaLines([{ ...stale, fetchedAt: new Date(NOW - 3 * HOUR) }], NOW).at(-1).text, "codex  as of 3 h ago")
const long = quotaLines([{ provider: "codex", status: "error", error: "x".repeat(60), windows: [] }], NOW)[0].text
assert.equal(long.length, 38)
assert.deepEqual(quotaLines([], NOW), [])
assert.deepEqual(quotaLines([undefined, undefined], NOW), [])
assert.equal(windowLine("claude", w("5h", 3, null), NOW), "claude 5h    ░░░░░░   3%")

// Colours: feedback colours when present, muted otherwise.
const theme = { text: { muted: "M", base: "B", feedback: { warning: { base: "W" }, error: { base: "E" } } } }
assert.deepEqual(["muted", "warning", "error"].map((l) => colourFor(theme, l)), ["M", "W", "E"])
assert.deepEqual(["muted", "warning", "error"].map((l) => colourFor({ text: { muted: "M" } }, l)), ["M", "M", "M"])
assert.equal(colourFor(undefined, "error"), undefined)

console.log("group 5 (formatting) passed")

// 6. Privacy: no token, account id or body text ever reaches a record or a line.
const leakyFetch = async (url, init) => {
  throw new Error(`request to ${url} failed: ${JSON.stringify(init.headers)}`)
}
const leaks = [
  await fetchClaude(claudeOpts({ fetch: leakyFetch })),
  await fetchCodex(codexOpts({ fetch: leakyFetch })),
  await fetchClaude(claudeOpts({ fetch: fetcher(500, { message: "FAKE-CLAUDE-TOKEN" }) })),
  await fetchCodex(codexOpts({ fetch: fetcher(200, { email: "user@example.invalid", user_id: "user-fake", ...codexBody() }) })),
]
const codexToken = JSON.parse(codexAuth()).tokens.access_token
for (const rec of leaks) {
  const dump = JSON.stringify(rec) + quotaLines([rec], NOW).map((l) => l.text).join("\n")
  for (const secret of ["FAKE-CLAUDE-TOKEN", codexToken, "fake-account", "user@example.invalid", "user-fake", "Bearer"]) {
    assert.ok(!dump.includes(secret), `leaked ${secret}`)
  }
}
assert.deepEqual(leaks.map((r) => r.error), ["network", "network", "HTTP 500", undefined])

console.log("group 6 (privacy) passed")
console.log("quota tests passed")

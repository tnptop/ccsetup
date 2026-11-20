// Run with: node opencode/quota.test.mjs
// No real network, keychain or auth file: fetch, execFile and readFile are all injected.
// Groups 1-4 here; the poller, formatting and privacy groups are in quota-display.test.mjs.
import assert from "node:assert/strict"
import path from "node:path"
import {
  claudeConfigDir,
  fetchClaude,
  fetchCodex,
  jwtExp,
  keychainService,
  mapClaude,
  mapCodex,
  readClaudeToken,
  readCodexToken,
} from "./plugins/ccsetup-anchor/quota.js"
import {
  HOUR,
  NOW,
  claudeBody,
  claudeOpts,
  codexAuth,
  codexBody,
  codexFile,
  codexOpts,
  fetcher,
  files,
  iso,
  jwt,
  keychainJson,
  noFiles,
  now,
  runner,
} from "./quota-test-helpers.mjs"

// 1. Config dir and keychain service name
assert.equal(keychainService("/Users/thanapbh/.claude-personal", true), "Claude Code-credentials-545e1623")
assert.equal(keychainService("/h/.claude", false), "Claude Code-credentials")
assert.equal(keychainService(undefined), "Claude Code-credentials")
// Claude Code hashes whenever CLAUDE_CONFIG_DIR is set, even to the default dir.
assert.match(keychainService("/h/.claude", true), /^Claude Code-credentials-[0-9a-f]{8}$/)

const serviceJson = "/h/.config/opencode/service.json"
assert.deepEqual(await claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "/x" }, home: "/h", readFile: noFiles }), {
  dir: "/x",
  explicit: true,
})
assert.deepEqual(await claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "~/.c" }, home: "/h", readFile: noFiles }), {
  dir: path.join("/h", ".c"),
  explicit: true,
})
const svc = files({ [serviceJson]: JSON.stringify({ password: "not-read", env: { CLAUDE_CONFIG_DIR: "/h/.claude-personal" } }) })
assert.deepEqual(await claudeConfigDir({ env: {}, home: "/h", readFile: svc }), { dir: "/h/.claude-personal", explicit: true })
// Process env wins over service.json.
assert.equal((await claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: "/x" }, home: "/h", readFile: svc })).dir, "/x")
assert.deepEqual(await claudeConfigDir({ env: {}, home: "/h", readFile: noFiles }), {
  dir: path.join("/h", ".claude"),
  explicit: false,
})
assert.deepEqual(await claudeConfigDir({ env: {}, home: "/h", readFile: files({ [serviceJson]: "{bad" }) }), {
  dir: path.join("/h", ".claude"),
  explicit: false,
})

// macOS reads the hashed keychain entry with execFile (no shell).
const keyCalls = []
assert.deepEqual(
  await readClaudeToken({ platform: "darwin", env: {}, home: "/h", readFile: svc, run: runner(keychainJson, keyCalls), now }),
  { status: "ok", token: "FAKE-CLAUDE-TOKEN" },
)
assert.equal(keyCalls[0].cmd, "security")
assert.deepEqual(keyCalls[0].args, ["find-generic-password", "-s", keychainService("/h/.claude-personal", true), "-w"])
assert.equal(keyCalls[0].opts.shell, undefined)
// Other systems read <configDir>/.credentials.json.
const credFile = files({ [path.join("/c", ".credentials.json")]: keychainJson })
assert.equal(
  (await readClaudeToken({ platform: "linux", env: { CLAUDE_CONFIG_DIR: "/c" }, home: "/h", readFile: credFile, now })).token,
  "FAKE-CLAUDE-TOKEN",
)
assert.deepEqual(await readClaudeToken({ platform: "darwin", env: {}, home: "/h", readFile: noFiles, run: runner(null), now }), {
  status: "no-auth",
})
assert.deepEqual(await readClaudeToken({ platform: "darwin", env: {}, home: "/h", readFile: noFiles, run: runner("not json"), now }), {
  status: "no-auth",
})

// Codex token: $CODEX_HOME/auth.json, default ~/.codex/auth.json.
const codexOk = await readCodexToken({ env: {}, home: "/h", readFile: files({ [codexFile]: codexAuth() }), now })
assert.equal(codexOk.status, "ok")
assert.equal(codexOk.accountId, "fake-account")
assert.equal(
  (await readCodexToken({ env: { CODEX_HOME: "/ch" }, home: "/h", readFile: files({ [path.join("/ch", "auth.json")]: codexAuth() }), now }))
    .status,
  "ok",
)
assert.equal(jwtExp(jwt({ exp: 42 })), 42)
assert.equal(jwtExp("not-a-jwt"), undefined)

console.log("group 1 (config dir, keychain, tokens) passed")

// 2. Claude mapping from the cleaned fixture.
const claudeWindows = mapClaude(claudeBody)
assert.equal(claudeWindows.length, 3)
assert.deepEqual(
  claudeWindows.map((w) => [w.label, w.usedPct, w.scoped, w.idle]),
  [
    ["5h", 32, false, false],
    ["7d", 18, false, false],
    ["Fable", 0, true, false],
  ],
)
assert.equal(claudeWindows[0].resetsAt.getTime(), new Date(iso(NOW + 5.67 * HOUR)).getTime())
// Fallback to five_hour / seven_day when limits[] is missing.
const legacy = mapClaude({ five_hour: { utilization: 40, resets_at: iso(NOW + HOUR) }, seven_day: { utilization: 5, resets_at: null } })
assert.deepEqual(
  legacy.map((w) => [w.label, w.usedPct, w.resetsAt === null]),
  [
    ["5h", 40, false],
    ["7d", 5, true],
  ],
)
assert.equal(mapClaude({ five_hour: { utilization: 0, resets_at: null } })[0].idle, true)
assert.equal(mapClaude({}), null)
assert.equal(mapClaude(undefined), null)
// Unknown kinds are skipped; a scoped limit without a display name uses its model id.
assert.deepEqual(
  mapClaude({ limits: [{ kind: "other", percent: 1 }, { kind: "weekly_scoped", percent: 3, scope: { model: { id: "m1" } } }] }).map(
    (w) => w.label,
  ),
  ["m1"],
)

// 3. Codex mapping from the cleaned fixture.
const codexWindows = mapCodex(codexBody(), NOW)
assert.deepEqual(
  codexWindows.map((w) => [w.label, w.usedPct, w.idle]),
  [
    ["5h", 12, false],
    ["7d", 0, false],
  ],
)
assert.equal(codexWindows[0].resetsAt.getTime(), NOW + HOUR)
// Idle: reset_after_seconds equals the window length and nothing is used.
const idle = mapCodex(codexBody({ used_percent: 0, reset_after_seconds: 18000 }), NOW)
assert.equal(idle[0].idle, true)
assert.equal(mapCodex(codexBody({ used_percent: 3, reset_after_seconds: 18000 }), NOW)[0].idle, false)
// Other window lengths become <n>h; reset_after_seconds is the fallback for reset_at.
const odd = mapCodex(codexBody({ limit_window_seconds: 7200, reset_at: undefined, reset_after_seconds: 60 }), NOW)
assert.equal(odd[0].label, "2h")
assert.equal(odd[0].resetsAt.getTime(), NOW + 60000)
assert.equal(mapCodex({}), null)

console.log("groups 2-3 (mapping) passed")

// 4. Status records from the adapters, all with injected readers and fetch.
const claudeCalls = []
const claudeOk = await fetchClaude(claudeOpts({ fetch: fetcher(200, claudeBody, claudeCalls) }))
assert.equal(claudeOk.provider, "claude")
assert.equal(claudeOk.status, "ok")
assert.equal(claudeOk.windows.length, 3)
assert.equal(claudeOk.fetchedAt.getTime(), NOW)
assert.equal(claudeCalls[0].url, "https://api.anthropic.com/api/oauth/usage")
assert.equal(claudeCalls[0].init.method, "GET")
assert.equal(claudeCalls[0].init.headers.Authorization, "Bearer FAKE-CLAUDE-TOKEN")
assert.equal(claudeCalls[0].init.headers["anthropic-beta"], "oauth-2025-04-20")
assert.ok(claudeCalls[0].init.signal instanceof AbortSignal)

const codexCalls = []
const codexRec = await fetchCodex(codexOpts({ fetch: fetcher(200, codexBody(), codexCalls) }))
assert.equal(codexRec.status, "ok")
assert.deepEqual(codexRec.windows.map((w) => w.label), ["5h", "7d"])
assert.equal(codexCalls[0].url, "https://chatgpt.com/backend-api/wham/usage")
assert.equal(codexCalls[0].init.headers["ChatGPT-Account-Id"], "fake-account")
assert.ok(codexCalls[0].init.signal instanceof AbortSignal)

// Expired token: no request is made.
const noCall = async () => assert.fail("must not fetch")
const expiredKey = JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-CLAUDE-TOKEN", expiresAt: NOW - 1 } })
assert.equal((await fetchClaude(claudeOpts({ run: runner(expiredKey), fetch: noCall }))).status, "expired")
const expiredCodex = files({ [codexFile]: codexAuth({ access_token: jwt({ exp: NOW / 1000 - 1 }) }) })
assert.equal((await fetchCodex(codexOpts({ readFile: expiredCodex, fetch: noCall }))).status, "expired")
// Missing auth file and API-key auth mode: no-auth.
assert.equal((await fetchCodex(codexOpts({ readFile: noFiles, fetch: noCall }))).status, "no-auth")
const apikey = files({ [codexFile]: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fake", tokens: null }) })
assert.equal((await fetchCodex(codexOpts({ readFile: apikey, fetch: noCall }))).status, "no-auth")
assert.equal((await fetchClaude(claudeOpts({ run: runner(null), fetch: noCall }))).status, "no-auth")
// HTTP 401: error, no backoff. HTTP 429: error with backoff.
const r401 = await fetchClaude(claudeOpts({ fetch: fetcher(401, { error: "secret body" }) }))
assert.deepEqual([r401.status, r401.error, r401.backoff], ["error", "HTTP 401", false])
const r429 = await fetchCodex(codexOpts({ fetch: fetcher(429, {}) }))
assert.deepEqual([r429.status, r429.error, r429.backoff], ["error", "HTTP 429", true])
// Timeout and network errors back off too.
const timeoutFetch = async () => {
  throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
}
const rTimeout = await fetchClaude(claudeOpts({ fetch: timeoutFetch }))
assert.deepEqual([rTimeout.status, rTimeout.error, rTimeout.backoff], ["error", "timeout", true])
const rNet = await fetchCodex(codexOpts({ fetch: async () => { throw new TypeError("fetch failed") } }))
assert.deepEqual([rNet.error, rNet.backoff], ["network", true])
// A body that is not JSON, or has no usage fields.
const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x") } })
assert.equal((await fetchClaude(claudeOpts({ fetch: badJson }))).error, "bad response")
assert.equal((await fetchCodex(codexOpts({ fetch: fetcher(200, { nothing: 1 }) }))).error, "bad response")
// The record keeps no body field.
assert.deepEqual(Object.keys(claudeOk).sort(), ["fetchedAt", "provider", "status", "windows"])

console.log("group 4 (status) passed")

await import("./quota-display.test.mjs")

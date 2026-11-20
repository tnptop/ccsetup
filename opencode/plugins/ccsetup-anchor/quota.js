// Pure helpers for the sidebar Quota block (tui.jsx). No OpenCode imports, so node can test them.
// Reads the Claude and Codex usage limits from their no-cost usage endpoints.
// Rules: never refresh a token, never keep or show a response body, a token, an email or an
// account ID. Errors are short reasons only ("HTTP 429", "timeout", "network").
// Readers and adapters never throw: they return a record with a status.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile as fsReadFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage"
export const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage"
export const TIMEOUT_MS = 5000
export const BASE_MS = 5 * 60 * 1000 // normal poll
export const MAX_MS = 30 * 60 * 1000 // backoff ceiling
export const EVENT_GAP_MS = 60 * 1000 // at most one event-driven poll per minute
export const STALE_MS = 15 * 60 * 1000
export const WIDTH = 38

const SERVICE = "Claude Code-credentials"

const defaults = (o = {}) => ({
  fetch: o.fetch ?? globalThis.fetch,
  run: o.run ?? execFile,
  readFile: o.readFile ?? fsReadFile,
  env: o.env ?? process.env,
  home: o.home ?? os.homedir(),
  platform: o.platform ?? process.platform,
  now: o.now ?? Date.now,
})

const expandHome = (p, home) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p)

const readJson = async (readFile, file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

// Claude config dir, in this order: process env, env in ~/.config/opencode/service.json, ~/.claude.
// The shell OpenCode starts has no CLAUDE_CONFIG_DIR; only service.json sets it.
// explicit is true when a dir was set (either source), which is when Claude Code hashes the name.
export async function claudeConfigDir(opts = {}) {
  const { env, home, readFile } = defaults(opts)
  if (env.CLAUDE_CONFIG_DIR) return { dir: expandHome(env.CLAUDE_CONFIG_DIR, home), explicit: true }
  const service = await readJson(readFile, path.join(home, ".config", "opencode", "service.json"))
  const fromService = service?.env?.CLAUDE_CONFIG_DIR
  if (typeof fromService === "string" && fromService) return { dir: expandHome(fromService, home), explicit: true }
  return { dir: path.join(home, ".claude"), explicit: false }
}

// Same rule as Claude Code: hash whenever CLAUDE_CONFIG_DIR is set, even if it equals ~/.claude.
// "<service>-<first 8 hex of sha256(dir)>"; plain "<service>" when no dir was set.
export function keychainService(dir, explicit = Boolean(dir)) {
  if (!explicit || !dir) return SERVICE
  return `${SERVICE}-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`
}

// execFile with no shell; resolves stdout or null. Never throws.
const runOut = (run, cmd, args) =>
  new Promise((resolve) => {
    try {
      run(cmd, args, { timeout: TIMEOUT_MS }, (error, stdout) => resolve(error ? null : String(stdout ?? "")))
    } catch {
      resolve(null)
    }
  })

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// { status: "ok", token } | { status: "no-auth" } | { status: "expired" }. Never throws.
export async function readClaudeToken(opts = {}) {
  const o = defaults(opts)
  try {
    const { dir, explicit } = opts.configDir ?? (await claudeConfigDir(o))
    const creds =
      o.platform === "darwin"
        ? parse((await runOut(o.run, "security", ["find-generic-password", "-s", keychainService(dir, explicit), "-w"])) ?? "")
        : await readJson(o.readFile, path.join(dir, ".credentials.json"))
    const oauth = creds?.claudeAiOauth
    if (!oauth?.accessToken) return { status: "no-auth" }
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= o.now()) return { status: "expired" }
    return { status: "ok", token: oauth.accessToken }
  } catch {
    return { status: "no-auth" }
  }
}

// exp claim of a JWT in seconds, or undefined when it cannot be read.
export function jwtExp(token) {
  try {
    const exp = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"))?.exp
    return typeof exp === "number" ? exp : undefined
  } catch {
    return undefined
  }
}

// { status: "ok", token, accountId } | { status: "no-auth" } | { status: "expired" }. Never throws.
// Needs auth_mode "chatgpt": an API key has no usage windows.
export async function readCodexToken(opts = {}) {
  const o = defaults(opts)
  try {
    const home = o.env.CODEX_HOME ? expandHome(o.env.CODEX_HOME, o.home) : path.join(o.home, ".codex")
    const auth = await readJson(o.readFile, path.join(home, "auth.json"))
    const token = auth?.tokens?.access_token
    if (auth?.auth_mode !== "chatgpt" || !token) return { status: "no-auth" }
    const exp = jwtExp(token)
    if (exp !== undefined && exp * 1000 <= o.now()) return { status: "expired" }
    return { status: "ok", token, accountId: auth.tokens.account_id }
  } catch {
    return { status: "no-auth" }
  }
}

// GET with a 5 s timeout. { body } or { error, backoff }. The error never holds the thrown message.
export async function getJson(fetchFn, url, headers) {
  let res
  try {
    res = await fetchFn(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError"
    return { error: timeout ? "timeout" : "network", backoff: true }
  }
  if (!res?.ok) {
    const status = Number(res?.status) || 0
    return { error: `HTTP ${status}`, backoff: status === 429 }
  }
  try {
    return { body: await res.json() }
  } catch {
    return { error: "bad response", backoff: false }
  }
}

const pct = (n) => Math.min(100, Math.max(0, Number(n) || 0))
const dateOf = (v) => {
  if (v === null || v === undefined || v === "") return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// Claude limits[] to windows. session -> 5h, weekly_all -> 7d, weekly_scoped -> its model name.
// Falls back to five_hour / seven_day when limits[] is missing. null when neither is there.
// A window with no reset time and 0% has not started: idle.
export function mapClaude(body) {
  const window = (label, usedPct, resetsAt, scoped = false) => ({
    label,
    usedPct: pct(usedPct),
    resetsAt: dateOf(resetsAt),
    idle: dateOf(resetsAt) === null && pct(usedPct) === 0,
    scoped,
  })
  if (Array.isArray(body?.limits)) {
    return body.limits.flatMap((l) => {
      if (l?.kind === "session") return [window("5h", l.percent, l.resets_at)]
      if (l?.kind === "weekly_all") return [window("7d", l.percent, l.resets_at)]
      if (l?.kind === "weekly_scoped") {
        const name = l.scope?.model?.display_name || l.scope?.model?.id || "scope"
        return [window(String(name), l.percent, l.resets_at, true)]
      }
      return []
    })
  }
  const legacy = [
    ["5h", body?.five_hour],
    ["7d", body?.seven_day],
  ].filter(([, w]) => w && typeof w === "object")
  if (legacy.length === 0) return null
  return legacy.map(([label, w]) => window(label, w.utilization, w.resets_at))
}

const windowLabel = (seconds) =>
  seconds === 18000 ? "5h" : seconds === 604800 ? "7d" : `${Math.round((Number(seconds) || 0) / 3600)}h`

// Codex rate_limit windows. Idle when reset_after_seconds equals the window length and 0% used:
// no window has started yet. null when rate_limit is missing.
export function mapCodex(body, now = Date.now()) {
  const rl = body?.rate_limit
  if (!rl || typeof rl !== "object") return null
  return [rl.primary_window, rl.secondary_window]
    .filter((w) => w && typeof w === "object")
    .map((w) => {
      const resetsAt =
        typeof w.reset_at === "number"
          ? new Date(w.reset_at * 1000)
          : typeof w.reset_after_seconds === "number"
            ? new Date(now + w.reset_after_seconds * 1000)
            : null
      return {
        label: windowLabel(w.limit_window_seconds),
        usedPct: pct(w.used_percent),
        resetsAt,
        idle: w.reset_after_seconds === w.limit_window_seconds && pct(w.used_percent) === 0,
        scoped: false,
      }
    })
}

// One adapter: read the token, call the endpoint, map the numbers. Never throws.
async function adapt(provider, o, readToken, request, map) {
  const record = (status, extra) => ({ provider, status, windows: [], fetchedAt: new Date(o.now()), ...extra })
  try {
    const cred = await readToken(o)
    if (cred.status !== "ok") return record(cred.status)
    const res = await getJson(o.fetch, ...request(cred))
    if (res.error) return record("error", { error: res.error, backoff: res.backoff })
    const windows = map(res.body, o.now())
    return windows ? record("ok", { windows }) : record("error", { error: "bad response", backoff: false })
  } catch {
    return record("error", { error: "failed", backoff: false })
  }
}

export const fetchClaude = (opts = {}) =>
  adapt(
    "claude",
    { ...defaults(opts), configDir: opts.configDir },
    readClaudeToken,
    (cred) => [CLAUDE_URL, { Authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20" }],
    mapClaude,
  )

export const fetchCodex = (opts = {}) =>
  adapt(
    "codex",
    defaults(opts),
    readCodexToken,
    (cred) => [
      CODEX_URL,
      { Authorization: `Bearer ${cred.token}`, ...(cred.accountId ? { "ChatGPT-Account-Id": cred.accountId } : {}) },
    ],
    mapCodex,
  )

// A failed poll keeps the last good windows (and their fetchedAt), so the rows stay and the
// stale line appears after 15 minutes. With no good data yet, the error record shows.
export function mergeRecord(prev, next) {
  if (next?.status === "error" && prev?.status === "ok") return { ...prev, error: next.error, backoff: next.backoff }
  return next
}

// Poll one provider: once on start, then every 5 minutes. HTTP 429, a network error or a timeout
// doubles the wait up to 30 minutes; a good answer resets it. event() polls now, but at most once
// a minute and not while backing off. Timers and the clock are injectable for tests.
export function createPoller({
  load,
  onRecord,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  baseMs = BASE_MS,
  maxMs = MAX_MS,
  eventGapMs = EVENT_GAP_MS,
}) {
  let timer
  let delay = baseMs
  let lastRun = -Infinity
  let running = false
  let stopped = false
  let record
  async function run() {
    if (running || stopped) return
    running = true
    lastRun = now()
    let next
    try {
      next = await load()
    } catch {
      next = { provider: record?.provider, status: "error", windows: [], error: "failed", backoff: true }
    }
    running = false
    if (stopped) return
    delay = next?.backoff ? Math.min(delay * 2, maxMs) : baseMs
    record = mergeRecord(record, next)
    clearTimer(timer)
    timer = setTimer(run, delay) // before onRecord, so a throwing callback cannot stop the polling
    try {
      onRecord?.(record)
    } catch {}
  }
  return {
    start: () => run(),
    event() {
      if (stopped || running || delay > baseMs || now() - lastRun < eventGapMs) return Promise.resolve()
      clearTimer(timer)
      return run()
    },
    stop() {
      stopped = true
      clearTimer(timer)
    },
    get delay() {
      return delay
    },
  }
}

// Fixed columns, so every bar starts at column 13:
// provider (6) · label (5) · bar (6) · percent (4, right-aligned) · reset time. 30 columns at most.
// "…", "█" and "░" are one column each, so padding by string length is right.
const BAR = 6
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const two = (n) => String(n).padStart(2, "0")

export const fitLabel = (label) => (label.length > 5 ? label.slice(0, 4) + "…" : label)

export function bar(usedPct) {
  const filled = Math.min(BAR, Math.max(0, Math.round((pct(usedPct) / 100) * BAR)))
  return "█".repeat(filled) + "░".repeat(BAR - filled)
}

// HH:MM local when the reset is within 24 hours, else the local weekday. "" when unknown.
export function formatReset(resetsAt, now = Date.now()) {
  const d = dateOf(resetsAt)
  if (!d) return ""
  return d.getTime() - now < 24 * 60 * 60 * 1000 ? `${two(d.getHours())}:${two(d.getMinutes())}` : WEEKDAYS[d.getDay()]
}

export const levelOf = (usedPct) => (usedPct >= 95 ? "error" : usedPct >= 80 ? "warning" : "muted")

const fit = (text) => (text.length <= WIDTH ? text : text.slice(0, WIDTH - 1) + "…")
const head = (provider, label) => `${provider.padEnd(6)} ${fitLabel(label).padEnd(5)} `

export function windowLine(provider, w, now = Date.now()) {
  if (w.idle) return fit(head(provider, w.label) + "idle")
  const percent = `${Math.round(w.usedPct)}%`.padStart(4)
  return fit(`${head(provider, w.label)}${bar(w.usedPct)} ${percent} ${formatReset(w.resetsAt, now)}`.trimEnd())
}

const ago = (ms) => {
  const min = Math.floor(ms / 60000)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`
}

// Lines for the block, each { text, level }. no-auth hides the provider. A scoped weekly row
// (for example Fable) shows even at 0%. The renderer adds the "Quota" heading when the list is not empty.
export function quotaLines(records, now = Date.now()) {
  const lines = []
  for (const r of records ?? []) {
    if (!r || r.status === "no-auth") continue
    const provider = String(r.provider ?? "")
    if (r.status === "expired") lines.push({ text: fit(`${provider} token expired`), level: "muted" })
    else if (r.status === "error") lines.push({ text: fit(`${provider} unavailable (${r.error ?? "error"})`), level: "muted" })
    else if (r.status === "ok") {
      for (const w of r.windows ?? []) {
        lines.push({ text: windowLine(provider, w, now), level: w.idle ? "muted" : levelOf(w.usedPct) })
      }
      const age = now - new Date(r.fetchedAt).getTime()
      if (age > STALE_MS) lines.push({ text: fit(`${provider.padEnd(6)} as of ${ago(age)} ago`), level: "muted" })
    }
  }
  return lines
}

// Theme colour for a level. Falls back to muted when the theme has no warning or error colour.
export function colourFor(theme, level) {
  const muted = theme?.text?.muted
  if (level !== "warning" && level !== "error") return muted
  return theme?.text?.feedback?.[level]?.base ?? muted
}

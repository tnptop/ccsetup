// Shared fakes and cleaned fixtures for quota.test.mjs and quota-display.test.mjs.
// No real network, keychain or auth file: fetch, execFile and readFile are all injected.
import path from "node:path"

// Fixed local clock: Friday 2026-11-20 12:00 local time.
export const NOW = new Date(2026, 10, 20, 12, 0).getTime()
export const now = () => NOW
export const HOUR = 3600 * 1000
export const iso = (ms) => new Date(ms).toISOString()

// Fake file system: path -> text. Missing paths reject like ENOENT.
export const files = (map) => async (file) => {
  if (file in map) return map[file]
  throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" })
}
export const noFiles = files({})

// Fake execFile: records the call and answers with stdout, or an error when stdout is null.
export const runner =
  (stdout, calls = []) =>
  (cmd, args, opts, done) => {
    calls.push({ cmd, args, opts })
    stdout === null ? done(new Error("not found")) : done(null, stdout)
  }

// Fake fetch: records the call and answers with a status and body.
export const fetcher =
  (status, body, calls = []) =>
  async (url, init) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }

export const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`

// Keychain JSON with a fake token.
export const keychainJson = JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-CLAUDE-TOKEN", expiresAt: NOW + HOUR } })

export const codexFile = path.join("/h", ".codex", "auth.json")
export const codexAuth = (extra = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }), account_id: "fake-account", ...extra },
  })

// Cleaned fixture of the 2026-11-20 Claude response shape (numbers made up).
export const claudeBody = {
  limits: [
    { kind: "session", group: "g", percent: 32, severity: "ok", resets_at: iso(NOW + 5.67 * HOUR), scope: null, is_active: true },
    { kind: "weekly_all", group: "g", percent: 18, severity: "ok", resets_at: iso(NOW + 72 * HOUR), scope: null, is_active: true },
    {
      kind: "weekly_scoped",
      group: "g",
      percent: 0,
      severity: "ok",
      resets_at: iso(NOW + 72 * HOUR),
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  five_hour: { utilization: 32, resets_at: iso(NOW + 5.67 * HOUR) },
  seven_day: { utilization: 18, resets_at: iso(NOW + 72 * HOUR) },
}

// Cleaned fixture of the Codex response shape: no email, user id or account id.
export const codexBody = (primary = {}, secondary = {}) => ({
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: NOW / 1000 + 3600, ...primary },
    secondary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 500000,
      reset_at: NOW / 1000 + 500000,
      ...secondary,
    },
  },
})

export const claudeOpts = (extra = {}) => ({
  platform: "darwin",
  env: { CLAUDE_CONFIG_DIR: "/c" },
  home: "/h",
  readFile: noFiles,
  run: runner(keychainJson),
  now,
  ...extra,
})
export const codexOpts = (extra = {}) => ({ env: {}, home: "/h", readFile: files({ [codexFile]: codexAuth() }), now, ...extra })

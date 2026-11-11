import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

// Same script the CLI statusLine runs: one source of truth.
const ARGV = ['bash', '-c', 'bash ~/.claude/statusline-command.sh'] as const
const line = atom({ plugin: 'anchor-band', key: 'line' } as const, '')

// The JSON the CLI pipes to a statusLine command (only the fields the script reads).
const payload = ([sessionId, cwd, root, model, usage]: [string, string, string, string, SessionUsage]) =>
  JSON.stringify({
    session_id: sessionId,
    model: { display_name: model },
    workspace: { current_dir: cwd, project_dir: root },
    context_window: { total_input_tokens: usage.context.tokens ?? 0, context_window_size: usage.context.window },
  })

// Keep the raw ANSI line; the band picks its segments. A failed run keeps nothing.
const clean = (r: { exitCode: number; stdout: string }) => (r.exitCode === 0 ? r.stdout.trim() : '')

// The script colours each field: 36 model, 34 dir, 33 context, 35 task.
// Desktop already shows model and context, so the band keeps dir and task.
const segment = (raw: string, code: number) =>
  raw.match(new RegExp(`\\x1b\\[${code}m(.*?)\\x1b\\[0m`))?.[1] ?? ''

export const register: Register = on => {
  // Refresh when a session opens and after every turn (claim-task and /park run inside turns).
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const values = await Promise.all([$.session.id(), $.session.cwd(), $.session.root(), $.session.model(), $.session.usage()])
    const r = await $.process.run(ARGV, { stdin: payload(values), timeoutMs: 5000 }).catch(() => null)
    if (r) await update($, line, () => clean(r))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const values = await Promise.all([$.session.id(), $.session.cwd(), $.session.root(), $.session.model(), $.session.usage()])
    const r = await $.process.run(ARGV, { stdin: payload(values), timeoutMs: 5000 }).catch(() => null)
    if (r) await update($, line, () => clean(r))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The terminal already has the real status line: don't show it twice.
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const raw = await read($, line)
    const dir = segment(raw, 34)
    const task = segment(raw, 35)
    if (!dir && !task) return next(e)
    const { Text } = $.ui.resolve(e)
    return (
      <Text mono wrap="truncate">
        <Text color="blue">{dir}</Text> <Text color="magenta">{task}</Text>
      </Text>
    )
  })
}

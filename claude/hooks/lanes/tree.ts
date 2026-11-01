// Tree
// ====
// A lane's messages and the tree over them, ported from Memory.ts. The
// messages are read from the Claude Code transcripts the lane's `log`
// lists (lane.ts), in log order, by the rules of spikes/1a/extract.py.
// Sizes are bytes of UTF-8.
//
// index.jsonl: one line per message, append-only, `{i, sid, line, date}`:
// its id, its transcript and line there (1-based). A transcript that grows
// later (a resumed session) appends after the others: no id moves. A
// leaf's text is read anew from its transcript by that pointer.
//
// tree.jsonl: the nodes built, append-only, `{l, i, text}`. Node (0,i) is
// message i if it fits NODE, else its summary line; node (l,i) merges
// (l-1,2i) and (l-1,2i+1) once both are built. A source that fits is its
// node; the others are asked of `claude -p` in batches (summarize): every
// leaf, and only the merges the view needs (build; Memory.ts asks all).
//
// view.json: the view's parts, oldest first, covering messages 0..end;
// past HIGH bytes the oldest adjacent siblings whose parent is built merge,
// down to half (fit): detail fades with age.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Constants
// =========

export const NODE  = 512;
// the bytes a line is asked for: under NODE, so few come back over it
export const AIM   = 450;
export const TRIES = 5;
// nodes a call, calls at once
export const BATCH = 20;
export const JOBS  = 8;
// the view's bytes: SessionStart injects at most 10,000 chars
export const HIGH  = 7000;

// a ruler, not a sample line: the compactor copied a sample's content
const SCALE = "-".repeat(AIM);

export const WAIT = "(not summarized yet: zoom it)";

// Types
// =====

// node (l,i), as a line of a view
export type Part = { l: number; i: number };

// a message as indexed: its id, transcript, line there, date
export type Entry = { i: number; sid: string; line: number; date: string };

// a summarizer: a system prompt and a task in, the reply's text out
export type Ask = (system: string, prompt: string) => Promise<string>;

// what a build did: calls made, ids asked again, nodes clipped, why calls
// stopped (none: they did not)
export type Stats = { calls: number; retries: number; clipped: number; error?: string };

// Messages
// ========

const DECL = /DECLARED TASK ANCHOR \(([^)]*)\):\s*STATE/;
const STRIP = /<system-reminder>[\s\S]*?<\/system-reminder>|<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g;
const CMD = /<command-name>([\s\S]*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/;
// prose lines that echo the anchor: hook blocks, STATE lines, INDEX rows,
// claim/park results, anchor-dir paths, the two commands
const ECHO = /TASK ANCHOR|STATE \d{4}-\d\d-\d\d|\|\s*(ACTIVE|PARKED|CLOSED)\s*\||^\W*(Claimed|Parked)\b|task-anchors|\/park\b|\/claim-task\b/;
// not inside a path: `patch ~/.claude/skills/park/SKILL.md` is no park
const LANE_CMD = /(?<![\w.~/-])\/(park|claim-task)\b[^\n]*/g;
// a tool call that loads the skill: Skill(park) or a Read of skills/park/
// ponytail: a Bash `cat` of SKILL.md is missed, so that turn's replies stay
const LANE_SKILL = /"skill":\s*"(park|claim-task)"|skills\/(park|claim-task)\//;

type Said = { who: "user" | "ai"; text: string };

// a record's text as the lane keeps it (user prompts still hold /park etc.,
// so `messages` can drop the turn); null: none
export function said(d: any): Said | null {
  const t = d?.type;
  if ((t !== "user" && t !== "assistant") || d.isSidechain || d.isMeta) {
    return null;
  }
  const c = d.message?.content;
  const texts: string[] = typeof c === "string" ? [c] : (Array.isArray(c) ? c : []).filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "");
  const out: string[] = [];
  for (let x of texts) {
    x = x.replace(STRIP, "").trim();
    if (x.startsWith("Base directory for this skill")) {
      continue;
    }
    if (t === "user" && x.startsWith("<command-")) {
      const m = CMD.exec(x);
      x = m ? (m[1] + " " + m[2]).trim() : "";
    }
    if (t === "assistant") {
      x = x.split("\n").filter((l) => !ECHO.test(l)).join("\n").trim();
    }
    if (x) {
      out.push(x);
    }
  }
  return out.length ? { who: t === "user" ? "user" : "ai", text: out.join("\n") } : null;
}

// a message's text as summarized: a prompt without its /park or /claim-task
export function clean({ who, text }: Said): string {
  return who === "user" ? text.replace(LANE_CMD, "").trim() : text;
}

// the lane's messages of a transcript, in order: each turn takes the anchor
// declared between its prompt and the next (else the last one); only
// `lane`'s are kept, all if none is declared. A /park or /claim-task turn,
// or one where the model loaded those skills, keeps its prompt's other text
// and drops its replies
export function messages(file: string, lane: string): Array<Said & { line: number; date: string }> {
  type Item = Said & { line: number; date: string; skill?: boolean };
  const turns: Array<{ anchor: string | null; items: Item[] }> = [];
  let [anchor, declared] = [null as string | null, false];
  let pending: Item[] = [];
  const flush = () => {
    if (pending.length) {
      turns.push({ anchor, items: pending });
    }
    pending = [];
  };
  fs.readFileSync(file, "utf8").split("\n").forEach((raw, k) => {
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    if (d.isSidechain || d.isMeta) {
      return;
    }
    if (d.type === "attachment" && d.attachment?.type === "hook_additional_context") {
      for (const c of d.attachment.content ?? []) {
        const m = DECL.exec(String(c));
        if (m) {
          [anchor, declared] = [path.basename(m[1]), true];
        }
      }
      return;
    }
    const [line, date] = [k + 1, String(d.timestamp ?? "")];
    const c = d.message?.content;
    if (d.type === "assistant" && Array.isArray(c) && c.some((b: any) => b?.type === "tool_use" && (b.name === "Skill" || b.name === "Read") && LANE_SKILL.test(JSON.stringify(b.input ?? null)))) {
      pending.push({ who: "ai", text: "", line, date, skill: true });
    }
    const s = said(d);
    if (s === null) {
      return;
    }
    if (s.who === "user") {
      flush();
    }
    pending.push({ ...s, line, date });
  });
  flush();
  const out: Array<Said & { line: number; date: string }> = [];
  for (const turn of turns.filter((turn) => !declared || turn.anchor === lane + ".md")) {
    let park = false;
    for (const { skill, ...m } of turn.items) {
      if (skill) {
        park = true;
      } else if (m.who === "user") {
        park = new RegExp(LANE_CMD.source).test(m.text);
        if (clean(m)) {
          out.push({ ...m, text: clean(m) });
        }
      } else if (!park) {
        out.push(m);
      }
    }
  }
  return out;
}

// Files
// =====

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// a JSON-lines file's records; a line cut short (a crash) is skipped
function jsonl(file: string): any[] {
  return lines(file).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

function append(file: string, recs: object[]): void {
  if (recs.length > 0) {
    fs.appendFileSync(file, recs.map((r) => JSON.stringify(r) + "\n").join(""));
  }
}

// the log's transcripts, in order: [session_id, path]
export function logged(dir: string): Array<[string, string]> {
  return lines(path.join(dir, "log"))
    .filter((l) => !l.startsWith("closed: ") && l.includes("\t"))
    .map((l) => l.split("\t", 2) as [string, string]);
}

export function index(dir: string): Entry[] {
  return jsonl(path.join(dir, "index.jsonl"));
}

// the index, with the messages logged since the last ingest appended: of
// each transcript, those after its last line indexed
export function ingest(dir: string, lane: string): Entry[] {
  const idx = index(dir);
  const last = new Map<string, number>();
  idx.forEach((e) => last.set(e.sid, Math.max(last.get(e.sid) ?? 0, e.line)));
  const add: Entry[] = [];
  for (const [sid, file] of logged(dir)) {
    if (!fs.existsSync(file)) {
      continue;
    }
    // ponytail: reads each transcript whole (a turn's anchor and /park state
    // start at its prompt); seek to the last indexed turn's prompt if slow
    for (const m of messages(file, lane)) {
      if (m.line > (last.get(sid) ?? 0)) {
        add.push({ i: idx.length + add.length, sid, line: m.line, date: m.date });
      }
    }
  }
  append(path.join(dir, "index.jsonl"), add);
  return [...idx, ...add];
}

// message i's text, `user: ...` or `ai: ...`, read anew from its transcript
export function reader(dir: string, idx: Entry[]): (i: number) => string {
  const files = new Map(logged(dir));
  const read = new Map<string, string[]>();
  const memo = new Map<number, string>();
  return (i) => {
    if (!memo.has(i)) {
      const { sid, line } = idx[i];
      if (!read.has(sid)) {
        read.set(sid, fs.readFileSync(files.get(sid)!, "utf8").split("\n"));
      }
      const s = said(JSON.parse(read.get(sid)![line - 1]));
      memo.set(i, s === null ? "" : s.who + ": " + clean(s));
    }
    return memo.get(i)!;
  };
}

// node texts by slot
export function tree(dir: string): Map<number, string> {
  return new Map(jsonl(path.join(dir, "tree.jsonl")).map(({ l, i, text }) => [slot(l, i), text]));
}

// Tree
// ====

export function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function slot(l: number, i: number): number {
  return (2 * i + 1) * 2 ** l - 1;
}

export function halves(part: Part): Part[] {
  return part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
}

export function ctx({ l, i }: Part): number {
  return l === 0 ? i : (i + 1) * 2 ** l;
}

export function span(part: Part): [number, number] {
  const a = part.i * 2 ** part.l;
  return [a, a + 2 ** part.l - 1];
}

// the regex tries every position; most lines have no newline at all
export function flat(text: string): string {
  return text.includes("\n") ? text.replace(/\s*\n\s*/g, " ") : text;
}

// its zoom target, "id+n"
export function ref(part: Part): string {
  return part.i * 2 ** part.l + "+" + 2 ** part.l;
}

export function line(part: Part, text: string): string {
  return ref(part) + "|" + flat(text);
}

// a text's first NODE bytes
export function cut(text: string): string {
  return Buffer.from(text, "utf8").subarray(0, NODE).toString("utf8").replace(/�+$/, "");
}

// Summaries
// =========

const SYSTEM = "You compress chat messages from one work lane into short summary lines. Lane: {lane}. Output only the requested lines, nothing else.";

// a batch's task, before its items: messages to compress, pairs of lines to
// merge
const TASK = `Write one line per item below, each at most ${AIM} bytes (about 50 words), the length of this ruler:
${SCALE}
Each line is \`<n>|<summary>\`, <n> being the item's number after its #: one line per item, nothing else.
An item with a date is one message: compress it. A "merge:" item is two adjacent summary lines (each after a "- "), oldest first: merge them into one line, keeping the latest state, open blockers, decisions and next steps over history.
Keep names, hashes, MR numbers, step numbers, decisions (D-numbers) and blockers.
The project's other lanes: {others}. A message mainly about another lane's work or ticket gets a summary starting \`other lane: <slug>\`; it is kept, not dropped. Keep \`other lane:\` marks when merging.
<input>
`;

// a batch's prompt: its items numbered from 1 (given "id+n" refs, Haiku
// answered "id" or the children's refs), a leaf as its message, a merge as
// its two children's texts; and a note per item whose last line was too long
// ponytail: merges see only their two child lines; pass the view up to the
// node (Memory.ts's <chat> context) if merged lines lose detail
export function prompt(batch: Array<Part & { text: string }>, idx: Entry[], nodes: Map<number, string>, others: string[], long: Map<number, number>): string {
  const items = batch.map((p, k) =>
    p.l === 0
      ? "#" + (k + 1) + " " + idx[p.i].date.slice(0, 16) + " " + p.text
      : "#" + (k + 1) + " merge:\n" + halves(p).map((h) => "- " + flat(nodes.get(slot(h.l, h.i))!)).join("\n"));
  const notes = batch.flatMap((p, k) => !long.has(slot(p.l, p.i)) ? [] :
    `Too long last time: #${k + 1} was ${long.get(slot(p.l, p.i))} bytes, over the ${NODE}-byte limit. Write it again, cutting the least valuable items.\n`);
  return TASK.replace("{others}", others.join(", ") || "none") + items.join("\n") + "\n</input>\n" + notes.join("");
}

// the nodes not built whose sources are, built: those that fit at once, the
// leaves and the merges of `want` (null: all) asked of `ask` in batches of
// BATCH, JOBS at once, in the order the messages came (a merge first at a
// tie); a free slot takes what is ready, up to BATCH. Each reply is checked per id: an id missing, given twice, or
// over NODE is asked again, TRIES times at most, then is its source clipped.
// A call that fails (an outage) stops the build: its nodes wait, unbuilt,
// for the next (Stats.error)
export async function summarize(dir: string, lane: string, others: string[], ask: Ask, idx = index(dir), nodes = tree(dir), want: Set<number> | null = null, stats: Stats = { calls: 0, retries: 0, clipped: 0 }): Promise<Stats> {
  const count = idx.length;
  const text = reader(dir, idx);
  const system = SYSTEM.replace("{lane}", lane);
  const [busy, tries, long] = [new Set<number>(), new Map<number, number>(), new Map<number, number>()];
  const source = (p: Part): string | null => {
    if (p.l === 0) {
      return text(p.i);
    }
    const [a, b] = halves(p).map((h) => nodes.get(slot(h.l, h.i)));
    return a === undefined || b === undefined ? null : flat(a) + "\n" + flat(b);
  };
  const ready = (): Array<Part & { text: string }> => {
    const out: Array<Part & { text: string }> = [];
    for (let l = 0; 2 ** l <= count; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= count; i++) {
        const k = slot(l, i);
        const t = nodes.has(k) || busy.has(k) ? null : source({ l, i });
        if (t !== null && (l === 0 || want === null || want.has(k) || bytes(t) <= NODE)) {
          out.push({ l, i, text: t });
        }
      }
    }
    return out.sort((a, b) => ctx(a) - ctx(b) || b.l - a.l);
  };
  const store = (parts: Array<Part & { text: string }>) => {
    append(path.join(dir, "tree.jsonl"), parts.map(({ l, i, text }) => ({ l, i, text })));
    parts.forEach(({ l, i, text }) => nodes.set(slot(l, i), text));
  };
  const run = async (batch: Array<Part & { text: string }>) => {
    stats.calls++;
    const got = new Map<number, string[]>();
    for (const l of (await ask(system, prompt(batch, idx, nodes, others, long))).split("\n")) {
      const m = /^#?(\d+)\|(.*)$/.exec(l.trim());
      if (m) {
        got.set(Number(m[1]), [...(got.get(Number(m[1])) ?? []), flat(m[2].trim())]);
      }
    }
    const done: Array<Part & { text: string }> = [];
    for (const [n, p] of batch.entries()) {
      const k = slot(p.l, p.i);
      const lines = got.get(n + 1) ?? [];
      if (lines.length === 1 && lines[0] !== "" && bytes(lines[0]) <= NODE) {
        done.push({ l: p.l, i: p.i, text: lines[0] });
        continue;
      }
      if (lines.length === 1) {
        long.set(k, bytes(lines[0]));
      }
      tries.set(k, (tries.get(k) ?? 0) + 1);
      if (tries.get(k)! < TRIES) {
        stats.retries++;
      } else {
        stats.clipped++;
        done.push({ l: p.l, i: p.i, text: cut(flat(p.text)) });
      }
    }
    store(done);
  };
  const running = new Set<Promise<void>>();
  let failed: unknown = null;
  for (;;) {
    for (let free = ready().filter((p) => bytes(p.text) <= NODE); free.length > 0; free = ready().filter((p) => bytes(p.text) <= NODE)) {
      store(free);
    }
    const next = failed === null ? ready() : [];
    while (next.length > 0 && running.size < JOBS) {
      const batch = next.splice(0, BATCH);
      const keys = batch.map((p) => slot(p.l, p.i));
      keys.forEach((k) => busy.add(k));
      const job: Promise<void> = run(batch)
        .catch((err) => void (failed ??= err))
        .finally(() => {
          running.delete(job);
          keys.forEach((k) => busy.delete(k));
        });
      running.add(job);
    }
    if (running.size === 0) {
      break;
    }
    await Promise.race(running);
  }
  if (failed !== null) {
    stats.error = String((failed as Error)?.message ?? failed);
  }
  return stats;
}

// `claude -p` on Haiku, lean (no tools, settings or session; `--bare` needs
// an API key); stderr kept apart (an MCP policy warning), stdout's JSON read
export function claude(system: string, prompt: string): Promise<string> {
  const args = ["-p", "--model", "claude-haiku-5-5", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt", system, "--output-format", "json"];
  return new Promise((resolve, reject) => {
    const child = execFile("claude", args, { cwd: os.tmpdir(), maxBuffer: 2 ** 26, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error("claude -p: " + (String(stderr).trim() || err.message)));
      }
      let j: any;
      try {
        j = JSON.parse(stdout);
      } catch {
        return reject(new Error("claude -p: no JSON on stdout"));
      }
      return j.is_error ? reject(new Error("claude -p: " + j.result)) : resolve(String(j.result ?? ""));
    });
    child.stdin!.end(prompt);
  });
}

// View
// ====

// a part's bytes as injected: its line and newline; none until built
export function size(nodes: Map<number, string>, part: Part): number {
  const text = nodes.get(slot(part.l, part.i));
  return text === undefined ? 0 : bytes(line(part, text)) + 1;
}

// the message after a view's last part
export function end(parts: Part[]): number {
  return parts.length === 0 ? 0 : span(parts[parts.length - 1])[1] + 1;
}

export function total(parts: Part[], nodes: Map<number, string>): number {
  return parts.reduce((n, p) => n + size(nodes, p), 0);
}

// the view kept, the messages to `count` appended
export function kept(dir: string, count: number): Part[] {
  let parts: Part[] = [];
  try {
    parts = JSON.parse(fs.readFileSync(path.join(dir, "view.json"), "utf8")).parts.map(([l, i]: number[]) => ({ l, i }));
  } catch {}
  for (let i = end(parts); i < count; i++) {
    parts.push({ l: 0, i });
  }
  return parts;
}

// the view to `count`; past HIGH, merged down to half; kept again
export function fit(dir: string, count: number, nodes: Map<number, string>): Part[] {
  let parts = kept(dir, count);
  if (total(parts, nodes) > HIGH) {
    parts = merge(parts, nodes, total(parts, nodes));
  }
  fs.writeFileSync(path.join(dir, "view.json"), JSON.stringify({ parts: parts.map((p) => [p.l, p.i]) }) + "\n");
  return parts;
}

// the merges a view past HIGH waits on to reach half: once merged as far as
// the nodes built allow, the parents not built of its sibling pairs built
// ponytail: asks every such pair's parent, the newest too (needed later);
// ask only the most due if backfill calls matter
export function needs(parts: Part[], nodes: Map<number, string>): Part[] {
  if (total(parts, nodes) <= HIGH) {
    return [];
  }
  const view = merge(parts, nodes, total(parts, nodes));
  if (total(view, nodes) <= HIGH / 2) {
    return [];
  }
  const built = (p: Part) => nodes.has(slot(p.l, p.i));
  return view.slice(1).flatMap((b, k) => {
    const a = view[k];
    const up = { l: a.l + 1, i: a.i / 2 };
    return a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1 && built(a) && built(b) && !built(up) ? [up] : [];
  });
}

// a view's most due pairs merged down to half, as their parents allow:
// a pair whose parent is built, most due first ((T + 1) / 2^l - i, T
// the view's end: its age from its last message, in halves), the oldest
// of equals; a heap of pairs over the view as a linked list
export function merge(parts: Part[], nodes: Map<number, string>, total: number): Part[] {
  const [t, low] = [end(parts), HIGH / 2];
  const view: Array<Part | null> = [...parts];
  const next = view.map((_, k) => k + 1);
  const prev = view.map((_, k) => k - 1);
  const heap: Array<{ d: number; k: number; a: Part; b: Part }> = [];
  const over = (x: (typeof heap)[0], y: (typeof heap)[0]) => x.d > y.d || (x.d === y.d && x.k < y.k);
  const swap = (x: number, y: number) => ([heap[x], heap[y]] = [heap[y], heap[x]]);
  const offer = (k: number) => {
    const [a, b] = [view[k], view[next[k]]];
    if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !nodes.has(slot(a.l + 1, a.i / 2))) {
      return;
    }
    heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b });
    for (let x = heap.length - 1; x > 0 && over(heap[x], heap[(x - 1) >> 1]); x = (x - 1) >> 1) {
      swap(x, (x - 1) >> 1);
    }
  };
  const take = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let x = 0; ; ) {
        const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => (c < heap.length && over(heap[c], heap[m]) ? c : m));
        if (m === x) {
          break;
        }
        swap(x, m);
        x = m;
      }
    }
    return top;
  };
  let n = total;
  view.forEach((_, k) => offer(k));
  while (heap.length > 0 && n > low) {
    const { k, a, b } = take();
    const j = next[k];
    if (view[k] !== a || view[j] !== b) {
      continue;
    }
    const up = { l: a.l + 1, i: a.i / 2 };
    n += size(nodes, up) - size(nodes, a) - size(nodes, b);
    [view[k], view[j]] = [up, null];
    next[k] = next[j];
    prev[next[j]] = k;
    offer(prev[k]);
    offer(k);
  }
  return view.filter((p) => p !== null);
}

// a line per part, oldest first; one not built says WAIT
export function render(parts: Part[], nodes: Map<number, string>): string {
  return parts.map((p) => line(p, nodes.get(slot(p.l, p.i)) ?? WAIT)).join("\n");
}

// ingest; summarize the leaves, then, a round per level, the merges the
// view needs (Memory.ts builds every node: a full tree is a call per level
// up, about 15 s each, for a view that may need none); fit: the view, and
// what it took. One at a time per lane (lock), never waiting: a build that
// finds the lock held touches `again` and returns null; the holder builds
// again while `again` exists
// ponytail: an `again` touched after the holder's last check and before its
// release is lost until the next Stop's build; re-check after release if
// that bites
export async function build(dir: string, lane: string, others: string[], ask: Ask = claude) {
  const release = lock(dir);
  const again = path.join(dir, "again");
  if (release === null) {
    fs.writeFileSync(again, "");
    return null;
  }
  try {
    let r;
    do {
      fs.rmSync(again, { force: true });
      const idx = ingest(dir, lane);
      const nodes = tree(dir);
      const stats = await summarize(dir, lane, others, ask, idx, nodes, new Set());
      for (let want = needs(kept(dir, idx.length), nodes); want.length > 0 && !stats.error; want = needs(kept(dir, idx.length), nodes)) {
        await summarize(dir, lane, others, ask, idx, nodes, new Set(want.map((p) => slot(p.l, p.i))), stats);
      }
      const parts = fit(dir, idx.length, nodes);
      r = { count: idx.length, parts, nodes, stats, view: render(parts, nodes) };
    } while (fs.existsSync(again) && !r.stats.error);
    return r;
  } finally {
    release();
  }
}

// Lock
// ====

export const STALE = 10000;

// a lane's build lock, as /claim-task's: the dir build.lock made by one
// mkdir (EEXIST: held), its owner's pid in build.lock/pid. One whose pid is
// dead, or with no pid past STALE ms (its owner died before writing it), is
// stale: removed, taken. Returns its release; null: held (no wait, D3).
// A takeover holds build.lock.take, a second mkdir lock, so two builds that
// both find it stale cannot both remove it (the second removing the first's
// new lock); a take past STALE ms (its owner died taking over) is removed
// ponytail: two that both find the take past STALE can remove a third's
// fresh one; needs a crash mid-takeover first
export function lock(dir: string): (() => void) | null {
  const l = path.join(dir, "build.lock");
  const t = l + ".take";
  const make = (): (() => void) | null => {
    try {
      fs.mkdirSync(l);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      return null;
    }
    fs.writeFileSync(path.join(l, "pid"), String(process.pid));
    return () => fs.rmSync(l, { recursive: true, force: true });
  };
  const got = make();
  if (got !== null || !stale(l)) {
    return got;
  }
  try {
    fs.mkdirSync(t);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    if (old(t)) {
      fs.rmSync(t, { recursive: true, force: true });
    }
    return null;
  }
  try {
    if (fs.existsSync(l) && !stale(l)) {
      return null;
    }
    fs.rmSync(l, { recursive: true, force: true });
    return make();
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// made more than STALE ms ago; gone: no
function old(p: string): boolean {
  try {
    return Date.now() - fs.statSync(p).mtimeMs > STALE;
  } catch {
    return false;
  }
}

function stale(l: string): boolean {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(l, "pid"), "utf8"));
  } catch {}
  if (!(pid > 0)) {
    return old(l); // gone: not stale, retry
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

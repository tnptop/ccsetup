// Lane
// ====
// A lane's log and its CLI (the hooks call it). A lane's dir is
// <root>/<project-slug>/<lane>/, root $LANES_ROOT or ~/.claude/lanes; the
// slug is the project dir with every char not in A-Za-z0-9 a `-` (as
// ~/.claude/task-anchors/<slug>). Its `log`, plain text, append-only:
// `<session_id>\t<transcript path>` per transcript of the lane (once), and
// `closed: <date> <outcome>`. Transcripts are not copied.
//
//   node lanes/lane.ts add <project-dir> <lane> <session_id> <transcript>
//   node lanes/lane.ts close <project-dir> <lane> <outcome>
//   node lanes/lane.ts build <project-dir> <lane>     (the view, to stdout)
//   node lanes/lane.ts inject view|last <project-dir> <lane>  (SessionStart)
//   node lanes/lane.ts zoom <project-dir> <lane> <id> <n>     (a view line opened)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build, halves, HIGH, index, kept, logged, merge, reader, render, span, total, tree } from "./tree.ts";

export function slug(project: string): string {
  return path.resolve(project).replace(/[^A-Za-z0-9]/g, "-");
}

export function dir(project: string, lane: string): string {
  const root = process.env.LANES_ROOT || path.join(os.homedir(), ".claude", "lanes");
  return path.join(root, slug(project), lane);
}

// the lane's dir, made if its project's lanes dir exists; never that dir:
// it switches its project over (section 6), so a hook elsewhere must not
// make it
function made(project: string, lane: string): string {
  const d = dir(project, lane);
  if (!fs.existsSync(path.dirname(d))) {
    throw new Error("no project lanes dir at " + path.dirname(d));
  }
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// a transcript logged, once per session
export function add(project: string, lane: string, sid: string, file: string): void {
  const d = made(project, lane);
  if (!logged(d).some(([s]) => s === sid)) {
    fs.appendFileSync(path.join(d, "log"), sid + "\t" + path.resolve(file) + "\n");
  }
}

export function close(project: string, lane: string, outcome: string): void {
  const d = made(project, lane);
  fs.appendFileSync(path.join(d, "log"), "closed: " + new Date().toISOString().slice(0, 10) + " " + outcome + "\n");
}

// the project's other lanes: its task files but INDEX.md and this one
export function others(project: string, lane: string): string[] {
  try {
    const anchors = path.join(os.homedir(), ".claude", "task-anchors", slug(project));
    return fs.readdirSync(anchors).filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== lane + ".md").map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

// Inject
// ======
// SessionStart's texts, read-only (no `claude -p`, no view.json written).
// Claude Code caps each hook's string at 10,000 chars (over it, Claude sees
// a path and 2,000 chars); each text clips itself at CAP JS chars, not
// bytes. Each names itself: the two hooks run in no set order

export const CAP = 9500;

const RULES = "live state not checked. Lines tagged `other lane:` are not this lane's next step.";

// the view as the last build left it, merged down past HIGH as `fit` would
// (the pure `merge`); over CAP, its oldest lines cut. "": no messages yet
export function injectView(project: string, lane: string): string {
  const d = dir(project, lane);
  const idx = index(d);
  if (idx.length === 0) {
    return "";
  }
  const nodes = tree(d);
  let parts = kept(d, idx.length);
  if (total(parts, nodes) > HIGH) {
    parts = merge(parts, nodes, total(parts, nodes));
  }
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const head = `LANE VIEW (inject view, lane ${lane}): this lane's summary, oldest first, a line per part \`id+n|text\` (messages id..id+n-1). Summary up to ${idx[idx.length - 1].date || "?"}; ${RULES} The last exchange comes verbatim in LANE LAST EXCHANGE. To zoom a line (read-only, Bash): node ${q(import.meta.filename)} zoom ${q(path.resolve(project))} ${lane} <id> <n> (n=1: the message whole; n>1: its two halves).\n`;
  const lines = render(parts, nodes).split("\n");
  const text = (k: number) => head + (k > 0 ? `older lines cut: zoom 0+${span(parts[k])[0]}\n` : "") + lines.slice(k).join("\n");
  let k = 0;
  while (text(k).length > CAP && k < lines.length - 1) {
    k++;
  }
  return text(k);
}

// the last exchange (last.json, written by the Stop hook) verbatim; over
// CAP, the prompt's first 1,500 chars and the message's end (its next step
// and options), naming the transcript for the cut. "": none
export function injectLast(project: string, lane: string): string {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(path.join(dir(project, lane), "last.json"), "utf8"));
  } catch {
    return "";
  }
  const [prompt, message] = [String(j.prompt ?? ""), String(j.message ?? "")];
  const head = `LANE LAST EXCHANGE (inject last, lane ${lane}): the last prompt and reply before this session, verbatim. Summary up to ${j.date || "?"}; ${RULES}\n`;
  const whole = head + "user: " + prompt + "\nassistant: " + message;
  if (whole.length <= CAP) {
    return whole;
  }
  const top = head + "user: " + (prompt.length > 1500 ? prompt.slice(0, 1500) + " [...]" : prompt) + "\nassistant: [...] ";
  const tail = "\n[cut: the whole exchange is in " + j.transcript + "]";
  return top + message.slice(message.length - Math.max(0, CAP - top.length - tail.length)) + tail;
}

// view line `id+n|...` opened, read-only: n = 1, message id whole (read
// anew from its transcript); n > 1, its two halves, a line each (WAIT: not
// built yet)
export function zoom(project: string, lane: string, id: number, n: number): string {
  const d = dir(project, lane);
  const idx = index(d);
  const l = Math.log2(n);
  if (!Number.isInteger(l) || !Number.isInteger(id) || id < 0 || id % n !== 0 || id + n > idx.length) {
    throw new Error(`no line ${id}+${n} in lane ${lane} (${idx.length} messages)`);
  }
  return n === 1 ? reader(d, idx)(id) : render(halves({ l, i: id / n }), tree(d));
}

if (import.meta.main) {
  const [cmd, project, lane, ...rest] = process.argv.slice(2);
  if ((cmd === "add" && rest.length === 2) || (cmd === "close" && rest.length > 0)) {
    try {
      cmd === "add" ? add(project, lane, rest[0], rest[1]) : close(project, lane, rest.join(" "));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  } else if (cmd === "build" && lane && rest.length === 0 && !fs.existsSync(dir(project, lane))) {
    console.error("no lane at " + dir(project, lane)); // never made here: a lanes dir switches its project over
    process.exitCode = 1;
  } else if (cmd === "build" && lane && rest.length === 0) {
    const t = Date.now();
    const r = await build(dir(project, lane), lane, others(project, lane));
    if (r === null) {
      console.error("lane " + lane + ": a build is running; it builds again (again)");
    } else {
      const { count, stats, view } = r;
      process.stdout.write(view + "\n");
      console.error(`lane ${lane}: ${count} messages, ${stats.calls} calls, ${stats.retries} retries, ${stats.clipped} clipped, ${Buffer.byteLength(view)} view bytes, ${Date.now() - t} ms`);
      if (stats.error) {
        console.error("lane " + lane + ": summaries stopped: " + stats.error);
        process.exitCode = 1;
      }
    }
  } else if (cmd === "zoom" && rest.length === 2) {
    try {
      process.stdout.write(zoom(project, lane, Number(rest[0]), Number(rest[1])) + "\n");
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  } else if (cmd === "inject" && (project === "view" || project === "last") && rest.length === 1) {
    const text = project === "view" ? injectView(lane, rest[0]) : injectLast(lane, rest[0]);
    if (text) {
      process.stdout.write(text);
    }
  } else {
    console.error("usage: node lanes/lane.ts add <project-dir> <lane> <session_id> <transcript-path>\n" +
      "       node lanes/lane.ts close <project-dir> <lane> <outcome>\n" +
      "       node lanes/lane.ts build <project-dir> <lane>\n" +
      "       node lanes/lane.ts inject view|last <project-dir> <lane>\n" +
      "       node lanes/lane.ts zoom <project-dir> <lane> <id> <n>");
    process.exitCode = 2;
  }
}

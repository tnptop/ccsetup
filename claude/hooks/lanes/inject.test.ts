import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inject-"));
process.env.LANES_ROOT = path.join(tmp, "root");

const { CAP, dir, injectLast, injectView, zoom } = await import("./lane.ts");
const { WAIT } = await import("./tree.ts");

let k = 0;

// a lane dir of its own, with files written as a build or Stop would
function lane(files: Record<string, string>): string {
  const project = path.join(tmp, "p" + k++);
  const d = dir(project, "l");
  fs.mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, f), text);
  }
  return project;
}

const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r) + "\n").join("");

test("a 20k-char view clips its oldest lines to CAP, with zoom 0+N", () => {
  const n = 50;
  const project = lane({
    "index.jsonl": jsonl(Array.from({ length: n }, (_, i) => ({ i, sid: "s", line: i + 1, date: "2026-10-22T10:00:00Z" }))),
    "tree.jsonl": jsonl(Array.from({ length: n }, (_, i) => ({ l: 0, i, text: `leaf${i} ` + "x".repeat(400) }))),
  });
  const v = injectView(project, "l");
  assert.ok(CAP <= 9500);
  assert.ok(v.length <= 9500, v.length + " chars");
  assert.match(v, /^LANE VIEW \(inject view, lane l\)/);
  assert.match(v, /Summary up to 2026-10-22T10:00:00Z; live state not checked/);
  assert.match(v, /`other lane:` are not this lane's next step/);
  const cut = /\nolder lines cut: zoom 0\+(\d+)\n(\d+)\+1\|leaf/.exec(v);
  assert.ok(cut, "no zoom line");
  assert.equal(cut[1], cut[2]);
  assert.ok(v.endsWith(`${n - 1}+1|leaf${n - 1} ` + "x".repeat(400)));
  assert.equal(fs.existsSync(path.join(dir(project, "l"), "view.json")), false, "read-only");
  assert.equal(injectView(lane({}), "l"), "");
});

test("a 20k-char Thai last exchange keeps the prompt start, the message end and the transcript", () => {
  const thai = "ภาษาไทย".repeat(1500); // 10,500 chars, 31,500 bytes
  const project = lane({
    "last.json": JSON.stringify({ prompt: "PSTART " + thai, message: thai + " MEND", transcript: "/t/s.jsonl", date: "2026-10-22T11:00:00+07:00" }),
  });
  const t = injectLast(project, "l");
  assert.ok(t.length <= 9500, t.length + " chars");
  assert.match(t, /^LANE LAST EXCHANGE \(inject last, lane l\)/);
  assert.match(t, /Summary up to 2026-10-22T11:00:00\+07:00; live state not checked/);
  assert.match(t, /\nuser: PSTART ภาษาไทย/);
  assert.match(t, / MEND\n\[cut: the whole exchange is in \/t\/s\.jsonl\]$/);
  const kept = t.slice(t.indexOf("user: ") + 6, t.indexOf(" [...]"));
  assert.equal(kept.length, 1500);
  // a short one is whole
  const small = lane({ "last.json": JSON.stringify({ prompt: "A", message: "pick A or B", transcript: "/t", date: "d" }) });
  assert.match(injectLast(small, "l"), /\nuser: A\nassistant: pick A or B$/);
  assert.equal(injectLast(lane({}), "l"), "");
});

// two messages (the first 3,000+ chars), their transcript logged; leaf 0
// built, leaf 1 not
const long = "y".repeat(3000);
function zoomed(): string {
  const file = path.join(tmp, "z" + k + ".jsonl");
  fs.writeFileSync(file, jsonl([
    { type: "user", message: { role: "user", content: "hello " + long }, timestamp: "2026-10-22T10:00:00Z" },
    { type: "assistant", message: { content: [{ type: "text", text: "pick A or B" }] }, timestamp: "2026-10-22T10:01:00Z" },
  ]));
  return lane({
    log: "s\t" + file + "\n",
    "index.jsonl": jsonl([{ i: 0, sid: "s", line: 1, date: "d" }, { i: 1, sid: "s", line: 2, date: "d" }]),
    "tree.jsonl": jsonl([{ l: 0, i: 0, text: "leaf zero" }]),
  });
}

test("zoom n = 1: the message whole, from its transcript", () => {
  const project = zoomed();
  assert.equal(zoom(project, "l", 0, 1), "user: hello " + long);
  assert.equal(zoom(project, "l", 1, 1), "ai: pick A or B");
  assert.throws(() => zoom(project, "l", 2, 1), /no line 2\+1 in lane l \(2 messages\)/);
});

test("zoom n > 1: its two halves, WAIT when not built; the view names the command", () => {
  const project = zoomed();
  assert.equal(zoom(project, "l", 0, 2), "0+1|leaf zero\n1+1|" + WAIT);
  assert.throws(() => zoom(project, "l", 1, 2), /no line 1\+2 in lane l \(2 messages\)/);
  assert.throws(() => zoom(project, "l", 0, 4), /no line 0\+4/);
  // the view names the command, with this lane.ts and the project filled in
  assert.ok(injectView(project, "l").includes(`node '${path.join(import.meta.dirname, "lane.ts")}' zoom '${project}' l <id> <n>`));
});

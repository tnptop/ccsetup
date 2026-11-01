import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-"));
process.env.LANES_ROOT = path.join(tmp, "root");

const { add, close, dir } = await import("./lane.ts");
const { AIM, build, bytes, cut, HIGH, index, ingest, lock, messages, NODE, slot, span, STALE, summarize, tree, TRIES, WAIT } = await import("./tree.ts");
const { spawnSync } = await import("node:child_process");

// Fixtures
// ========

const u = (text: string) => ({ type: "user", message: { role: "user", content: text }, timestamp: "2026-10-22T10:00:00Z" });
const a = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp: "2026-10-22T10:01:00Z" });
const h = (lane: string) => ({ type: "attachment", attachment: { type: "hook_additional_context", content: [`DECLARED TASK ANCHOR (/x/${lane}.md): STATE 2026-10-22 | ACTIVE | next: x`] } });

let k = 0;

// a lane of its own, its transcripts' records appended by `put`
function lane(): { d: string; project: string; put: (sid: string, recs: object[]) => void } {
  const project = path.join(tmp, "p" + k++);
  fs.mkdirSync(path.dirname(dir(project, "l")), { recursive: true }); // switched over
  const put = (sid: string, recs: object[]) => {
    const file = project + "-" + sid + ".jsonl";
    fs.appendFileSync(file, recs.map((r) => JSON.stringify(r) + "\n").join(""));
    add(project, "l", sid, file);
  };
  return { d: dir(project, "l"), project, put };
}

// n messages, prompt and reply in turns, each `size` bytes
function msgs(n: number, size = 600, from = 0): object[] {
  return Array.from({ length: n }, (_, j) => (j % 2 === 0 ? u : a)(`m${from + j} ` + "x".repeat(size)));
}

// a prompt's items: number, node ("id+n": a leaf's from its message mK, a
// merge's from its children's texts, which name theirs: reply), the
// children's refs
function items(prompt: string): Array<{ k: number; ref: string; n: number; kids: string[] }> {
  const body = prompt.slice(prompt.indexOf("<input>\n") + 8, prompt.indexOf("\n</input>"));
  const out: Array<{ k: number; ref: string; n: number; kids: string[] }> = [];
  for (const l of body.split("\n")) {
    const m = /^#(\d+) (merge:|\S+ \w+: m(\d+) )/.exec(l);
    if (m) {
      out.push({ k: Number(m[1]), ref: m[3] === undefined ? "" : m[3] + "+1", n: 1, kids: [] });
    } else if (out.length > 0 && l.startsWith("- ")) {
      const it = out.at(-1)!;
      it.kids.push(/^- [LM](\d+\+\d+) /.exec(l)?.[1] ?? l);
      const [a, n] = it.kids[0].split("+").map(Number);
      [it.ref, it.n] = [a + "+" + 2 * n, 2 * n];
    }
  }
  return out;
}

// a line per item, about 300 bytes: L for a leaf, M for a merge
const reply = (it: { k: number; ref: string; n: number }) => `${it.k}|${it.n === 1 ? "L" : "M"}${it.ref} ` + "y".repeat(300);

// a summarizer answering every item, its prompts kept
function fake(edit = (_p: string, lines: string[]) => lines) {
  const prompts: string[] = [];
  const ask = async (_s: string, p: string) => {
    prompts.push(p);
    return edit(p, items(p).map(reply)).join("\n");
  };
  return { ask, prompts };
}

// Summaries
// =========

test("a batch missing an id or giving one twice asks just those again", async () => {
  const { d, put } = lane();
  put("s", msgs(5));
  let first = true;
  const { ask, prompts } = fake((_p, lines) => {
    if (!first) {
      return lines;
    }
    first = false;
    return [lines[1], ...lines.slice(1)]; // #1 (0+1) missing, #2 (1+1) twice
  });
  const { stats } = await build(d, "l", [], ask);
  assert.deepEqual(items(prompts[1]).filter((it) => it.n === 1).map((it) => it.ref), ["0+1", "1+1"]);
  const nodes = tree(d);
  for (let i = 0; i < 5; i++) {
    assert.match(nodes.get(slot(0, i))!, new RegExp(`^L${i}\\+1 `));
  }
  assert.equal(stats.retries, 2);
  assert.equal(stats.clipped, 0);
});

test("a line over NODE bytes is asked again, then the source clipped", async () => {
  const { d, put } = lane();
  put("s", msgs(3));
  const { ask, prompts } = fake((_p, lines) => lines.map((l) => (l.includes("|L0+1 ") ? l + "z".repeat(300) : l)));
  const { stats } = await build(d, "l", [], ask);
  assert.equal(prompts.filter((p) => items(p).some((it) => it.ref === "0+1")).length, TRIES);
  assert.match(prompts[1], /Too long last time: #\d+ was \d+ bytes/);
  const text = tree(d).get(slot(0, 0))!;
  assert.ok(bytes(text) <= NODE);
  assert.equal(text, cut("user: m0 " + "x".repeat(600)));
  assert.equal(stats.retries, TRIES - 1);
  assert.equal(stats.clipped, 1);
  for (const t of tree(d).values()) {
    assert.ok(bytes(t) <= NODE);
  }
});

test("the ruler is AIM bytes; a line between AIM and NODE is kept, not asked again", async () => {
  const { d, put } = lane();
  put("s", msgs(1));
  const { ask, prompts } = fake(() => ["1|" + "y".repeat(AIM + 30)]);
  const { stats } = await build(d, "l", [], ask);
  assert.ok(prompts[0].split("\n").includes("-".repeat(AIM)));
  assert.equal(bytes(tree(d).get(slot(0, 0))!), AIM + 30);
  assert.ok(AIM + 30 <= NODE);
  assert.equal(stats.retries, 0);
});

test("a free slot takes a batch less than full while others run", async () => {
  const { d, put } = lane();
  put("s", msgs(30)); // 20 leaves, then 10: both at once
  const { ask } = fake();
  let [now, most] = [0, 0];
  const slow = async (s: string, p: string) => {
    most = Math.max(most, ++now);
    await new Promise((r) => setTimeout(r, 5));
    now--;
    return ask(s, p);
  };
  await build(d, "l", [], slow);
  assert.ok(most > 1);
});

test("node (l,i) merges (l-1,2i) and (l-1,2i+1)", async () => {
  const { d, put } = lane();
  put("s", msgs(16));
  const { ask } = fake((p, lines) => {
    for (const it of items(p).filter((it) => it.n > 1)) {
      const [a0, n] = it.ref.split("+").map(Number);
      assert.deepEqual(it.kids, [`${a0}+${n / 2}`, `${a0 + n / 2}+${n / 2}`]);
    }
    return lines;
  });
  await summarize(d, "l", [], ask, ingest(d, "l")); // want null: every node, as Memory.ts
  const nodes = tree(d);
  assert.equal(nodes.size, 31);
  for (let l = 1; l <= 4; l++) {
    for (let i = 0; i < 16 / 2 ** l; i++) {
      assert.match(nodes.get(slot(l, i))!, new RegExp(`^M${i * 2 ** l}\\+${2 ** l} `));
    }
  }
  // sources that fit are their nodes, a merge's its halves' lines
  const small = lane();
  small.put("s", msgs(4, 10));
  await build(small.d, "l", [], fake().ask);
  const t = tree(small.d);
  assert.equal(t.get(slot(1, 1)), t.get(slot(0, 2)) + "\n" + t.get(slot(0, 3)));
  assert.equal(t.get(slot(2, 0)), t.get(slot(0, 0)) + " " + t.get(slot(0, 1)) + "\n" + t.get(slot(0, 2)) + " " + t.get(slot(0, 3)));
});

test("a failed call leaves its nodes unbuilt, shown as WAIT", async () => {
  const { d, put } = lane();
  put("s", msgs(3));
  const { stats, view } = await build(d, "l", [], async () => {
    throw new Error("down");
  });
  assert.equal(stats.error, "down");
  assert.equal(view, ["0+1", "1+1", "2+1"].map((r) => r + "|" + WAIT).join("\n"));
  assert.equal(tree(d).size, 0);
});

// View
// ====

// the view's parts cover 0..count-1, in order, with no gap
function contiguous(parts: Array<{ l: number; i: number }>, count: number): void {
  let next = 0;
  for (const p of parts) {
    assert.equal(span(p)[0], next);
    next = span(p)[1] + 1;
  }
  assert.equal(next, count);
}

test("the view fits HIGH and covers 0..end; detail fades with age", async () => {
  const { d, put } = lane();
  put("s", msgs(100));
  let r = await build(d, "l", [], fake().ask);
  assert.ok(bytes(r.view) <= HIGH, `${bytes(r.view)} bytes`);
  contiguous(r.parts, 100);
  assert.ok(r.parts[0].l > r.parts.at(-1)!.l);
  assert.equal(r.view.split("\n").length, r.parts.length);
  put("s", msgs(40, 600, 100));
  r = await build(d, "l", [], fake().ask);
  assert.ok(bytes(r.view) <= HIGH, `${bytes(r.view)} bytes`);
  contiguous(r.parts, 140);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "view.json"), "utf8")).parts, r.parts.map((p) => [p.l, p.i]));
});

// Log and index
// =============

test("a resumed older transcript's growth keeps the ids it had", () => {
  const { d, put } = lane();
  put("a", msgs(3, 10));
  put("b", msgs(2, 10));
  const before = ingest(d, "l");
  assert.deepEqual(before.map((e) => [e.i, e.sid]), [[0, "a"], [1, "a"], [2, "a"], [3, "b"], [4, "b"]]);
  put("a", msgs(2, 10, 3)); // resumed: same session, its transcript grows
  const after = ingest(d, "l");
  assert.deepEqual(after.slice(0, 5), before);
  assert.deepEqual(after.slice(5).map((e) => [e.i, e.sid, e.line]), [[5, "a", 4], [6, "a", 5]]);
  assert.deepEqual(index(d), after);
  assert.equal(ingest(d, "l").length, 7);
});

test("log: a session once; closed lines", () => {
  const { d, project, put } = lane();
  put("a", msgs(1, 10));
  put("a", msgs(1, 10));
  close(project, "l", "merged");
  const log = fs.readFileSync(path.join(d, "log"), "utf8").split("\n");
  assert.equal(log[0], "a\t" + project + "-a.jsonl");
  assert.match(log[1], /^closed: \d{4}-\d\d-\d\d merged$/);
  assert.equal(log.length, 3);
});

test("messages: the lane's turns, park turns' replies and echoes stripped", () => {
  const file = path.join(tmp, "x.jsonl");
  const skill = { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "park" } }] } };
  const bash = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cp ~/.claude/skills/park/SKILL.md b/" } }] } };
  const recs = [
    u("hello x"), h("lane-x"), a("did x"),
    u("hello y"), h("lane-y"), a("did y"),
    u("<command-name>/park</command-name><command-args>next</command-args>"), h("lane-x"), a("parked reply"),
    u("go on <system-reminder>TASK ANCHOR stuff</system-reminder>"), h("lane-x"), a("STATE 2026-10-22 | ACTIVE | next\nreal reply"),
    u("save it"), h("lane-x"), a("before skill"), skill, a("after skill"),
    u("! patch ~/.claude/skills/claim-task/SKILL.md"), h("lane-x"), a("patched"), bash, a("after bash"),
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(messages(file, "lane-x").map((m) => m.text),
    ["hello x", "did x", "go on", "real reply", "save it", "before skill", "! patch ~/.claude/skills/claim-task/SKILL.md", "patched", "after bash"]);
  fs.writeFileSync(file, [u("a"), a("b")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(messages(file, "lane-x").map((m) => m.text), ["a", "b"]);
});

test("add and close refuse, making nothing, when the project has no lanes dir", () => {
  const project = path.join(tmp, "p" + k++);
  const pd = path.dirname(dir(project, "l"));
  assert.throws(() => add(project, "l", "s", "x.jsonl"), { message: "no project lanes dir at " + pd });
  assert.throws(() => close(project, "l", "merged"), { message: "no project lanes dir at " + pd });
  assert.equal(fs.existsSync(pd), false);
  const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, "lane.ts"), "add", project, "l", "s", "x.jsonl"], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "no project lanes dir at " + pd + "\n");
  assert.equal(fs.existsSync(pd), false);
});

test("add makes the lane's dir when the project has a lanes dir", () => {
  const project = path.join(tmp, "p" + k++);
  fs.mkdirSync(path.dirname(dir(project, "l")), { recursive: true });
  add(project, "l", "s", "x.jsonl");
  assert.equal(fs.readFileSync(path.join(dir(project, "l"), "log"), "utf8"), "s\t" + path.resolve("x.jsonl") + "\n");
});

// Lock
// ====

test("a build while the lock is held returns at once, leaving `again`; the holder builds again and removes it", async () => {
  const { d, put } = lane();
  put("s", msgs(2));
  const { ask } = fake();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let calls = 0;
  const held = async (s: string, p: string) => {
    if (++calls === 1) {
      await gate;
    }
    return ask(s, p);
  };
  const first = build(d, "l", [], held);
  while (calls === 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
  put("s", msgs(2, 600, 2)); // a turn more while the holder is in its call
  const t = Date.now();
  assert.equal(await build(d, "l", [], held), null);
  assert.ok(Date.now() - t < 100, "the second build waited");
  assert.equal(fs.existsSync(path.join(d, "again")), true);
  open();
  const r = (await first)!;
  assert.equal(calls, 2);
  assert.equal(r.count, 4);
  assert.equal(tree(d).size >= 4, true);
  assert.equal(fs.existsSync(path.join(d, "again")), false);
  for (const f of ["index.jsonl", "tree.jsonl"]) {
    const ls = fs.readFileSync(path.join(d, f), "utf8").split("\n").filter(Boolean);
    assert.equal(new Set(ls).size, ls.length, f + " has a line twice");
  }
  assert.equal(fs.existsSync(path.join(d, "build.lock")), false);
});

test("a lock whose pid is dead is taken over", { timeout: 5000 }, async () => {
  const { d, put } = lane();
  put("s", msgs(2, 10));
  fs.mkdirSync(path.join(d, "build.lock"));
  fs.writeFileSync(path.join(d, "build.lock", "pid"), String(spawnSync(process.execPath, ["-e", ""]).pid));
  const r = (await build(d, "l", [], fake().ask))!;
  assert.equal(r.count, 2);
  assert.equal(fs.existsSync(path.join(d, "build.lock")), false);
});

test("a stale lock another build is taking over is left to it; a take past STALE is cleared", { timeout: 5000 }, () => {
  const { d } = lane();
  const [l, t] = [path.join(d, "build.lock"), path.join(d, "build.lock.take")];
  fs.mkdirSync(l, { recursive: true });
  fs.writeFileSync(path.join(l, "pid"), String(spawnSync(process.execPath, ["-e", ""]).pid));
  fs.mkdirSync(t);
  assert.equal(lock(d), null);
  assert.ok(fs.existsSync(path.join(l, "pid")) && fs.existsSync(t));
  const past = new Date(Date.now() - STALE - 1000);
  fs.utimesSync(t, past, past);
  assert.equal(lock(d), null);
  assert.equal(fs.existsSync(t), false);
  const release = lock(d)!;
  assert.equal(fs.readFileSync(path.join(l, "pid"), "utf8"), String(process.pid));
  release();
  assert.equal(fs.existsSync(l), false);
});

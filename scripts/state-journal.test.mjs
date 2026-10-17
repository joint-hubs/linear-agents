// scripts/state-journal.test.mjs — the per-task journal CLI (FOC-904).
//
// What is worth protecting:
//   · init is idempotent — a second init must never rewrite the header the
//     metadata lines already record (Branch, PR, Status drift with work).
//   · add is append-only: earlier bytes are never touched, because the journal
//     IS the record for the task session that wrote it.
//   · set touches exactly one metadata line, and never anything below the
//     first entry heading.
//   · no task identity → exit 2. A journal without a task id is the ambiguity
//     the tool exists to remove.
//
// Run: node scripts/state-journal.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initJournal, addEntry, setFields, runCli } from "./state-journal.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), "la-journal-"));
  mkdirSync(join(dir, "docs", "state"), { recursive: true });
  return dir;
}

const ENV = {
  LA_TASK_ID: "FOC-904",
  FENIX_SUPERVISOR_SESSION_ID: "sess-abc",
  LA_SUPERVISOR_RUN: "run-123",
};
const capture = () => ({ out: [], err: [] });
const cli = (argv, { env = {}, root } = {}) => {
  const io = capture();
  const code = runCli(argv, {
    env: { ...ENV, ...env },
    root,
    stdout: (l) => io.out.push(l),
    stderr: (l) => io.err.push(l),
  });
  return { code, ...io };
};

console.log("\ninit");

test("init creates the file with the metadata block, derived from the env", () => {
  const root = tmpRoot();
  const res = cli(["init"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  const path = join(root, "docs", "state", "FOC-904.md");
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  assert.match(text, /^# FOC-904 — journal\n/);
  assert.match(text, /^Task: FOC-904$/m);
  assert.match(text, /^Session: sess-abc$/m);
  assert.match(text, /^Run: run-123$/m);
  assert.match(text, /^Branch: -$/m);
  assert.match(text, /^PR: -$/m);
  assert.match(text, /^Status: in progress$/m);
});

test("init accepts --task when no env names one", () => {
  const root = tmpRoot();
  const res = cli(["init", "--task", "FOC-1"], { env: { LA_TASK_ID: "" }, root });
  assert.equal(res.code, 0, res.err.join("\n"));
  assert.ok(existsSync(join(root, "docs", "state", "FOC-1.md")));
  assert.match(readFileSync(join(root, "docs", "state", "FOC-1.md"), "utf8"), /^Task: FOC-1$/m);
});

test("a second init is a no-op — the header is not rewritten", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  setFields({ root, taskId: "FOC-904", fields: ["Status=done", "PR=42"] });
  const before = readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8");
  const res = cli(["init"], { root });
  assert.equal(res.code, 0);
  assert.match(res.out.join("\n"), /already exists/);
  assert.equal(readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8"), before);
});

test("no task id at all → exit 2", () => {
  const root = tmpRoot();
  const res = cli(["init"], { env: { LA_TASK_ID: "" }, root });
  assert.equal(res.code, 2);
  assert.match(res.err.join("\n"), /no task id/);
});

test("a task id that could climb out of docs/state/ is refused", () => {
  const root = tmpRoot();
  for (const bad of ["../evil", "a/b", ".hidden", "a b"]) {
    const res = cli(["init", "--task", bad], { root });
    assert.equal(res.code, 2, `accepted ${bad}`);
  }
  assert.equal(existsSync(join(root, "docs", "STATE.md")), false);
});

console.log("\nadd");

test("add appends the heading and body, never rewriting earlier content", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const path = join(root, "docs", "state", "FOC-904.md");
  const before = readFileSync(path, "utf8");
  const res = cli(["add", "--text", "first line\nsecond line"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(before), "earlier content was rewritten");
  assert.match(after, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — first line\n\nsecond line\n\n$/m);
});

test("add appends below the previous entry, in order", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  addEntry({ root, taskId: "FOC-904", text: "one", stamp: "2026-10-16 10:00" });
  addEntry({ root, taskId: "FOC-904", text: "two", stamp: "2026-10-16 11:00" });
  const text = readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8");
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["2026-10-16 10:00 — one", "2026-10-16 11:00 — two"]);
});

test("add without a journal file fails with the init hint", () => {
  const root = tmpRoot();
  const res = cli(["add", "--text", "x", "--task", "FOC-1"], { env: { LA_TASK_ID: "" }, root });
  assert.equal(res.code, 1);
  assert.match(res.err.join("\n"), /init/);
});

console.log("\nset");

test("set updates one metadata line in place", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const path = join(root, "docs", "state", "FOC-904.md");
  addEntry({ root, taskId: "FOC-904", text: "entry body\nmore", stamp: "2026-10-16 10:00" });
  const before = readFileSync(path, "utf8");
  const res = cli(["set", "--field", "PR=12"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  const after = readFileSync(path, "utf8");
  assert.match(after, /^PR: 12$/m);
  // Everything else — including the entry — is byte-identical.
  assert.equal(after.replace(/^PR: .*/m, "PR: -"), before);
});

test("set refuses an unknown field and a multiline value", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  assert.equal(cli(["set", "--field", "Nope=1"], { root }).code, 1);
  assert.equal(cli(["set", "--field", "Status=a\nb"], { root }).code, 1);
});

test("set stores $-patterns in the value literally, not as replacement backreferences", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const res = cli(["set", "--field", "PR=$& $1 X"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  assert.match(readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8"), /^PR: \$& \$1 X$/m);
});

console.log("\nsummary");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);

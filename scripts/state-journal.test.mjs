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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initJournal, addEntry, setFields, resolveRoot, runCli } from "./state-journal.mjs";

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

console.log("\nresolveRoot — which root wins (FOC-1211)");

const scriptPath = fileURLToPath(new URL("./state-journal.mjs", import.meta.url));
const ownRepo = resolve(dirname(scriptPath), "..");

/** A throwaway git repository under tmpdir, with docs/state/ pre-created for init. */
function tmpGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "la-journal-git-"));
  const res = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, `git init failed: ${res.stderr}`);
  mkdirSync(join(dir, "docs", "state"), { recursive: true });
  return dir;
}

/** A throwaway NON-git directory — for the LA_ROOT / own-repo fallbacks. */
function tmpPlainDir() {
  const dir = mkdtempSync(join(tmpdir(), "la-journal-plain-"));
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(probe.status, 0, "tmpdir sits inside a git repository — this fixture is not a valid non-repo here");
  return dir;
}

test("resolveRoot prefers the cwd's git repository over LA_ROOT", () => {
  const main = tmpGitRepo();
  const worktree = tmpGitRepo();
  assert.equal(resolveRoot({ LA_ROOT: main }, worktree), resolve(worktree));
});

test("resolveRoot keeps the cwd's repo when LA_ROOT names the same repository", () => {
  const main = tmpGitRepo();
  assert.equal(resolveRoot({ LA_ROOT: main }, main), resolve(main));
});

test("resolveRoot falls back to LA_ROOT when cwd is not a git repository", () => {
  const plain = tmpPlainDir();
  const main = tmpGitRepo();
  assert.equal(resolveRoot({ LA_ROOT: main }, plain), resolve(main));
});

test("resolveRoot falls back to the script's own repo when neither cwd nor LA_ROOT applies", () => {
  const plain = tmpPlainDir();
  assert.equal(resolveRoot({}, plain), ownRepo);
});

test("end to end: the CLI journals into the cwd's repository, not LA_ROOT", () => {
  const main = tmpGitRepo();
  const worktree = tmpGitRepo();
  const res = spawnSync(process.execPath, [scriptPath, "init", "--task", "FOC-1211"], {
    cwd: worktree,
    env: { ...process.env, LA_ROOT: main },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(worktree, "docs", "state", "FOC-1211.md")), "journal missing in the cwd's repository");
  assert.equal(existsSync(join(main, "docs", "state", "FOC-1211.md")), false, "journal leaked into LA_ROOT");
});

test("end to end: --root overrides the cwd's repository", () => {
  const worktree = tmpGitRepo();
  const override = tmpGitRepo();
  const res = spawnSync(
    process.execPath,
    [scriptPath, "init", "--task", "FOC-1211-R", "--root", override],
    { cwd: worktree, env: { ...process.env }, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(override, "docs", "state", "FOC-1211-R.md")), "--root was ignored");
  assert.equal(existsSync(join(worktree, "docs", "state", "FOC-1211-R.md")), false, "--root was not exclusive");
});

console.log("\nclose — one command after the merge (FOC-1224)");

test("close sets Status=done and PR, appends a dated close entry, and regenerates the index", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  writeFileSync(
    join(root, "docs", "STATE.md"),
    "# STATE — fixture\n\n## 2026-10-01 10:00 — base entry\n\nbody.\n",
    "utf8",
  );
  const res = cli(["close", "--pr", "#217", "--date", "2026-11-02 10:12"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  const text = readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8");
  assert.match(text, /^Status: done$/m);
  assert.match(text, /^PR: #217$/m);
  assert.match(text, /^## 2026-11-02 10:12 — closed: merged in #217$/m);
  const state = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  assert.match(state, /- FOC-904 — done — last entry 2026-11-02 10:12 — - — #217/);
});

test("close stamps the close entry with now when --date is absent", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const res = cli(["close", "--pr", "#1"], { root });
  assert.equal(res.code, 0, res.err.join("\n"));
  const text = readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8");
  assert.match(text, /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — closed: merged in #1$/m);
});

test("close without --pr is refused", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const res = cli(["close"], { root });
  assert.equal(res.code, 2, res.out.join("\n"));
  assert.match(res.err.join("\n"), /--pr/);
});

test("close on a journal that does not exist exits 1", () => {
  const res = cli(["close", "--task", "FOC-404", "--pr", "#1"], { root: tmpRoot() });
  assert.equal(res.code, 1);
  assert.match(res.err.join("\n"), /no journal for FOC-404/);
});

test("close reports a failed index regen and keeps the journal edits", () => {
  const root = tmpRoot();
  cli(["init"], { root });
  const body = "# STATE\n\n## entry\n\n<!-- state-index:end -->\ndangling end marker.\n";
  writeFileSync(join(root, "docs", "STATE.md"), body, "utf8");
  const res = cli(["close", "--pr", "#217"], { root });
  assert.equal(res.code, 1, res.out.join("\n"));
  assert.match(res.err.join("\n"), /index regen failed/);
  const text = readFileSync(join(root, "docs", "state", "FOC-904.md"), "utf8");
  assert.match(text, /^Status: done$/m, "the journal edits must survive a failed regen");
});

console.log("\nsummary");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);

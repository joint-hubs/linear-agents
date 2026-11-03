// scripts/state-index.test.mjs — the generated "Task journals" block (FOC-904).
//
// What is worth protecting:
//   · the block is DERIVED and deterministic — the same docs/state/ always
//     renders the same bytes, newest entry first, id breaking ties.
//   · --write is a splice: every byte outside the markers survives untouched,
//     and the file's EOL style is preserved (the real STATE.md is CRLF).
//   · --check holds the line "the committed block is what the journals say",
//     including when the markers are missing entirely.
//
// Run: node scripts/state-index.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_START, INDEX_END, render, resolveRoot, runCli, writeIndex, checkIndex } from "./state-index.mjs";

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
  const dir = mkdtempSync(join(tmpdir(), "la-index-"));
  mkdirSync(join(dir, "docs", "state"), { recursive: true });
  return dir;
}

function journal(root, id, { stamp, status = "in progress", branch = `foc-x-dev`, pr = "-" } = {}) {
  const text =
    `# ${id} — journal\n` +
    `\n` +
    `Task: ${id}\n` +
    `Session: sess\n` +
    `Run: run\n` +
    `Branch: ${branch}\n` +
    `PR: ${pr}\n` +
    `Status: ${status}\n` +
    (stamp ? `\n## ${stamp} — an entry\n\nbody\n` : "");
  writeFileSync(join(root, "docs", "state", `${id}.md`), text, "utf8");
}

const STATE_HEADER = "# STATE — fixture\n\n> header line.\n\n";

const cli = (argv, root) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { env: {}, root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

console.log("\nrender");

test("render is deterministic, sorted by last entry desc then id", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  journal(root, "FOC-100", { stamp: "2026-10-16 11:00" });
  journal(root, "FOC-101", { stamp: "2026-10-16 11:00" });
  const first = render(root);
  const second = render(root);
  assert.equal(first, second);
  assert.equal(
    first,
    [
      INDEX_START,
      "## Task journals (generated)",
      "",
      "- FOC-100 — in progress — last entry 2026-10-16 11:00 — foc-x-dev — -",
      "- FOC-101 — in progress — last entry 2026-10-16 11:00 — foc-x-dev — -",
      "- FOC-904 — in progress — last entry 2026-10-16 10:00 — foc-x-dev — -",
      INDEX_END,
    ].join("\n"),
  );
});

test("a journal without entries sorts last and renders '-' for the date", () => {
  const root = tmpRoot();
  journal(root, "FOC-904");
  journal(root, "FOC-100", { stamp: "2026-10-16 09:00" });
  const lines = render(root).split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(lines.map((l) => l.split(" — ")[0].replace(/^- /, "")), ["FOC-100", "FOC-904"]);
  assert.match(lines[1], /last entry -/);
});

test("no journals render an empty block, not an error", () => {
  const root = tmpRoot();
  assert.equal(render(root), [INDEX_START, "## Task journals (generated)", "", INDEX_END].join("\n"));
});

console.log("\n--write");

test("--write inserts after the header, before the first ## heading", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  writeFileSync(
    join(root, "docs", "STATE.md"),
    STATE_HEADER + "## 2026-10-01 10:00 — base entry\n\nbody.\n",
    "utf8",
  );
  const res = writeIndex(root);
  assert.equal(res.changed, true);
  const text = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  const start = text.indexOf(INDEX_START);
  const firstHeading = text.search(/^## /m);
  assert.ok(start !== -1 && start < firstHeading, "the block did not land after the header");
  assert.equal(text.slice(0, start), STATE_HEADER, "bytes before the block changed");
  assert.match(text.slice(start), /^## Task journals \(generated\)/m);
});

test("--write leaves every byte outside the block untouched, CRLF preserved", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  const crlf = (s) => s.replace(/\n/g, "\r\n");
  const body = crlf(STATE_HEADER + "## 2026-10-01 10:00 — base entry\n\nbody.\n");
  writeFileSync(join(root, "docs", "STATE.md"), body, "utf8");
  writeIndex(root);
  const after = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  assert.equal(after.startsWith(crlf(STATE_HEADER)), true);
  assert.equal(after.endsWith(crlf("## 2026-10-01 10:00 — base entry\n\nbody.\n")), true);
  assert.ok(after.includes(INDEX_START + "\r\n"));
});

test("--write is idempotent", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  writeFileSync(join(root, "docs", "STATE.md"), STATE_HEADER + "## entry\n\nbody.\n", "utf8");
  writeIndex(root);
  const once = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  const res = writeIndex(root);
  assert.equal(res.changed, false);
  assert.equal(readFileSync(join(root, "docs", "STATE.md"), "utf8"), once);
});

test("--write updates the block when a journal changes, in place", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  writeFileSync(join(root, "docs", "STATE.md"), STATE_HEADER + "## entry\n\nbody.\n", "utf8");
  writeIndex(root);
  journal(root, "FOC-905", { stamp: "2026-10-16 12:00" });
  const res = writeIndex(root);
  assert.equal(res.changed, true);
  const text = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  assert.equal(text.split(INDEX_START).length, 2, "a second block was inserted");
  assert.match(text, /- FOC-905 — in progress — last entry 2026-10-16 12:00/);
  assert.match(text, /^## entry$/m);
});

test("--write on a tree without docs/STATE.md is a reported no-op", () => {
  const root = tmpRoot();
  const res = writeIndex(root);
  assert.equal(res.changed, false);
  assert.match(res.reason, /no docs\/STATE\.md/);
});

test("--write refuses malformed markers — start only", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  const body = STATE_HEADER + "## entry\n\n" + INDEX_START + "\nbody under a dangling marker.\n";
  writeFileSync(join(root, "docs", "STATE.md"), body, "utf8");
  const res = cli(["--write"], root);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /malformed index markers/);
  assert.equal(readFileSync(join(root, "docs", "STATE.md"), "utf8"), body, "the file was written anyway");
});

test("--write refuses malformed markers — end only", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  const body = STATE_HEADER + "## entry\n\n" + INDEX_END + "\nbody under a dangling marker.\n";
  writeFileSync(join(root, "docs", "STATE.md"), body, "utf8");
  const res = cli(["--write"], root);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /malformed index markers/);
  assert.equal(readFileSync(join(root, "docs", "STATE.md"), "utf8"), body, "the file was written anyway");
});

test("--write refuses malformed markers — end before start", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  const body =
    STATE_HEADER + "## entry\n\n" + INDEX_END + "\ninverted order.\n\n" + INDEX_START + "\n";
  writeFileSync(join(root, "docs", "STATE.md"), body, "utf8");
  const res = cli(["--write"], root);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /malformed index markers/);
  assert.equal(readFileSync(join(root, "docs", "STATE.md"), "utf8"), body, "the file was written anyway");
});

console.log("\n--check");

test("--check exits 0 when the committed block matches, 1 when it differs", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  writeFileSync(join(root, "docs", "STATE.md"), STATE_HEADER + "## entry\n\nbody.\n", "utf8");
  assert.equal(cli(["--check"], root).code, 1, "missing markers counted as up to date");
  writeIndex(root);
  assert.equal(cli(["--check"], root).code, 0);
  journal(root, "FOC-906", { stamp: "2026-10-16 13:00" });
  assert.equal(cli(["--check"], root).code, 1);
  assert.match(cli(["--check"], root).err, /differs/);
});

test("--check compares CRLF-normalised", () => {
  const root = tmpRoot();
  journal(root, "FOC-904", { stamp: "2026-10-16 10:00" });
  writeFileSync(join(root, "docs", "STATE.md"), STATE_HEADER + "## entry\n\nbody.\n", "utf8");
  writeIndex(root);
  // Same content, CRLF: the check must not fail on line endings.
  const text = readFileSync(join(root, "docs", "STATE.md"), "utf8");
  writeFileSync(join(root, "docs", "STATE.md"), text.replace(/\n/g, "\r\n"), "utf8");
  assert.equal(checkIndex(root).ok, true);
});

console.log("\nresolveRoot — shared with state-journal, cwd-first (FOC-1224)");

const ownRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway git repository under tmpdir (the "worktree" side of the fixture). */
function tmpGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "la-index-git-"));
  const res = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, `git init failed: ${res.stderr}`);
  mkdirSync(join(dir, "docs", "state"), { recursive: true });
  return dir;
}

/** A throwaway NON-git directory — for the LA_ROOT fallback. */
function tmpPlainDir() {
  const dir = mkdtempSync(join(tmpdir(), "la-index-plain-"));
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

test("--write from a worktree cwd touches only that worktree, never LA_ROOT", () => {
  const main = tmpGitRepo();
  const worktree = tmpGitRepo();
  const stateBody = STATE_HEADER + "## 2026-10-01 10:00 — base entry\n\nbody.\n";
  writeFileSync(join(main, "docs", "STATE.md"), stateBody, "utf8");
  writeFileSync(join(worktree, "docs", "STATE.md"), stateBody, "utf8");
  const prevCwd = process.cwd();
  try {
    process.chdir(worktree);
    const out = [];
    const err = [];
    const code = runCli(["--write"], {
      env: { LA_ROOT: main },
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    assert.equal(code, 0, err.join("\n"));
  } finally {
    process.chdir(prevCwd);
  }
  assert.match(
    readFileSync(join(worktree, "docs", "STATE.md"), "utf8"),
    /state-index:start/,
    "the worktree's STATE.md was not written",
  );
  assert.equal(
    readFileSync(join(main, "docs", "STATE.md"), "utf8"),
    stateBody,
    "LA_ROOT's STATE.md was rewritten",
  );
});

test("--root overrides the cwd resolution", () => {
  const main = tmpGitRepo();
  const override = tmpGitRepo();
  writeFileSync(join(override, "docs", "STATE.md"), STATE_HEADER + "## entry\n\nbody.\n", "utf8");
  const prevCwd = process.cwd();
  try {
    process.chdir(main);
    const res = cli(["--root", override, "--write"]);
    assert.equal(res.code, 0, res.err);
  } finally {
    process.chdir(prevCwd);
  }
  assert.match(readFileSync(join(override, "docs", "STATE.md"), "utf8"), /state-index:start/);
  assert.equal(existsSync(join(main, "docs", "STATE.md")), false, "--root was not exclusive");
});

console.log("\nCI wiring (FOC-1224)");

test("the CI lint job gates on state-index --check", () => {
  const sh = readFileSync(join(ownRepo, "docker", "test-in-container.sh"), "utf8");
  assert.match(sh, /node scripts\/state-index\.mjs --check/, "the lint job must run state-index --check next to lint.mjs");
});

console.log("\nsummary");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);

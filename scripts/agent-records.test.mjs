// scripts/agent-records.test.mjs — FOC-795: the record gatekeeper.
//
// Self-contained: the supervisor state home is pointed at a temp dir BEFORE
// the module is imported, a fixture run dir is built with one record of every
// editable type, and every write goes through the library itself — nothing
// here touches the real .state/ stores. Covers the contract the API, the
// waker/hook and the UI build against: classification, listing by run and by
// task, optimistic-concurrency writes with per-type immutability, originals,
// verdict annotations, path-safety refusals and the edits.jsonl seq stream.
//
// Run: node scripts/agent-records.test.mjs

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, appendFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The seam FIRST — supervisorStateHome() reads it lazily, but set it before
// the import so no call can ever see the repo's real .state/supervisor.
process.env.LA_SUPERVISOR_STATE_HOME = mkdtempSync(join(tmpdir(), "agent-records-test-"));

const {
  RECORD_TYPES,
  classifyPath,
  listRecords,
  readRecord,
  writeRecord,
  annotateVerdict,
  readEdits,
  recordAnswerRow,
} = await import("./agent-records.mjs");

let passed = 0;
const failures = [];

const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
};

const fail = (msg) => {
  throw new Error(msg);
};
const eq = (a, b, label) => {
  if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const deepEq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}: ${sa} !== ${sb}`);
};
const expectThrow = (fn, label) => {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail(`${label}: must refuse (throw)`);
  return thrown;
};

// ── fixture ──────────────────────────────────────────────────────────────────

const home = process.env.LA_SUPERVISOR_STATE_HOME;
const RUN = "run-1";
const rd = join(home, RUN);
mkdirSync(join(rd, "gates"), { recursive: true });
mkdirSync(join(rd, "verdicts"), { recursive: true });
mkdirSync(join(rd, "children"), { recursive: true });

const pendingGate = {
  gateId: "gate-dev-1-1",
  childId: "dev-1",
  status: "pending",
  summary: "pick the base branch",
  questions: ["which base?"],
  facts: { branch: "main" },
  artifacts: [],
};
const pendingGateText = JSON.stringify(pendingGate, null, 2) + "\n";
writeFileSync(join(rd, "gates", "gate-dev-1-1.json"), pendingGateText, "utf8");

const answeredGateText =
  JSON.stringify({ ...pendingGate, gateId: "gate-dev-1-2", status: "answered", answer: "main" }, null, 2) + "\n";
writeFileSync(join(rd, "gates", "gate-dev-1-2.json"), answeredGateText, "utf8");

writeFileSync(join(rd, "triage.json"), JSON.stringify({ issue: "FOC-795", node: "dev", note: "first pass" }, null, 2) + "\n", "utf8");
writeFileSync(join(rd, "intake.json"), JSON.stringify({ goal: "land FOC-795" }, null, 2) + "\n", "utf8");
writeFileSync(join(rd, "kickoff.md"), "line1\nline2\n", "utf8");
writeFileSync(
  join(rd, "child-settings-dev-1.json"),
  JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] }, model: "x" }, null, 2) + "\n",
  "utf8",
);
writeFileSync(
  join(rd, "verdicts", "foc-1-round1.json"),
  JSON.stringify({ taskId: "FOC-1", round: 1, verdict: "pass" }, null, 2) + "\n",
  "utf8",
);
writeFileSync(
  join(rd, "children.json"),
  JSON.stringify({ runId: RUN, children: { "dev-1": { taskId: "FOC-1", status: "exited" } }, rounds: {} }, null, 2) + "\n",
  "utf8",
);
writeFileSync(join(rd, "wake-queue.jsonl"), JSON.stringify({ seq: 1, event: "exit" }) + "\n", "utf8");
// Answer locks (supervisor-gate.mjs withAnswerLock): transient internal state
// beside the records they guard — never a record itself.
writeFileSync(join(rd, "gates", "gate-dev-1-1.json.lock"), "", "utf8");
writeFileSync(join(rd, "holds.json.lock"), "", "utf8");

// A second run with a different issue — the negative half of the by-task listing.
const rd2 = join(home, "run-2");
mkdirSync(rd2, { recursive: true });
writeFileSync(join(rd2, "triage.json"), JSON.stringify({ issue: "FOC-999" }, null, 2) + "\n", "utf8");

const edit = (path, baseSha256, content, who = "dashboard") =>
  writeRecord({ runId: RUN, path, baseSha256, content, who });

const shaOf = (path) => readRecord({ runId: RUN, path }).sha256;
const jsonOf = (abs) => JSON.parse(readFileSync(abs, "utf8"));

console.log("\nagent-records: classification");

await test("RECORD_TYPES names every classified type", () => {
  deepEq(
    RECORD_TYPES,
    ["gate", "triage", "intake", "brief", "child-settings", "verdict", "other"],
    "RECORD_TYPES",
  );
});

await test("classifyPath: each fixture path lands on its type and editability", () => {
  const gate = classifyPath("gates/gate-dev-1-1.json", { runId: RUN });
  deepEq(gate.type, "gate", "pending gate type");
  eq(gate.editable, true, "pending gate editable");
  deepEq(gate.editableFields, ["summary", "questions", "facts", "artifacts"], "gate editable fields");

  eq(classifyPath("gates/gate-dev-1-2.json", { runId: RUN }).editable, false, "answered gate not editable");

  eq(classifyPath("triage.json").type, "triage", "triage");
  eq(classifyPath("intake.json").type, "intake", "intake");
  const brief = classifyPath("kickoff.md");
  deepEq([brief.type, brief.editable, brief.editableFields], ["brief", true, ["text"]], "brief");
  const settings = classifyPath("child-settings-dev-1.json");
  deepEq([settings.type, settings.editable, settings.editableFields], ["child-settings", true, ["permissions.deny"]], "child-settings");

  const verdict = classifyPath("verdicts/foc-1-round1.json");
  deepEq([verdict.type, verdict.editable, verdict.editableFields], ["verdict", false, []], "verdict");

  for (const readonly of ["children.json", "wake-queue.jsonl", "wake-ack.json", "waker.json", "children/dev-1.jsonl", "evidence/run.log", "guard/state.json", "gates/sub/deep.json"]) {
    const cls = classifyPath(readonly);
    deepEq([cls.type, cls.editable], ["other", false], `read-only: ${readonly}`);
  }

  for (const hidden of ["edits.jsonl", "edits-seen.json", ".originals/gates/gate-dev-1-1.json", "verdicts/foc-1-round1.annotations.jsonl"]) {
    eq(classifyPath(hidden), null, `hidden: ${hidden}`);
  }
});

console.log("\nagent-records: listing");

await test("listRecords by run: lists records, skips hidden, carries the write contract", () => {
  const records = listRecords({ runId: RUN });
  const byPath = Object.fromEntries(records.map((r) => [r.path, r]));
  for (const expected of [
    "gates/gate-dev-1-1.json",
    "gates/gate-dev-1-2.json",
    "triage.json",
    "intake.json",
    "kickoff.md",
    "child-settings-dev-1.json",
    "verdicts/foc-1-round1.json",
    "children.json",
    "wake-queue.jsonl",
  ]) {
    if (!(expected in byPath)) fail(`missing record: ${expected}`);
  }
  for (const hidden of ["edits.jsonl", "edits-seen.json", ".originals/gates/gate-dev-1-1.json", "verdicts/foc-1-round1.annotations.jsonl"]) {
    if (hidden in byPath) fail(`hidden path must not be listed: ${hidden}`);
  }

  const gate = byPath["gates/gate-dev-1-1.json"];
  eq(gate.runId, RUN, "entry.runId");
  eq(gate.type, "gate", "entry.type");
  eq(gate.editable, true, "pending gate listed editable");
  eq(gate.sha256, shaOf("gates/gate-dev-1-1.json"), "entry.sha256 matches readRecord");
  eq(gate.size, readFileSync(join(rd, "gates", "gate-dev-1-1.json")).length, "entry.size");
  eq(typeof gate.mtime, "number", "entry.mtime is a number");
  if (!/^[0-9a-f]{64}$/.test(gate.sha256)) fail("sha256 must be 64 hex chars");

  eq(byPath["gates/gate-dev-1-2.json"].editable, false, "answered gate listed not editable");
  eq(byPath["verdicts/foc-1-round1.json"].type, "verdict", "verdict listed");
});

await test("listRecords by task: triage issue and registry child, case-insensitive", () => {
  deepEq(
    listRecords({ taskId: "foc-795" }).map((r) => r.runId).filter((v, i, a) => a.indexOf(v) === i),
    [RUN],
    "triage issue match (lowercased query)",
  );
  deepEq(
    listRecords({ taskId: "FOC-1" }).map((r) => r.runId).filter((v, i, a) => a.indexOf(v) === i),
    [RUN],
    "registry child taskId match (uppercase query)",
  );
  deepEq(listRecords({ taskId: "FOC-999" }).map((r) => r.runId), ["run-2"], "other task maps to run-2 only");
  deepEq(listRecords({ taskId: "FOC-000" }), [], "unknown task lists nothing");
});

await test("answer locks (.lock) are never listed nor readable as records", () => {
  const listed = listRecords({ runId: RUN }).map((r) => r.path);
  for (const lock of ["gates/gate-dev-1-1.json.lock", "holds.json.lock"]) {
    if (listed.includes(lock)) fail(`a lock file must not be listed: ${lock}`);
    eq(classifyPath(lock, { runId: RUN }), null, `classifyPath hides the lock: ${lock}`);
    const err = expectThrow(() => readRecord({ runId: RUN, path: lock }), `readRecord(${lock})`);
    eq(err.code, "not-found", `readRecord on a lock is not-found: ${lock}`);
  }
});

console.log("\nagent-records: gate edits");

await test("edit a pending gate's facts → ok, original kept, audit row names facts.branch", () => {
  const baseSha256 = shaOf("gates/gate-dev-1-1.json");
  const content = JSON.stringify({ ...pendingGate, facts: { branch: "foc-795-agent-records" } }, null, 2) + "\n";
  const res = edit("gates/gate-dev-1-1.json", baseSha256, content);
  eq(res.ok, true, "write accepted");

  const original = readFileSync(join(rd, ".originals", "gates", "gate-dev-1-1.json"), "utf8");
  eq(original, pendingGateText, "the original bytes are kept under .originals/");

  const row = readEdits({ runId: RUN }).find((r) => r.seq === res.seq);
  if (!row) fail("audit row missing");
  eq(row.path, "gates/gate-dev-1-1.json", "row.path");
  eq(row.type, "gate", "row.type");
  eq(row.who, "dashboard", "row.who");
  eq(row.runId, RUN, "row.runId");
  eq(row.baseSha256, baseSha256, "row.baseSha256");
  eq(row.newSha256, res.sha256, "row.newSha256 is the new file's sha");
  const change = row.changes.find((c) => c.field === "facts.branch");
  if (!change) fail(`expected a facts.branch change, got ${JSON.stringify(row.changes)}`);
  eq(change.before, JSON.stringify("main"), "change.before (stringified)");
  eq(change.after, JSON.stringify("foc-795-agent-records"), "change.after (stringified)");
  eq(res.sha256, shaOf("gates/gate-dev-1-1.json"), "returned sha matches the file on disk");
});

await test("second edit keeps the FIRST original; seq increments", () => {
  const res = edit(
    "gates/gate-dev-1-1.json",
    shaOf("gates/gate-dev-1-1.json"),
    JSON.stringify({ ...pendingGate, facts: { branch: "again" } }, null, 2) + "\n",
  );
  eq(res.ok, true, "second write accepted");
  eq(res.seq, 2, "seq is max+1 from the file, not a counter in memory");
  eq(
    readFileSync(join(rd, ".originals", "gates", "gate-dev-1-1.json"), "utf8"),
    pendingGateText,
    ".originals still holds the FIRST version",
  );
});

await test("stale baseSha256 → conflict, file unchanged, no audit row", () => {
  const before = readFileSync(join(rd, "gates", "gate-dev-1-1.json"), "utf8");
  const res = edit("gates/gate-dev-1-1.json", "deadbeef", '{"gateId":"x"}');
  eq(res.ok, false, "refused");
  eq(res.conflict, true, "flagged as conflict");
  eq(res.sha256, shaOf("gates/gate-dev-1-1.json"), "conflict carries the CURRENT sha");
  eq(res.content, before, "conflict carries the current content");
  eq(readFileSync(join(rd, "gates", "gate-dev-1-1.json"), "utf8"), before, "file unchanged");
  deepEq(readEdits({ runId: RUN }).map((r) => r.seq), [1, 2], "no audit row appended");
});

await test("editing a gate's status or gateId → refused", () => {
  const baseSha256 = shaOf("gates/gate-dev-1-1.json");
  const status = edit("gates/gate-dev-1-1.json", baseSha256, JSON.stringify({ ...pendingGate, status: "answered" }, null, 2));
  eq(status.ok, false, "status change refused");
  eq(status.error, "invalid", "status change is invalid, not a conflict");
  const gateId = edit("gates/gate-dev-1-1.json", baseSha256, JSON.stringify({ ...pendingGate, gateId: "hijacked" }, null, 2));
  eq(gateId.ok, false, "gateId change refused");
  eq(gateId.error, "invalid", "gateId change is invalid");
  deepEq(readEdits({ runId: RUN }).map((r) => r.seq), [1, 2], "refusals leave no audit row");
});

await test("answered gate → not-editable", () => {
  const res = edit("gates/gate-dev-1-2.json", shaOf("gates/gate-dev-1-2.json"), answeredGateText);
  eq(res.ok, false, "refused");
  eq(res.error, "not-editable", "error is not-editable");
  eq(res.conflict, undefined, "not a conflict");
});

console.log("\nagent-records: triage, brief, child-settings");

await test("triage: issue change refused, other field ok", () => {
  const baseSha256 = shaOf("triage.json");
  const hijacked = edit("triage.json", baseSha256, JSON.stringify({ issue: "FOC-1", node: "dev", note: "first pass" }, null, 2));
  eq(hijacked.ok, false, "issue change refused");
  eq(hijacked.error, "invalid", "issue change is invalid");

  const res = edit("triage.json", shaOf("triage.json"), JSON.stringify({ issue: "FOC-795", node: "review", note: "first pass" }, null, 2));
  eq(res.ok, true, "node change accepted");

  deepEq(readEdits({ runId: RUN }).map((r) => r.seq), [1, 2, 3], "seq increments 1, 2, 3");
  const row = readEdits({ runId: RUN }).find((r) => r.seq === 3);
  eq(row.type, "triage", "row.type");
  deepEq(row.changes.map((c) => c.field), ["node"], "row names the changed field");
});

await test("brief edit → line counts", () => {
  const res = edit("kickoff.md", shaOf("kickoff.md"), "line1\nline2b\nline3\n");
  eq(res.ok, true, "brief edit accepted");
  const row = readEdits({ runId: RUN }).find((r) => r.seq === res.seq);
  eq(row.type, "brief", "row.type");
  deepEq(row.changes, [{ field: "text", linesAdded: 2, linesRemoved: 1 }], "line counts (multiset diff)");
  eq(row.newSha256, shaOf("kickoff.md"), "new sha matches");
});

await test("child-settings: adding a deny ok, removing one refused, model change refused", () => {
  const add = edit(
    "child-settings-dev-1.json",
    shaOf("child-settings-dev-1.json"),
    JSON.stringify({ permissions: { deny: ["Bash(git push:*)", "Bash(gh api:*)"] }, model: "x" }, null, 2),
  );
  eq(add.ok, true, "gaining a deny entry accepted");
  const row = readEdits({ runId: RUN }).find((r) => r.seq === add.seq);
  deepEq(row.changes.map((c) => c.field), ["permissions.deny"], "row names permissions.deny");

  const loosen = edit(
    "child-settings-dev-1.json",
    shaOf("child-settings-dev-1.json"),
    JSON.stringify({ permissions: { deny: ["Bash(git push:*)"] }, model: "x" }, null, 2),
  );
  eq(loosen.ok, false, "removing a deny entry refused");
  eq(loosen.error, "invalid", "loosening is invalid");

  const model = edit(
    "child-settings-dev-1.json",
    shaOf("child-settings-dev-1.json"),
    JSON.stringify({ permissions: { deny: ["Bash(git push:*)", "Bash(gh api:*)"] }, model: "y" }, null, 2),
  );
  eq(model.ok, false, "model change refused");
});

console.log("\nagent-records: verdicts");

await test("verdict write refused; annotate appends sidecar + audit row; bytes untouched", () => {
  const res = edit("verdicts/foc-1-round1.json", shaOf("verdicts/foc-1-round1.json"), '{"taskId":"FOC-1","verdict":"fail"}');
  eq(res.ok, false, "verdict write refused");
  eq(res.error, "not-editable", "verdict is not-editable");

  const before = readFileSync(join(rd, "verdicts", "foc-1-round1.json"), "utf8");
  const shaBefore = shaOf("verdicts/foc-1-round1.json");
  const ann = annotateVerdict({ runId: RUN, path: "verdicts/foc-1-round1.json", note: "verified against the suite", who: "dashboard" });
  eq(ann.ok, true, "annotation accepted");

  const record = readRecord({ runId: RUN, path: "verdicts/foc-1-round1.json" });
  deepEq(record.annotations.map((a) => a.note), ["verified against the suite"], "annotations read back");
  eq(record.annotations[0].who, "dashboard", "annotation carries who");
  eq(readFileSync(join(rd, "verdicts", "foc-1-round1.json"), "utf8"), before, "verdict bytes unchanged");
  eq(shaOf("verdicts/foc-1-round1.json"), shaBefore, "verdict sha unchanged");

  const listed = listRecords({ runId: RUN }).map((r) => r.path);
  if (listed.includes("verdicts/foc-1-round1.annotations.jsonl")) {
    fail("annotation sidecar must not be listed — readRecord folds it into the verdict");
  }

  const row = readEdits({ runId: RUN }).find((r) => r.seq === ann.seq);
  eq(row.type, "verdict-annotation", "audit row type");
  eq(row.path, "verdicts/foc-1-round1.json", "audit row path");
  deepEq(row.changes.map((c) => c.field), ["annotation"], "audit row field");

  const gateRecord = readRecord({ runId: RUN, path: "gates/gate-dev-1-1.json" });
  if ("annotations" in gateRecord) fail("annotations only on verdicts");

  const notAVerdict = annotateVerdict({ runId: RUN, path: "triage.json", note: "x", who: "dashboard" });
  eq(notAVerdict.ok, false, "annotating a non-verdict refused");
  eq(notAVerdict.error, "not-annotatable", "not-annotatable error");
});

console.log("\nagent-records: path safety");

await test("path traversal refused in read, write and annotate", () => {
  for (const bad of ["../x", "/etc/passwd", "gates\\x.json"]) {
    for (const [label, fn] of [
      ["write", () => writeRecord({ runId: RUN, path: bad, baseSha256: "x", content: "{}", who: "dashboard" })],
      ["read", () => readRecord({ runId: RUN, path: bad })],
      ["annotate", () => annotateVerdict({ runId: RUN, path: bad, note: "x", who: "dashboard" })],
    ]) {
      const err = expectThrow(fn, `${label}(${JSON.stringify(bad)})`);
      eq(err.code, "bad-path", `${label}(${JSON.stringify(bad)}) error code`);
    }
  }
  for (const badRun of ["../evil", "bad/id", "", null]) {
    const err = expectThrow(() => readRecord({ runId: badRun, path: "triage.json" }), `runId ${JSON.stringify(badRun)}`);
    eq(err.code, "bad-path", `runId ${JSON.stringify(badRun)} error code`);
  }
});

console.log("\nagent-records: edits.jsonl stream");

await test("torn lines are skipped and seq continues from the last VALID row", () => {
  appendFileSync(join(rd, "edits.jsonl"), "\nnot json\n", "utf8");
  const res = edit("intake.json", shaOf("intake.json"), JSON.stringify({ goal: "land FOC-795 today" }, null, 2));
  eq(res.ok, true, "write accepted past a torn line");
  eq(res.seq, 7, "seq = max VALID seq + 1, not line count");

  const all = readEdits({ runId: RUN });
  eq(all.length, 7, "unparseable line not counted");
  deepEq(all.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7], "rows in seq order");

  deepEq(readEdits({ runId: RUN, sinceSeq: 5 }).map((r) => r.seq), [6, 7], "sinceSeq filter");
  deepEq(readEdits({ runId: RUN, sinceSeq: 7 }), [], "nothing past the last seq");
});

await test("readRecord carries the contract fields for the API", () => {
  const rec = readRecord({ runId: RUN, path: "kickoff.md" });
  deepEq(
    Object.keys(rec).sort(),
    ["content", "editable", "editableFields", "sha256", "type"],
    "record keys",
  );
  eq(rec.type, "brief", "type");
  eq(rec.editable, true, "editable");
  eq(rec.content, "line1\nline2b\nline3\n", "content is the current text");

  const missing = (() => {
    try {
      readRecord({ runId: RUN, path: "nope.json" });
      return null;
    } catch (err) {
      return err;
    }
  })();
  eq(missing?.code, "not-found", "missing record throws not-found");
});

await test("the CLI prints one line per row (contract shape)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, [join(scriptsDir, "agent-records.mjs"), "edits", "--run", RUN, "--since", "6"], {
    encoding: "utf8",
  });
  const lines = out.trim().split("\n");
  deepEq(lines.length, 1, "since=6 leaves one row");
  if (!/^#7 \S+ dashboard intake intake\.json: goal$/.test(lines[0])) {
    fail(`unexpected CLI line: ${lines[0]}`);
  }
});

await test("edits.jsonl is created 0664 (children and the Supervisor both append)", () => {
  if (process.platform === "win32") return; // POSIX mode bits only; the Windows run asserts the write succeeds above
  const modeRun = `${RUN}-mode`;
  mkdirSync(join(home, modeRun), { recursive: true });
  recordAnswerRow({ runId: modeRun, kind: "gate-answer", id: "gate-mode-1", text: "ok", who: "test", notified: false });
  const mode = statSync(join(home, modeRun, "edits.jsonl")).mode & 0o777;
  eq(mode, 0o664, "edits.jsonl mode on creation");
});

console.log("\nagent-records: answer notice rows (FOC-783)");

await test("recordAnswerRow: seq continues from the file, gate row shape, notified flag", () => {
  const row = recordAnswerRow({
    runId: RUN,
    kind: "gate-answer",
    id: "gate-dev-1-1",
    text: "tak",
    who: "dashboard",
    notified: true,
  });
  eq(row.seq, 8, "seq continues after the existing rows, like every other write");
  if (typeof row.ts !== "string" || Number.isNaN(Date.parse(row.ts))) fail(`row.ts must be an ISO timestamp, got ${JSON.stringify(row.ts)}`);
  eq(row.who, "dashboard", "row.who");
  eq(row.runId, RUN, "row.runId");
  eq(row.path, "gates/gate-dev-1-1.json", "the row names the answered record");
  eq(row.type, "gate-answer", "row.type");
  deepEq(row.changes, [{ field: "answer", before: null, after: '"tak"' }], "the change names answer, before null");
  eq(row.notified, true, "notified flag carried");
  if ("baseSha256" in row || "newSha256" in row) fail("a notice row is not a content write — no sha pair");
  deepEq(readEdits({ runId: RUN, sinceSeq: 7 }).map((r) => r.seq), [8], "row readable back through readEdits");
});

await test("recordAnswerRow: hold row uses holds.json and <id>.answer; notified defaults to false", () => {
  const row = recordAnswerRow({ runId: RUN, kind: "hold-answer", id: "hold-3", text: "idź", who: "dashboard" });
  eq(row.seq, 9, "seq keeps counting");
  eq(row.path, "holds.json", "the whole store is the record");
  eq(row.type, "hold-answer", "row.type");
  eq(row.notified, false, "notified defaults to false");
  deepEq(row.changes, [{ field: "hold-3.answer", before: null, after: '"idź"' }], "the change names the hold");
});

await test("recordAnswerRow: after is truncated like every audit value", () => {
  const long = "x".repeat(600);
  const row = recordAnswerRow({ runId: RUN, kind: "hold-answer", id: "hold-4", text: long, who: "dashboard" });
  eq(row.changes[0].after, JSON.stringify(long).slice(0, 500), "truncated to 500 chars, same trunc() rule");
  eq(row.changes[0].after.length, 500, "length capped");
});

await test("recordAnswerRow: refusals append no row", () => {
  const before = readEdits({ runId: RUN }).map((r) => r.seq);
  const badKind = expectThrow(() => recordAnswerRow({ runId: RUN, kind: "other", id: "x", text: "t", who: "w" }), "bad kind");
  eq(badKind.code, "invalid-kind", "bad kind code");
  const traversal = expectThrow(() => recordAnswerRow({ runId: RUN, kind: "gate-answer", id: "../x", text: "t", who: "w" }), "traversal");
  eq(traversal.code, "bad-id", "traversal id code");
  const badRun = expectThrow(() => recordAnswerRow({ runId: "../evil", kind: "gate-answer", id: "g", text: "t", who: "w" }), "bad runId");
  eq(badRun.code, "bad-path", "traversal runId code");
  const noWho = expectThrow(() => recordAnswerRow({ runId: RUN, kind: "gate-answer", id: "g", text: "t" }), "missing who");
  eq(noWho.code, "invalid", "who required");
  const noText = expectThrow(() => recordAnswerRow({ runId: RUN, kind: "gate-answer", id: "g", who: "w" }), "missing text");
  eq(noText.code, "invalid", "text required");
  deepEq(readEdits({ runId: RUN }).map((r) => r.seq), before, "refusals leave the stream untouched");
});

for (const dir of [home]) rmSync(dir, { recursive: true, force: true });

console.log(`\nagent-records: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}

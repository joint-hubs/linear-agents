// scripts/agent-records.mjs — FOC-795: edit an agent's persisted records while it works.
//
// Everything an agent leaves behind lives in its run dir (supervisor-lib's
// <LA_SUPERVISOR_STATE_HOME>/<runId>/). Most of it is evidence the Supervisor
// owns, but a handful of records are Mateusz's to correct while the run is
// live: a gate's summary before it is answered, the triage's routing, a
// kickoff brief's wording, a child's deny list. This module is the ONLY writer
// of edits.jsonl and the single gatekeeper for every record write — the API
// (telemetry-server) and the CLI below both come through here, so the
// allowlist, the immutability rules and the audit trail cannot drift apart.
//
// Classification (docs/plans/foc-795-editable-agent-records.md §Records):
//   gate            gates/*.json          editable while status === "pending";
//                                         summary/questions/facts/artifacts only
//   triage          triage.json           every field except `issue`
//   intake          intake.json           every field
//   brief           <name>.md (root)      the whole text
//   child-settings  child-settings-*.json tighten-only: permissions.deny may
//                                         gain entries, nothing else moves
//   verdict         verdicts/*.json       never editable; annotatable via
//                                         verdicts/<name>.annotations.jsonl
//   other           everything else       listed read-only, never writable
//   (hidden)        .originals/**, edits*.json*,   not listed at all
//                   verdicts/*.annotations.jsonl,
//                   *.lock (answer locks, supervisor-gate withAnswerLock)
//
// `editableFields` semantics: a fixed list means exactly those dot-paths may
// change; `null` means every field of the record except the type's immutable
// ones (`issue` on triage; none on intake); `[]` means nothing is editable.
//
// Every write is atomic (tmp + rename) and lands one audit row in
// edits.jsonl — { seq, ts, who, runId, path, type, changes, baseSha256,
// newSha256 } — with seq = max(on disk) + 1. The jsonl appends use
// appendFileSync, the same single-writer discipline as the wake queue
// (supervisor-lib.appendWakeEvent): one line per write, torn lines skipped on
// read, never fatal. Before the first edit of a record, its original bytes
// are copied to .originals/<path> and never overwritten — the audit always
// has the before.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { readJsonOr, readRegistry, runDir, supervisorStateHome } from "./supervisor-lib.mjs";

export const RECORD_TYPES = ["gate", "triage", "intake", "brief", "child-settings", "verdict", "other"];

// The gate's four editable fields (spec table, §Records). Everything else on a
// gate record — gateId, childId, status, answer — is the Supervisor's state
// machine and may not move through this door.
export const GATE_EDITABLE_FIELDS = ["summary", "questions", "facts", "artifacts"];

const MAX_RECORD_BYTES = 256 * 1024; // 256 KB content cap
const MAX_NOTE_CHARS = 4000;
const MAX_CHANGE_CHARS = 500; // audit values are truncated to this
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

// Same transient set utils.atomicWriteJSON retries on: on Windows a rename
// over an existing file fails EPERM/EACCES while an AV scan or indexer holds
// the destination open.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES"]);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = [25, 50, 100, 100];

const OTHER = Object.freeze({ type: "other", editable: false, editableFields: [] });

// ── path safety ──────────────────────────────────────────────────────────────

const badPath = (message) => Object.assign(new Error(message), { code: "bad-path" });

function validRunId(runId) {
  return (
    typeof runId === "string" &&
    RUN_ID_RE.test(runId) &&
    runId !== "." &&
    runId !== ".." // the regex admits them; the resolver must not
  );
}

/**
 * Resolve a record path inside its run dir, refusing everything that could
 * land the write/read outside it: absolute paths, "..", backslashes (Windows
 * separators are not our convention and dodge the segment checks), NUL, empty
 * or dot segments. Belt and braces: the segment checks already bound the
 * resolve, and the startsWith confirms it.
 */
function resolveRecordPath(runId, rel) {
  if (!validRunId(runId)) throw badPath(`invalid runId: ${JSON.stringify(runId ?? null)}`);
  if (typeof rel !== "string" || rel.length === 0) {
    throw badPath("record path must be a non-empty string");
  }
  if (rel.includes("\\")) throw badPath(`record path must use "/" separators: ${JSON.stringify(rel)}`);
  if (rel.includes("\0")) throw badPath(`record path must not contain NUL: ${JSON.stringify(rel)}`);
  if (isAbsolute(rel)) throw badPath(`record path must be relative: ${JSON.stringify(rel)}`);
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw badPath(`record path must be a plain relative path: ${JSON.stringify(rel)}`);
  }
  const base = resolve(runDir(runId));
  const abs = resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw badPath(`record path escapes the run dir: ${JSON.stringify(rel)}`);
  }
  return { base, abs, rel };
}

/**
 * No component of the record path may be a symlink — a symlinked gate file
 * would let a "gates/x.json" edit land somewhere else entirely. Each component
 * from the run dir down is lstat'd; a missing component (ENOENT) ends the walk
 * and is the caller's not-found to report.
 */
function assertNoSymlink(base, abs) {
  let cur = base;
  for (const part of relative(base, abs).split(sep)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) throw badPath(`record path traverses a symlink: ${cur}`);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ── classification ───────────────────────────────────────────────────────────

// Unreadable gate counts as pending (hasPendingGate's rule in supervisor-lib):
// a gate nobody can parse must not look editable-false, and writeRecord
// re-validates the parsed content anyway, so classification can be optimistic.
function gateClass(fileName, runId) {
  if (!runId) return { type: "gate", editable: true, editableFields: GATE_EDITABLE_FIELDS };
  const gate = readJsonOr(join(runDir(runId), "gates", fileName), null);
  return { type: "gate", editable: gate === null || gate?.status === "pending", editableFields: GATE_EDITABLE_FIELDS };
}

/**
 * Classify a run-dir-relative path. Returns { type, editable, editableFields },
 * or null when the path is hidden (internal state, never listed nor offered).
 * Structural only, except gates: with a runId the gate's status is read, so
 * `editable` reflects the record, not just the path.
 */
export function classifyPath(rel, { runId } = {}) {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.includes("\\") || rel.includes("\0") || isAbsolute(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;

  if (parts[0] === ".originals") return null; // the audit originals — internal
  if (/^edits.*\.json/.test(rel)) return null; // edits.jsonl, edits-seen.json — this module's own state
  // Answer locks (supervisor-gate's withAnswerLock: gates/<id>.json.lock,
  // holds.json.lock) — transient internal state, never a record.
  if (rel.endsWith(".lock")) return null;

  const [top, second] = parts;
  if (parts.length === 1) {
    if (top === "triage.json") return { type: "triage", editable: true, editableFields: null };
    if (top === "intake.json") return { type: "intake", editable: true, editableFields: null };
    if (top.startsWith("child-settings-") && top.endsWith(".json")) {
      return { type: "child-settings", editable: true, editableFields: ["permissions.deny"] };
    }
    if (top.endsWith(".md")) return { type: "brief", editable: true, editableFields: ["text"] };
    return { ...OTHER }; // children.json, wake-queue.jsonl, wake-ack.json, waker.json, siblings…
  }
  if (parts.length === 2) {
    if (top === "gates") {
      return second.endsWith(".json") ? gateClass(second, runId) : { ...OTHER };
    }
    if (top === "verdicts") {
      if (second.endsWith(".annotations.jsonl")) return null; // the verdict's sidecar — readRecord folds it into the verdict
      return second.endsWith(".json")
        ? { type: "verdict", editable: false, editableFields: [] }
        : { ...OTHER };
    }
    return { ...OTHER }; // children/*.jsonl, evidence/*, guard/*…
  }
  return { ...OTHER }; // deeper than two levels is never a record
}

// ── edits.jsonl — the single audit + notice stream ───────────────────────────

const editsPath = (runId) => join(runDir(runId), "edits.jsonl");

/** Every valid row, in file order. Torn/unparseable lines are skipped, never fatal. */
function readEditRows(runId) {
  const path = editsPath(runId);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.seq === "number") rows.push(row);
    } catch {
      /* torn trailing line — the events before it survive (wake-queue's rule) */
    }
  }
  return rows;
}

const nextEditSeq = (runId) => readEditRows(runId).reduce((max, r) => Math.max(max, r.seq), 0) + 1;

const appendEditRow = (runId, row) => appendFileSync(editsPath(runId), JSON.stringify(row) + "\n");

// ── change description ───────────────────────────────────────────────────────

/** Stringify an audit value and truncate — a whole-file diff must not flood the row. */
function trunc(value) {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > MAX_CHANGE_CHARS ? s.slice(0, MAX_CHANGE_CHARS) : s;
}

/**
 * Dot-path diff of two JSON objects. Objects recurse; arrays and scalars are
 * leaves (a gate's `facts.branch` change names `facts.branch`, a replaced
  * `facts` array names `facts`). before/after are stringified and truncated;
 * a side that lacks the key reads null.
 */
function diffJSON(cur, next) {
  const changes = [];
  const walk = (a, b, prefix) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const field = prefix ? `${prefix}.${key}` : key;
      const va = a[key];
      const vb = b[key];
      if (isPlainObject(va) && isPlainObject(vb)) {
        walk(va, vb, field);
        continue;
      }
      const before = key in a ? trunc(va) : null;
      const after = key in b ? trunc(vb) : null;
      if (before !== after) changes.push({ field, before, after });
    }
  };
  walk(cur, next, "");
  return changes;
}

/** Multiset line diff for briefs — added/removed line counts, order-insensitive. */
function lineDiff(beforeText, afterText) {
  const bag = (text) => {
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const m = new Map();
    for (const line of lines) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = bag(beforeText);
  const b = bag(afterText);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const [line, n] of b) {
    const d = n - (a.get(line) ?? 0);
    if (d > 0) linesAdded += d;
  }
  for (const [line, n] of a) {
    const d = n - (b.get(line) ?? 0);
    if (d > 0) linesRemoved += d;
  }
  return { linesAdded, linesRemoved };
}

function changesFor(type, currentText, nextText) {
  if (type === "brief") {
    return [{ field: "text", ...lineDiff(currentText, nextText) }];
  }
  return diffJSON(JSON.parse(currentText), JSON.parse(nextText));
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Raw content lands byte-exact (a brief is not JSON), so tmp + rename here rather than atomicWriteJSON. */
function writeTmpThenRename(abs, text) {
  const tmp = `${abs}.${Math.floor(Math.random() * 0xffffffff).toString(36)}.tmp`;
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, abs);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has(err?.code) || attempt >= RENAME_MAX_ATTEMPTS) {
        try {
          unlinkSync(tmp);
        } catch {
          // Best effort — the rename error is the one that matters.
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS[attempt - 1] ?? 100);
    }
  }
}

function notEditableReason(cls) {
  if (cls.type === "gate") return "gate-not-pending";
  if (cls.type === "verdict") return "verdict-immutable";
  return "read-only";
}

/**
 * Validate and apply one record edit. Optimistic concurrency: the caller's
 * baseSha256 must match the file's current sha256, else a conflict is returned
 * with the current content and NOTHING is written.
 *
 * Path-safety violations THROW (code "bad-path") — readRecord must throw
 * anyway, so all three entry points reject unsound paths the same way.
 */
export function writeRecord({ runId, path, baseSha256, content, who }) {
  const { base, abs, rel } = resolveRecordPath(runId, path);
  assertNoSymlink(base, abs);

  const cls = classifyPath(rel, { runId });
  if (!cls) return { ok: false, error: "not-editable", reason: "hidden" };
  if (!cls.editable) return { ok: false, error: "not-editable", reason: notEditableReason(cls) };
  if (typeof who !== "string" || !who.trim()) return { ok: false, error: "invalid", reason: "who-required" };
  if (typeof content !== "string") return { ok: false, error: "invalid", reason: "content-not-a-string" };
  if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES) {
    return { ok: false, error: "invalid", reason: `record exceeds the ${MAX_RECORD_BYTES}-byte cap` };
  }

  let currentBytes;
  try {
    currentBytes = readFileSync(abs);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, error: "not-found", reason: rel };
    throw err;
  }
  const currentSha = sha256(currentBytes);
  const currentText = currentBytes.toString("utf8");

  if (baseSha256 !== currentSha) {
    return { ok: false, conflict: true, sha256: currentSha, content: currentText };
  }

  // Per-type validation. JSON types parse to a plain object; the immutable
  // fields are compared via JSON.stringify per key, which covers changed,
  // added AND removed keys in one comparison.
  const invalid = (reason) => ({ ok: false, error: "invalid", reason });
  if (cls.type !== "brief") {
    let next;
    try {
      next = JSON.parse(content);
    } catch {
      return invalid("content is not valid JSON");
    }
    if (!isPlainObject(next)) return invalid("content must be a JSON object");
    const current = JSON.parse(currentText);
    if (!isPlainObject(current)) return invalid("current record is not a JSON object");

    if (cls.type === "gate") {
      if (current.status !== "pending") return { ok: false, error: "not-editable", reason: "gate-not-pending" };
      if (next.status !== "pending") return invalid(`gate status must stay "pending" while editable`);
      const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
      for (const key of keys) {
        if (GATE_EDITABLE_FIELDS.includes(key)) continue;
        if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
          return invalid(`field "${key}" is not editable on a gate`);
        }
      }
    } else if (cls.type === "triage") {
      if (JSON.stringify(next.issue) !== JSON.stringify(current.issue)) {
        return invalid(`triage "issue" is not editable`);
      }
    } else if (cls.type === "child-settings") {
      // Tighten-only: the deny list may gain entries, never lose one, and
      // nothing else in the file may move at all.
      const newDeny = next.permissions?.deny;
      if (!Array.isArray(newDeny) || newDeny.some((rule) => typeof rule !== "string")) {
        return invalid("permissions.deny must stay an array of strings");
      }
      const gained = new Set(newDeny);
      for (const rule of current.permissions?.deny ?? []) {
        if (!gained.has(rule)) {
          return invalid(`permissions.deny may only gain entries — ${JSON.stringify(rule)} would be removed`);
        }
      }
      const minusDeny = (obj) => {
        const copy = structuredClone(obj);
        if (isPlainObject(copy.permissions)) delete copy.permissions.deny;
        return copy;
      };
      if (JSON.stringify(minusDeny(current)) !== JSON.stringify(minusDeny(next))) {
        return invalid("only permissions.deny may change on child-settings");
      }
    }
    // intake: every field is editable — the object check above is the whole rule.
  }

  // First edit snapshots the original; later edits never overwrite it, so the
  // audit chain always ends at the version the agent wrote first.
  const originalPath = join(base, ".originals", ...rel.split("/"));
  if (!existsSync(originalPath)) {
    mkdirSync(dirname(originalPath), { recursive: true });
    copyFileSync(abs, originalPath);
  }

  writeTmpThenRename(abs, content);
  const newSha = sha256(Buffer.from(content, "utf8"));

  const seq = nextEditSeq(runId);
  appendEditRow(runId, {
    seq,
    ts: new Date().toISOString(),
    who,
    runId,
    path: rel,
    type: cls.type,
    changes: changesFor(cls.type, currentText, content),
    baseSha256: currentSha,
    newSha256: newSha,
  });
  return { ok: true, sha256: newSha, seq };
}

/**
 * Append a verdict annotation. The verdict file itself is NEVER touched — its
 * bytes go into the audit row as both baseSha256 and newSha256 — and the
 * annotation lives beside it in verdicts/<name>.annotations.jsonl.
 */
export function annotateVerdict({ runId, path, note, who }) {
  const { base, abs, rel } = resolveRecordPath(runId, path);
  assertNoSymlink(base, abs);

  const cls = classifyPath(rel, { runId });
  if (!cls || cls.type !== "verdict") {
    return { ok: false, error: "not-annotatable", reason: cls ? cls.type : "hidden" };
  }
  if (typeof note !== "string" || !note.trim()) return { ok: false, error: "invalid", reason: "note-required" };
  if (note.length > MAX_NOTE_CHARS) {
    return { ok: false, error: "invalid", reason: `note exceeds ${MAX_NOTE_CHARS} characters` };
  }
  if (typeof who !== "string" || !who.trim()) return { ok: false, error: "invalid", reason: "who-required" };

  let verdictBytes;
  try {
    verdictBytes = readFileSync(abs);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, error: "not-found", reason: rel };
    throw err;
  }
  const sha = sha256(verdictBytes);

  const name = rel.split("/")[1].replace(/\.json$/, "");
  const annotationsPath = join(base, "verdicts", `${name}.annotations.jsonl`);
  appendFileSync(annotationsPath, JSON.stringify({ ts: new Date().toISOString(), who, note }) + "\n");

  const seq = nextEditSeq(runId);
  appendEditRow(runId, {
    seq,
    ts: new Date().toISOString(),
    who,
    runId,
    path: rel,
    type: "verdict-annotation",
    changes: [{ field: "annotation", after: trunc(note) }],
    baseSha256: sha,
    newSha256: sha,
  });
  return { ok: true, sha256: sha, seq };
}

// ── answer notice rows (FOC-783) ─────────────────────────────────────────────

/**
 * The edits.jsonl row for a gate or hold answer made from the dashboard. The
 * ANSWER itself is written by supervisor-gate.mjs's answerGate/answerHold —
 * the same rules the CLI enforces; this is only the audit/notice row, through
 * the SAME single-writer append and seq logic as every other write here, so
 * the waker's and the hook's watermarks stay one sequence.
 *
 * `notified: true` means the Supervisor was already told through its session:
 * the row stays in the audit, but the wake and the edits hook skip it (no
 * wake, no re-show) — the notice was delivered where the answer happened.
 */
export function recordAnswerRow({ runId, kind, id, text, who, notified }) {
  if (!validRunId(runId)) throw badPath(`invalid runId: ${JSON.stringify(runId ?? null)}`);
  if (kind !== "gate-answer" && kind !== "hold-answer") {
    throw Object.assign(
      new Error(`kind must be "gate-answer" or "hold-answer", got ${JSON.stringify(kind ?? null)}`),
      { code: "invalid-kind" },
    );
  }
  // The id names the answered record — a gate id lands in the row's path
  // (gates/<id>.json), so it is bounded to the same sayable token set the
  // answer functions enforce, which is also the traversal guard.
  if (typeof id !== "string" || !RUN_ID_RE.test(id) || id === "." || id === "..") {
    throw Object.assign(new Error(`invalid answer id: ${JSON.stringify(id ?? null)}`), { code: "bad-id" });
  }
  if (typeof who !== "string" || !who.trim()) {
    throw Object.assign(new Error("who is required"), { code: "invalid" });
  }
  if (typeof text !== "string" || !text.trim()) {
    throw Object.assign(new Error("answer text is required"), { code: "invalid" });
  }

  const isGate = kind === "gate-answer";
  const row = {
    seq: nextEditSeq(runId),
    ts: new Date().toISOString(),
    who,
    runId,
    path: isGate ? `gates/${id}.json` : "holds.json",
    type: kind,
    changes: [{ field: isGate ? "answer" : `${id}.answer`, before: null, after: trunc(text) }],
    notified: Boolean(notified),
  };
  appendEditRow(runId, row);
  return row;
}

// ── reads ────────────────────────────────────────────────────────────────────

function readJsonLines(path) {
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* torn line — skipped, never fatal */
    }
  }
  return rows;
}

/**
 * One record: type, editability, current sha256, raw content — and, for
 * verdicts, the annotation rows from the sidecar jsonl.
 */
export function readRecord({ runId, path }) {
  const { base, abs, rel } = resolveRecordPath(runId, path);
  // A lock file is not a hidden record but no record at all — not-found, not bad-path.
  if (rel.endsWith(".lock")) {
    throw Object.assign(new Error(`record not found: ${rel}`), { code: "not-found" });
  }
  assertNoSymlink(base, abs);

  const cls = classifyPath(rel, { runId });
  if (!cls) throw badPath(`record path is hidden: ${rel}`);

  let bytes;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    if (err.code === "ENOENT") throw Object.assign(new Error(`record not found: ${rel}`), { code: "not-found" });
    throw err;
  }

  const record = {
    type: cls.type,
    editable: cls.editable,
    editableFields: cls.editableFields,
    sha256: sha256(bytes),
    content: bytes.toString("utf8"),
  };
  if (cls.type === "verdict") {
    const name = rel.split("/")[1].replace(/\.json$/, "");
    const annotationsPath = join(base, "verdicts", `${name}.annotations.jsonl`);
    record.annotations = existsSync(annotationsPath) ? readJsonLines(annotationsPath) : [];
  }
  return record;
}

/**
 * Audit rows with seq > sinceSeq, in seq order. Unparseable lines are skipped
 * — a torn trailing line never blinds the reader to the rows before it.
 */
export function readEdits({ runId, sinceSeq = 0 } = {}) {
  if (!validRunId(runId)) throw badPath(`invalid runId: ${JSON.stringify(runId ?? null)}`);
  return readEditRows(runId)
    .filter((row) => row.seq > sinceSeq)
    .sort((a, b) => a.seq - b.seq);
}

// ── listing ──────────────────────────────────────────────────────────────────

/**
 * Does this run belong to the task? Either its triage.json `issue` matches
 * (case-insensitive) or its registry carries a child with that taskId. A
 * corrupt registry is tolerated — the triage match already had its chance, and
 * a registry nobody can parse must not hide a run whose triage says yes.
 */
function runMatchesTask(runId, taskId) {
  const wanted = String(taskId).toLowerCase();
  if (!wanted) return false;
  const triage = readJsonOr(join(runDir(runId), "triage.json"), null);
  if (isPlainObject(triage) && String(triage.issue ?? "").toLowerCase() === wanted) return true;
  try {
    const registry = readRegistry(runId);
    return Object.values(registry.children ?? {}).some(
      (child) => String(child?.taskId ?? "").toLowerCase() === wanted,
    );
  } catch {
    return false;
  }
}

/** Root files plus one directory level — 2 levels deep, sorted, nothing deeper. */
function walkRunDir(dir) {
  const rels = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // .originals — hidden by classification anyway
    if (entry.name.endsWith(".lock")) continue; // answer locks — never a record
    if (entry.isFile()) {
      rels.push(entry.name);
    } else if (entry.isDirectory()) {
      for (const inner of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (inner.isFile() && !inner.name.endsWith(".lock")) rels.push(`${entry.name}/${inner.name}`);
      }
    }
  }
  return rels.sort();
}

/**
 * Records for one run, or — with taskId — every run whose triage `issue` or a
 * registry child's taskId matches. Hidden paths (.originals, edits*) are
 * skipped; symlinks and unreadable files are skipped, never fatal. Each entry
 * carries the sha256 the API needs for optimistic writes.
 */
export function listRecords({ runId = null, taskId = null } = {}) {
  const home = supervisorStateHome();
  let runIds;
  if (runId !== null && runId !== undefined) {
    if (!validRunId(runId)) throw badPath(`invalid runId: ${JSON.stringify(runId)}`);
    runIds = [runId];
  } else if (!existsSync(home)) {
    return [];
  } else {
    runIds = readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && validRunId(e.name))
      .map((e) => e.name)
      .sort();
  }
  if (taskId !== null && taskId !== undefined) {
    runIds = runIds.filter((id) => runMatchesTask(id, taskId));
  }

  const records = [];
  for (const id of runIds) {
    const dir = runDir(id);
    if (!existsSync(dir)) continue;
    for (const rel of walkRunDir(dir)) {
      const cls = classifyPath(rel, { runId: id });
      if (!cls) continue; // hidden
      const abs = join(dir, ...rel.split("/"));
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      let bytes;
      try {
        bytes = readFileSync(abs);
      } catch {
        continue;
      }
      records.push({
        runId: id,
        path: rel,
        type: cls.type,
        editable: cls.editable,
        editableFields: cls.editableFields,
        sha256: sha256(bytes),
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  return records;
}

// ── CLI — what the Supervisor runs after a wake ──────────────────────────────

function main(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--run") flags.run = rest[++i];
    else if (rest[i] === "--since") flags.since = Number(rest[++i]);
  }
  if (command === "edits" && flags.run) {
    for (const row of readEdits({
      runId: flags.run,
      sinceSeq: Number.isFinite(flags.since) ? flags.since : 0,
    })) {
      const fields = (row.changes ?? []).map((c) => c?.field).filter(Boolean).join(", ") || "no edits";
      console.log(`#${row.seq} ${row.ts} ${row.who} ${row.type} ${row.path}: ${fields}`);
    }
    return 0;
  }
  console.error("usage: node scripts/agent-records.mjs edits --run <id> [--since <n>]");
  return 1;
}

// pathToFileURL comparison, case-insensitive on win32 (argv[1] preserves the
// case the caller typed).
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const isMain = Boolean(process.argv[1]) && samePath(pathToFileURL(process.argv[1]).href, import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

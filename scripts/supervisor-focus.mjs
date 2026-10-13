// scripts/supervisor-focus.mjs — the Supervisor declares its focus (FOC-769,
// plan §FOC-769, slice S5a).
//
// The Supervisor's own turns are billable to a ticket only when the Supervisor
// SAYS which ticket it is working on. "overhead" is the explicit "no ticket"
// focus, so unattributed time becomes a declared state instead of a gap. One
// `set` writes the declaration in three places:
//
//   <stateHome>/<runId>/focus.jsonl  append-only, one JSON line per CHANGE —
//                                    a focus is a fact that was true for an
//                                    interval, never a slot to overwrite;
//   current-run.json                 a `focus` field on the live record, so
//                                    the Cockpit and the waker read the
//                                    current focus without parsing the log
//                                    (only when the record's runId matches);
//   telemetry                        one `supervisor.focus` event per change,
//                                    sourcePath = focus.jsonl and eventId =
//                                    a sha256 of the change's content, so the
//                                    store's idempotent dedup makes a replay
//                                    of the same change a no-op while two
//                                    racing changes (a spawn auto-focus and a
//                                    manual `set`) never collide (the
//                                    run_focus projection lands in S5b).
//
// CLI (run id from --run, else LA_SUPERVISOR_RUN; refuses without one):
//   node scripts/supervisor-focus.mjs set <TICKET|overhead> [--note "…"] [--source manual|spawn|followup] [--run <runId>]
//   node scripts/supervisor-focus.mjs show [--run <runId>]
//
// ESM, zero runtime deps (Node 18+). Follows the JSON-out/stderr-log/exit-1
// conventions of supervisor-current-run.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { supervisorStateHome } from "./supervisor-lib.mjs";
import { RUN_ID_RE, readCurrentRun, writeCurrentRun } from "./supervisor-current-run.mjs";
import { emitEvent, makeEvent } from "./telemetry-store.mjs";

// ── Library ──────────────────────────────────────────────────────────────────

/**
 * The two focus shapes, from any spelling a caller has:
 *   · a ticket id (`/^[A-Za-z][A-Za-z0-9]*-\d+$/`, uppercased — "foc-12" IS
 *     "FOC-12", the telemetry keys on the id and must not see two spellings);
 *   · "overhead", case-insensitive — the explicit no-ticket focus.
 * Anything else THROWS: a silent fallback would attribute turns to a ticket
 * nobody declared or drop them from the cost report entirely.
 */
export function normalizeFocus(value) {
  const s = String(value ?? "").trim();
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s)) return { kind: "ticket", taskId: s.toUpperCase() };
  if (s.toLowerCase() === "overhead") return { kind: "overhead", taskId: null };
  throw new Error("focus must be a ticket id like FOC-123 or 'overhead'");
}

/** The run's focus log — <stateHome>/<runId>/focus.jsonl. */
export function focusPath(runId, { stateHome } = {}) {
  return join(stateHome ?? supervisorStateHome(), runId, "focus.jsonl");
}

/**
 * Every valid focus line in file order, plus the last one as `current`.
 * Malformed lines are skipped, not fatal — a torn trailing append (the one
 * shape a crash mid-write can leave) must not hide the focus that came before
 * it, same tolerance the wake queue applies.
 */
export function readFocus(runId, { stateHome } = {}) {
  const path = focusPath(runId, { stateHome });
  if (!existsSync(path)) return { current: null, history: [] };
  const history = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && !Array.isArray(row)) history.push(row);
    } catch {
      /* torn trailing line — see the doc comment */
    }
  }
  return { current: history.length ? history[history.length - 1] : null, history };
}

/**
 * Declare the focus for a run. Returns
 * { ok: true, changed, runId, focus, line } (+ telemetryError when the
 * telemetry emit failed — a telemetry outage must never fail the declaration
 * itself, so this is added, never thrown).
 *
 * `changed: false` (same kind+taskId already current) writes NOTHING — not the
 * log, not the record, not telemetry — so a repeated `set` cannot manufacture
 * focus intervals for the cost report.
 */
export function setFocus({
  runId,
  value,
  note = null,
  source = "manual",
  now = new Date(),
  stateHome,
  currentRunPath,
  telemetry = true,
} = {}) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  const focus = normalizeFocus(value);
  const path = focusPath(runId, { stateHome });
  const home = stateHome ?? supervisorStateHome();

  const { current } = readFocus(runId, { stateHome });
  if (current && current.kind === focus.kind && current.taskId === focus.taskId) {
    return { ok: true, changed: false, runId, focus, line: null };
  }

  const at = now.toISOString();
  // 0-based index of the appended line — informational only, kept in the
  // result for humans. It is NOT the telemetry identity: an offset counted
  // before the append loses the race when a spawn auto-focus and a manual
  // `set` land together (both read the same line count, and the store's
  // source-identity dedup then drops one of the two events). Counted from the
  // file, not from history, so it stays stable even when a malformed line
  // sits in the middle.
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = existing ? existing.split("\n").filter((l) => l.trim() !== "").length : 0;
  // The event's identity is the CONTENT of the change, hashed — never the
  // line offset. With no sourceOffset, the store's dedup keys on eventId
  // alone: a replay of the same change is a no-op, and two different changes
  // (different at/kind/taskId) never collide.
  const eventId = createHash("sha256")
    .update(["supervisor.focus", runId, at, focus.kind, focus.taskId ?? ""].join("|"))
    .digest("hex");

  mkdirSync(join(home, runId), { recursive: true });
  // A torn trailing line (no final newline) would fuse with the append —
  // separate it first.
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(path, prefix + JSON.stringify({ at, kind: focus.kind, taskId: focus.taskId, note, source }) + "\n");

  // The live record only carries the focus when it points at THIS run — a
  // stale pointer (the supervisor restarted without recording) must not be
  // rewritten to claim a focus its run never had.
  const record = readCurrentRun({ path: currentRunPath });
  if (record && record.runId === runId) {
    writeCurrentRun(
      { ...record, focus: { kind: focus.kind, taskId: focus.taskId, at, source }, updatedAt: at },
      { path: currentRunPath },
    );
  }

  let telemetryError;
  if (telemetry && process.env.LA_SUPERVISOR_NO_TELEMETRY !== "1") {
    try {
      const emitted = emitEvent(
        makeEvent(
          "supervisor.focus",
          { runId, kind: focus.kind, taskId: focus.taskId, at, source, note },
          {
            eventId,
            runId,
            observedAt: at,
            sourceKind: "supervisor-focus",
            sourcePath: path,
          },
        ),
      );
      // emitEvent swallows its own failures into { pending: true, error } —
      // surface that here rather than reporting a change as fully recorded.
      if (emitted?.error) telemetryError = emitted.error;
    } catch (err) {
      telemetryError = err.message;
    }
  }

  return { ok: true, changed: true, runId, focus, line, ...(telemetryError ? { telemetryError } : {}) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: node scripts/supervisor-focus.mjs <verb> [options]",
  "  set <TICKET|overhead> [--note \"…\"] [--source manual|spawn|followup] [--run <runId>]",
  "                                  declare the focus (run id from --run or LA_SUPERVISOR_RUN)",
  "  show [--run <runId>]            print the current focus and the change count",
].join("\n");

const labelOf = (focus) => (focus ? (focus.kind === "overhead" ? "overhead" : focus.taskId) : "none");

// Refusals go to stdout as JSON — the Supervisor parses stdout and nothing else,
// so an error it cannot read is an error it cannot act on.
function failJsonOut(message) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  return 1;
}

function optionValue(args, i) {
  if (i + 1 >= args.length) throw new Error(`${args[i]} requires a value`);
  return args[i + 1];
}

// Run id: --run wins, LA_SUPERVISOR_RUN is the fallback. Missing or a bad
// shape is a refusal, not a guess — focus charged to the wrong run would be
// worse than no focus.
function resolveRunId(flags) {
  const runId = flags.run ?? process.env.LA_SUPERVISOR_RUN;
  if (!runId) throw new Error("no run id: pass --run or set LA_SUPERVISOR_RUN");
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return runId;
}

// Every flag this CLI knows takes a value; anything else is refused, spelled
// the same way supervisor-current-run.mjs refuses its unknown options.
function parseFlags(rest, allowed) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new Error(`unexpected argument '${token}'`);
    if (token === "--run") flags.run = optionValue(rest, i++);
    else if (allowed.includes(token)) flags[token.slice(2)] = optionValue(rest, i++);
    else throw new Error(`unknown option '${token}'`);
  }
  return flags;
}

function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "set") {
    const [value] = rest;
    if (!value) return failJsonOut("set requires a focus: a ticket id like FOC-123 or 'overhead'");
    let flags;
    try {
      flags = parseFlags(rest.slice(1), ["--note", "--source"]);
    } catch (err) {
      return failJsonOut(err.message);
    }
    try {
      const runId = resolveRunId(flags);
      const before = readFocus(runId).current;
      const result = setFocus({ runId, value, note: flags.note ?? null, source: flags.source ?? "manual" });
      console.log(JSON.stringify(result, null, 2));
      console.error(
        `focus: ${labelOf(result.focus)} (${result.changed ? `was ${labelOf(before)}` : "unchanged"})`,
      );
      return 0;
    } catch (err) {
      return failJsonOut(err.message);
    }
  }
  if (verb === "show") {
    let flags;
    try {
      flags = parseFlags(rest, []);
    } catch (err) {
      return failJsonOut(err.message);
    }
    try {
      const runId = resolveRunId(flags);
      const { current, history } = readFocus(runId);
      console.log(JSON.stringify({ ok: true, runId, current, changes: history.length }, null, 2));
      return 0;
    } catch (err) {
      return failJsonOut(err.message);
    }
  }
  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`focus: ${err.message}`);
    process.exit(1);
  }
}

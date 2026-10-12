// scripts/supervisor-current-run.mjs — the current-run record (FOC-807, plan §1).
//
// The Docker entrypoint does not set LA_SUPERVISOR_RUN/RUN_ID/LA_RUN_ID, so the
// waker, the turn-end guard, the briefing and the Cockpit all lose track of
// which run the live supervisor session belongs to. This module writes ONE
// pointer file — <dataHome>/supervisor/current-run.json, next to session.json
// (Docker: /data/supervisor/, on the shared volume) — and resolves its content
// with a single precedence:
//
//   fresh (--new) → a new id, source "new"
//   a valid pointer file → reuse it, source "pointer"
//   the newest recent run dir (recentRunIds, 14 days) → source "adopted"
//   none of the above → a new id, source "new"
//
// The launcher path (supervisor.bat, which DOES have an id) records it via
// recordLauncherRun() — source "launcher". resolveCurrentRun() always creates
// the run dir so the waker hook finds it from the first turn.
//
// CLI:
//   node scripts/supervisor-current-run.mjs resolve [--new] [--model <id>]
//   node scripts/supervisor-current-run.mjs record <runId> [--model <id>]
//   node scripts/supervisor-current-run.mjs show [--json]
//
// ESM, zero runtime deps (Node 18+).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { supervisorCurrentRunPath } from "./fenix-paths.mjs";
import { supervisorStateHome } from "./supervisor-lib.mjs";
import { recentRunIds } from "./cockpit.mjs";

// ── Library ──────────────────────────────────────────────────────────────────

// The id shape `run-manifest.mjs gen-id supervisor` produces
// (e.g. 2026-10-06T15-09-19-713-supervisor-26c7) — the guard against adopting
// a stray directory name as a run id.
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-supervisor-[0-9a-f]{4}$/;

/** Same format as cmdGenId in run-manifest.mjs, with squad "supervisor". */
export function newRunId(now = new Date(), rand = () => randomBytes(2).toString("hex")) {
  const ts = now.toISOString().replace(/:/g, "-").replace(".", "-").replace(/Z$/, "");
  return `${ts}-supervisor-${rand()}`;
}

/** The record or null — missing, unreadable, non-JSON or a bad runId shape all read as "no pointer". Never throws. */
export function readCurrentRun({ path = supervisorCurrentRunPath() } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object") return null;
    if (typeof record.runId !== "string" || !RUN_ID_RE.test(record.runId)) return null;
    return record;
  } catch {
    return null;
  }
}

/** Atomic write: mkdir -p the parent, write a pid-suffixed temp file, rename over the target. */
export function writeCurrentRun(record, { path = supervisorCurrentRunPath() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
}

// The default recent-runs source — cockpit.mjs's newest-first list of run dirs
// touched in the last 14 days. Injectable so tests (and future callers) can
// stub the adoption pool without touching the filesystem.
const defaultRecentRuns = (opts) => recentRunIds(opts);

/**
 * Resolve the current run and persist the pointer. Returns
 * { runId, model, startedAt, source, updatedAt }. Never leaves the caller
 * without a run: the pointer and the recent-runs pool are both best effort.
 */
export function resolveCurrentRun({
  fresh = false,
  model = null,
  now = new Date(),
  path,
  stateHome,
  recentRuns = defaultRecentRuns,
} = {}) {
  const home = stateHome ?? supervisorStateHome();
  let record;
  if (fresh) {
    record = { runId: newRunId(now), model, startedAt: now.toISOString(), source: "new" };
  } else {
    const pointer = readCurrentRun({ path });
    if (pointer) {
      record = { ...pointer, model: model ?? pointer.model ?? null, source: "pointer" };
    } else {
      const adopted = recentRuns({ stateHome: home, now: now.getTime() }).find((id) => RUN_ID_RE.test(id));
      record = adopted
        ? { runId: adopted, model, startedAt: now.toISOString(), source: "adopted" }
        : { runId: newRunId(now), model, startedAt: now.toISOString(), source: "new" };
    }
  }
  mkdirSync(join(home, record.runId), { recursive: true });
  record.updatedAt = now.toISOString();
  writeCurrentRun(record, { path });
  return record;
}

/** The launcher's record path (supervisor.bat): the id is authoritative, so a bad shape throws. */
export function recordLauncherRun({ runId, model = null, now = new Date(), path } = {}) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id: ${runId}`);
  }
  const startedAt = now.toISOString();
  const record = { runId, model, startedAt, updatedAt: startedAt, source: "launcher" };
  writeCurrentRun(record, { path });
  return record;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: node scripts/supervisor-current-run.mjs <verb> [options]",
  "  resolve [--new] [--model <id>]  resolve (or create) the current run; stdout is '<runId> <source>'",
  "  record <runId> [--model <id>]   record a launcher-provided run id (source: launcher)",
  "  show [--json]                   print the current record (or 'none' when absent)",
].join("\n");

function parseModelOption(args, flagIndex) {
  if (flagIndex + 1 >= args.length) throw new Error("--model requires a value");
  return args[flagIndex + 1];
}

function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "resolve") {
    let fresh = false;
    let model = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--new") fresh = true;
      else if (rest[i] === "--model") model = parseModelOption(rest, i++);
      else throw new Error(`unknown option '${rest[i]}'`);
    }
    const record = resolveCurrentRun({ fresh, model });
    console.log(`${record.runId} ${record.source}`);
    console.error(`current-run: ${record.source} ${record.runId}`);
    return 0;
  }
  if (verb === "record") {
    const [runId] = rest;
    if (!runId) throw new Error("record requires a run id");
    let model = null;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--model") model = parseModelOption(rest, i++);
      else throw new Error(`unknown option '${rest[i]}'`);
    }
    recordLauncherRun({ runId, model });
    return 0;
  }
  if (verb === "show") {
    const json = rest.includes("--json");
    if (!json && rest.length) throw new Error(`unknown option '${rest[0]}'`);
    const record = readCurrentRun();
    if (!record) console.log("none");
    else console.log(json ? JSON.stringify(record, null, 2) : JSON.stringify(record));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`current-run: ${err.message}`);
    process.exit(1);
  }
}

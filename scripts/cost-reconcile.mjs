#!/usr/bin/env node
/**
 * scripts/cost-reconcile.mjs — shared acceptance for FOC-760 / FOC-761: one
 * cost truth across the three surfaces that hold a child's cost.
 *
 * Why. The cost review (docs/research/2026-10-10-model-cost-telemetry-review.md,
 * findings F4/F5) measured two independent lies: F4 — the registry's `costUsd`
 * summed session-cumulative `result.modelUsage` events, 5.05× ground truth;
 * F5 — telemetry dropped resumed turns, 0.25× ground truth for multi-turn
 * children. FOC-760 fixes the registry (cost SET from the child's own
 * transcripts at turn end), FOC-761 fixes telemetry (resumed turns re-open the
 * run and re-ingest). This check reconciles all three per child and fails
 * loudly under --strict when they disagree:
 *
 *   registry   vs transcript truth   off by > 1 %              (FOC-760 AC1)
 *   telemetry  vs transcript truth   multi-turn ratio < 0.99   (FOC-761 AC1)
 *
 * Ground truth is the child's own transcripts, priced by
 * priceChildTranscripts() (transcript-cost.mjs) — the same pricing the watcher
 * now records, so the registry comparison is definition-by-definition.
 *
 * Telemetry is the summed cost of the usage rows of the child's
 * `telemetryRunId`: usage_facts LEFT-JOINed to runs and to cost_facts at the
 * run's OWN price_set_id — the same rule costPanel (telemetry-analysis.mjs)
 * and queryTrace (telemetry-store.mjs) apply, because cost_facts holds a row
 * per price snapshot and a join without that predicate would count every
 * message once per price set. The join to runs is LEFT on purpose: a run
 * missing from `runs` has no price set, so its rows price to nothing and are
 * counted as unpriced — they are not dropped. A run with NO usage rows at all
 * yields `telemetryUsd: null` — telemetry that saw nothing is unknown, never
 * laundered into $0. Post-FOC-381 a usage row IS one message (message_id
 * set); rows with a NULL message_id are legacy per-line history — counted as
 * `legacyRows` and flagged on the child, never silently mixed into the
 * per-message story.
 *
 * READ-ONLY by construction: the registries are only read, and the store is
 * opened with `new DatabaseSync(dbPath, { readOnly: true })` — never
 * openTelemetryDb(), which is read-write and migrates on open (the same rule
 * openAnalysisDb() enforces for the dashboard). A missing or unopenable store
 * is not an error: telemetry columns go null and the registry-vs-transcript
 * comparison still runs.
 *
 * Excluded from every ratio — counted, never folded in (unknown is not free,
 * unsettled is not settled):
 *   - in-flight children (status `running`/`starting`, or any turn without
 *     `endedAt`) — their cost is not final yet; counted as `skipped`;
 *   - children with no transcript found (`noTranscript`) — no ground truth;
 *   - children whose transcript truth is null (`unpriced`) — a message on an
 *     unpriceable model makes truth unknown, so no ratio is computed.
 *
 * Usage: node scripts/cost-reconcile.mjs [--state-home <dir>] [--db <path>]
 *             [--run <runId>] [--json] [--strict]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { supervisorStateHome } from "./supervisor-lib.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import { squadConfigDir } from "./fenix-paths.mjs";
import { telemetryDbPath } from "./telemetry-store.mjs";

/** Registry statuses that mean the child's cost is not settled yet. */
const IN_FLIGHT_STATUSES = new Set(["running", "starting"]);

/** Off-by threshold for the registry comparison — FOC-760 AC1. */
const REGISTRY_TOLERANCE = 0.01;
/** Floor for the multi-turn telemetry ratio — FOC-761 AC1. */
const TELEMETRY_FLOOR = 0.99;

// One row per usage fact of the run, with its cost joined at the run's own
// price set (the costPanel/queryTrace rule — see the header comment). The join
// leads with run_id so SQLite can seek the v5 composite PK (JOI-260). The join
// to runs is LEFT: a run missing from `runs` has no price set, so its rows come
// back with a NULL cost and count as unpriced — dropping them (an INNER join)
// would read "run absent from the store" as "run was free". Rows with a NULL
// message_id are legacy per-line history (FOC-381); a NULL cost on a real model
// is unpriced, and unpriced is not free — counted, not folded.
const TELEMETRY_SQL = `
  SELECT u.message_id AS messageId,
         u.model AS model,
         COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)
           + COALESCE(u.cache_read_tokens, 0) + COALESCE(u.cache_creation_tokens, 0) AS tokens,
         c.cost_usd AS costUsd
  FROM usage_facts u
  LEFT JOIN runs r ON r.run_id = u.run_id
  LEFT JOIN cost_facts c
    ON c.run_id = u.run_id AND c.usage_id = u.usage_id AND c.price_set_id = r.price_set_id
  WHERE u.run_id = ?`;

/**
 * Sum one telemetry run's usage cost, read-only.
 *
 * @returns {{ usd: number|null, legacyRows: number|null, unpricedRows: number|null }}
 *   null fields when there is no open store or no telemetryRunId — telemetry
 *   unknown is reported as null, never laundered into 0. `usd` is also null
 *   when the run has NO usage rows (absent from the store — unknown, not $0).
 *   Priced rows sum into `usd`; rows whose cost could not be joined (no `runs`
 *   row → no price set) or that carry a real model without a price count in
 *   `unpricedRows` instead of silently vanishing.
 */
function telemetryForRun(db, telemetryRunId) {
  if (!db || !telemetryRunId) return { usd: null, legacyRows: null, unpricedRows: null };
  const rows = db.prepare(TELEMETRY_SQL).all(telemetryRunId);
  if (rows.length === 0) {
    // No usage rows for the run — the store saw nothing for it. Unknown is
    // not free: null, never a laundered 0.
    return { usd: null, legacyRows: 0, unpricedRows: 0 };
  }
  let usd = 0;
  let legacyRows = 0;
  let unpricedRows = 0;
  for (const row of rows) {
    if (row.messageId == null) legacyRows++;
    // Claude Code placeholder rows (sentinel model, or no model and no tokens)
    // are not priceable by definition — same classification as the canonical
    // views; they must not feed the unpriced count.
    const synthetic =
      row.model === "synthetic" || row.model === "<synthetic>" ||
      (row.model == null && !(row.tokens > 0));
    if (row.costUsd == null && !synthetic) unpricedRows++;
    else usd += row.costUsd ?? 0;
  }
  return { usd, legacyRows, unpricedRows };
}

/** A turn without `endedAt` means the child is mid-turn — cost not settled. */
function isInFlight(child, turns) {
  if (IN_FLIGHT_STATUSES.has(child.status)) return true;
  return turns.some((turn) => !turn?.endedAt);
}

/**
 * part/whole as a comparison ratio. A zero-truth child is exact only when the
 * compared side is 0 too (0/0 → 1); anything over a zero truth is
 * unverifiable → null, never Infinity in the JSON.
 */
function ratio(part, whole) {
  if (part == null || whole == null) return null;
  if (whole > 0) return part / whole;
  return part === 0 ? 1 : null;
}

/**
 * Reconcile every settled child of every run registry under `stateHome`
 * (or only `runId` when given) against transcript truth and telemetry.
 *
 * @param {{ stateHome?: string, dbPath?: string|null, runId?: string|null }} options
 * @returns {{ meta: object, children: object[], summary: object }}
 */
export function reconcile(options = {}) {
  const stateHome = options.stateHome ?? supervisorStateHome();
  const dbPath = options.dbPath !== undefined ? options.dbPath : telemetryDbPath();

  let db = null;
  if (dbPath && existsSync(dbPath)) {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 10000;");
    } catch {
      db = null; // unopenable store — telemetry unknown, keep going
    }
  }

  const runIds = options.runId ? [options.runId] : listRunIds(stateHome);
  const children = [];
  for (const runId of runIds) {
    const registry = readRegistryFile(stateHome, runId);
    for (const childId of Object.keys(registry.children ?? {}).sort()) {
      children.push(evaluateChild(db, runId, childId, registry.children[childId]));
    }
  }
  db?.close();

  const summary = summarize(children);
  return {
    meta: { stateHome, db: dbPath, dbAvailable: db != null, runId: options.runId ?? null },
    children,
    summary,
  };
}

/** Directories under stateHome that hold a children.json registry, sorted. */
function listRunIds(stateHome) {
  let entries;
  try {
    entries = readdirSync(stateHome, { withFileTypes: true });
  } catch {
    return []; // no state home — nothing to reconcile
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(stateHome, e.name, "children.json")))
    .map((e) => e.name)
    .sort();
}

/** Parse one registry. Corrupt JSON throws — silently skipping a registry
 *  would orphan its children from the check exactly like the lies it hunts. */
function readRegistryFile(stateHome, runId) {
  const path = join(stateHome, runId, "children.json");
  if (!existsSync(path)) return { children: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function evaluateChild(db, runId, childId, child) {
  const turns = Array.isArray(child?.turns) ? child.turns : [];
  const entry = {
    runId,
    childId,
    turns: turns.length,
    multiTurn: turns.length > 1,
    status: child?.status ?? null,
    truthUsd: null,
    registryUsd: child?.costUsd ?? null,
    telemetryUsd: null,
    registryRatio: null,
    telemetryRatio: null,
    legacyRows: null,
    flags: [],
  };
  const result = { ...entry, _excluded: null, _included: false };

  if (isInFlight(child ?? {}, turns)) {
    result.flags.push("inFlight");
    result._excluded = "skipped";
    return result;
  }

  // Telemetry is reported for every settled child that has a run id — even
  // one excluded from the ratios — so the row still says what telemetry saw.
  const tel = telemetryForRun(db, child?.telemetryRunId ?? null);
  result.telemetryUsd = tel.usd;
  result.legacyRows = tel.legacyRows;
  if ((tel.legacyRows ?? 0) > 0) result.flags.push("legacyRows");
  if ((tel.unpricedRows ?? 0) > 0) result.flags.push("telemetryUnpriced");

  // The lookup is guarded like recomputeChild guards it (registry-cost-recompute.mjs):
  // an unreadable config dir or a squad that cannot even be joined into a path
  // is "not found", not a crashed run — the child counts as noTranscript with a
  // `lookup-error` flag and every other child still reconciles.
  let priced = null;
  let lookupError = false;
  try {
    priced = priceChildTranscripts({
      configDir: squadConfigDir(child?.squad),
      cwd: child?.worktree,
      sessionId: child?.sessionId,
    });
  } catch {
    lookupError = true;
  }
  if (!priced) {
    if (lookupError) result.flags.push("lookup-error");
    result.flags.push("noTranscript");
    result._excluded = "noTranscript";
    return result;
  }
  result.transcriptPath = priced.transcriptPath;
  result.truthUsd = priced.costUsd;
  if (priced.costUsd == null) {
    result.flags.push("unpriced");
    result._excluded = "unpriced";
    return result;
  }

  result.registryRatio = ratio(result.registryUsd, result.truthUsd);
  result.telemetryRatio = ratio(result.telemetryUsd, result.truthUsd);
  // A zero-truth child over a non-zero side is off even though ratio() is null
  // there (part/0) — a null ratio must never read as "verified".
  if (result.truthUsd === 0) {
    if ((result.registryUsd ?? 0) !== 0) result.flags.push("registryOff");
    if ((result.telemetryUsd ?? 0) !== 0) result.flags.push("telemetryOff");
  }
  result._included = true;
  return result;
}

function sumBy(entries, field) {
  let total = 0;
  let seen = false;
  for (const e of entries) {
    if (e[field] != null) {
      total += e[field];
      seen = true;
    }
  }
  return seen ? total : null;
}

function summarize(children) {
  const included = children.filter((c) => c._included);
  const bucket = (label, entries) => {
    const truthUsd = sumBy(entries, "truthUsd");
    const registryUsd = sumBy(entries, "registryUsd");
    const telemetryUsd = sumBy(entries, "telemetryUsd");
    return {
      n: entries.length,
      truthUsd,
      registryUsd,
      telemetryUsd,
      registryRatio: ratio(registryUsd, truthUsd),
      telemetryRatio: ratio(telemetryUsd, truthUsd),
    };
  };
  const isMulti = (c) => c.multiTurn;
  // FOC-761's gate asks what telemetry SAW, so the multi telemetry ratio is
  // computed only over multi-turn children with non-null telemetryUsd — a
  // child with no store rows would otherwise dilute the ratio with a null and
  // hide a real under-report. The count is surfaced as multi.withTelemetry so
  // the JSON says what the ratio covers. The registry side of the bucket stays
  // over ALL multi children: it needs no telemetry.
  const multiAll = included.filter(isMulti);
  const multiWithTelemetry = multiAll.filter((c) => c.telemetryUsd != null);
  const multi = bucket("multi", multiAll);
  multi.withTelemetry = multiWithTelemetry.length;
  multi.telemetryRatio = ratio(sumBy(multiWithTelemetry, "telemetryUsd"), sumBy(multiWithTelemetry, "truthUsd"));
  const summary = {
    single: bucket("single", included.filter((c) => !isMulti(c))),
    multi,
    all: bucket("all", included),
    registryOff: included
      .filter(
        (c) =>
          c.registryUsd == null ||
          (c.registryRatio != null && Math.abs(c.registryRatio - 1) > REGISTRY_TOLERANCE) ||
          // truth $0 over a non-zero registry: ratio() is null there (0 whole)
          // — still off, and --strict must fail on it.
          (c.truthUsd === 0 && c.registryUsd !== 0),
      )
      .map((c) => c.childId),
    noTranscript: children.filter((c) => c._excluded === "noTranscript").length,
    unpriced: children.filter((c) => c._excluded === "unpriced").length,
    skipped: children.filter((c) => c._excluded === "skipped").length,
  };
  return summary;
}

/** The strict failure list: FOC-760 AC1 and FOC-761 AC1 violations. */
export function strictFailures(result) {
  const failures = [];
  const { registryOff, multi } = result.summary;
  if (registryOff.length > 0) {
    failures.push(`${registryOff.length} children off by > ${REGISTRY_TOLERANCE * 100}% (registry vs transcript truth): ${registryOff.join(", ")}`);
  }
  // FOC-761 AC1 only bites when there is something to check: the ratio covers
  // only multi-turn children telemetry actually reported (summary.multi
  // computed it over exactly those; multi.withTelemetry says how many).
  if (multi.withTelemetry > 0 && multi.telemetryRatio != null && multi.telemetryRatio < TELEMETRY_FLOOR) {
    failures.push(
      `multi-turn telemetry ratio ${multi.telemetryRatio.toFixed(3)} over ${multi.withTelemetry} children with telemetry < ${TELEMETRY_FLOOR} (FOC-761 AC1)`,
    );
  }
  return failures;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--state-home") args.stateHome = argv[++i];
    else if (arg === "--db") args.db = argv[++i];
    else if (arg === "--run") args.run = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

// Money for humans — unknown, zero and positive must stay distinguishable:
// null → "unknown" (unknown is not free), exactly 0 → "$0", >= $0.01 → cents,
// below that enough decimals for 2 significant digits ($0.000021) — mock runs
// and cheap models produce sub-cent figures, and $0 for a non-zero cost is a
// lie. JSON output is never routed through this.
const usd = (v) => {
  if (v == null) return "unknown";
  if (v === 0) return "$0";
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(1 - Math.floor(Math.log10(v)))}`;
};
const times = (v) => (v == null ? "—" : `${v.toFixed(3)}x`);

function printHuman(result) {
  const { meta, children, summary } = result;
  console.log(`cost-reconcile — registry vs telemetry vs transcript truth (FOC-760/FOC-761)`);
  console.log(`state home: ${meta.stateHome}`);
  console.log(`store: ${meta.db} ${meta.dbAvailable ? "(read-only)" : "(NOT FOUND — telemetry unknown)"}`);
  console.log("");
  console.log("bucket    n   truth       registry    telemetry   reg/truth  tel/truth");
  for (const [label, b] of [["single", summary.single], ["multi", summary.multi], ["all", summary.all]]) {
    console.log(
      `${label.padEnd(10)}${String(b.n).padStart(3)}  ${usd(b.truthUsd).padStart(10)}  ${usd(b.registryUsd).padStart(10)}  ${usd(b.telemetryUsd).padStart(10)}  ${times(b.registryRatio).padStart(9)}  ${times(b.telemetryRatio).padStart(9)}`,
    );
  }
  console.log(
    `excluded: noTranscript=${summary.noTranscript} unpriced=${summary.unpriced} skipped=${summary.skipped}`,
  );

  // The worst children by |registry ratio − 1| — the actionable tail. A null
  // registry over a priced truth, or a null ratio (zero truth over a non-zero
  // registry), is the worst kind (unknown posing as verified) — sorts first.
  const worst = children
    .filter((c) => c._included)
    .map((c) => ({
      c,
      off: c.registryUsd == null || c.registryRatio == null ? Infinity : Math.abs(c.registryRatio - 1),
    }))
    .sort((a, b) => b.off - a.off)
    .slice(0, 10)
    .filter((w) => w.off > REGISTRY_TOLERANCE || w.off === Infinity);
  if (worst.length > 0) {
    console.log("");
    console.log("worst registry deviations (up to 10):");
    console.log("run                child          turns  truth        registry     reg     flags");
    for (const { c } of worst) {
      console.log(
        `${c.runId.padEnd(19)}${c.childId.padEnd(15)}${String(c.turns).padStart(5)}  ${usd(c.truthUsd).padStart(11)}  ${usd(c.registryUsd).padStart(11)}  ${times(c.registryRatio).padStart(6)}  ${c.flags.join(",") || "-"}`,
      );
    }
  }
  if (summary.registryOff.length > 0) {
    console.log("");
    console.log(`registry off by > ${REGISTRY_TOLERANCE * 100}%: ${summary.registryOff.join(", ")}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`cost-reconcile: ${err.message}`);
    console.error("usage: node scripts/cost-reconcile.mjs [--state-home <dir>] [--db <path>] [--run <runId>] [--json] [--strict]");
    return 2;
  }

  const result = reconcile({ stateHome: args.stateHome, dbPath: args.db, runId: args.run });
  if (args.json) {
    // The internal inclusion markers are CLI plumbing — the JSON contract is
    // the documented shape: children + summary.
    const { meta, children: rawChildren, summary } = result;
    const children = rawChildren.map(({ _excluded, _included, ...entry }) => entry);
    console.log(JSON.stringify({ meta, children, summary }, null, 2));
  } else {
    printHuman(result);
  }

  if (args.strict) {
    const failures = strictFailures(result);
    if (failures.length > 0) {
      console.error(`cost-reconcile --strict FAILED:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main());
}

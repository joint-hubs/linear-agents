// scripts/cadence-quality.mjs — FOC-1071: the four quality/cost numbers the
// weekly CADENCE digest reports, for the current and the previous ISO week,
// with the delta.
//
//   node scripts/cadence-quality.mjs --json
//
// JSON is the only output mode — the digest agent parses stdout. The four
// numbers, one definition each (docs/TELEMETRY-EXPLAINED.md §12):
//   firstTimeRight          — share of round-1 REVIEW PASS (0..1, or null)
//   interventionsPerTicket  — gate/hold/ask answers per ticket with children
//   wallTimeToPr            — p50 hours from first activity to first PR open
//   costPerTicketBySize     — p50 all-in USD per triage size (small/medium/large)
//
// Windows are ISO weeks, Monday 00:00 UTC: current = [monday, now], previous =
// the full week before. A ticket belongs to the window its last activity falls
// in — the same membership rule the /api/quality period filter applies, so the
// weekly numbers and the screen never disagree about who is in the window.
// Cost comes straight from the telemetry store (ticketCostReport over the
// half-open [since, until) window); targets ride from the settings overlay
// (the per-size target lines) — the digest reads numbers, never states.

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readSettings } from "./fenix-settings.mjs";
import { stateRoot } from "./fenix-paths.mjs";
import { supervisorStateHome } from "./supervisor-lib.mjs";
import { telemetryDbPath, ticketCostReport } from "./telemetry-store.mjs";
import { collectTicketFacts } from "./work-board.mjs";
import { costPerTicketBySize, percentileNearestRank, round1VerdictOf } from "./cost-quality.mjs";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The ISO-week windows containing `now`: current = [Monday 00:00 UTC, now],
 * previous = the full 7 days before it. Monday 00:00 sharp opens a fresh
 * week; a Sunday evening still belongs to the week that started 6 days
 * earlier.
 */
export function isoWeekRange(now) {
  const d = new Date(now);
  const shiftToMonday = (d.getUTCDay() + 6) % 7;
  const start =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - shiftToMonday * DAY_MS;
  return {
    current: { start, end: now },
    previous: { start: start - 7 * DAY_MS, end: start },
  };
}

/** Facts whose last activity falls in the half-open [start, end) window. */
const factsInWindow = (facts, { start, end }) =>
  facts.filter((f) => {
    const at = Date.parse(f.lastActivityAt);
    return Number.isFinite(at) && at >= start && at < end;
  });

/** The four numbers for one window. No data → null values, never a zero. */
function windowNumbers({ facts, report, targets }) {
  const withRound1 = facts.filter((f) => round1VerdictOf(f) != null);
  const firstTimePass = withRound1.filter((f) => round1VerdictOf(f) === "PASS");
  const withChildren = facts.filter((f) => (Array.isArray(f.children) ? f.children : []).length > 0);
  const wallHours = facts
    .map((f) => {
      const start = Date.parse(f.firstActivityAt);
      const pr = Date.parse(f.prOpenAt);
      return Number.isFinite(start) && Number.isFinite(pr) && pr >= start
        ? (pr - start) / HOUR_MS
        : null;
    })
    .filter((h) => h != null);
  const factsByTask = new Map(facts.map((f) => [f.taskId, f]));
  return {
    tickets: facts.length,
    firstTimeRight: withRound1.length ? firstTimePass.length / withRound1.length : null,
    interventionsPerTicket: withChildren.length
      ? withChildren.reduce((sum, f) => sum + (f.interventions ?? 0), 0) / withChildren.length
      : null,
    wallTimeToPr: percentileNearestRank(wallHours, 50),
    costPerTicketBySize: costPerTicketBySize(report?.tickets ?? [], factsByTask, targets),
  };
}

/** current - previous; a null on either side stays null — never a fake 0. */
const delta = (a, b) => (a == null || b == null ? null : a - b);

/**
 * The digest's numbers: { weeks, current, previous, deltas }. Pure — the CLI
 * main below owns the reads, tests drive this with fixtures.
 */
export function cadenceQuality({ now, facts, reports, targets = null }) {
  const { current, previous } = isoWeekRange(now);
  const all = Array.isArray(facts) ? facts : [];
  const cur = windowNumbers({ facts: factsInWindow(all, current), report: reports?.current, targets });
  const prev = windowNumbers({ facts: factsInWindow(all, previous), report: reports?.previous, targets });
  const iso = (ms) => new Date(ms).toISOString();
  const sizeDelta = (size) => delta(cur.costPerTicketBySize[size]?.p50, prev.costPerTicketBySize[size]?.p50);
  return {
    weeks: {
      current: { start: iso(current.start), end: iso(current.end) },
      previous: { start: iso(previous.start), end: iso(previous.end) },
    },
    current: cur,
    previous: prev,
    deltas: {
      firstTimeRight: delta(cur.firstTimeRight, prev.firstTimeRight),
      interventionsPerTicket: delta(cur.interventionsPerTicket, prev.interventionsPerTicket),
      wallTimeToPr: delta(cur.wallTimeToPr, prev.wallTimeToPr),
      costPerTicketBySize: {
        small: sizeDelta("small"),
        medium: sizeDelta("medium"),
        large: sizeDelta("large"),
      },
    },
  };
}

/** --json only — this tool exists to be parsed by the digest agent. */
async function main() {
  if (!process.argv.includes("--json")) {
    throw new Error("cadence-quality only prints JSON; pass --json");
  }
  const now = Date.now();
  const { current, previous } = isoWeekRange(now);
  const days = Math.ceil((now - previous.start) / DAY_MS) + 1;
  const facts = collectTicketFacts({
    stateHome: supervisorStateHome(),
    days,
    now,
    publishActionsPath: resolve(stateRoot(), "publish-actions.jsonl"),
  });
  const db = new DatabaseSync(resolve(telemetryDbPath()), { readOnly: true });
  let reports;
  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    reports = {
      current: ticketCostReport(db, {
        since: new Date(current.start).toISOString(),
        until: new Date(current.end).toISOString(),
      }),
      previous: ticketCostReport(db, {
        since: new Date(previous.start).toISOString(),
        until: new Date(previous.end).toISOString(),
      }),
    };
  } finally {
    db.close();
  }
  let targets = null;
  try {
    targets = readSettings().targets ?? null;
  } catch {
    targets = null; // a broken overlay costs the target lines, never the numbers
  }
  console.log(JSON.stringify(cadenceQuality({ now, facts, reports, targets }), null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
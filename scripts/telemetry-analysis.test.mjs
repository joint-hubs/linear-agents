// Tests for telemetry-analysis.mjs — the dashboard Analysis screen's read side.
//
// The panel code's two failure modes this file exists to catch:
//   1. A raw usage_facts sum sneaking back in — that table double-counts by
//      design (ADR-0008 run-scoped claims + FOC-381 per-message lines), so
//      one grep-level source guard plus view-only queries enforce the rule.
//   2. The analysis connection writing or migrating the store — openAnalysisDb
//      must be strictly read-only, verified here by an INSERT that must throw.
//
// Fixtures are built with openTelemetryDb() (fine in a temp dir), then re-opened
// with the analysis opener, exactly the shape production uses.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import {
  ERA_BOUNDARY,
  openAnalysisDb,
  normalizeFilters,
  filterSql,
  metaPanel,
  toolsPanel,
  qualityPanel,
  costPanel,
  handoffsPanel,
} from "./telemetry-analysis.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const throwsBadFilter = (name, fn) => {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (error) {
    check(name, error.code === "bad_filter", `code=${error.code} message=${error.message}`);
  }
};

// ---------------------------------------------------------------------------
// normalizeFilters — defaults and validation
// ---------------------------------------------------------------------------

{
  const f = normalizeFilters({});
  check("defaults: era is post", f.era === "post");
  check("defaults: eraBoundary is the FOC-397 merge", f.eraBoundary === ERA_BOUNDARY);
  check("defaults: squad and model are null", f.squad === null && f.model === null);
  check("defaults: window spans exactly 30 days ending now",
    Date.parse(f.to) - Date.parse(f.from) === 30 * 24 * 60 * 60 * 1000);
  check("defaults: from/to are ISO strings", !Number.isNaN(Date.parse(f.from)) && !Number.isNaN(Date.parse(f.to)));

  const p = normalizeFilters(new URLSearchParams("squad=alpha&era=pre&from=2026-09-01T00:00:00.000Z"));
  check("URLSearchParams input is accepted", p.squad === "alpha" && p.era === "pre" && p.from === "2026-09-01T00:00:00.000Z");
  check("URLSearchParams: missing keys still default", p.eraBoundary === ERA_BOUNDARY && p.model === null);

  const blank = normalizeFilters(new URLSearchParams("squad=&model="));
  check("empty-string params are treated as unset", blank.squad === null && blank.model === null);

  const custom = normalizeFilters({ era: "all", eraBoundary: "2026-01-01T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" });
  check("explicit era/eraBoundary survive", custom.era === "all" && custom.eraBoundary === "2026-01-01T00:00:00.000Z");

  throwsBadFilter("bad date rejects with bad_filter", () => normalizeFilters({ from: "not-a-date" }));
  throwsBadFilter("from > to rejects with bad_filter",
    () => normalizeFilters({ from: "2026-09-26T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }));
  throwsBadFilter("unknown era rejects with bad_filter", () => normalizeFilters({ era: "mid" }));
  throwsBadFilter("squad over 100 chars rejects with bad_filter", () => normalizeFilters({ squad: "x".repeat(101) }));
  throwsBadFilter("model over 100 chars rejects with bad_filter", () => normalizeFilters({ model: "y".repeat(101) }));

  // Date-only values mean the whole UTC day: `from` = the day's start,
  // `to` = the day's END — a date-only `to` at midnight would drop the day.
  const dayFrom = normalizeFilters({ from: "2026-09-01", era: "all" });
  check("date-only from reads as the UTC day's start",
    dayFrom.from === "2026-09-01T00:00:00.000Z", `got ${dayFrom.from}`);
  const dayTo = normalizeFilters({ to: "2026-09-26", era: "all" });
  check("date-only to reads as the UTC day's end (not midnight)",
    dayTo.to === "2026-09-26T23:59:59.999Z", `got ${dayTo.to}`);
  check("date-only from/to do not overlap a whole single day",
    Date.parse(dayTo.to) - Date.parse(dayTo.from) > 0);
  const dateTime = normalizeFilters({ from: "2026-09-01T10:00:00.000Z", to: "2026-09-02T10:00:00.000Z", era: "all" });
  check("full datetimes pass through unchanged",
    dateTime.from === "2026-09-01T10:00:00.000Z" && dateTime.to === "2026-09-02T10:00:00.000Z",
    `got ${dateTime.from} .. ${dateTime.to}`);
  const dayBoundary = normalizeFilters({ eraBoundary: "2026-01-01", era: "all" });
  check("date-only eraBoundary stays the day's start (a boundary, not a window end)",
    dayBoundary.eraBoundary === "2026-01-01T00:00:00.000Z", `got ${dayBoundary.eraBoundary}`);
}

// ---------------------------------------------------------------------------
// filterSql — values bound, never concatenated
// ---------------------------------------------------------------------------

{
  const f = normalizeFilters({
    from: "2026-09-01T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z",
    squad: "alpha", model: "m1", era: "pre",
  });
  const { where, params } = filterSql(f);
  check("filterSql returns a compound WHERE", where.startsWith("WHERE ") && where.includes(" AND "));
  check("filterSql binds five values", params.length === 5, JSON.stringify(params));
  check("no filter value appears inside the where string",
    params.every((p) => !where.includes(String(p))), where);
  check("era pre keeps timestampless rows and cuts at the boundary",
    where.includes("IS NULL") && where.includes("<"), where);

  const post = filterSql(normalizeFilters({ era: "post" }));
  check("era post is >= the boundary", post.where.includes(">=") && !post.where.includes("IS NULL"), post.where);

  const none = filterSql({ from: null, to: null, squad: null, model: null, era: "all", eraBoundary: ERA_BOUNDARY });
  check("era all with no other filters yields no clause", none.where === "" && none.params.length === 0);
}

// ---------------------------------------------------------------------------
// Fixture store
// ---------------------------------------------------------------------------

const temp = mkdtempSync(join(tmpdir(), "telemetry-analysis-test-"));
const storePath = join(temp, "t.sqlite");
const db = openTelemetryDb(storePath);
ensureViews(db);

db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");

const insertRun = db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
// runPre straddles the era boundary's left side, runPost the right side.
insertRun.run("runPre", "alpha", "2026-09-20T10:00:00.000Z", "2026-09-20T11:00:00.000Z", "ps1", "completed");
insertRun.run("runPost", "beta", "2026-09-24T10:00:00.000Z", "2026-09-24T11:00:00.000Z", "ps1", "completed");

const usage = db.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const cost = db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

// pre.jsonl: a priced lead turn and an UNPRICED turn (model mX is in no price set).
usage.run("up1", "runPre", "s1", "_lead", "m1", "2026-09-20T10:30:00.000Z", 100, 50, 0, 0, "/pre.jsonl", 10, "2026-09-20T10:30:00.000Z");
usage.run("up2", "runPre", "s1", "worker", "mX", "2026-09-20T10:40:00.000Z", 20, 10, 0, 0, "/pre.jsonl", 20, "2026-09-20T10:40:00.000Z");
cost.run("runPre", "up1", "ps1", 1.5);

// post.jsonl: an after_end turn, plus a two-line per-message island (FOC-381 shape).
usage.run("up3", "runPost", "s2", "_lead", "m1", "2026-09-24T11:30:00.000Z", 80, 40, 0, 0, "/post.jsonl", 10, "2026-09-24T11:30:00.000Z");
usage.run("up4a", "runPost", "s2", "_lead", "m1", "2026-09-24T10:40:00.000Z", 7, 8, 0, 0, "/post.jsonl", 20, "2026-09-24T10:40:00.000Z");
usage.run("up4b", "runPost", "s2", "_lead", "m1", "2026-09-24T10:40:05.000Z", 7, 8, 0, 0, "/post.jsonl", 30, "2026-09-24T10:40:05.000Z");
cost.run("runPost", "up3", "ps1", 2.0);
cost.run("runPost", "up4a", "ps1", 0.5);

// shared.jsonl: one physical call claimed by BOTH runs (ADR-0008) — the live
// run (runPre, in-window) must win the representation; claim_count is 2.
usage.run("up5", "runPre", "s1", "_lead", "m1", "2026-09-20T10:45:00.000Z", 30, 30, 0, 0, "/shared.jsonl", 5, "2026-09-20T10:45:00.000Z");
usage.run("up5", "runPost", "s2", "_lead", "m1", "2026-09-20T10:45:00.000Z", 30, 30, 0, 0, "/shared.jsonl", 5, "2026-09-20T10:45:00.000Z");
cost.run("runPre", "up5", "ps1", 0.7);

// tool_facts — FOC-220 columns included directly.
const tool = db.prepare(`INSERT INTO tool_facts
  (tool_fact_id, run_id, agent_key, model, observed_at, tool_name_raw, tool_name_canon,
   tool_input, tool_has_error, turn_index, source_path, source_offset, created_at,
   tool_input_id, tool_index, tool_result_state, tool_result_bytes, tool_result_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// A Read repeated with identical args AND identical result digest, no mutation
// in between → classified `unchanged` by analyseToolCalls.
tool.run("tf1", "runPost", "_lead", "m1", "2026-09-24T10:31:00.000Z", "Read", "read_file",
  '{"file_path":"/a.txt"}', 0, 0, "/tp.jsonl", 10, "2026-09-24T10:31:00.000Z", "idA", 0, "ok", 10, "res1");
tool.run("tf2", "runPost", "_lead", "m1", "2026-09-24T10:32:00.000Z", "Read", "read_file",
  '{"file_path":"/a.txt"}', 0, 1, "/tp.jsonl", 20, "2026-09-24T10:32:00.000Z", "idA", 1, "ok", 10, "res1");
// An errored call.
tool.run("tf3", "runPost", "_lead", "m1", "2026-09-24T10:33:00.000Z", "Edit", "edit_file",
  '{"file_path":"/b.txt"}', 1, 2, "/tp.jsonl", 30, "2026-09-24T10:33:00.000Z", "idB", 2, "error", 20, "res2");
// A pre-FOC-220-shaped row: no canon name, no identity, no result state —
// outcome unknown, canon coverage hole.
tool.run("tf4", "runPre", "_lead", "m1", "2026-09-20T10:32:00.000Z", "Weird", null,
  "{}", 0, 0, "/tpre.jsonl", 10, "2026-09-20T10:32:00.000Z", null, 0, null, null, null);
// Bash with no recorded result → outcome unknown.
tool.run("tf5", "runPre", "_lead", "m1", "2026-09-20T10:33:00.000Z", "Bash", "bash",
  "{}", 0, 1, "/tpre.jsonl", 20, "2026-09-20T10:33:00.000Z", "idC", 1, null, null, null);

// data_quality_issues: one open, one resolved.
const issue = db.prepare(`INSERT INTO data_quality_issues
  (issue_id, run_id, issue_type, severity, details_json, opened_at, resolved_at) VALUES (?,?,?,?,?,?,?)`);
issue.run("iss1", "runPre", "pricing_missing", "warning", "{}", "2026-09-20T12:00:00.000Z", null);
issue.run("iss2", "runPost", "transcript_missing", "warning", "{}", "2026-09-24T12:00:00.000Z", "2026-09-24T13:00:00.000Z");

db.close();

// Production shape: the analysis connection is read-only.
const analysis = openAnalysisDb(storePath);

// Expected canonical fixture shape: 5 turns (pre@10, pre@20, post@10,
// post@20 [line_count 2], shared@5 [claim_count 2]) and 5 tool calls.
const countUsage = (filters) => {
  const { where, params } = filterSql(normalizeFilters(filters));
  return analysis.prepare(`SELECT COUNT(*) AS n FROM canonical_usage ${where}`).get(...params).n;
};

// Default filters end at "now" with era=post — the two post-boundary turns.
check("fixture: default window + era post counts the post turns", countUsage({}) === 2, `got ${countUsage({})}`);
check("filterSql from-to restricts the window",
  countUsage({ from: "2026-09-24T00:00:00.000Z", era: "all" }) === 2, `got ${countUsage({ from: "2026-09-24T00:00:00.000Z", era: "all" })}`);
check("filterSql squad filters (alpha)", countUsage({ squad: "alpha", era: "all" }) === 3);
check("filterSql squad filters (beta)", countUsage({ squad: "beta", era: "all" }) === 2);
check("filterSql model filters", countUsage({ model: "mX", era: "all" }) === 1);
check("era pre counts the pre-boundary turns", countUsage({ era: "pre" }) === 3, `got ${countUsage({ era: "pre" })}`);
check("era post counts the post-boundary turns", countUsage({ era: "post" }) === 2, `got ${countUsage({ era: "post" })}`);
check("era all counts everything", countUsage({ era: "all" }) === 5, `got ${countUsage({ era: "all" })}`);
// A date-only from/to pair covers the WHOLE chosen day — the two post.jsonl
// turns of 2026-09-24 survive a `to` of "2026-09-24" (midnight would drop them).
check("date-only window keeps the whole chosen day",
  countUsage({ from: "2026-09-24", to: "2026-09-24", era: "all" }) === 2,
  `got ${countUsage({ from: "2026-09-24", to: "2026-09-24", era: "all" })}`);

// --- read-only guarantee ---------------------------------------------------

let wrote = false;
try {
  analysis.prepare("INSERT INTO runs (run_id, status, updated_at) VALUES ('no-write','running','2026-09-26T00:00:00.000Z')").run();
} catch {
  wrote = true;
}
check("openAnalysisDb cannot write (INSERT throws)", wrote);

// --- metaPanel --------------------------------------------------------------

{
  const meta = metaPanel(analysis);
  check("metaPanel window first", meta.data.window.first === "2026-09-20T10:30:00.000Z", `got ${meta.data.window.first}`);
  check("metaPanel window last", meta.data.window.last === "2026-09-24T11:30:00.000Z", `got ${meta.data.window.last}`);
  check("metaPanel squads", JSON.stringify(meta.data.squads) === JSON.stringify(["alpha", "beta"]), JSON.stringify(meta.data.squads));
  check("metaPanel models", JSON.stringify(meta.data.models) === JSON.stringify(["m1", "mX"]), JSON.stringify(meta.data.models));
  check("metaPanel counts runs/turns/toolCalls",
    meta.data.counts.runs === 2 && meta.data.counts.turns === 5 && meta.data.counts.toolCalls === 5,
    JSON.stringify(meta.data.counts));
  check("metaPanel exposes eraBoundary", meta.data.eraBoundary === ERA_BOUNDARY);
  check("metaPanel caveats empty on a populated store", Array.isArray(meta.caveats) && meta.caveats.length === 0);
}

// --- toolsPanel --------------------------------------------------------------

{
  const tp = toolsPanel(analysis, { era: "all", from: "2026-01-01T00:00:00.000Z" });
  const t = tp.data.totals;
  check("toolsPanel totals", t.calls === 5 && t.repeats === 1 && t.errors === 1 && t.outcomeUnknown === 2, JSON.stringify(t));
  check("toolsPanel repeatCategories has all five categories",
    tp.data.repeatCategories.length === 5 &&
    tp.data.repeatCategories.every((c) => typeof c.category === "string" && typeof c.n === "number"),
    JSON.stringify(tp.data.repeatCategories));
  check("repeatCategories sum to repeats",
    tp.data.repeatCategories.reduce((s, c) => s + c.n, 0) === t.repeats);
  check("identical-args identical-result repeat classifies as unchanged",
    tp.data.repeatCategories.find((c) => c.category === "unchanged")?.n === 1,
    JSON.stringify(tp.data.repeatCategories));
  const readFile = tp.data.byTool.find((r) => r.label === "read_file");
  check("byTool shape and percentages",
    readFile && readFile.calls === 2 && readFile.repeats === 1 && readFile.errors === 0 &&
    readFile.repeatPct === 50 && readFile.errorPct === 0, JSON.stringify(readFile));
  check("byModel present (single model)", tp.data.byModel.length === 1 && tp.data.byModel[0].calls === 5);
  check("bySquad splits alpha/beta", tp.data.bySquad.length === 2 &&
    tp.data.bySquad.reduce((s, r) => s + r.calls, 0) === 5);
  const warn = tp.caveats.find((c) => c.code === "outcome_unknown");
  check("outcome_unknown is warn when share > 10%", warn?.level === "warn" && warn.count === 2, JSON.stringify(warn));
  check("toolsPanel returns normalized filters", tp.filters.era === "all" && typeof tp.filters.from === "string");

  const post = toolsPanel(analysis, { era: "post", from: "2026-01-01T00:00:00.000Z" });
  check("era post restricts tool calls to the post-boundary three",
    post.data.totals.calls === 3 && post.data.totals.repeats === 1 && post.data.totals.errors === 1 &&
    post.data.totals.outcomeUnknown === 0, JSON.stringify(post.data.totals));
  check("no outcome_unknown caveat when nothing is unknown",
    !post.caveats.some((c) => c.code === "outcome_unknown"));
}

// --- qualityPanel -------------------------------------------------------------

{
  const qp = qualityPanel(analysis, { era: "all", from: "2026-01-01T00:00:00.000Z" });
  const d = qp.data;
  check("unpricedByModel lists the unpriced model only",
    JSON.stringify(d.unpricedByModel) === JSON.stringify([{ model: "mX", turns: 1 }]), JSON.stringify(d.unpricedByModel));
  check("attributionMix splits in_window / after_end",
    d.attributionMix.length === 2 &&
    d.attributionMix.some((r) => r.attribution === "in_window" && r.turns === 4) &&
    d.attributionMix.some((r) => r.attribution === "after_end" && r.turns === 1),
    JSON.stringify(d.attributionMix));
  check("contested counts the run-scoped claim and its share",
    d.contested.rows === 1 && d.contested.share === 20, JSON.stringify(d.contested));
  // Two collapsed islands: /post.jsonl@20 (two per-message lines) and
  // /shared.jsonl@5 — the two claimant lines of one call are identical tuples
  // at the same offset, so the message layer folds them too (same interaction
  // the canonical contract test asserts as line_count 2 on a contested call).
  check("lineCollapsed counts both collapsed islands and their share",
    d.lineCollapsed.rows === 2 && d.lineCollapsed.share === 40, JSON.stringify(d.lineCollapsed));
  check("canonCoverage rows/nullCanon/pct",
    d.canonCoverage.rows === 5 && d.canonCoverage.nullCanon === 1 && d.canonCoverage.pct === 80,
    JSON.stringify(d.canonCoverage));
  check("outcomeUnknown rows and share (40%)",
    d.outcomeUnknown.rows === 2 && d.outcomeUnknown.share === 40, JSON.stringify(d.outcomeUnknown));
  check("openIssues lists only unresolved issues",
    JSON.stringify(d.openIssues) === JSON.stringify([{ issue_type: "pricing_missing", n: 1 }]),
    JSON.stringify(d.openIssues));
  const unpriced = qp.caveats.find((c) => c.code === "unpriced");
  check("unpriced caveat is crit with the turn count", unpriced?.level === "crit" && unpriced.count === 1, JSON.stringify(unpriced));
  const collapsed = qp.caveats.find((c) => c.code === "line_collapsed");
  check("line_collapsed caveat is warn with the post-rewrite wording",
    collapsed?.level === "warn" && collapsed.count === 2 &&
    /legacy per-line history/.test(collapsed.message) &&
    /transcript no longer on disk/.test(collapsed.message) &&
    /FOC-381 rewrite could not re-derive/.test(collapsed.message),
    JSON.stringify(collapsed));
  check("contested caveat is informational", qp.caveats.find((c) => c.code === "contested")?.level === "info");
}

// --- views_missing -------------------------------------------------------------

{
  const bare = new DatabaseSync(join(temp, "bare.sqlite"));
  for (const [name, fn] of [
    ["metaPanel", () => metaPanel(bare)],
    ["toolsPanel", () => toolsPanel(bare, {})],
    ["qualityPanel", () => qualityPanel(bare, {})],
    ["costPanel", () => costPanel(bare, {})],
    ["handoffsPanel", () => handoffsPanel(bare, {})],
  ]) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(`${name} fails with views_missing on a db without the views`, err?.code === "views_missing", err?.message);
  }
  bare.close();
}

// ---------------------------------------------------------------------------
// costPanel + handoffsPanel — a dedicated fixture store with known numbers.
// Every usage row uses its own source_path (except the deliberate two-line
// per-message island), so each row is exactly one canonical island.
// ---------------------------------------------------------------------------

const temp2 = mkdtempSync(join(tmpdir(), "telemetry-analysis-cost-test-"));
const costPath = join(temp2, "c.sqlite");
const cdb = openTelemetryDb(costPath);
ensureViews(cdb);

cdb.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
const insertRun2 = cdb.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`);
insertRun2.run("runA", "alpha", "2026-09-01T10:00:00.000Z", "2026-09-01T12:00:00.000Z", "ps1", "completed");
insertRun2.run("runB", "beta", "2026-09-08T10:00:00.000Z", "2026-09-08T12:00:00.000Z", "ps1", "completed");
insertRun2.run("runC", "alpha", "2026-09-15T10:00:00.000Z", "2026-09-15T12:00:00.000Z", "ps1", "completed");

const usage2 = cdb.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const cost2 = cdb.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

// runA: priced lead with cache traffic (cacheHitPct), priced worker-1.
usage2.run("u1", "runA", "a1", "_lead", "m1", "2026-09-01T10:30:00.000Z", 100, 50, 200, 10, "/c1.jsonl", 10, "2026-09-01T10:30:00.000Z");
usage2.run("u2", "runA", "a2", "worker-1", "m1", "2026-09-01T11:00:00.000Z", 50, 25, 0, 0, "/c2.jsonl", 10, "2026-09-01T11:00:00.000Z");
// runB: UNPRICED lead (m2 in no price set) + an ephemeral agent-% handle.
usage2.run("u3", "runB", "b1", "_lead", "m2", "2026-09-08T10:30:00.000Z", 60, 30, 0, 0, "/c3.jsonl", 10, "2026-09-08T10:30:00.000Z");
usage2.run("u4", "runB", "b2", "agent-abc123", "m1", "2026-09-08T11:00:00.000Z", 40, 20, 0, 0, "/c4.jsonl", 10, "2026-09-08T11:00:00.000Z");
// runC: worker-2 twice — once pre-boundary (09-15), once post (09-22).
usage2.run("u5", "runC", "c1", "worker-2", "m1", "2026-09-15T10:30:00.000Z", 10, 5, 0, 0, "/c5.jsonl", 10, "2026-09-15T10:30:00.000Z");
usage2.run("u6", "runC", "c2", "worker-2", "m1", "2026-09-22T10:30:00.000Z", 10, 5, 0, 0, "/c6.jsonl", 10, "2026-09-22T10:30:00.000Z");
// runA: a two-line per-message island (identical token tuples, 10 s apart) —
// the view collapses it into one canonical row with line_count 2.
usage2.run("u7a", "runA", "a3", "_lead", "m1", "2026-09-01T11:30:00.000Z", 200, 100, 0, 0, "/msg.jsonl", 10, "2026-09-01T11:30:00.000Z");
usage2.run("u7b", "runA", "a3", "_lead", "m1", "2026-09-01T11:30:10.000Z", 200, 100, 0, 0, "/msg.jsonl", 20, "2026-09-01T11:30:10.000Z");

cost2.run("runA", "u1", "ps1", 1.0);
cost2.run("runA", "u2", "ps1", 0.5);
cost2.run("runB", "u4", "ps1", 0.2);
cost2.run("runC", "u5", "ps1", 0.1);
cost2.run("runC", "u6", "ps1", 0.1);
cost2.run("runA", "u7a", "ps1", 0.3);
cost2.run("runA", "u7b", "ps1", 0.3);

// delegation_links — historical shape: the child_* numbers are NULL and the
// panel must derive them from canonical_usage. dl2 repeats dl1's (run, child)
// pair on purpose (double-counting check).
const link = cdb.prepare(`INSERT INTO delegation_links
  (delegation_id, parent_run_id, parent_agent, child_agent, child_model,
   child_transcript, observed_at, child_tokens, child_cost_usd, child_turns,
   source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
link.run("dl1", "runA", "lead-1", "worker-1", "m1", "/w1.jsonl", "2026-09-01T11:00:00.000Z", null, null, null, "test", "2026-09-01T11:00:00.000Z");
link.run("dl2", "runA", "lead-1", "worker-1", "m1", "/w1.jsonl", "2026-09-01T11:10:00.000Z", null, null, null, "test", "2026-09-01T11:10:00.000Z");
link.run("dl3", "runB", "lead-2", "ghost", "m1", "/ghost.jsonl", "2026-09-08T10:30:00.000Z", null, null, null, "test", "2026-09-08T10:30:00.000Z");
link.run("dl4", "runC", "lead-3", "worker-2", "m9", "/w2.jsonl", "2026-09-15T10:30:00.000Z", null, null, null, "test", "2026-09-15T10:30:00.000Z");

cdb.close();
const analysis2 = openAnalysisDb(costPath);

const usdIs = (actual, expected) => Math.abs(actual - expected) < 1e-9;
const ALL = { era: "all", from: "2026-01-01T00:00:00.000Z" };

// Expected canonical shape (7 rows): u1 360 tok/$1.0, u2 75/$0.5, u3 90/unpriced,
// u4 60/$0.2, u5 15/$0.1, u6 15/$0.1, msg-island 300 tok/$0.3 (line_count 2).
{
  const cp = costPanel(analysis2, ALL);
  const t = cp.data.totals;
  check("costPanel totals (turns/usd/unpriced/tokens)",
    t.turns === 7 && usdIs(t.usd, 2.2) && t.unpriced === 1 && t.tokens === 915, JSON.stringify(t));
  check("costPanel token columns sum to tokens",
    t.inputTokens === 470 && t.outputTokens === 235 && t.cacheReadTokens === 200 && t.cacheCreationTokens === 10,
    JSON.stringify(t));
  check("costPanel cacheHitPct = 100*200/670", t.cacheHitPct === 29.9, `got ${t.cacheHitPct}`);
  check("costPanel returns normalized filters", cp.filters.era === "all" && cp.filters.squad === null);

  const alpha = cp.data.bySquad.find((r) => r.label === "alpha");
  const beta = cp.data.bySquad.find((r) => r.label === "beta");
  check("bySquad alpha: 5 turns, $2.0, 765 tokens", alpha &&
    alpha.turns === 5 && usdIs(alpha.usd, 2.0) && alpha.tokens === 765, JSON.stringify(alpha));
  check("bySquad beta: 2 turns, $0.2, unpriced 1", beta &&
    beta.turns === 2 && usdIs(beta.usd, 0.2) && beta.unpriced === 1 && beta.tokens === 150, JSON.stringify(beta));
  check("bySquad sorted by usd desc", cp.data.bySquad[0].label === "alpha", JSON.stringify(cp.data.bySquad.map((r) => r.label)));

  const m1 = cp.data.byModel.find((r) => r.label === "m1");
  const m2 = cp.data.byModel.find((r) => r.label === "m2");
  check("byModel m1: 6 turns, $2.2", m1 && m1.turns === 6 && usdIs(m1.usd, 2.2), JSON.stringify(m1));
  check("byModel m2: unpriced, usd 0 (not folded)", m2 && m2.turns === 1 && usdIs(m2.usd, 0) && m2.unpriced === 1, JSON.stringify(m2));

  check("byRole excludes _lead and agent-% handles, top by usd",
    JSON.stringify(cp.data.byRole.map((r) => r.label)) === JSON.stringify(["worker-1", "worker-2"]) &&
    cp.data.byRole[0].turns === 1 && usdIs(cp.data.byRole[0].usd, 0.5) &&
    cp.data.byRole[1].turns === 2 && usdIs(cp.data.byRole[1].usd, 0.2),
    JSON.stringify(cp.data.byRole));

  const weeks = cp.data.byWeek.map((r) => r.label);
  check("byWeek ascending and groups the four weeks",
    weeks.length === 4 && weeks.every((w, i) => i === 0 || weeks[i - 1] < w) &&
    cp.data.byWeek.map((r) => r.turns).join(",") === "3,2,1,1",
    JSON.stringify(cp.data.byWeek));

  const [lead, sub] = cp.data.leadVsSubagent;
  check("leadVsSubagent: lead 3 turns $1.3, sub 4 turns $0.9",
    lead.label === "lead" && lead.turns === 3 && usdIs(lead.usd, 1.3) &&
    sub.label === "subagent" && sub.turns === 4 && usdIs(sub.usd, 0.9),
    JSON.stringify(cp.data.leadVsSubagent));
  check("leadVsSubagent shares sum to 1 (4 decimals)",
    usdIs(lead.usdShare + sub.usdShare, 1) && lead.usdShare === 0.5909 && sub.usdShare === 0.4091,
    `${lead.usdShare} + ${sub.usdShare}`);

  const unpricedCav = cp.caveats.find((c) => c.code === "unpriced");
  check("unpriced caveat is crit with the count, usd excludes it",
    unpricedCav?.level === "crit" && unpricedCav.count === 1 && usdIs(t.usd, 2.2), JSON.stringify(unpricedCav));
  const collapsedCav = cp.caveats.find((c) => c.code === "line_collapsed_in_scope");
  check("line_collapsed_in_scope caveat fires with the post-rewrite wording",
    collapsedCav?.level === "warn" && collapsedCav.count === 1 &&
    /legacy per-line history/.test(collapsedCav.message) &&
    /transcript no longer on disk/.test(collapsedCav.message) &&
    /FOC-381 rewrite could not re-derive/.test(collapsedCav.message),
    JSON.stringify(collapsedCav));
  check("no empty caveat on a populated window", !cp.caveats.some((c) => c.code === "empty"));

  const betaOnly = costPanel(analysis2, { ...ALL, squad: "beta" });
  check("squad filter changes cost totals (beta only)",
    betaOnly.data.totals.turns === 2 && usdIs(betaOnly.data.totals.usd, 0.2) && betaOnly.data.totals.unpriced === 1,
    JSON.stringify(betaOnly.data.totals));

  const postOnly = costPanel(analysis2, { era: "post", from: "2026-01-01T00:00:00.000Z" });
  check("era post leaves the single post-boundary turn",
    postOnly.data.totals.turns === 1 && usdIs(postOnly.data.totals.usd, 0.1) &&
    !postOnly.caveats.some((c) => c.code === "unpriced"),
    JSON.stringify(postOnly.data.totals));

  const empty = costPanel(analysis2, { era: "all", from: "2027-01-01T00:00:00.000Z", to: "2027-01-02T00:00:00.000Z" });
  check("empty window: zero totals, cacheHitPct null, empty caveat",
    empty.data.totals.turns === 0 && empty.data.totals.cacheHitPct === null &&
    empty.caveats.some((c) => c.code === "empty" && c.level === "info"),
    JSON.stringify(empty.data.totals));
}

// --- handoffsPanel -------------------------------------------------------------

{
  const hp = handoffsPanel(analysis2, ALL);
  check("handoffs totals: 4 links, 3 resolved, 1 unresolved",
    hp.data.totals.links === 4 && hp.data.totals.resolved === 3 && hp.data.totals.unresolved === 1,
    JSON.stringify(hp.data.totals));
  check("handoffs returns normalized filters", hp.filters.era === "all" && typeof hp.filters.from === "string");

  const dupPair = hp.data.byPair.find((p) => p.child === "worker-1");
  check("byPair: two links to the same child, usage counted ONCE",
    dupPair && dupPair.parent === "lead-1" && dupPair.childModel === "m1" &&
    dupPair.links === 2 && dupPair.childTurns === 1 && usdIs(dupPair.childUsd, 0.5) && dupPair.childTokens === 75,
    JSON.stringify(dupPair));
  const ghostPair = hp.data.byPair.find((p) => p.child === "ghost");
  check("byPair: unresolved child has zero usage",
    ghostPair && ghostPair.links === 1 && ghostPair.childTurns === 0 && usdIs(ghostPair.childUsd, 0),
    JSON.stringify(ghostPair));
  const w2Pair = hp.data.byPair.find((p) => p.child === "worker-2");
  check("byPair: worker-2 carries both its turns",
    w2Pair && w2Pair.links === 1 && w2Pair.childTurns === 2 && usdIs(w2Pair.childUsd, 0.2) && w2Pair.childTokens === 30,
    JSON.stringify(w2Pair));
  check("byPair sorted by links desc, top 30",
    hp.data.byPair[0].links === 2 && hp.data.byPair.length === 3, JSON.stringify(hp.data.byPair.map((p) => p.links)));

  const alphaSq = hp.data.bySquad.find((s) => s.label === "alpha");
  const betaSq = hp.data.bySquad.find((s) => s.label === "beta");
  check("bySquad: alpha 3 links, childUsd 0.7 (worker-1 once + worker-2)",
    alphaSq && alphaSq.links === 3 && usdIs(alphaSq.childUsd, 0.7), JSON.stringify(alphaSq));
  check("bySquad: beta 1 link, no child usage, sorted by links desc",
    betaSq && betaSq.links === 1 && usdIs(betaSq.childUsd, 0) && hp.data.bySquad[0].label === "alpha",
    JSON.stringify(hp.data.bySquad));

  const warn = hp.caveats.find((c) => c.code === "unresolved_children");
  check("unresolved_children caveat is warn with count and share",
    warn?.level === "warn" && warn.count === 1 && /25%/.test(warn.message), JSON.stringify(warn));
  const scope = hp.caveats.find((c) => c.code === "handoff_child_scope");
  check("handoff_child_scope caveat is info and states the whole-run scope",
    scope?.level === "info" && /whole run/.test(scope.message) && /cost panel/.test(scope.message),
    JSON.stringify(scope));
  check("no empty caveat on a populated window", !hp.caveats.some((c) => c.code === "empty"));

  const betaOnly = handoffsPanel(analysis2, { ...ALL, squad: "beta" });
  check("squad filter rides runs.squad",
    betaOnly.data.totals.links === 1 && betaOnly.data.totals.resolved === 0 && betaOnly.data.totals.unresolved === 1,
    JSON.stringify(betaOnly.data.totals));

  const m9Only = handoffsPanel(analysis2, { ...ALL, model: "m9" });
  check("model filter rides child_model (m9 → dl4 only)",
    m9Only.data.totals.links === 1 && m9Only.data.totals.resolved === 1 &&
    m9Only.data.byPair[0]?.child === "worker-2", JSON.stringify(m9Only.data.totals));
  const m1Only = handoffsPanel(analysis2, { ...ALL, model: "m1" });
  check("model filter m1 keeps the three m1 links",
    m1Only.data.totals.links === 3 && m1Only.data.totals.resolved === 2, JSON.stringify(m1Only.data.totals));

  const later = handoffsPanel(analysis2, { era: "all", from: "2026-09-10T00:00:00.000Z" });
  check("time window binds to delegation_links.observed_at (only dl4 survives)",
    later.data.totals.links === 1 && later.data.totals.resolved === 1 &&
    later.data.byPair[0]?.child === "worker-2", JSON.stringify(later.data.totals));

  const none = handoffsPanel(analysis2, { era: "all", from: "2027-01-01T00:00:00.000Z", to: "2027-01-02T00:00:00.000Z" });
  check("empty window: zero links, empty caveat",
    none.data.totals.links === 0 && none.caveats.some((c) => c.code === "empty" && c.level === "info"),
    JSON.stringify(none.data.totals));
}

// --- synthetic placeholder rows ------------------------------------------------
// Claude Code placeholder usage (sentinel model, 0 tokens, cost NULL) must
// never feed the unpriced alarm, while a genuinely unpriced real model must
// still count. Dedicated store so the known-number fixtures above stay stable.

const temp3 = mkdtempSync(join(tmpdir(), "telemetry-analysis-synthetic-test-"));
const synthPath = join(temp3, "s.sqlite");
const sdb = openTelemetryDb(synthPath);
ensureViews(sdb);

sdb.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hashS", "2026-09-01T00:00:00.000Z", "test");
sdb.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`)
  .run("runS", "gamma", "2026-09-10T10:00:00.000Z", "2026-09-10T12:00:00.000Z", "ps1", "completed");

const usageS = sdb.prepare(`INSERT INTO usage_facts
  (usage_id, run_id, session_id, agent_key, model, observed_at,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   source_path, source_offset, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const costS = sdb.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?,?,?,?)");

// Placeholder shapes exactly as Claude Code writes them: sentinel model (both
// spellings isSyntheticModel accepts), 0 tokens, no cost row.
usageS.run("us1", "runS", "g1", "_lead", "<synthetic>", "2026-09-10T10:30:00.000Z", 0, 0, 0, 0, "/s1.jsonl", 10, "2026-09-10T10:30:00.000Z");
usageS.run("us2", "runS", "g1", "_lead", "synthetic", "2026-09-10T10:40:00.000Z", 0, 0, 0, 0, "/s2.jsonl", 10, "2026-09-10T10:40:00.000Z");
// A genuinely unpriced REAL model (mX is in no price set) — must still count.
usageS.run("us3", "runS", "g2", "worker-1", "mX", "2026-09-10T11:00:00.000Z", 5, 5, 0, 0, "/s3.jsonl", 10, "2026-09-10T11:00:00.000Z");
// A priced real model for the money side.
usageS.run("us4", "runS", "g3", "worker-2", "m1", "2026-09-10T11:30:00.000Z", 10, 5, 0, 0, "/s4.jsonl", 10, "2026-09-10T11:30:00.000Z");
costS.run("runS", "us4", "ps1", 1.0);
// NULL model WITH tokens: a real call whose model was lost — tokens-aware
// synthetic must NOT swallow it; it is unpriced under the label "(none)".
usageS.run("us5", "runS", "g4", "worker-3", null, "2026-09-10T12:00:00.000Z", 5, 5, 0, 0, "/s5.jsonl", 10, "2026-09-10T12:00:00.000Z");
// NULL model with NO tokens: the placeholder shape — synthetic, like a sentinel.
usageS.run("us6", "runS", "g5", "worker-4", null, "2026-09-10T12:30:00.000Z", 0, 0, 0, 0, "/s6.jsonl", 10, "2026-09-10T12:30:00.000Z");

sdb.close();
const analysis3 = openAnalysisDb(synthPath);

{
  const SYN = { era: "all", from: "2026-01-01T00:00:00.000Z" };
  const cp = costPanel(analysis3, SYN);
  const t = cp.data.totals;
  check("synthetic: placeholders still count as turns/tokens (rows of the view)",
    t.turns === 6 && t.tokens === 35, JSON.stringify(t));
  check("synthetic: totals report them separately, unpriced keeps mX + the tokenful NULL-model row",
    t.unpriced === 2 && usdIs(t.usd, 1.0) && t.synthetic === 3, JSON.stringify(t));
  // A NULL-model row WITH tokens is NOT synthetic — it was a real call and
  // lands in unpriced, never in the synthetic count.
  check("synthetic: tokenful NULL-model row counts as unpriced, not synthetic",
    t.synthetic === 3 && t.unpriced === 2, JSON.stringify(t));

  const mx = cp.data.byModel.find((r) => r.label === "mX");
  const synthRow = cp.data.byModel.find((r) => r.label === "<synthetic>");
  const noneRow = cp.data.byModel.find((r) => r.label === "(none)");
  check("synthetic: breakdown unpriced drops placeholders, keeps mX",
    mx && mx.turns === 1 && mx.unpriced === 1 &&
    synthRow && synthRow.turns === 1 && synthRow.unpriced === 0,
    JSON.stringify(cp.data.byModel));
  check("synthetic: NULL-model rows group under the label \"(none)\" with the tokenful one unpriced",
    noneRow && noneRow.turns === 2 && noneRow.unpriced === 1,
    JSON.stringify(cp.data.byModel));

  const unpricedCav = cp.caveats.find((c) => c.code === "unpriced");
  check("synthetic: cost unpriced caveat counts the real model + the tokenful NULL-model row",
    unpricedCav?.level === "crit" && unpricedCav.count === 2, JSON.stringify(unpricedCav));
  const synCav = cp.caveats.find((c) => c.code === "synthetic_excluded");
  check("synthetic: cost panel reports placeholders via an info caveat",
    synCav?.level === "info" && synCav.count === 3 && /synthetic turns/.test(synCav.message),
    JSON.stringify(synCav));

  const qp = qualityPanel(analysis3, SYN);
  check("synthetic: quality unpricedByModel lists mX and \"(none)\"",
    JSON.stringify(qp.data.unpricedByModel) === JSON.stringify([{ model: "(none)", turns: 1 }, { model: "mX", turns: 1 }]),
    JSON.stringify(qp.data.unpricedByModel));
  const qUnpriced = qp.caveats.find((c) => c.code === "unpriced");
  check("synthetic: quality unpriced caveat counts the real model + the tokenful NULL-model row",
    qUnpriced?.level === "crit" && qUnpriced.count === 2, JSON.stringify(qUnpriced));
  const qSyn = qp.caveats.find((c) => c.code === "synthetic_excluded");
  check("synthetic: quality panel reports the same info caveat",
    qSyn?.level === "info" && qSyn.count === 3, JSON.stringify(qSyn));

  // N = 0: the known-number store holds no placeholders — the caveat must be
  // absent there, not fire vacuously.
  check("synthetic: no synthetic_excluded caveat when N = 0",
    !costPanel(analysis2, ALL).caveats.some((c) => c.code === "synthetic_excluded") &&
    !qualityPanel(analysis2, ALL).caveats.some((c) => c.code === "synthetic_excluded"));
}

analysis3.close();
rmSync(temp3, { recursive: true, force: true });

analysis2.close();
rmSync(temp2, { recursive: true, force: true });

// --- source guard: no raw usage sums ------------------------------------------

{
  const src = readFileSync(new URL("./telemetry-analysis.mjs", import.meta.url), "utf8");
  check("source guard: analysis never aggregates the raw usage table",
    !/from\s+usage_facts/i.test(src));
}

// -----------------------------------------------------------------------------

analysis.close();
rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
// Tests for scripts/team-model.mjs (FOC-791 slice A) — the /api/team payload
// against a seeded telemetry store.
//
// Two layers, per the plan's AC1:
//   1. unit layer — `buildTeam` over the fixture turns (loaded from the fixture
//      DB) asserting every contract field, the 5 % bench rule, the insight
//      rules, the period windows, the group repo filter and the ticket scope;
//   2. AC1 — the SAME numbers recomputed with a DIRECT SQL query over
//      `canonical_usage` on the fixture DB (picks = COUNT(DISTINCT
//      COALESCE(session_id, run_id|observed_at|agent_key|model), i.e. a NULL
//      session is its own pick, cost = SUM(cost_usd) per (squad, agent_key))
//      and compared to the model's output: the dashboard must not invent a
//      second truth.
//
// `seedTeamFixture(dbPath, { now })` (exported for slice D's acceptance
// instance and the routes test) inserts runs / usage_facts / cost_facts /
// run_task_links rows directly — one usage row per priced message, each with
// its own source_path and message_id, so the canonical view's per-message
// projection keeps every row (rn=1). `seedRegistryFixture(stateHome)` seeds the
// Supervisor registry children the ticket scope reads.
//
// Isolation: one mkdtemp dir, explicit DB paths, no ports, no network, no
// real-repo-path writes. `now` is pinned, never Date.now().

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openTelemetryDb } from "./telemetry-store.mjs";
import { loadPrimaryTaskLinks } from "./delegation-outcomes.mjs";
import { loadTeamTurns } from "./team-routes.mjs";
import { buildTeam, periodWindow, lineupPlacement, insightLine } from "./team-model.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

// ── the fixture definition ───────────────────────────────────────────────────

// 2026-10-18T12:00Z; the 30d window opens 2026-09-18T12:00Z, the 7d window
// 2026-10-11T12:00Z. Runs are dated so 30d sees six, 7d sees two
// (dev, test) and `all` sees seven (run-dev-old is 60+ days back).
export const NOW = Date.parse("2026-10-18T12:00:00.000Z");

const IMPL_MODEL = "z-ai/glm-5.3-flash";
const LEAD_MODEL = "z-ai/glm-5.2";

// role — agent_key; 40 implementer sessions vs 1 debugger session puts the
// debugger at 1/41 ≈ 2.4 % of picks (bench) while its cost stays 31 % of the
// squad's — the "rare but expensive" insight row, and the 5 % rule in one.
const TURN_SPECS = [
  // run-dev-1 (dev, FOC-100) — the headline squad
  ...Array.from({ length: 40 }, (_, i) => ({ runId: "run-dev-1", session: `sess-i${i + 1}`, agentKey: "implementer", model: IMPL_MODEL, ts: "2026-10-15T09:00:00.000Z", cost: 1 })),
  { runId: "run-dev-1", session: "sess-d1", agentKey: "debugger", model: IMPL_MODEL, ts: "2026-10-15T09:30:00.000Z", cost: 20 },
  { runId: "run-dev-1", session: "sess-l1", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-15T08:10:00.000Z", cost: 2.5 },
  { runId: "run-dev-1", session: "sess-l2", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-15T10:10:00.000Z", cost: 2.5 },
  // run-plan-1 (plan, FOC-100) — inside 30d, outside 7d
  { runId: "run-plan-1", session: "sess-p1", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-10T09:00:00.000Z", cost: 1 },
  { runId: "run-plan-1", session: "sess-p2", agentKey: "decomposer", model: IMPL_MODEL, ts: "2026-10-10T09:20:00.000Z", cost: 0.5 },
  { runId: "run-plan-1", session: "sess-p3", agentKey: "decomposer", model: IMPL_MODEL, ts: "2026-10-10T09:40:00.000Z", cost: 0.5 },
  // run-review-1 (review, FOC-300 → repo "office") — outside 7d
  { runId: "run-review-1", session: "sess-r1", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-05T09:00:00.000Z", cost: 1 },
  { runId: "run-review-1", session: "sess-r2", agentKey: "first-pass", model: IMPL_MODEL, ts: "2026-10-05T09:20:00.000Z", cost: 0.75 },
  { runId: "run-review-1", session: "sess-r3", agentKey: "first-pass", model: IMPL_MODEL, ts: "2026-10-05T09:40:00.000Z", cost: 0.75 },
  // a turn with NO session id: its own pick (D1) — the NULL-session case AC1 must count
  { runId: "run-review-1", session: null, agentKey: "first-pass", model: IMPL_MODEL, ts: "2026-10-05T10:00:00.000Z", cost: 0.5 },
  // run-test-1 (test, FOC-200) — inside 7d; the ticket-scope run
  { runId: "run-test-1", session: "sess-t1", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-16T09:00:00.000Z", cost: 1 },
  { runId: "run-test-1", session: "sess-t2", agentKey: "runner", model: IMPL_MODEL, ts: "2026-10-16T09:20:00.000Z", cost: 0.5 },
  { runId: "run-test-1", session: "sess-t3", agentKey: "runner", model: IMPL_MODEL, ts: "2026-10-16T09:40:00.000Z", cost: 0.5 },
  // run-sup-1 (supervisor, FOC-100) — the Supervisor block, not a line-up card
  { runId: "run-sup-1", session: "sess-s1", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-02T09:00:00.000Z", cost: 3 },
  { runId: "run-sup-1", session: "sess-s2", agentKey: "_lead", model: LEAD_MODEL, ts: "2026-10-02T10:00:00.000Z", cost: 3 },
  // run-dev-old (dev, FOC-100) — outside every bounded window, visible in `all`
  { runId: "run-dev-old", session: "sess-old", agentKey: "implementer", model: IMPL_MODEL, ts: "2026-08-10T09:00:00.000Z", cost: 9 },
];

const LINK_SPECS = [
  { runId: "run-dev-1", taskId: "FOC-100", validFrom: "2026-10-15T08:00:00.000Z" },
  { runId: "run-plan-1", taskId: "FOC-100", validFrom: "2026-10-10T08:00:00.000Z" },
  { runId: "run-review-1", taskId: "FOC-300", validFrom: "2026-10-05T08:00:00.000Z" },
  { runId: "run-test-1", taskId: "FOC-200", validFrom: "2026-10-16T08:00:00.000Z" },
  { runId: "run-sup-1", taskId: "FOC-100", validFrom: "2026-10-02T08:00:00.000Z" },
  { runId: "run-dev-old", taskId: "FOC-100", validFrom: "2026-08-01T08:00:00.000Z" },
];

// Offline facts the model test passes in (the route derives the repo column
// itself from config/projects.json via repoPrefixMap — unit-tested there).
const TICKET_FACTS = [
  { taskId: "FOC-100", repo: "linear-agents" },
  { taskId: "FOC-200", repo: "linear-agents" },
  { taskId: "FOC-300", repo: "office" },
];

// The squad config, as a fixture — buildTeam is pure, so the test owns it. The
// roles mirror agents/<squad>/agents/*.md; `refactorer`/`explorer` are never
// picked anywhere, which the ran=false zeros path must show.
const SQUAD_CONFIG = {
  squads: {
    plan: { lead: LEAD_MODEL, agents: { decomposer: { model: IMPL_MODEL }, researcher: { model: IMPL_MODEL } } },
    dev: { lead: LEAD_MODEL, agents: { implementer: { model: IMPL_MODEL }, debugger: { model: IMPL_MODEL }, refactorer: { model: IMPL_MODEL } } },
    review: { lead: LEAD_MODEL, agents: { "first-pass": { model: IMPL_MODEL } } },
    test: { lead: LEAD_MODEL, agents: { runner: { model: IMPL_MODEL }, explorer: { model: IMPL_MODEL } } },
    supervisor: { lead: LEAD_MODEL, agents: {} },
  },
};

/**
 * Seed the telemetry DB at `dbPath` (created fresh). Returns { now, turns,
 * links, squadConfig, ticketFacts } — everything `buildTeam` needs, loaded the
 * same way the route loads it (turns straight from the store).
 */
export function seedTeamFixture(dbPath, { now = NOW } = {}) {
  const db = openTelemetryDb(dbPath);
  try {
    db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?, ?, ?, ?)")
      .run("ps-fixture", "hash-fixture", new Date(now).toISOString(), "fixture");
    const runs = [
      { runId: "run-dev-1", squad: "dev", startedAt: "2026-10-15T08:00:00.000Z" },
      { runId: "run-plan-1", squad: "plan", startedAt: "2026-10-10T08:00:00.000Z" },
      { runId: "run-review-1", squad: "review", startedAt: "2026-10-05T08:00:00.000Z" },
      { runId: "run-test-1", squad: "test", startedAt: "2026-10-16T08:00:00.000Z" },
      { runId: "run-sup-1", squad: "supervisor", startedAt: "2026-10-02T08:00:00.000Z" },
      { runId: "run-dev-old", squad: "dev", startedAt: "2026-08-10T08:00:00.000Z" },
    ];
    for (const r of runs) {
      db.prepare("INSERT INTO runs (run_id, squad, source, started_at, price_set_id, updated_at) VALUES (?, ?, 'fixture', ?, 'ps-fixture', ?)")
        .run(r.runId, r.squad, r.startedAt, new Date(now).toISOString());
    }
    for (const taskId of ["FOC-100", "FOC-200", "FOC-300"]) {
      db.prepare("INSERT INTO work_items (task_id, provider, workspace, identifier, created_at) VALUES (?, 'linear', 'joi', ?, ?)")
        .run(taskId, taskId, new Date(now).toISOString());
    }
    for (const l of LINK_SPECS) {
      db.prepare("INSERT INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, created_at) VALUES (?, ?, ?, 'primary', ?, NULL, 'fixture', 1, ?)")
        .run(`link-${l.runId}`, l.runId, l.taskId, l.validFrom, new Date(now).toISOString());
    }
    TURN_SPECS.forEach((t, i) => {
      const usageId = `usage-${String(i).padStart(3, "0")}`;
      const sourcePath = join(dbPath, "..", `t-${i}.jsonl`); // one partition per message row → rn=1
      db.prepare(`INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
                  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                  source_path, source_offset, created_at, message_id)
                  VALUES (?, ?, ?, ?, ?, ?, 100, 50, 300, 40, ?, 0, ?, ?)`)
        .run(usageId, t.runId, t.session, t.agentKey, t.model, t.ts, sourcePath, t.ts, `msg-${i}`);
      db.prepare("INSERT INTO cost_facts (run_id, usage_id, price_set_id, cost_usd) VALUES (?, ?, 'ps-fixture', ?)").run(t.runId, usageId, t.cost);
    });
  } finally {
    db.close();
  }
  return { now, turns: TURN_SPECS, links: LINK_SPECS, squadConfig: SQUAD_CONFIG, ticketFacts: TICKET_FACTS };
}

/**
 * Seed a Supervisor state home with the registry children the ticket scope
 * reads (run-test-1 → FOC-200 exited recently, run-dev-1 → FOC-100 running).
 */
export function seedRegistryFixture(stateHome) {
  const run = (runId, registry, triage) => {
    mkdirSync(join(stateHome, runId), { recursive: true });
    writeFileSync(join(stateHome, runId, "children.json"), JSON.stringify(registry), "utf8");
    if (triage) writeFileSync(join(stateHome, runId, "triage.json"), JSON.stringify(triage), "utf8");
  };
  run("run-test-1", {
    children: {
      // Ended ONE HOUR before the real clock: the route's collectChildren keeps
      // ended children for 24 h of Date.now(), so a fixed date silently expires.
      "test-1": { childId: "test-1", taskId: "FOC-200", squad: "test", status: "exited", pid: null, endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    },
  }, { issue: "FOC-200" });
  run("run-dev-1", {
    children: {
      "dev-1": { childId: "dev-1", taskId: "FOC-100", squad: "dev", status: "running", pid: null },
    },
  }, { issue: "FOC-100" });
}

// ── shared fixture load ──────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "team-model-"));
const dbPath = join(dir, "telemetry.sqlite");
const fx = seedTeamFixture(dbPath, { now: NOW });
const db = openTelemetryDb(dbPath);
const turns = loadTeamTurns(db);
const links = loadPrimaryTaskLinks(db);
db.close();

const BASE = { turns, links, squadConfig: fx.squadConfig, ticketFacts: fx.ticketFacts, now: NOW };
const overall = buildTeam({ ...BASE, period: "30d", scope: "overall", filters: {} });
const squadOf = (payload, key) => payload.squads.find((s) => s.key === key);
const roleOf = (squad, role) => squad.roles.find((r) => r.role === role);

// ── helpers under direct test ────────────────────────────────────────────────

test("periodWindow bounds 7d/30d/90d and leaves `all` unbounded", () => {
  const w7 = periodWindow("7d", NOW);
  assert.equal(w7.days, 7);
  assert.equal(w7.from, "2026-10-11T12:00:00.000Z");
  const wall = periodWindow("all", NOW);
  assert.equal(wall.from, null);
  assert.equal(wall.days, null);
});

test("lineupPlacement draws the 5 % line", () => {
  assert.equal(lineupPlacement(0.05), "lineup");
  assert.equal(lineupPlacement(0.0499), "bench");
});

// ── the contract (overall scope, 30d) ────────────────────────────────────────

test("payload carries the contract keys", () => {
  assert.deepEqual(
    Object.keys(overall).sort(),
    ["generatedAt", "groundTruth", "period", "scope", "squads", "supervisor", "totals", "filters"].sort(),
  );
  assert.equal(overall.scope, "overall");
  assert.equal(overall.groundTruth, "per-message priced usage (FOC-760/761)");
  assert.deepEqual(overall.period, { from: "2026-09-18T12:00:00.000Z", to: "2026-10-18T12:00:00.000Z", days: 30 });
  assert.deepEqual(overall.filters.supported, ["repo"]);
  assert.deepEqual(overall.filters.unsupported, ["milestone", "type", "epic", "size"]);
});

test("repoFilterAvailable: false lists repo under unsupported, not supported", () => {
  const none = buildTeam({ ...BASE, period: "30d", scope: "overall", filters: {}, repoFilterAvailable: false });
  assert.deepEqual(none.filters.supported, []);
  assert.deepEqual(none.filters.unsupported, ["repo", "milestone", "type", "epic", "size"]);
  // and the default stays the shipped contract
  assert.deepEqual(overall.filters.supported, ["repo"]);
});

test("squads are plan, dev, review, test in that order", () => {
  assert.deepEqual(overall.squads.map((s) => s.key), ["plan", "dev", "review", "test"]);
});

test("dev line-up: lead costShare, picks and the 5 % bench rule", () => {
  const dev = squadOf(overall, "dev");
  assert.equal(dev.ran, true);
  assert.equal(dev.picks, 41); // the lead's own sessions are excluded from squad picks
  assert.equal(dev.sessions, 43); // 40 impl + 1 debug + 2 lead sessions
  assert.equal(dev.costUsd, 65);
  assert.deepEqual(dev.lead, { model: LEAD_MODEL, costUsd: 5, costShare: 0.0769 });
  const impl = roleOf(dev, "implementer");
  assert.deepEqual({ picks: impl.picks, pickShare: impl.pickShare, costUsd: impl.costUsd, costShare: impl.costShare, placement: impl.placement },
    { picks: 40, pickShare: 0.9756, costUsd: 40, costShare: 0.6154, placement: "lineup" });
  const debug = roleOf(dev, "debugger");
  assert.equal(debug.pickShare, 0.0244); // 1/41 < 5 %
  assert.equal(debug.placement, "bench");
  assert.equal(debug.costShare, 0.3077); // rare but expensive
});

test("lead row carries its own picks but no pickShare", () => {
  const lead = roleOf(squadOf(overall, "dev"), "lead");
  assert.deepEqual({ role: lead.role, picks: lead.picks, pickShare: lead.pickShare, placement: lead.placement },
    { role: "lead", picks: 2, pickShare: null, placement: "lead" });
  assert.equal(roleOf(squadOf(overall, "dev"), "lead").costShare, 0.0769);
});

test("insight: top pick, rare-but-expensive, lead share — deterministic", () => {
  assert.equal(squadOf(overall, "dev").insight,
    "implementer is 98 % of picks; debugger is 2 % of picks but 31 % of cost");
  // review: first-pass is 2/2 picks with 1.5/2.5 cost — no rare-expensive, no lead majority
  assert.equal(squadOf(overall, "review").insight, "first-pass is 100 % of picks");
  assert.equal(insightLine({ ran: false, roles: [] }), "");
});

test("totals and supervisor across the window", () => {
  assert.deepEqual(overall.totals, { costUsd: 78, sessions: 54, tasks: 3, runs: 5 });
  assert.deepEqual(overall.supervisor, { model: LEAD_MODEL, costUsd: 6 });
});

test("overallPickShare exists only in group/ticket scopes and quotes the overall share", () => {
  assert.ok(!("overallPickShare" in roleOf(squadOf(overall, "dev"), "implementer")));
  const group = buildTeam({ ...BASE, period: "30d", scope: "group", filters: {} });
  const impl = roleOf(squadOf(group, "dev"), "implementer");
  assert.equal(impl.overallPickShare, 0.9756); // same share: overall IS this scope here
});

test("period windows: 7d greys plan/review (ran=false, config roles with zeros), all adds the old run", () => {
  const w7 = buildTeam({ ...BASE, period: "7d", scope: "overall", filters: {} });
  const plan = squadOf(w7, "plan");
  assert.equal(plan.ran, false);
  assert.deepEqual({ costUsd: plan.costUsd, picks: plan.picks, sessions: plan.sessions }, { costUsd: 0, picks: 0, sessions: 0 });
  assert.deepEqual(plan.roles.map((r) => [r.role, r.picks, r.placement]),
    [["decomposer", 0, "bench"], ["researcher", 0, "bench"]]); // config roles with zeros
  assert.equal(plan.insight, "");
  assert.equal(squadOf(w7, "dev").costUsd, 65);
  assert.equal(squadOf(w7, "test").ran, true); // run-test-1 (Oct 16) is inside 7d
  assert.deepEqual(w7.supervisor, { model: LEAD_MODEL, costUsd: 0 }); // run-sup-1 fell out

  const wall = buildTeam({ ...BASE, period: "all", scope: "overall", filters: {} });
  assert.equal(squadOf(wall, "dev").costUsd, 74); // 65 + the old run's 9
  assert.deepEqual(wall.totals, { costUsd: 87, sessions: 55, tasks: 3, runs: 6 });
});

test("group scope: repo filter keeps only the matching tickets' turns", () => {
  const group = buildTeam({ ...BASE, period: "30d", scope: "group", filters: { repo: "office" } });
  assert.deepEqual(group.filters.applied, { repo: "office" });
  assert.equal(squadOf(group, "review").ran, true); // run-review-1 → FOC-300 → office
  assert.equal(squadOf(group, "dev").ran, false);
  assert.deepEqual(group.totals, { costUsd: 3, sessions: 3, tasks: 1, runs: 1 });

  const none = buildTeam({ ...BASE, period: "30d", scope: "group", filters: { repo: "gantt-pisi" } });
  assert.ok(none.squads.every((s) => !s.ran));
  assert.deepEqual(none.totals, { costUsd: 0, sessions: 0, tasks: 0, runs: 0 });
});

test("group scope: unsupported filters are reported, never silently applied", () => {
  const base = buildTeam({ ...BASE, period: "30d", scope: "group", filters: { repo: "linear-agents" } });
  const group = buildTeam({ ...BASE, period: "30d", scope: "group", filters: { repo: "linear-agents", epic: "FOC-768", size: "L" } });
  assert.deepEqual(group.filters.applied, { repo: "linear-agents" });
  assert.ok(group.filters.unsupported.includes("epic") && group.filters.unsupported.includes("size"));
  assert.deepEqual(group.totals, base.totals); // epic/size did NOT narrow further than repo
});

test("ticket scope: turns of the linked runs, period ignored, children from the registry", () => {
  const children = [
    { runId: "run-test-1", childId: "test-1", taskId: "FOC-200", squad: "test", status: "exited" },
    { runId: "run-dev-1", childId: "dev-1", taskId: "FOC-100", squad: "dev", status: "running" },
  ];
  // FOC-100 owns runs spanning well beyond 7d (run-dev-1, run-plan-1,
  // run-sup-1, run-dev-old). With period=7d the plan squad would be greyed on
  // the overall screen — the ticket scope must still show it: the question is
  // "who worked on THIS ticket", not "who worked lately" (plan D1).
  const ticket = buildTeam({ ...BASE, period: "7d", scope: "ticket", ticket: "FOC-100", filters: {}, registryChildren: children });
  assert.deepEqual(ticket.ticket.runs.sort(), ["run-dev-1", "run-dev-old", "run-plan-1", "run-sup-1"]);
  assert.equal(squadOf(ticket, "plan").ran, true); // the period-ignored rule, visible
  assert.equal(squadOf(ticket, "dev").costUsd, 74); // 65 + the old run's 9
  assert.deepEqual(squadOf(ticket, "dev").children, [{ childId: "dev-1", status: "running", runId: "run-dev-1" }]);
  assert.deepEqual(squadOf(ticket, "test").children, []); // children only in scope, only the ticket's
  assert.equal(ticket.totals.tasks, 1);
  assert.equal(ticket.supervisor.costUsd, 6); // run-sup-1 belongs to FOC-100
  assert.ok(roleOf(squadOf(ticket, "plan"), "decomposer").overallPickShare >= 0);
  // ...and the FOC-200 ticket keeps its own children, newest run first.
  const t200 = buildTeam({ ...BASE, period: "7d", scope: "ticket", ticket: "FOC-200", filters: {}, registryChildren: children });
  assert.deepEqual(squadOf(t200, "test").children, [{ childId: "test-1", status: "exited", runId: "run-test-1" }]);
  assert.deepEqual(t200.ticket, { id: "FOC-200", runs: ["run-test-1"] });
});

// ── AC1: the model agrees with a DIRECT SQL query over canonical_usage ──────

test("AC1: picks/cost per (squad, agent_key) recomputed from canonical_usage match the payload", () => {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sql = check.prepare(`
      SELECT squad, agent_key,
             COUNT(DISTINCT COALESCE(session_id, run_id || '|' || observed_at || '|' || agent_key || '|' || model)) AS picks,
             SUM(cost_usd)              AS cost
      FROM canonical_usage
      WHERE observed_at >= ? AND observed_at < ?
      GROUP BY squad, agent_key
    `);
    const expected = new Map(sql.all(overall.period.from, overall.period.to)
      .map((r) => [`${r.squad}|${r.agent_key}`, { picks: r.picks, cost: Math.round(r.cost * 10_000) / 10_000 }]));

    // Fold the payload back to the same grain.
    const payload = new Map();
    const sup = squadOf(overall, "supervisor");
    assert.ok(!sup, "supervisor is a block, not a squad card");
    for (const s of overall.squads) {
      for (const r of s.roles) {
        // the roles table names the picker "lead"; telemetry names it "_lead"
        payload.set(`${s.key}|${r.role === "lead" ? "_lead" : r.role}`, { picks: r.picks ?? 0, cost: r.costUsd ?? 0 });
      }
    }
    payload.set("supervisor|_lead", { picks: 2, cost: overall.supervisor.costUsd });

    assert.equal(payload.size, expected.size, "same (squad, agent_key) cells");
    for (const [key, want] of expected) {
      const got = payload.get(key);
      assert.ok(got, `payload has ${key}`);
      assert.equal(got.picks, want.picks, `picks ${key}`);
      assert.equal(got.cost, want.cost, `cost ${key}`);
    }
  } finally {
    check.close();
  }
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log(`\nteam-model: ${passed} passed, ${failed} failed`);
try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
if (failed) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}

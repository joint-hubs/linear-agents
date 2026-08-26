// scripts/supervisor-lib.mjs — shared state for the Supervisor's child processes.
//
// Three scripts touch the same run directory (spawn, watch, stop), so the paths,
// the registry schema and the worktree rules live here rather than being
// re-derived three times and drifting.
//
// Layout under .state/supervisor/<runId>/:
//   children.json        the registry (§2.5)
//   children/<id>.jsonl  the raw stream-json tee for one child (§2.7)
//   gates/<gateId>.json  gate records (supervisor-gate.mjs, FOC-122)
//   triage.json          the recorded verdict (FOC-123, read here, never written)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJSON } from "./utils.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// FOC-161 replaced MAX_LIVE_CHILDREN_PER_RUN with a per-node semaphore whose
// limits live in config/graph.json (`nodes.<name>.concurrency`). One source of
// topology truth, and no orphaned constant.
//
// REMOVING THE CONSTANT DID NOT TURN PARALLELISM ON. Every node ships
// `concurrency: 1`, so the semaphore admits exactly what the old guard did, one
// child per node. What changed is WHERE the limit lives and how it is raised:
// editing a number in a committed, reviewed, validated file, rather than by
// nobody, silently, because a constant was deleted. Raising it is a decision
// with a diff.

// The stream-json `system/init` event carries the session_id that IS the child's
// durable identity — without it there is no --resume, so a child we cannot
// identify is worse than no child at all. Fail rather than register a ghost.
export const INIT_TIMEOUT_MS = 30_000;

export const runDir = (runId) => join(ROOT, ".state", "supervisor", runId);
export const registryPath = (runId) => join(runDir(runId), "children.json");
export const triagePath = (runId) => join(runDir(runId), "triage.json");
export const gatesDir = (runId) => join(runDir(runId), "gates");
export const gatePath = (runId, gateId) => join(gatesDir(runId), `${gateId}.json`);
export const verdictsDir = (runId) => join(runDir(runId), "verdicts");
export const verdictPath = (runId, taskId, round) =>
  join(verdictsDir(runId), `${String(taskId).toLowerCase()}-round${round}.json`);
export const teeRelPath = (childId) => join("children", `${childId}.jsonl`);
export const teeAbsPath = (runId, childId) => join(runDir(runId), teeRelPath(childId));

export function ensureRunDir(runId) {
  mkdirSync(join(runDir(runId), "children"), { recursive: true });
  mkdirSync(gatesDir(runId), { recursive: true });
}

export function emptyRegistry(runId) {
  return { runId, children: {}, rounds: {} };
}

export function readRegistry(runId) {
  const path = registryPath(runId);
  if (!existsSync(path)) return emptyRegistry(runId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { ...emptyRegistry(runId), ...parsed };
  } catch (err) {
    // A corrupt registry must not be silently replaced with an empty one — that
    // would orphan every running child and lose the pids needed to stop them.
    throw new Error(`${path} is not readable JSON: ${err.message}`);
  }
}

export function writeRegistry(runId, registry) {
  ensureRunDir(runId);
  atomicWriteJSON(registryPath(runId), registry);
}

// Read-modify-write. Single-writer by phase: supervisor-spawn writes the initial
// entry BEFORE launching the watcher, and after that only the watcher writes
// that child's state. That discipline — not locking — is what keeps this safe
// today. It survives the semaphore only because every node ships concurrency 1;
// raising any node above 1 makes two writers possible and needs real locking
// first. `admissionCheck` says so where the limit is read.
export function updateChild(runId, childId, patch) {
  const registry = readRegistry(runId);
  const current = registry.children[childId] || {};
  registry.children[childId] = { ...current, ...patch };
  writeRegistry(runId, registry);
  return registry.children[childId];
}

// Does this child have an unanswered question outstanding? The watcher asks at
// turn end to tell `exited` (finished the work) apart from `waiting_gate`
// (stopped to ask) — §2.5. Deliberately tolerant of a malformed file: a gate
// nobody can parse must not make a waiting child look finished, so anything
// unreadable counts as pending.
export function hasPendingGate(runId, childId) {
  const dir = gatesDir(runId);
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      try {
        const gate = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return gate.childId === childId && gate.status === "pending";
      } catch {
        return true;
      }
    });
}

// ── cost (FOC-165) ───────────────────────────────────────────────────────────
// The stream's `total_cost_usd` is NOT a measurement. Claude Code computes it
// from its own table, and it does not recognise a single model id this repo
// routes to — every child run prints `[claude-code:unrecognized_model]` to
// stderr. Measured on 2026-08-26: a turn on `stealth/ox-alpha`, which OpenRouter
// serves at $0/$0, was reported at $0.2059. Fabricated whole.
//
// So the cost the Supervisor reports is computed here from TOKEN COUNTS through
// config/models.json — the same path the dashboard uses, so the two numbers can
// no longer disagree about the same run. The stream's figure is kept alongside
// as `costUsdReported`, because a discrepancy is evidence, not noise.
//
// `null` is contagious and deliberate: a model with no price row makes the total
// UNKNOWN, never zero. Silently free is the failure that already cost this repo
// a null dashboard total once (config-drift.test.mjs header, Haiku 4.5).

// Claude Code spells usage two ways depending on where it appears: camelCase in
// `result.modelUsage`, snake_case in `result.usage`. Both reach here.
function normaliseUsage(u = {}) {
  return {
    inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
    outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
    cacheReadTokens: u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0,
  };
}

/**
 * `priceOne` is injected rather than imported so this module stays free of
 * telemetry-store — and therefore of node:sqlite, which every script importing
 * supervisor-lib would otherwise load for nothing. It also makes the unpriced
 * path testable without a price table.
 *
 * @param {object} event   a stream-json `result` event
 * @param {string|null} fallbackModel  the model from `system/init`, used when
 *   the event carries no per-model breakdown
 * @param {(usage: object, model: string) => number|null} priceOne
 * @returns {{ computed: number|null, reported: number|null, unpriced: string[] }}
 */
export function costFromResult(event, fallbackModel, priceOne) {
  const reported =
    typeof event.total_cost_usd === "number"
      ? event.total_cost_usd
      : typeof event.cost_usd === "number"
        ? event.cost_usd
        : null;

  // A turn can touch more than one model (the main one plus the small/fast one),
  // and they are priced differently. modelUsage is the only place that split is
  // visible; `usage` is already summed and would price the whole turn at one rate.
  const byModel =
    event.modelUsage && typeof event.modelUsage === "object"
      ? event.modelUsage
      : fallbackModel
        ? { [fallbackModel]: event.usage ?? {} }
        : {};

  let computed = 0;
  const unpriced = [];
  for (const [model, usage] of Object.entries(byModel)) {
    const cost = priceOne(normaliseUsage(usage), model);
    if (cost === null) unpriced.push(model);
    else computed += cost;
  }

  return { computed: unpriced.length || !Object.keys(byModel).length ? null : computed, reported, unpriced };
}

// Add two costs where `null` means "unknown". Unknown + anything is unknown:
// treating it as zero is exactly how an unpriced model becomes a free one.
export function addCost(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return null;
  return a + b;
}

/**
 * The spend cap, evaluated at turn boundaries (spec §2.1: post-hoc, so one turn
 * can overshoot before it trips). Unset means no cap and no behaviour change.
 *
 * A cap that cannot be evaluated is not a cap: when the operator asked for a
 * limit and some model has no price, this reports `evaluable: false` and the
 * callers refuse. Continuing would spend unbounded money under a setting whose
 * whole purpose is to bound it — and the fix is one row in config/models.json.
 */
export function budgetStatus(runId, registry = readRegistry(runId)) {
  const raw = process.env.LA_SUPERVISOR_MAX_COST_USD;
  const cap = raw === undefined || raw === "" ? null : Number(raw);
  const children = Object.values(registry.children || {});

  let spent = 0;
  let anyUnknown = false;
  const unpriced = [];
  for (const child of children) {
    for (const m of child.unpricedModels ?? []) if (!unpriced.includes(m)) unpriced.push(m);
    const cost = child.costUsd === undefined ? 0 : child.costUsd;
    // Explicit, not propagated through addCost. That helper is asymmetric so a
    // null accumulator can be seeded (`addCost(null, 1)` is 1), which made this
    // loop order-dependent: an unpriced child followed by a priced one reported
    // a total that looked known, under the one setting whose whole purpose is
    // to refuse when it is not. Found by spendByStage's test, FOC-162.
    if (cost === null) anyUnknown = true;
    else spent += cost;
  }
  if (anyUnknown) spent = null;

  const capValid = cap !== null && Number.isFinite(cap) && cap >= 0;
  return {
    cap: capValid ? cap : null,
    capInvalid: cap !== null && !capValid ? raw : null,
    spent,
    reported: children.reduce((sum, c) => sum + (c.costUsdReported || 0), 0),
    unpricedModels: unpriced,
    evaluable: spent !== null,
    exceeded: capValid && spent !== null && spent >= cap,
  };
}

/**
 * The turn-boundary gate. Called by spawn and by followup — the two places a new
 * turn begins — and it refuses in three distinct ways, each with a different fix:
 *
 *   · the cap is set and already spent      → Mateusz decides whether to raise it
 *   · the cap is set but spend is UNKNOWN   → one model has no price row
 *   · the cap itself is not a number        → a typo in the env var
 *
 * The middle one is the interesting refusal. A cap you cannot evaluate is not a
 * cap; carrying on would spend unbounded money under the one setting whose whole
 * purpose is to bound it. The fix is a single row in config/models.json, and the
 * error names the model that needs it.
 */
export function assertWithinBudget(runId, fail = failJson) {
  const budget = budgetStatus(runId);
  if (budget.capInvalid !== null) {
    return fail(`LA_SUPERVISOR_MAX_COST_USD is "${budget.capInvalid}", which is not a number >= 0`, { budget });
  }
  if (budget.cap === null) return budget;

  if (!budget.evaluable) {
    return fail(
      `LA_SUPERVISOR_MAX_COST_USD is set to ${budget.cap} but spend so far is UNKNOWN — ` +
        `no price row for ${budget.unpricedModels.join(", ") || "an unrecorded model"}. ` +
        `A cap that cannot be evaluated is not a cap.`,
      { budget, hint: "add the model to pricing.openrouter in config/models.json" },
    );
  }
  if (budget.exceeded) {
    return fail(
      `budget spent: $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)} — no new turn until Mateusz decides. ` +
        `The cap is checked at turn boundaries, so the last turn may have carried it past the limit.`,
      { budget },
    );
  }
  return budget;
}

// ── semaphore and backpressure (FOC-161) ─────────────────────────────────────
//
// WIP=1 gave backpressure for free. The moment children run in parallel that
// property is gone and has to be built, or an unbounded queue of unreviewed
// candidates grows until model quotas, the repo, or Mateusz's attention is the
// thing that breaks.
//
// HELD IS NOT REFUSED. A spawn that cannot start now is recorded and released
// when a slot frees. Dropping it would make the Supervisor responsible for
// remembering what it asked for, which is exactly the kind of state a model
// loses across a compaction.

export const heldDir = (runId) => join(runDir(runId), "held");
export const heldPath = (runId, heldId) => join(heldDir(runId), `${heldId}.json`);

export function readHeld(runId) {
  const dir = heldDir(runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        // Unreadable is not absent: a held request nobody can parse is still a
        // slot somebody is waiting for, and hiding it would release the slot to
        // someone else.
        return { heldId: f.replace(/\.json$/, ""), squad: null, unreadable: true };
      }
    })
    .sort((a, b) => String(a.heldAt).localeCompare(String(b.heldAt)));
}

/** The per-node limit, from the graph. Absent means 1 — never unbounded. */
export function concurrencyFor(squad, graph) {
  const n = graph?.nodes?.[squad]?.concurrency;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * Who PRODUCES the work this node consumes — the routable handoff edge in.
 *
 * REVIEW's producer is DEV, and that matters more than it looks: a REVIEW
 * verdict's progress fingerprint has to measure the tree holding the work under
 * review, not the reviewer's own checkout. Fingerprinting the reviewer's tree
 * made every second round look identical (it never changes), so the review loop
 * refused at round 2 no matter how much DEV had fixed — worse than the counter
 * it replaced, which at least allowed two.
 */
export function producerOf(squad, graph) {
  const edge = (graph?.edges ?? [])
    .filter((e) => e.to === squad && e.type === "handoff" && e.routable)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  return edge?.from ?? null;
}

/** Who consumes what this node produces — the first routable handoff edge out. */
export function consumerOf(squad, graph) {
  const edge = (graph?.edges ?? [])
    .filter((e) => e.from === squad && e.type === "handoff" && e.routable)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  return edge?.to ?? null;
}

/**
 * Live plus held, per node. Both count: a held request has already been decided
 * on and is waiting for a slot, so treating it as free capacity would admit work
 * that is already queued.
 */
export function queueState(runId, graph, registry = readRegistry(runId), { excludeHeld = null } = {}) {
  // `excludeHeld` is how --release asks "could this run if it were not itself
  // queued?". Without it a held request counts against its own slot and can
  // never be released — it blocks itself forever, which is what the first
  // version of this did.
  const held = readHeld(runId).filter((h) => h.heldId !== excludeHeld);
  const state = {};
  const touch = (squad) => (state[squad] ??= { live: 0, held: 0, limit: concurrencyFor(squad, graph) });

  for (const child of liveChildren(registry)) touch(child.squad).live++;
  for (const h of held) if (h.squad) touch(h.squad).held++;

  for (const [squad, s] of Object.entries(state)) {
    s.queued = s.live + s.held;
    s.saturated = s.queued >= s.limit;
  }
  return state;
}

/**
 * May a child of this squad start right now?
 *
 * Two independent reasons to hold, and they are reported separately because the
 * fix differs: a full node means wait, a saturated CONSUMER means the graph is
 * producing faster than it can verify, and adding capacity upstream would make
 * that worse rather than better.
 */
export function admissionCheck(runId, squad, graph, registry = readRegistry(runId), opts = {}) {
  const state = queueState(runId, graph, registry, opts);
  const limit = concurrencyFor(squad, graph);
  const mine = state[squad] ?? { live: 0, held: 0, queued: 0, limit, saturated: false };

  if (mine.queued >= limit) {
    return {
      admit: false,
      reason: "node-full",
      squad,
      detail:
        `${squad} already has ${mine.live} live and ${mine.held} held, and its concurrency is ${limit} ` +
        `(config/graph.json). Held until a slot frees.`,
      state,
    };
  }

  // Backpressure. Pausing the PRODUCER is the point: queueing here instead would
  // grow exactly the backlog this exists to prevent.
  const consumer = consumerOf(squad, graph);
  if (consumer) {
    const c = state[consumer];
    if (c?.saturated) {
      return {
        admit: false,
        reason: "consumer-saturated",
        squad,
        consumer,
        detail:
          `${consumer} is saturated (${c.live} live, ${c.held} held, limit ${c.limit}), so ${squad} is paused ` +
          `upstream rather than queued — producing candidates ${consumer} cannot absorb is not throughput.`,
        state,
      };
    }
  }

  return { admit: true, squad, state };
}

// ── per-stage budgets (FOC-162) ──────────────────────────────────────────────
//
// One number cannot express the failure that actually costs money: DEV eats the
// whole issue budget and REVIEW/TEST have nothing left, so the run ends with
// work nobody verified. A single cap trips only AFTER that has happened.
//
// So the budget is split up front, from the `budget.shareHint` on each node in
// config/graph.json, and the split is enforced per stage. `shareHint` is a
// starting guess, explicitly labelled as one in the graph — `reconcile` is what
// turns it into a measured number.
//
// LA_SUPERVISOR_MAX_COST_USD is NOT a competing cap. It stays as the OUTER
// BACKSTOP above the split: the stage gate refuses first, and if a run somehow
// gets past it the global cap still stops the whole thing. Two caps that could
// each be the binding one would be two ways to be surprised; these are ordered.

export const budgetPath = (runId) => join(runDir(runId), "budget.json");

/**
 * Split a total across stages using the graph's own hints.
 *
 * Nodes with `shareHint: null` (cadence, human) are out-of-band and get nothing:
 * they are not part of an issue's work. The reserve comes off the top per
 * `budgetPolicy.reserveShare`, and the remaining hints are NORMALISED rather
 * than trusted to sum to 1 — a graph edit that changes one hint must not
 * silently under- or over-allocate the whole run.
 */
export function allocateBudget(total, graph) {
  const reserveShare = graph?.budgetPolicy?.reserveShare ?? 0;
  if (!(total > 0)) throw new Error(`budget total must be > 0 (got ${total})`);
  if (!(reserveShare >= 0 && reserveShare < 1)) {
    throw new Error(`budgetPolicy.reserveShare must be in [0, 1) (got ${reserveShare})`);
  }

  const byStage = {};
  for (const [name, node] of Object.entries(graph?.nodes ?? {})) {
    const stage = node?.budget?.stage;
    const hint = node?.budget?.shareHint;
    if (!stage || hint === null || hint === undefined) continue;
    if (!(hint > 0)) throw new Error(`node "${name}" has shareHint ${hint} — a stage cannot be allocated nothing`);
    byStage[stage] = (byStage[stage] ?? 0) + hint;
  }

  const hintTotal = Object.values(byStage).reduce((a, b) => a + b, 0);
  if (hintTotal <= 0) throw new Error("no node in the graph declares a positive budget.shareHint");

  const reserve = round4(total * reserveShare);
  const allocatable = total - reserve;

  const stages = {};
  for (const [stage, hint] of Object.entries(byStage)) {
    stages[stage] = round4((hint / hintTotal) * allocatable);
  }

  return {
    total: round4(total),
    reserve,
    reserveShare,
    stages,
    // Kept so `reconcile` can say whether a hint was wrong or the run was.
    hints: byStage,
    hintTotal: round4(hintTotal),
  };
}

const round4 = (n) => Math.round(n * 10_000) / 10_000;

/** Which stage does this squad's work belong to? `null` when out-of-band. */
export function stageForSquad(squad, graph) {
  return graph?.nodes?.[squad]?.budget?.stage ?? null;
}

/**
 * Spend so far, grouped by the stage each child's squad belongs to.
 *
 * `null` is contagious here for the same reason it is in budgetStatus: a child
 * on an unpriced model makes its STAGE unknown, not free.
 */
export function spendByStage(registry, graph) {
  const totals = {};
  const unknownStage = new Set();
  const unknown = [];

  for (const child of Object.values(registry?.children ?? {})) {
    const stage = stageForSquad(child.squad, graph);
    if (!stage) continue;
    const cost = child.costUsd === undefined ? 0 : child.costUsd;
    if (cost === null) {
      unknownStage.add(stage);
      if (!unknown.includes(child.squad)) unknown.push(child.squad);
      continue;
    }
    totals[stage] = (totals[stage] ?? 0) + cost;
  }

  // Unknown-ness is tracked in a SET rather than propagated through addCost.
  // addCost is asymmetric on purpose — `addCost(null, 1)` is 1, so that a null
  // accumulator can be seeded — which makes null-contagion depend on the order
  // children happen to be iterated in. An unpriced child followed by a priced
  // one would report a total that looks known. Same bug was live in
  // budgetStatus; both now decide unknown-ness explicitly.
  const stages = {};
  for (const [stage, sum] of Object.entries(totals)) stages[stage] = unknownStage.has(stage) ? null : sum;
  for (const stage of unknownStage) if (!(stage in stages)) stages[stage] = null;

  return { stages, unknownStages: unknown };
}

/**
 * Where a run stands against its split.
 *
 * The reserve is accounted from ACTUAL overspend rather than from a number
 * somebody reserved in advance: `reserveDrawn` is the sum of how far each stage
 * has gone past its own allocation. That way an authorisation is permission to
 * overspend, and the cost of using it is measured after the fact instead of
 * estimated before — which is the same discipline the cost figures already
 * follow (FOC-165: measured, not reported).
 */
export function stageBudgetStatus(runId, { graph, registry = readRegistry(runId) } = {}) {
  const path = budgetPath(runId);
  if (!existsSync(path)) return null; // no allocation for this run; the global cap still applies
  let plan;
  try {
    plan = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not readable JSON: ${err.message}`);
  }

  const { stages: spent, unknownStages } = spendByStage(registry, graph);
  const stages = {};
  let reserveDrawn = 0;

  for (const [stage, allocated] of Object.entries(plan.stages ?? {})) {
    // `spent[stage] ?? 0` would be wrong here and was, until a test caught it:
    // `??` treats null as absent, so an UNKNOWN stage would have read as a stage
    // that spent nothing. That is the silently-free failure this whole file
    // exists to prevent, one operator away from a run continuing under a budget
    // nobody could evaluate. Absent means 0; present-and-null means unknown.
    const used = stage in spent ? spent[stage] : 0;
    const over = used === null ? null : Math.max(0, used - allocated);
    if (over !== null) reserveDrawn += over;
    stages[stage] = {
      allocated,
      spent: used,
      remaining: used === null ? null : round4(allocated - used),
      over: over === null ? null : round4(over),
      exhausted: used === null ? null : used >= allocated,
      authorised: (plan.authorisations ?? []).some((a) => a.stage === stage),
    };
  }

  const reserveRemaining = round4((plan.reserve ?? 0) - reserveDrawn);
  return {
    ...plan,
    stages,
    reserveDrawn: round4(reserveDrawn),
    reserveRemaining,
    reserveExhausted: reserveRemaining <= 0,
    unknownStages,
    evaluable: unknownStages.length === 0,
  };
}

/**
 * What the run produced and what nobody checked.
 *
 * Written when the reserve runs out, because the alternative — stopping with an
 * error and nothing else — is the silent halt this task exists to prevent. The
 * useful column is `unverified`: tasks with children that ran and no recorded
 * REVIEW verdict. That is the money already spent whose result nobody can vouch
 * for, and it is the reason per-stage budgets exist at all.
 */
export function partialStatusReport(runId, { graph, registry = readRegistry(runId) } = {}) {
  const budget = stageBudgetStatus(runId, { graph, registry });
  const byTask = new Map();
  for (const child of Object.values(registry?.children ?? {})) {
    if (!child.taskId) continue;
    const row = byTask.get(child.taskId) ?? { taskId: child.taskId, squads: [], rounds: 0, verdict: null };
    if (!row.squads.includes(child.squad)) row.squads.push(child.squad);
    byTask.set(child.taskId, row);
  }
  for (const row of byTask.values()) {
    const rounds = roundsFor(runId, row.taskId);
    row.rounds = rounds.length;
    row.verdict = rounds.length ? rounds[rounds.length - 1].verdict : null;
  }

  const tasks = [...byTask.values()];
  return {
    runId,
    reason: "reserve exhausted — graph expansion stopped",
    generatedAt: new Date().toISOString(),
    budget,
    tasks,
    unverified: tasks.filter((t) => t.verdict !== "pass").map((t) => t.taskId),
  };
}

/**
 * The per-stage gate. Ordered BELOW the global cap deliberately: the split is
 * the working control, LA_SUPERVISOR_MAX_COST_USD is the outer backstop, and
 * a refusal always names which of the two it was.
 *
 * Returns null when the run has no allocation — the feature is opt-in per run,
 * and a run started before `budget allocate` must not become unstartable.
 */
export function assertStageBudget(runId, squad, { graph, fail = failJson } = {}) {
  const stage = stageForSquad(squad, graph);
  if (!stage || stage === "out-of-band") return null;

  // Every other refusal in this runtime is JSON on stdout; the Supervisor parses
  // stdout and nothing else. stageBudgetStatus THROWS on an unreadable
  // budget.json, which reached spawn as a raw stack trace on stderr with empty
  // stdout — a refusal the lead cannot read is a refusal it cannot act on.
  // Converted at the gate rather than in the reader, so `budget status` can
  // still surface the parse error as an exception to a human.
  let budget;
  try {
    budget = stageBudgetStatus(runId, { graph });
  } catch (err) {
    return fail(`the per-stage budget could not be read: ${err.message}`, {
      hint: "fix or delete .state/supervisor/<run>/budget.json — a budget nobody can parse is not a budget",
    });
  }
  if (!budget) return null;

  const s = budget.stages[stage];
  if (!s) return null;

  if (s.spent === null) {
    return fail(
      `stage "${stage}" spend is UNKNOWN — no price row for ${budget.unknownStages.join(", ")}. ` +
        `A budget that cannot be evaluated is not a budget.`,
      { budget, hint: "add the model to pricing.openrouter in config/models.json" },
    );
  }

  if (!s.exhausted) return budget;

  // Exhausted. The whole point of splitting is that this does NOT reach across.
  //
  // Permission to overspend is PERSISTED STATE (`budget authorise` writes it),
  // not a flag on this call. A flag would let whoever invokes spawn grant
  // themselves the reserve; the authorisation has to be a decision on disk with
  // a reason attached, because `reconcile` later has to say why a stage went
  // past its allocation.
  if (!s.authorised) {
    return fail(
      `stage "${stage}" has spent $${s.spent.toFixed(4)} of its $${s.allocated.toFixed(2)} allocation — ` +
        `it will NOT borrow from the other stages. That is the split doing its job: money left in ` +
        `verification is what stops this run ending with work nobody checked.`,
      {
        stage,
        budget,
        hint:
          `Mateusz decides: raise the total (budget allocate --total), or authorise the reserve ` +
          `(budget authorise --stage ${stage} --reason "..."), which is the only pool that may cover an overrun.`,
      },
    );
  }

  if (budget.reserveExhausted) {
    const report = partialStatusReport(runId, { graph });
    atomicWriteJSON(join(runDir(runId), "partial-status.json"), report);
    return fail(
      `the reserve is exhausted ($${budget.reserve.toFixed(2)} allocated, $${budget.reserveDrawn.toFixed(4)} drawn) — ` +
        `graph expansion stops here`,
      {
        budget,
        partialStatus: report,
        // Stopping with an error and nothing else is the silent halt this exists
        // to prevent. The report says what ran and, more usefully, what nobody
        // verified.
        unverified: report.unverified,
        hint: "report the partial status to Mateusz; raising the total is his decision, not a retry",
      },
    );
  }

  return budget;
}

// ── child settings (P9) ──────────────────────────────────────────────────────
// The push gate is enforced by the harness, not by asking the child nicely.
// This exact list is the spec's (§1.7): `gh api` is here because it can create a
// PR through the REST route, which the three `gh pr`/`gh release` rules would
// otherwise miss.
//
// WHAT THIS IS NOT: a sandbox. `cmd /c git push`, `powershell -c`, `git -C <path>
// push` (the prefix no longer matches the rule) and any wrapper script all walk
// straight past it. The real control is the human `push-approval` gate; this
// list removes the accidental push, not the determined one. ADR-0009 §Risks.
// The last two are the worktree gate (FOC-167), and they are here for the same
// reason as the push rules: a child must not reclaim the checkout it is standing
// in. Removal is the Supervisor's act, behind TEST-pass + Mateusz's yes
// (scripts/supervisor-cleanup.mjs). Same caveat as above — this is the
// accidental `git worktree remove`, not the determined one; the identity check
// in supervisor-cleanup.mjs is the control that actually holds.
export const SUPERVISOR_DENY = [
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr merge:*)",
  "Bash(gh release create:*)",
  "Bash(gh api:*)",
  "Bash(git worktree remove:*)",
  "Bash(git worktree prune:*)",
];

export const childSettingsPath = (runId, childId) =>
  join(runDir(runId), `child-settings-${childId}.json`);

/**
 * DENY ONLY, on purpose.
 *
 * `claude --settings <file>` loads "additional settings" (its own --help), so
 * this file is merged with the squad's own settings.json from CLAUDE_CONFIG_DIR
 * rather than replacing it. Two consequences shape what goes in here:
 *
 *   · No `allow` list. Under merge semantics an allow entry can only ADD a
 *     permission, never remove one, and this file exists to remove. Writing one
 *     would make the file's intent readable two ways.
 *   · No `hooks`. The squad's SessionStart telemetry hook already loads from the
 *     config dir; repeating it here risks registering it twice and double-
 *     counting every child run.
 *
 * The squad's own denies are copied in anyway even though the merge would apply
 * them regardless — so one file answers "what is this child forbidden to do?"
 * without needing to know the merge rules. Order is stable (squad first, then
 * whatever the Supervisor adds) so regenerating produces a byte-identical file.
 */
export function buildChildSettings(...baseSettings) {
  const deny = [];
  for (const base of [...baseSettings, { permissions: { deny: SUPERVISOR_DENY } }]) {
    for (const rule of base?.permissions?.deny ?? []) {
      if (!deny.includes(rule)) deny.push(rule);
    }
  }
  return { permissions: { deny } };
}

export function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A settings file we cannot parse must not silently become "no denies".
    // Returning the fallback keeps the Supervisor's own list intact, which is
    // the half that matters for P9.
    return fallback;
  }
}

export const LIVE_STATUSES = ["starting", "running"];

// "The turn has ended" — no process is running, nothing will write this child's
// state again until someone starts a new turn. `waiting_gate` belongs here even
// though the WORK is unfinished: liveness is about the process, not the task.
// Getting that wrong is not cosmetic — a `waiting_gate` child counted as live
// would be reported as stalled once its tee went quiet (it always does; it is
// waiting on a human), and `status --wait` would block instead of sending the
// Supervisor to Mateusz for the answer.
export const TERMINAL_STATUSES = ["exited", "crashed", "stopped", "waiting_gate"];

export function liveChildren(registry) {
  return Object.values(registry.children || {}).filter((c) => LIVE_STATUSES.includes(c.status));
}

// ── git / worktree ───────────────────────────────────────────────────────────

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

export function resolveGitRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

// Worktrees live as siblings of the repo (../la-wt/<branch>) rather than inside
// it: a worktree nested under the repo shows up in the parent's own status and
// in every glob the agents run, which is exactly the confusion worktrees exist
// to remove.
export function worktreeRoot(gitRoot) {
  return join(gitRoot, "..", "la-wt");
}

// Always resolved. `git worktree list` prints forward slashes on win32 while
// path.join produces backslashes, so create and reuse used to hand back the same
// directory spelled two different ways — and the registry recorded whichever the
// caller happened to hit. Anything that compares worktree paths (FOC-160's merge
// node compares touched paths across candidates) would have broken on that.
export function worktreePathFor(gitRoot, branch) {
  return resolve(worktreeRoot(gitRoot), branch);
}

export function listWorktrees(gitRoot) {
  const out = git(["worktree", "list", "--porcelain"], gitRoot);
  const entries = [];
  let current = {};
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

/**
 * Give this child an isolated checkout. Creates ../la-wt/<branch> off the
 * current HEAD when it does not exist, reuses it when it does.
 *
 * Reuse must NEVER run `git checkout` in the main tree — switching a branch
 * under a live run is one of the two failures this whole change exists to
 * prevent (docs/ROADMAP.md §NOW.1).
 *
 * @returns {{ worktree: string, branch: string, baseRevision: string, created: boolean }}
 */
export function ensureWorktree(gitRoot, branch) {
  const existing = listWorktrees(gitRoot).find((w) => w.branch === branch);
  if (existing) {
    const path = resolve(existing.path);
    return { worktree: path, branch, baseRevision: git(["rev-parse", "HEAD"], path), created: false };
  }

  const target = worktreePathFor(gitRoot, branch);
  mkdirSync(worktreeRoot(gitRoot), { recursive: true });

  const head = git(["rev-parse", "HEAD"], gitRoot);
  const branchExists = (() => {
    try {
      git(["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot);
      return true;
    } catch {
      return false;
    }
  })();

  // `git worktree add <path> <branch>` checks out an existing branch;
  // `-b` creates it. Passing -b for an existing branch fails, and omitting it
  // for a missing one checks out a detached HEAD named after nothing.
  const args = branchExists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, head];
  git(args, gitRoot);

  const path = resolve(target);
  return { worktree: path, branch, baseRevision: git(["rev-parse", "HEAD"], path), created: true };
}

// Reported after a kill so Mateusz can see what the child left behind. Never
// acted on: cleanup is his call, and an auto-reset would destroy the only copy
// of work a crashed child had not committed.
export function dirtyTreeReport(cwd) {
  try {
    const out = git(["status", "--porcelain"], cwd);
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    return [`<git status failed: ${err.message}>`];
  }
}

// ── progress fingerprint (FOC-163) ───────────────────────────────────────────
//
// The thing that replaces counting rounds. A round is progress when the work
// CHANGED; a second round producing the same diff and failing the same tests is
// not a second attempt, it is the first attempt billed twice.
//
// Two components, hashed separately so a report can say WHICH half stood still:
//
//   · the diff against the round's base — `git diff <base>` compares base to the
//     WORKING TREE, so it catches committed and uncommitted work in one pass.
//     Untracked files never appear in a diff, so the porcelain list rides along;
//     a round whose only output is an untracked file would otherwise fingerprint
//     as "nothing happened".
//   · the failing-test set the verdict declared, sorted and deduped — order out
//     of a test runner is not stable, and an unsorted set would make every round
//     look different for free.
//
// Deliberately NOT included: timestamps, durations, cost. All three change on
// every round by construction, and a fingerprint that always differs is a cap
// of infinity wearing a measurement's clothes.
export function progressFingerprint({ worktree, baseRevision, failingTests = [] } = {}) {
  const sha = (s) => createHash("sha256").update(s).digest("hex");

  let diffText = null;
  let porcelain = [];
  let error = null;
  if (worktree && baseRevision && existsSync(worktree)) {
    try {
      diffText = git(["diff", baseRevision], worktree);
      porcelain = dirtyTreeReport(worktree);
    } catch (err) {
      error = err.message.split("\n")[0];
    }
  } else if (worktree || baseRevision) {
    error = "worktree or baseRevision missing";
  }

  const tests = [...new Set(failingTests.map((t) => String(t).trim()).filter(Boolean))].sort();

  // A fingerprint that could not read the tree is UNKNOWN, not empty. Returning
  // a hash of "" here would make two unreadable rounds compare equal, and equal
  // means "no progress, escalate" — the system would escalate on its own
  // inability to look rather than on the child's failure to move.
  const diffHash = error ? null : sha(`${diffText ?? ""}\n${[...porcelain].sort().join("\n")}`).slice(0, 12);
  const testsHash = sha(tests.join("\n")).slice(0, 12);

  return {
    diff: diffHash,
    tests: testsHash,
    combined: diffHash ? sha(`${diffHash}:${testsHash}`).slice(0, 16) : null,
    changedFiles: error ? null : porcelain.length,
    failingTests: tests,
    error,
  };
}

/**
 * Did this round move? `null` means UNKNOWN — one of the two could not be read —
 * and callers must treat that as "cannot tell", never as "no progress".
 */
export function comparableProgress(a, b) {
  if (!a?.combined || !b?.combined) return null;
  return a.combined === b.combined;
}

/**
 * Every recorded REVIEW verdict for one task, oldest first.
 *
 * Lives here rather than in supervisor-verdict.mjs because supervisor-followup
 * reads it too, and a CLI script is the wrong thing for another script to import.
 * Same rule the registry and the gate paths already follow.
 */
export function roundsFor(runId, taskId) {
  const dir = verdictsDir(runId);
  if (!existsSync(dir)) return [];
  const prefix = `${String(taskId).toLowerCase()}-round`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        // Unreadable is not absent. A verdict nobody can parse must not make the
        // round before it look like the latest one.
        return { round: Number(f.slice(prefix.length, -5)) || 0, unreadable: true };
      }
    })
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
}

export function latestVerdict(runId, taskId) {
  const all = roundsFor(runId, taskId);
  return all.length ? all[all.length - 1] : null;
}

// ── killing a child ──────────────────────────────────────────────────────────

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive, just not ours to signal
  }
}

/**
 * Kill a child process and everything it spawned.
 *
 * On win32 this is ALWAYS a tree kill (`taskkill /T`). A claude child routinely
 * spawns cmd.exe for build and test commands; signalling only the top pid
 * leaves those nested shells running, holding file locks in a worktree nobody
 * owns any more.
 *
 * @param {"graceful"|"force"} mode
 */
export function killTree(pid, mode = "graceful") {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (mode === "force") args.push("/F");
      execFileSync("taskkill", args, { stdio: "ignore" });
    } else {
      process.kill(-pid, mode === "force" ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    // Already gone, or the tree died with the parent — either way there is
    // nothing left to kill, which is the outcome the caller wanted.
    return false;
  }
}

// ── claude binary ────────────────────────────────────────────────────────────

// LA_CLAUDE_BIN is a TEST SEAM. The suite points it at scripts/mock-claude.mjs
// so spawn/watch/stop can be exercised without a real model call or an API key.
// Production leaves it unset and gets `claude` from PATH.
export function claudeCommand(args) {
  const bin = process.env.LA_CLAUDE_BIN;
  if (!bin) return { command: "claude", args };
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args };
}

// Only these flags accumulate. Everything else takes the LAST value, so a
// wrapper that appends an override (`--task A ... --task B`) gets B rather than
// the array ["A","B"] — which silently became the string "A,B" downstream and
// failed identifier validation with a nonsense message.
const REPEATABLE = new Set(["allowed-path"]);

export function parseArgs(argv, repeatable = REPEATABLE) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      if (repeatable.has(key)) {
        out[key] = [...asArray(out[key]), next];
      } else {
        out[key] = next;
      }
      i++;
    }
  }
  return out;
}

export const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function failJson(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

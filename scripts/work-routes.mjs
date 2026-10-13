// scripts/work-routes.mjs — the Work board and Costs & quality routes
// (FOC-784/785, plan slice W5): GET /api/work/tickets, the ticket detail,
// the Start preview/confirm pair, GET /api/costs and GET /api/quality.
//
// This module is TRANSPORT ONLY, in the style of cockpit-routes.mjs: guard
// order, body handling and the error shape mirror the Cockpit's routes
// (isLocalOrigin first, isAllowedOrigin second, then the body). Everything
// served is derived in libraries — work-board.mjs (TicketFacts, stages,
// board/detail payloads), cost-quality.mjs (the /api/costs and /api/quality
// payloads) and cost-snapshot.mjs (the cost truth, computed OFF the request
// path) — the route layer only guards, parses, maps statuses and passes
// bodies through.
//
// The cost snapshot is a CHILD PROCESS spawn (`node scripts/cost-snapshot.mjs
// --json --cutoffs <file>`, read-only store): a full ticketCostReport scans
// the whole store and must never block this event loop (FOC-547). The manager
// below keeps the last snapshot, refreshes it at most every 2 min, serves the
// previous snapshot while a refresh runs (the payload builders compute the
// stale flag from computedAt) and records a failure as state "error" while
// keeping the previous snapshot — never invented numbers, never a blocked
// route (plan §Shared decisions).
//
// TEST-ONLY SEAM (FENIX_LINEAR_FAKE_FILE + NODE_ENV=test): when BOTH are set,
// the Linear issue fetch and the Linear states lookup read a JSON fixture
// file (see fakeLinearFixture) instead of the Linear API, mirroring the same
// seam linearQueue() has in telemetry-server.mjs. Guarded by NODE_ENV so the
// env var alone can never redirect a production fetch.

import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hostBase } from "./supervisor-host-client.mjs";
import { graphql } from "./linear-client.mjs";
import { readRegistry, supervisorStateHome } from "./supervisor-lib.mjs";
import { squadConfigDir } from "./fenix-paths.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import {
  buildBoardPayload,
  buildTicketDetail,
  collectTicketFacts,
  fetchLinearStates,
  startText,
  TICKET_ID_RE,
} from "./work-board.mjs";
import { buildCostsPayload, buildQualityPayload } from "./cost-quality.mjs";
import { forwardMessageToHost, writeGuards } from "./cockpit-routes.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const COST_SNAPSHOT_SCRIPT = join(__dir, "cost-snapshot.mjs");

// The body cap for the Start POST: a hand-off text is a control payload, not
// a document — the same 16 KB the Cockpit's chat POST applies.
const BODY_CAP = 16 * 1024;

// Ticket ids on these routes are Linear identifiers (FOC-123, TEST-9, W2 …) —
// the board library's shape, imported so route and library can never drift.

// The board's workspace (the /api/linear/queue default); FENIX_WORK_WORKSPACE
// overrides it for tests.
const workWorkspace = () => process.env.FENIX_WORK_WORKSPACE || "jointhubs";

// The hand-off text cap passed to startText: the confirm dialog shows the
// whole text and the Start POST forwards it inside a 16 KB body, so the issue
// description is truncated well below that.
const START_TEXT_MAX_CHARS = 4_000;

// The staleness label the spec defines (§8): a snapshot older than 5 min is
// marked stale in the payloads. Same bound cost-quality.mjs defaults to.
const STALE_AFTER_MS = 5 * 60_000;

// The refresh child's budgets: a full-store scan takes seconds, not minutes;
// 120 s covers a loaded store, 64 MB covers a big --json dump.
const COST_SNAPSHOT_TIMEOUT_MS = 120_000;
const COST_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;

// ── the cost snapshot manager (module-level, one refresh at a time) ─────────

const COST_SNAPSHOT_TTL_MS_DEFAULT = 2 * 60_000;

// ── the shared facts cache (the request path) ────────────────────────────────
//
// collectTicketFacts is a directory walk over every run in the 30-day window.
// The board, the detail, /api/costs, /api/quality and the snapshot cutoffs all
// need the same tree within a few seconds of each other, so ONE cached result
// serves them all (FENIX_WORK_FACTS_TTL_MS overrides the 10 s for tests).

const WORK_FACTS_TTL_MS_DEFAULT = 10_000;
let factsCache = null; // { facts, at }

function workFactsTtlMs() {
  const raw = Number(process.env.FENIX_WORK_FACTS_TTL_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : WORK_FACTS_TTL_MS_DEFAULT;
}

/**
 * collectTicketFacts for the default state home, cached for a short TTL —
 * exported for the tests that prove the sharing and the reset.
 */
export function ticketFacts() {
  const now = Date.now();
  if (factsCache && now - factsCache.at < workFactsTtlMs()) return factsCache.facts;
  const facts = collectTicketFacts({ stateHome: supervisorStateHome(), days: 30, now: new Date(now) });
  factsCache = { facts, at: now };
  return facts;
}

let costSnapshot = null; // the last parsed CostSnapshot, or null before the first
let costState = "computing"; // "ok" | "computing" | "error"
let costError = null; // the last refresh failure's message, cleared on success
let costRefresh = null; // the in-flight refresh promise, if any
let costClock = () => Date.now(); // test seam
let costTtlMsOverride = null; // test seam

/** The refresh interval: FENIX_COST_SNAPSHOT_TTL_MS for tests, else 2 min. */
function costSnapshotTtlMs() {
  if (costTtlMsOverride != null) return costTtlMsOverride;
  const raw = Number(process.env.FENIX_COST_SNAPSHOT_TTL_MS);
  return Number.isInteger(raw) && raw >= 0 ? raw : COST_SNAPSHOT_TTL_MS_DEFAULT;
}

/**
 * The current cost snapshot state: `{ snapshot, state, error, computedAt }`.
 * Starts a refresh when the snapshot is missing or older than the TTL — one
 * refresh in flight at a time; while it runs the PREVIOUS snapshot is served
 * (the payload builders compute the stale flag from computedAt), so a slow
 * store scan never blanks the screen and never blocks the event loop. A
 * failed refresh records `error` and keeps the previous snapshot.
 */
export function getCostSnapshot() {
  if (!costRefresh) {
    const age = costSnapshot ? costClock() - Date.parse(costSnapshot.computedAt) : Infinity;
    if (!Number.isFinite(age) || age >= costSnapshotTtlMs()) startCostRefresh();
  }
  return {
    snapshot: costSnapshot,
    state: costState,
    error: costError,
    computedAt: costSnapshot?.computedAt ?? null,
  };
}

/**
 * The snapshot shape the payload builders take: the real snapshot with the
 * manager's state stamped on it (cost-quality passes "computing"/"error"
 * through), null before the first snapshot, and an error marker with no
 * snapshot behind it. While refreshing, the previous snapshot is served
 * as-is — the builders compute `stale` from its computedAt.
 */
function snapshotForPayloads() {
  const cost = getCostSnapshot();
  if (cost.snapshot) return { ...cost.snapshot, state: cost.state };
  if (cost.state === "error") return { state: "error", error: cost.error ?? "cost snapshot failed" };
  return null; // computing — the first refresh has not landed yet
}

/** Start one refresh child; the promise is stored so callers share it. */
function startCostRefresh() {
  costRefresh = (async () => {
    try {
      // Yield BEFORE the synchronous part: getCostSnapshot() runs on the
      // request path, and the facts sweep + cutoffs write below are sync work
      // the calling request must never wait for (the child process already
      // ran off-loop; this moves the sync half off it too).
      await new Promise((resolve) => setImmediate(resolve));
      const facts = ticketFacts();
      // Rework cutoffs: per child telemetry run, the START OF TURN 2 (the
      // first reworked turn); children that never reworked cut at +∞ so no
      // row counts as rework. Same mapping the cutoffs file documents.
      const cutoffs = {};
      for (const fact of Array.isArray(facts) ? facts : []) {
        for (const child of Array.isArray(fact.children) ? fact.children : []) {
          if (!child.telemetryRunId) continue;
          const turn2 = Array.isArray(child.turns) ? child.turns[1] : null;
          cutoffs[child.telemetryRunId] = turn2?.startedAt ?? "9999-12-31T00:00:00.000Z";
        }
      }
      const cutoffsPath = join(tmpdir(), `work-routes-cutoffs-${process.pid}-${Date.now()}.json`);
      writeFileSync(cutoffsPath, JSON.stringify(cutoffs), "utf8");
      try {
        const stdout = await new Promise((resolve, reject) => {
          execFile(
            process.execPath,
            [COST_SNAPSHOT_SCRIPT, "--json", "--cutoffs", cutoffsPath],
            {
              timeout: COST_SNAPSHOT_TIMEOUT_MS,
              maxBuffer: COST_SNAPSHOT_MAX_BUFFER,
              env: process.env, // inherited — LA_TELEMETRY_DB / HOME seams apply
              encoding: "utf8",
            },
            (err, out, stderr) => {
              if (err) reject(new Error(`cost-snapshot child failed: ${err.message}${stderr ? ` — ${String(stderr).slice(-500)}` : ""}`));
              else resolve(out);
            },
          );
        });
        const parsed = JSON.parse(stdout);
        if (!parsed || typeof parsed !== "object" || !parsed.windows) {
          throw new Error("cost-snapshot child printed no snapshot");
        }
        costSnapshot = parsed;
        costState = "ok";
        costError = null;
      } finally {
        try { unlinkSync(cutoffsPath); } catch { /* already gone */ }
      }
    } catch (err) {
      costError = String(err?.message ?? err);
      costState = "error"; // the previous snapshot (if any) is kept and served
      console.error("[work] cost snapshot refresh failed:", costError);
    } finally {
      costRefresh = null;
    }
  })();
  return costRefresh;
}

/** Test seam: reset the cost snapshot manager and (optionally) inject clock / TTL. */
export function resetWorkRoutesState({ now, ttlMs } = {}) {
  if (typeof now === "function") costClock = now;
  costTtlMsOverride = null; // cleared too — a stale override would outlive the test that set it
  if (Number.isInteger(ttlMs)) costTtlMsOverride = ttlMs;
  costSnapshot = null;
  costState = "computing";
  costError = null;
  costRefresh = null;
  factsCache = null;
  reconciliationMemo.clear();
}

// ── the TEST-ONLY Linear fixture ─────────────────────────────────────────────

/**
 * The fake Linear fixture, or null outside TEST ONLY paths: NODE_ENV=test
 * AND FENIX_LINEAR_FAKE_FILE set (the same two-key guard telemetry-server's
 * linearQueue applies). Shape: `{ queue: { tasks: [...] }, issues: { "<ID>":
 * { identifier, title, url, description, state: { name, type } } } }`.
 */
function fakeLinearFixture() {
  if (process.env.NODE_ENV !== "test") return null;
  const file = process.env.FENIX_LINEAR_FAKE_FILE;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One Linear issue WITH its description (the start text's body). Reuses the
 * shared linear-client graphql() layer — one small query, no shelling out.
 * Resolves null when the issue does not exist; throws on a Linear failure
 * (the callers map that to their own status).
 */
async function fetchIssue(identifier, workspace) {
  const fake = fakeLinearFixture();
  if (fake) {
    const issue = fake.issues?.[identifier];
    return issue && typeof issue === "object" ? issue : null;
  }
  const data = await graphql(
    `query($id: String!) {
      issue(id: $id) {
        identifier
        title
        url
        description
        state { name type }
      }
    }`,
    { id: identifier },
    workspace,
  );
  return data?.issue ?? null;
}

/**
 * Linear states for the touched tickets (Q2: Landed = state type completed).
 * TEST ONLY: from the fake fixture's issues. Production: W1's
 * fetchLinearStates — the batched GraphQL lookup with its own 60 s cache
 * (jointhubs first, then pisi); its `{ states, error, fetchedAt }` result
 * IS the linearMeta the board payload carries. A Linear failure degrades to
 * an error meta and no states — never a 5xx.
 */
async function linearStatesFor(identifiers) {
  const ids = [...new Set((Array.isArray(identifiers) ? identifiers : []).filter((id) => typeof id === "string"))];
  const fake = fakeLinearFixture();
  if (fake) {
    const states = {};
    for (const id of ids) {
      const issue = fake.issues?.[id];
      if (issue?.state) {
        states[id] = {
          name: issue.state.name ?? null,
          type: issue.state.type ?? null,
          title: issue.title ?? null,
          url: issue.url ?? null,
          priority: issue.priority ?? null,
          milestone: issue.milestone ?? null,
        };
      }
    }
    return { states, meta: { ok: true, error: null, fetchedAt: new Date().toISOString() } };
  }
  if (ids.length === 0) return { states: {}, meta: { ok: true, error: null, fetchedAt: null } };
  try {
    const { states, error, fetchedAt } = await fetchLinearStates(ids);
    return { states: states ?? {}, meta: { ok: error == null, error: error ?? null, fetchedAt: fetchedAt ?? new Date().toISOString() } };
  } catch (err) {
    return { states: {}, meta: { ok: false, error: String(err?.message ?? err), fetchedAt: null } };
  }
}

// ── the ticket detail's cost reconciliation ──────────────────────────────────

/**
 * Reconciliation for one ticket (plan FOC-784): per child of the ticket,
 * transcriptUsd = Σ priceChildTranscripts (the child's own transcripts — the
 * ground truth, sessionId from the run's registry), telemetryUsd = Σ
 * snapshot.runs[telemetryRunId].usd, registryUsd = Σ child.costUsd, ratio =
 * telemetry / transcript. "Never invented numbers": a child whose transcript,
 * telemetry or registry cost is missing marks the sum's note instead of
 * counting it as $0.
 */
function buildReconciliation(fact, snapshot) {
  const children = Array.isArray(fact?.children) ? fact.children : [];
  let transcriptUsd = 0;
  let telemetryUsd = 0;
  let registryUsd = 0;
  const missing = [];
  let transcriptKnown = true;
  let telemetryKnown = true;
  let registryKnown = true;
  for (const child of children) {
    // The session id lives in the run's registry (TicketFacts does not carry
    // it); a missing registry entry simply leaves that child unverified.
    let sessionId = null;
    try {
      sessionId = readRegistry(child.runId)?.children?.[child.childId]?.sessionId ?? null;
    } catch {
      sessionId = null;
    }
    const priced = sessionId && child.worktree
      ? priceChildTranscripts({
          configDir: squadConfigDir(child.squad),
          cwd: child.worktree,
          sessionId,
        })
      : null;
    if (priced && priced.costUsd != null) transcriptUsd += priced.costUsd;
    else transcriptKnown = false;
    const run = child.telemetryRunId != null ? snapshot?.runs?.[child.telemetryRunId] : null;
    if (run && run.usd != null) telemetryUsd += run.usd;
    else telemetryKnown = false;
    if (child.costUsd != null) registryUsd += child.costUsd;
    else registryKnown = false;
  }
  if (!transcriptKnown) missing.push("transcript cost unknown for at least one child");
  if (!telemetryKnown) missing.push("telemetry cost unknown for at least one child");
  if (!registryKnown) missing.push("registry cost unknown for at least one child");
  return {
    transcriptUsd,
    telemetryUsd,
    registryUsd,
    ratio: transcriptUsd > 0 ? telemetryUsd / transcriptUsd : null,
    note: missing.length ? missing.join("; ") : null,
  };
}

// The detail route re-derives reconciliation on every paint; priceChildTranscripts
// reads the child's whole transcript, so the result is memoized for 60 s keyed
// by the ticket's children (childId + turns count + last endedAt) and the
// snapshot generation — a new child, another turn or a fresh snapshot recomputes.
const RECONCILIATION_TTL_MS = 60_000;
const reconciliationMemo = new Map(); // cacheKey → { value, at }

function reconciliationFor(fact, snapshot) {
  const children = Array.isArray(fact?.children) ? fact.children : [];
  const key = [
    fact?.taskId ?? "",
    ...children.map((c) => `${c.childId}:${(Array.isArray(c.turns) ? c.turns.length : 0)}:${c.endedAt ?? ""}`),
    snapshot?.computedAt ?? "",
  ].join("|");
  const now = Date.now();
  const hit = reconciliationMemo.get(key);
  if (hit && now - hit.at < RECONCILIATION_TTL_MS) return hit.value;
  const value = buildReconciliation(fact, snapshot);
  reconciliationMemo.set(key, { value, at: now });
  for (const [k, v] of reconciliationMemo) {
    if (now - v.at >= RECONCILIATION_TTL_MS) reconciliationMemo.delete(k);
  }
  return value;
}

/** decodeURIComponent that reports a malformed sequence instead of throwing. */
const decodeId = (raw) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

// ── the routes ───────────────────────────────────────────────────────────────

/** Spec §8 staleness, computed from the snapshot's computedAt. */
const staleOf = (computedAt, now) =>
  computedAt == null ? true : now - Date.parse(computedAt) > STALE_AFTER_MS;

/**
 * Handle a Work / Costs route. Returns true when the request was handled
 * (the caller returns immediately), false when it is not one of ours.
 */
export async function handleWorkRoute(req, res, url, ctx) {
  const method = req.method;
  const path = url.pathname;
  const { readJsonBody, respondBodyError, json, log } = ctx;
  const workspace = workWorkspace();

  // GET /api/work/tickets?milestone=&priority= — the board payload.
  if (method === "GET" && path === "/api/work/tickets") {
    const filters = {
      milestone: url.searchParams.get("milestone"),
      priority: url.searchParams.get("priority"),
    };
    const facts = ticketFacts();
    const queuePayload = await ctx.linearQueue(workspace);
    // buildBoardPayload iterates the queue as the Ready column's items —
    // the tasks array, not the payload envelope.
    const queue = Array.isArray(queuePayload?.tasks) ? queuePayload.tasks : [];
    const { states, meta } = await linearStatesFor(facts.map((f) => f.taskId));
    const cost = getCostSnapshot();
    const now = Date.now();
    const payload = buildBoardPayload({
      facts,
      queue,
      linearStates: states,
      costReport: cost.snapshot?.windows?.all ?? null,
      costMeta: {
        computedAt: cost.computedAt,
        // While the FIRST snapshot is still computing there is nothing stale to
        // report — the state already says "computing" (consistent with
        // /api/costs, which answers stale:false there). An error with no
        // snapshot stays stale: nothing computed, nothing fresh.
        stale: cost.snapshot ? staleOf(cost.computedAt, now) : cost.state !== "computing",
        state: cost.state,
      },
      linearMeta: meta,
      filters,
      now,
    });
    json(res, 200, payload);
    log(method, path, 200);
    return true;
  }

  // GET /api/work/tickets/:id/start-preview — the hand-off text for the
  // confirm dialog. The issue comes from Linear (with its description); a
  // Linear failure is a 502, never a crash.
  let m = path.match(/^\/api\/work\/tickets\/([^/]+)\/start-preview$/);
  if (method === "GET" && m) {
    const id = decodeId(m[1]);
    if (id === null) {
      json(res, 400, { error: "bad-id" });
      log(method, path, 400);
      return true;
    }
    if (!TICKET_ID_RE.test(id)) {
      json(res, 400, { error: `not a ticket id: ${id}` });
      log(method, path, 400);
      return true;
    }
    let issue;
    try {
      issue = await fetchIssue(id, workspace);
    } catch (err) {
      json(res, 502, { error: `linear failed: ${String(err?.message ?? err)}` });
      log(method, path, 502);
      return true;
    }
    if (!issue) {
      json(res, 404, { error: `linear issue not found: ${id}` });
      log(method, path, 404);
      return true;
    }
    const payload = {
      text: startText(issue, { maxChars: START_TEXT_MAX_CHARS }),
      issue: { identifier: issue.identifier, title: issue.title, url: issue.url },
      delivery: hostBase() ? "supervisor" : "cockpit",
    };
    json(res, 200, payload);
    log(method, path, 200);
    return true;
  }

  // POST /api/work/tickets/:id/start { text } — the confirm dialog's send.
  // The Cockpit's write guards, the Cockpit's body cap, then the one rule
  // that makes the endpoint safe: the text must be the preview's own
  // hand-off text for THIS ticket (it starts with "Start ticket <ID>"), so a
  // stray body can never send an arbitrary message as a ticket start.
  // Everything else is the /api/supervisor/message forward, unchanged.
  m = path.match(/^\/api\/work\/tickets\/([^/]+)\/start$/);
  if (method === "POST" && m) {
    if (!writeGuards(req, res, path, ctx)) return true;
    const id = decodeId(m[1]);
    if (id === null) {
      json(res, 400, { error: "bad-id" });
      log(method, path, 400);
      return true;
    }
    if (!TICKET_ID_RE.test(id)) {
      json(res, 400, { error: `not a ticket id: ${id}` });
      log(method, path, 400);
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      json(res, 400, { error: "text (string) is required" });
      log(method, path, 400);
      return true;
    }
    if (!body.text.startsWith(`Start ticket ${id}`)) {
      json(res, 400, { error: `text must start with "Start ticket ${id}"` });
      log(method, path, 400);
      return true;
    }
    await forwardMessageToHost(res, ctx, path, body.text);
    return true;
  }

  // GET /api/work/tickets/:id — the ticket detail. A touched ticket answers
  // from its facts; a queue-only id (open in Linear, never touched by Fenix)
  // answers with the issue and an empty timeline; an id that is neither
  // known touched nor in the queue is a 404.
  m = path.match(/^\/api\/work\/tickets\/([^/]+)$/);
  if (method === "GET" && m) {
    const id = decodeId(m[1]);
    if (id === null) {
      json(res, 400, { error: "bad-id" });
      log(method, path, 400);
      return true;
    }
    if (!TICKET_ID_RE.test(id)) {
      json(res, 400, { error: `not a ticket id: ${id}` });
      log(method, path, 400);
      return true;
    }
    const facts = ticketFacts();
    const fact = facts.find((f) => f.taskId === id) ?? null;
    if (!fact) {
      const queuePayload = await ctx.linearQueue(workspace);
      const inQueue = (Array.isArray(queuePayload?.tasks) ? queuePayload.tasks : []).some((t) => t.identifier === id);
      if (!inQueue) {
        json(res, 404, { error: `unknown ticket: ${id}` });
        log(method, path, 404);
        return true;
      }
    }
    const { states } = await linearStatesFor([id]);
    let issue = null;
    try {
      issue = await fetchIssue(id, workspace);
    } catch {
      issue = null; // Linear down → the detail still answers from Fenix data
    }
    const cost = getCostSnapshot();
    const payload = buildTicketDetail({
      // A queue-only id (open in Linear, never touched by Fenix) has no
      // facts yet — the detail is the issue over an empty facts record.
      facts: fact ?? {
        taskId: id,
        runIds: [],
        firstActivityAt: null,
        lastActivityAt: null,
        children: [],
        rounds: 0,
        verdicts: [],
        gates: [],
        interventions: 0,
        interventionRows: [],
      },
      linearState: states[id] ?? null,
      issue,
      costReport: cost.snapshot?.windows?.all ?? null,
      reconciliation: fact ? reconciliationFor(fact, cost.snapshot) : null,
    });
    json(res, 200, payload);
    log(method, path, 200);
    return true;
  }

  // GET /api/costs?period=7d|30d|all and GET /api/quality?period= — the
  // Costs & quality payloads (FOC-785). The period is validated here (400
  // for anything else); absent it defaults to 30d, the toggle's middle. The
  // cost snapshot triggers its first refresh on this request and answers
  // "computing" until the child lands — never a blocked event loop.
  if (method === "GET" && (path === "/api/costs" || path === "/api/quality")) {
    const period = url.searchParams.get("period") || "30d";
    if (!["7d", "30d", "all"].includes(period)) {
      json(res, 400, { error: `unknown period: ${period} (expected "7d", "30d" or "all")` });
      log(method, path, 400);
      return true;
    }
    const facts = ticketFacts();
    const snapshot = snapshotForPayloads();
    let payload;
    if (path === "/api/costs") {
      payload = buildCostsPayload({ snapshot, facts, period, now: Date.now() });
    } else {
      // landingYield needs the Linear state types; skipped while the snapshot
      // is still computing/erroring — the payload's signals are all null then.
      const linearStates = snapshot?.state === "ok"
        ? (await linearStatesFor(facts.map((f) => f.taskId))).states
        : {};
      payload = buildQualityPayload({ snapshot, facts, linearStates, period, now: Date.now() });
    }
    json(res, 200, payload);
    log(method, path, 200);
    return true;
  }

  return false;
}

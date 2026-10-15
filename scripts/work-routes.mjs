// scripts/work-routes.mjs — the Work board and Costs & quality routes
// (FOC-784/785, plan slice W5): GET /api/work/tickets, the ticket detail,
// the Start preview/confirm pair, the publish preview/act trio (FOC-788:
// publish-preview, push, pr), GET /api/costs and GET /api/quality.
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

import { hostBase, hostRequest, FAST_TIMEOUT_MS, SLOW_TIMEOUT_MS } from "./supervisor-host-client.mjs";
import { graphql } from "./linear-client.mjs";
import { readRegistry, supervisorStateHome } from "./supervisor-lib.mjs";
import { squadConfigDir } from "./fenix-paths.mjs";
import { resolveTaskKey } from "./task-sessions.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import {
  buildBoardPayload,
  buildTicketDetail,
  collectTicketFacts,
  deriveStage,
  fetchLinearStates,
  startText,
  TICKET_ID_RE,
} from "./work-board.mjs";
import { buildCostsPayload, buildQualityPayload } from "./cost-quality.mjs";
import { forwardMessageToHost, writeGuards } from "./cockpit-routes.mjs";
import { buildPublishPreview, verifyConfirmToken } from "./publish-actions.mjs";
import {
  buildPublishRecord,
  composePrBody,
  composePrTitle,
  createPullRequest,
  pushBranch,
  recordPublishAction,
} from "./publish-exec.mjs";

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

/**
 * The canonical taskKey for a Linear issue: `workspace:issueId` from the
 * SERVER-side identity (resolveTaskKey). The workspace is this route's own
 * (FENIX_WORK_WORKSPACE / jointhubs) and the issueId is the id the SERVER
 * fetched from Linear — never a client-supplied taskKey and never derived
 * from the title. Throws on a non-canonical id; callers map that to 400.
 */
const taskKeyOf = (issue) => resolveTaskKey({ workspace: workWorkspace(), issueId: issue.id ?? issue.identifier });

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
    // The canonical identity, when the issue carries it (the taskKey the Start
    // flow will bind): the preview tells the UI where the cockpit will live
    // before anything is started. A fetchIssue without an id (older fixture)
    // simply omits the block — the Start POST re-derives it.
    if (issue.id && issue.identifier) {
      payload.identity = {
        workspace,
        issueId: issue.identifier,
        taskKey: taskKeyOf(issue),
      };
      payload.cockpitUrl = `/work/${encodeURIComponent(taskKeyOf(issue))}/cockpit`;
    }
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

  // GET /api/work/tickets/:id/publish-preview?action=push|pr — what the Push
  // branch / Open PR confirm dialog shows (FOC-788, plan §4.1): the discovered
  // checkout, the diff summary, the local checks state (the run's verdicts —
  // never GitHub checks, decision 2) and a confirmToken bound to all of it.
  // Read-only and safe for the UI to poll. No checkout answers 404 no-checkout
  // with the reason and NO action is offered — fail-closed is the design, not
  // an error path.
  m = path.match(/^\/api\/work\/tickets\/([^/]+)\/publish-preview$/);
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
    const preview = buildPublishPreview({
      ticket: id,
      action: url.searchParams.get("action") ?? "",
      // ONE ticket's facts (children + verdicts), never the whole sweep —
      // an untouched ticket carries none and honestly yields no-checkout.
      facts: ticketFacts().find((f) => f.taskId === id) ?? { children: [] },
    });
    if (!preview.ok) {
      const status = preview.error === "no-checkout" ? 404 : 400;
      json(res, status, { error: preview.error, reason: preview.reason });
      log(method, path, status);
      return true;
    }
    json(res, 200, preview);
    log(method, path, 200);
    return true;
  }

  // POST /api/work/tickets/:id/push | .../pr { confirmToken, actor, actorId }
  // — the confirm dialog's send for a publish (FOC-788, plan §4.2). The
  // Cockpit's write guards and body cap first (the `start` route's shape),
  // then the rule that makes the endpoint safe: the checkout is re-derived
  // NOW and the body must carry the confirmToken for the CURRENT state — a
  // stray or replayed body can never act, and a moved head answers 409
  // stale-preview before any executor runs. `actor` (human | ai) is required
  // and recorded verbatim (decision 3). The audit trio (JSONL, telemetry,
  // Linear comment) is written before the response returns, failures included
  // (plan §4.3) — never automatic, never merge.
  m = path.match(/^\/api\/work\/tickets\/([^/]+)\/(push|pr)$/);
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
    const action = m[2];
    let body;
    try {
      body = await readJsonBody(req, BODY_CAP);
    } catch (err) {
      log(method, path, respondBodyError(res, err));
      return true;
    }
    if (typeof body.confirmToken !== "string" || !body.confirmToken) {
      json(res, 400, { error: "confirmToken (string) is required" });
      log(method, path, 400);
      return true;
    }
    if (body.actor !== "human" && body.actor !== "ai") {
      json(res, 400, { error: 'actor must be "human" or "ai"' });
      log(method, path, 400);
      return true;
    }
    if (typeof body.actorId !== "string" || !body.actorId.trim()) {
      json(res, 400, { error: "actorId (string) is required" });
      log(method, path, 400);
      return true;
    }
    const preview = buildPublishPreview({
      ticket: id,
      action,
      facts: ticketFacts().find((f) => f.taskId === id) ?? { children: [] },
    });
    if (!preview.ok) {
      const status = preview.error === "no-checkout" ? 404 : 400;
      json(res, status, { error: preview.error, reason: preview.reason });
      log(method, path, status);
      return true;
    }
    const verdict = verifyConfirmToken({ action, ticket: id, checkout: preview.checkout, token: body.confirmToken });
    if (!verdict.ok) {
      const status = verdict.error === "stale-preview" ? 409 : 400;
      json(res, status, { error: verdict.error, reason: verdict.reason });
      log(method, path, status);
      return true;
    }

    const { checkout, diff } = preview;
    const actor = body.actor;
    const actorId = body.actorId.trim();
    let outcome;
    if (action === "push") {
      outcome = pushBranch({ checkout });
    } else {
      // Best effort — Linear being down must never block a publish; the PR
      // title falls back to the published head (composePrTitle).
      let title = null;
      try {
        const issue = await fetchIssue(id, workspace);
        title = typeof issue?.title === "string" ? issue.title : null;
      } catch {
        title = null;
      }
      outcome = await createPullRequest({
        checkout,
        title: composePrTitle({ ticket: id, title, head: checkout.head }),
        body: composePrBody({ ticket: id, head: checkout.head, base: checkout.base, diff, actor, actorId }),
      });
    }
    const ok = outcome.ok === true;
    const record = buildPublishRecord({
      ticket: id,
      action,
      checkout,
      diff,
      actor,
      actorId,
      confirmToken: body.confirmToken,
      ok,
      error: ok ? null : outcome.error,
      prUrl: ok ? outcome.prUrl ?? null : null,
    });
    const { audit } = await recordPublishAction({ record });
    for (const [sink, result] of Object.entries(audit)) {
      if (result?.ok === false) console.error(`[work] publish ${action} ${id}: ${sink} sink refused: ${result.error}`);
    }
    if (!ok) {
      // 502: the git/API side refused. The detail text is scrubbed of the
      // token at the executor (scrubSecret); the error name is the contract.
      json(res, 502, { error: outcome.error, detail: outcome.detail ?? null });
      log(method, path, 502);
      return true;
    }
    // head is the published SHA (the record's identity); the PR's `head`
    // field already carries the branch name at GitHub.
    json(res, 200, {
      ok: true,
      action,
      actor,
      head: checkout.head,
      ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
    });
    log(method, path, 200);
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

// ── the task-map corpus (P4 slice) ───────────────────────────────────────────
//
// loadTaskMapCorpus assembles the semantic task map's input corpus from the
// SAME sources the board serves: the tickets Fenix touched in the last 30
// days (ticketFacts) plus the open Ready column of the Linear queue (the
// shared linearQueue getter — the same cache the board reads). One task per
// canonical identity; identity is resolveTaskKey (the Start flow's resolver)
// over the SERVER-fetched issue — a failed fetch is counted "unavailable",
// never faked from the display identifier.
//
// Read-only and bounded: one small GraphQL issue fetch per selected id
// (title + description only — never transcripts, never Thoughtmap text),
// capped at TASK_MAP_CORPUS_CAP ids with an explicit warning when the board
// holds more. No Linear writes anywhere on this path. Cost and duration ride
// along when known (the cost snapshot's all window, summed child turn time)
// — unknown stays null, never a zero.

export const TASK_MAP_CORPUS_CAP = 200;

// The description cap handed to the embedder: the map needs the gist, not the
// whole document (bounded input, bounded cache entries).
const TASK_MAP_DESCRIPTION_CAP_CHARS = 8000;

/** Summed agent time across a fact's completed child turns; null when none. */
function corpusDurationMs(fact) {  let total = 0;
  let any = false;
  for (const child of Array.isArray(fact?.children) ? fact.children : []) {
    for (const turn of Array.isArray(child?.turns) ? child.turns : []) {
      const a = Date.parse(turn?.startedAt ?? "");
      const b = Date.parse(turn?.endedAt ?? "");
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        total += b - a;
        any = true;
      }
    }
  }
  return any ? total : null;
}

/**
 * The ticket's cost row from the snapshot's window — the same shape
 * work-board.mjs's internal ticketCostOf reads ({ tickets: [{ taskId,
 * totalUsd, … }] }); mirrored here because that helper is not exported and
 * work-board is outside this slice. Unknown stays null, never a zero.
 */
function corpusCostOf(costReport, taskId) {
  const row = costReport?.tickets?.find((t) => t.taskId === taskId);
  if (!row) return null;
  return { childrenUsd: row.childrenUsd ?? 0, supervisorUsd: row.supervisorUsd ?? 0, totalUsd: row.totalUsd ?? 0 };
}

/**
 * The task-map corpus for one workspace: `{ workspace, tasks, unavailable,
 * requested, cap, truncated, warning }`. `tasks` carries exactly the shape
 * scripts/task-map.mjs validates (taskKey/taskId/title/description/stage/
 * labels as NAMES/costUsd/durationMs). `unavailable` lists the ids that could
 * not be honestly resolved, with a reason — the map never invents a point
 * for them.
 */
export async function loadTaskMapCorpus({
  workspace,
  linearQueue,
  cap = TASK_MAP_CORPUS_CAP,
  issueFetch = null, // test seam; default is the module's fetchIssue (fake fixture in tests)
  statesLookup = null, // test seam; default is the module's linearStatesFor
  costReport = null, // test seam; default is the live cost snapshot's all window
} = {}) {
  if (typeof linearQueue !== "function") {
    throw new Error("loadTaskMapCorpus needs a linearQueue getter");
  }
  const ws = workspace || workWorkspace();
  const facts = ticketFacts();
  const queuePayload = await linearQueue(ws);
  const queue = Array.isArray(queuePayload?.tasks) ? queuePayload.tasks : [];

  // The board's composition, in the board's order: touched tickets first
  // (facts are lastActivity desc), then the open Ready items the board would
  // show — completed/canceled queue rows are never Ready. A touched id the
  // queue also holds is never duplicated.
  const touched = new Set(facts.map((f) => f.taskId));
  const ids = [...facts.map((f) => f.taskId)];
  for (const item of queue) {
    if (!item?.identifier || touched.has(item.identifier)) continue;
    if (item.stateType === "completed" || item.stateType === "canceled") continue;
    ids.push(item.identifier);
  }

  const requested = ids.length;
  const truncated = requested > cap;
  const selected = truncated ? ids.slice(0, cap) : ids;

  const fetchOne = issueFetch ?? fetchIssue;
  const { states } = await (statesLookup ? statesLookup(selected) : linearStatesFor(selected));
  const costRows = costReport ?? getCostSnapshot().snapshot?.windows?.all ?? null;

  const tasks = [];
  const unavailable = [];
  for (const id of selected) {
    let issue = null;
    try {
      issue = await fetchOne(id, ws);
    } catch {
      issue = null; // a Linear failure for one id never breaks the corpus
    }
    if (!issue) {
      unavailable.push({ taskId: id, reason: "linear_unavailable" });
      continue;
    }
    // Identity ONLY from the server-fetched issue, through the Start flow's
    // resolver — the display identifier alone never invents a taskKey.
    let taskKey = null;
    try {
      taskKey = resolveTaskKey({ workspace: ws, issueId: issue.id ?? issue.identifier });
    } catch {
      taskKey = null;
    }
    if (!taskKey) {
      unavailable.push({ taskId: id, reason: "no_canonical_identity" });
      continue;
    }
    const state = states[id] ?? null;
    const fact = facts.find((f) => f.taskId === id) ?? null;
    const cost = corpusCostOf(costRows, id);
    tasks.push({
      taskKey,
      taskId: id,
      title: typeof issue.title === "string" ? issue.title : "",
      description: typeof issue.description === "string"
        ? issue.description.slice(0, TASK_MAP_DESCRIPTION_CAP_CHARS)
        : "",
      stage: fact ? deriveStage(fact, state) : "ready",
      labels: (Array.isArray(state?.labels) ? state.labels : [])
        .map((l) => (typeof l?.name === "string" ? l.name : ""))
        .filter(Boolean),
      costUsd: cost?.totalUsd ?? null,
      durationMs: fact ? corpusDurationMs(fact) : null,
    });
  }

  return {
    workspace: ws,
    tasks,
    unavailable,
    requested,
    cap,
    truncated,
    warning: truncated
      ? `the corpus is capped at ${cap} of ${requested} tickets — the map covers the most recently touched tickets and the first Ready items only`
      : null,
  };
}

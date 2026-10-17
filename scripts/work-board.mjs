// scripts/work-board.mjs — the Work board library (FOC-784, plan §FOC-784).
//
// What the dashboard's /api/work/* routes (slice W5) will serve, as pure data:
// the tickets Fenix touched in the last `days` (children, verdict rounds,
// gates, interventions), the untouched Ready column from the existing Linear
// queue, per-ticket stage/flags/cost, and the ticket detail with its timeline
// and evidence. One read layer (collectTicketFacts) + pure derivations; Linear
// goes through the injectable graphqlFor (fetchLinearStates), cost numbers come
// from a ticketCostReport the caller already computed — this module never
// invents a number (spec principle 1: unpriced stays "unknown").
//
// Never throws on one bad run dir: the run is skipped, or the unreadable bit is
// dropped where it cannot be attributed to a ticket. A corrupt children.json
// skips the run (readRegistry throws; the Cockpit parity rule).
//
// Path note: run discovery and the per-run readers derive their paths from the
// `stateHome` argument. When that argument IS the env seam
// (LA_SUPERVISOR_STATE_HOME — the default, and what the routes and tests use),
// registry and verdict reads go through the supervisor-lib helpers W1 is bound
// to (readRegistry, roundsFor, verdictPath — env-welded by design); when a
// caller passes a different home those helpers would read the wrong tree, so
// equivalent stateHome-parameterised readers with identical tolerance run
// instead. The same split the Cockpit documents, kept here so both modes stay
// honest. Gates, triage and edits.jsonl have no exported lib reader (the
// Cockpit re-derives them too), so they always read against `home`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readRegistry, roundsFor, supervisorStateHome, verdictPath } from "./supervisor-lib.mjs";
import { graphql, workspaceEnabled } from "./linear-client.mjs";

const DAY_MS = 86_400_000;

// The ticket-id shape the board speaks (task prompt): team prefix + number.
// Anything else — `SUP:` pseudo ids, uuids, prose — is not a Fenix ticket.
export const TICKET_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export const BOARD_COLUMNS = ["ready", "plan", "dev", "review", "test", "landed"];

// Squad → column. `cadence` (SQUAD_ALLOWLIST) is real work but not a board
// stage; an unknown squad means dev-shaped work until proven otherwise.
const STAGE_SQUADS = { plan: "plan", dev: "dev", review: "review", test: "test" };

const ANSWER_KINDS = ["gate-answer", "hold-answer", "ask-answer"];

const LINEAR_STATES_TTL_MS = 60_000;
const LINEAR_CHUNK = 50; // aliases per GraphQL request

// ── small helpers ────────────────────────────────────────────────────────────

const isTicketId = (value) => typeof value === "string" && TICKET_ID_RE.test(value);

const isoMs = (value) => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function mtimeMsOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Latest child by startedAt (missing timestamps sort last, first one wins ties). */
function latestChild(facts) {
  let latest = null;
  let latestMs = -Infinity;
  for (const child of facts.children) {
    const key = isoMs(child.startedAt) ?? Number.NEGATIVE_INFINITY;
    if (latest === null || key > latestMs) {
      latest = child;
      latestMs = key;
    }
  }
  return latest;
}

// ── per-run readers (stateHome-parameterised; see the path note above) ───────

/** readRegistry parity, against `home`: corrupt → ok:false (caller skips the run). */
function readRegistryHome(home, runId) {
  const path = join(home, runId, "children.json");
  if (!existsSync(path)) return { ok: true, registry: { runId, children: {}, rounds: {} } };
  const parsed = readJsonFile(path);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, registry: null };
  }
  return { ok: true, registry: { runId, children: {}, rounds: {}, ...parsed.value } };
}

/** roundsFor parity, against `home`: same prefix, same unreadable-not-absent rule. */
function roundsForHome(home, runId, taskId) {
  const dir = join(home, runId, "verdicts");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const prefix = `${String(taskId).toLowerCase()}-round`;
  return files
    .filter((f) => f.startsWith(prefix))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        return { round: Number(f.slice(prefix.length, -5)) || 0, unreadable: true };
      }
    })
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
}

const verdictPathHome = (home, runId, taskId, round) =>
  join(home, runId, "verdicts", `${String(taskId).toLowerCase()}-round${round}.json`);

function triageIssueHome(home, runId) {
  const parsed = readJsonFile(join(home, runId, "triage.json"));
  const issue = parsed.ok ? parsed.value?.issue : null;
  return typeof issue === "string" && isTicketId(issue.trim()) ? issue.trim() : null;
}

/** Every readable gate file in the run; unreadable ones are skipped (W1 rule). */
function scanGatesHome(home, runId) {
  const dir = join(home, runId, "gates");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const gates = [];
  for (const file of files) {
    const parsed = readJsonFile(join(dir, file));
    if (parsed.ok && parsed.value && typeof parsed.value === "object") gates.push(parsed.value);
  }
  return gates;
}

/** readEdits parity, against `home`: seq-ordered, torn lines skipped. */
function readEditsHome(home, runId) {
  const path = join(home, runId, "edits.jsonl");
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object") rows.push(row);
    } catch {
      /* torn line — the writer crashed mid-append; skip */
    }
  }
  return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** Run ids whose children.json or triage.json was touched within the window, newest first. */
function recentRunIdsHome(home, windowStartMs) {
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const newest = Math.max(
      mtimeMsOf(join(home, entry.name, "children.json")),
      mtimeMsOf(join(home, entry.name, "triage.json")),
    );
    if (newest >= windowStartMs && newest > 0) runs.push({ runId: entry.name, newest });
  }
  return runs.sort((a, b) => b.newest - a.newest).map((r) => r.runId);
}

// ── 1. collectTicketFacts ────────────────────────────────────────────────────

const emptyFacts = (taskId) => ({
  taskId,
  runIds: [],
  firstActivityAt: null,
  lastActivityAt: null,
  children: [],
  rounds: 0,
  verdicts: [],
  gates: [],
  interventions: 0,
  interventionRows: [],
});

const childFact = (runId, child) => {
  const turns = Array.isArray(child.turns) ? child.turns : [];
  return {
    runId,
    childId: child.childId ?? null,
    squad: child.squad ?? null,
    status: child.status ?? null,
    turns,
    telemetryRunId: child.telemetryRunId ?? null,
    branch: child.branch ?? null,
    baseRevision: child.baseRevision ?? null,
    worktree: child.worktree ?? null,
    costUsd: typeof child.costUsd === "number" ? child.costUsd : null,
    costSource: child.costSource ?? null,
    // Registry children carry no startedAt/endedAt of their own in the real
    // shape — the start is the FIRST turn's startedAt, the end the LAST
    // turn's endedAt. Without this fallback every child sorts as "missing
    // timestamp" and deriveStage reads the first child it sees (a ticket with
    // dev-1 then review-2 showed as "dev" on the acceptance stack).
    startedAt: child.startedAt ?? turns[0]?.startedAt ?? null,
    endedAt: child.endedAt ?? turns[turns.length - 1]?.endedAt ?? null,
    tee: child.tee ?? null,
  };
};

/** The verdict value the record carries, or UNKNOWN when the shape says nothing we know. */
const verdictOf = (record) => {
  const v = String(record?.verdict ?? "").toUpperCase();
  return v === "PASS" || v === "FAIL" ? v : "UNKNOWN";
};

/**
 * Tickets Fenix touched, from the supervisor state home. One bad run never
 * breaks the sweep: corrupt registry → run skipped, unreadable files dropped.
 */
export function collectTicketFacts({ stateHome = supervisorStateHome(), days = 30, now = Date.now() } = {}) {
  const home = stateHome ?? supervisorStateHome();
  const useLib = home === supervisorStateHome();
  const windowStart = now - days * DAY_MS;
  const tickets = new Map();

  for (const runId of recentRunIdsHome(home, windowStart)) {
    let registry;
    if (useLib) {
      try {
        registry = readRegistry(runId);
      } catch {
        continue; // corrupt children.json — the run is skipped, never invented
      }
    } else {
      const parsed = readRegistryHome(home, runId);
      if (!parsed.ok) continue;
      registry = parsed.registry;
    }

    const childById = new Map();
    const runTickets = new Set(); // taskIds this run contributes children/triage for
    const newChildren = new Map(); // taskId → childFacts from THIS run
    for (const child of Object.values(registry.children ?? {})) {
      if (!child || typeof child !== "object") continue;
      const taskId = child.taskId;
      if (!isTicketId(taskId)) continue; // SUP: pseudo ids and odd shapes are not tickets
      childById.set(child.childId, child);
      if (!runTickets.has(taskId)) {
        runTickets.add(taskId);
        newChildren.set(taskId, []);
      }
      newChildren.get(taskId).push(childFact(runId, child));
    }

    const triageIssue = triageIssueHome(home, runId);
    if (isTicketId(triageIssue)) runTickets.add(triageIssue);

    // Gates: attributed via the record's own taskId, else its child's taskId,
    // else the triage issue when exactly one ticket lives in this run.
    const readableGates = scanGatesHome(home, runId);
    const singleTicket = runTickets.size === 1 ? [...runTickets][0] : null;
    const gateById = new Map(readableGates.map((g) => [g.gateId, g]));
    const gatesByTicket = new Map();
    for (const gate of readableGates) {
      const taskId = isTicketId(gate.taskId)
        ? gate.taskId
        : (childById.get(gate.childId)?.taskId ?? singleTicket);
      if (!taskId || !runTickets.has(taskId)) continue;
      if (!gatesByTicket.has(taskId)) gatesByTicket.set(taskId, []);
      gatesByTicket.get(taskId).push({
        gateId: gate.gateId ?? null,
        status: gate.status ?? null,
        kind: gate.kind ?? null,
        childId: gate.childId ?? null,
        createdAt: gate.createdAt ?? null,
        answeredAt: gate.answer?.answeredAt ?? null,
      });
    }

    // Interventions: answer rows in edits.jsonl (recordAnswerRow's shape). A
    // gate answer maps through the gate it answered; hold and ask answers name
    // no child, so they land on the triage ticket when the run has exactly one.
    const rowsByTicket = new Map();
    for (const row of readEditsHome(home, runId)) {
      if (!ANSWER_KINDS.includes(row.type)) continue;
      let taskId = null;
      if (row.type === "gate-answer") {
        const gateId = String(row.path ?? "").replace(/^gates\//, "").replace(/\.json$/, "");
        const gate = gateById.get(gateId);
        if (gate) {
          taskId = isTicketId(gate.taskId)
            ? gate.taskId
            : (childById.get(gate.childId)?.taskId ?? singleTicket);
        }
      }
      if (!taskId) taskId = singleTicket;
      if (!taskId || !runTickets.has(taskId)) continue;
      if (!rowsByTicket.has(taskId)) rowsByTicket.set(taskId, []);
      rowsByTicket.get(taskId).push({ at: row.ts ?? null, kind: row.type, path: row.path ?? null });
    }

    // Verdicts per ticket in this run (roundsFor semantics; unreadable → UNKNOWN).
    const verdictsByTicket = new Map();
    for (const taskId of runTickets) {
      const records = useLib ? roundsFor(runId, taskId) : roundsForHome(home, runId, taskId);
      if (!records.length) continue;
      verdictsByTicket.set(
        taskId,
        records.map((record) => ({
          round: typeof record.round === "number" ? record.round : 0,
          verdict: record.unreadable ? "UNKNOWN" : verdictOf(record),
          at: record.recordedAt ?? null,
          path: useLib
            ? verdictPath(runId, taskId, record.round ?? 0)
            : verdictPathHome(home, runId, taskId, record.round ?? 0),
        })),
      );
    }

    for (const taskId of runTickets) {
      if (!tickets.has(taskId)) tickets.set(taskId, emptyFacts(taskId));
      const facts = tickets.get(taskId);
      facts.runIds.push(runId);
      facts.children.push(...(newChildren.get(taskId) ?? []));
      facts.gates.push(...(gatesByTicket.get(taskId) ?? []));
      facts.verdicts.push(...(verdictsByTicket.get(taskId) ?? []));
      facts.interventionRows.push(...(rowsByTicket.get(taskId) ?? []));
    }
  }

  for (const facts of tickets.values()) {
    facts.rounds = facts.verdicts.length;
    facts.interventions = facts.interventionRows.length;
    const stamps = [
      ...facts.children.flatMap((c) => [c.startedAt, c.endedAt, ...c.turns.flatMap((t) => [t.startedAt, t.endedAt])]),
      ...facts.verdicts.map((v) => v.at),
      ...facts.gates.flatMap((g) => [g.createdAt, g.answeredAt]),
      ...facts.interventionRows.map((r) => r.at),
    ]
      .map(isoMs)
      .filter((ms) => ms !== null);
    if (stamps.length) {
      facts.firstActivityAt = new Date(Math.min(...stamps)).toISOString();
      facts.lastActivityAt = new Date(Math.max(...stamps)).toISOString();
    }
  }

  return [...tickets.values()].sort((a, b) =>
    String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")),
  );
}

// ── 2. deriveStage ───────────────────────────────────────────────────────────

/** Landed beats everything (Linear says done); else the latest child's squad; else Ready. */
export function deriveStage(facts, linearState) {
  if (linearState?.type === "completed") return "landed";
  const latest = latestChild(facts);
  if (!latest) return "ready";
  return STAGE_SQUADS[latest.squad] ?? "dev";
}

// ── 3. deriveFlags ───────────────────────────────────────────────────────────

/**
 * Flags the UI must be able to read without colour (spec §7): the text says it.
 * Stalled is deliberately absent — it needs tee-mtime silence probing, which is
 * a process-adjacent fact this pure module does not own; the Cockpit owns it.
 */
export function deriveFlags(facts) {
  const flags = [];
  for (const child of facts.children) {
    if (child.status === "running" || child.status === "starting") {
      flags.push({ kind: "live", text: `${child.childId} ${child.status}`, childId: child.childId });
    }
  }
  const pending = facts.gates.filter((g) => g.status === "pending");
  for (const gate of pending) {
    flags.push({ kind: "gate", text: `gate ${gate.gateId} pending`, childId: gate.childId });
  }
  const latest = latestChild(facts);
  if (latest?.status === "waiting_gate" && !pending.some((g) => g.childId === latest.childId)) {
    flags.push({ kind: "needs-you", text: `${latest.childId} waiting for you`, childId: latest.childId });
  }
  if (latest?.status === "crashed") {
    flags.push({ kind: "crashed", text: `${latest.childId} crashed`, childId: latest.childId });
  }
  return flags;
}

// ── 4. fetchLinearStates ─────────────────────────────────────────────────────

const defaultGraphqlFor = (workspace) => (query, vars) => graphql(query, vars, workspace);

// 60 s in-memory cache, keyed by the sorted id list — the same TTL the queue
// fetch uses, so the board never hammers Linear twice for one paint.
const cachedLinearStates = new Map(); // key → { states, fetchedAt, fetchedAtMs }

// Only sayable ids go into a query string: the ticket shape, and never quotes
// or newlines even if a caller hands us something wider.
const isSafeLinearId = (id) => typeof id === "string" && id.trim() !== "" && !/["\\\n\r]/.test(id);

// Label normalization (task contract): the payload carries { id, name, color }
// exactly — never more, never less. A label without a sayable name is not a
// label; id and color degrade to null rather than being dropped. Colors are
// validated to the hex forms Linear issues (#rgb, #rgba, #rrggbb, #rrggbbaa):
// anything else becomes null so the UI can never style from an arbitrary
// Linear-provided string.
const LABEL_COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;
const MAX_LABELS = 20; // the same cap the Linear queue query uses

export const normalizeLabel = (raw) => {
  if (typeof raw === "string") {
    const name = raw.trim();
    return name ? { id: null, name, color: null } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : null,
    name,
    color: typeof raw.color === "string" && LABEL_COLOR_RE.test(raw.color) ? raw.color : null,
  };
};

const normalizeLabels = (nodes) => {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const raw of nodes) {
    const label = normalizeLabel(raw);
    if (label) out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
};

const linearStateOf = (issue) => ({
  name: issue?.state?.name ?? null,
  type: issue?.state?.type ?? null,
  title: issue?.title ?? null,
  url: issue?.url ?? null,
  priority: {
    value: typeof issue?.priority === "number" ? issue.priority : 0,
    name: issue?.priorityLabel ?? null,
  },
  milestone: issue?.projectMilestone?.name ?? null,
  labels: normalizeLabels(issue?.labels?.nodes),
});

/**
 * A per-issue miss ("Entity not found: Issue"): Linear answered and this id is
 * simply not in that workspace. Not "Linear unavailable" — and never a reason
 * to drop the batch's siblings (FOC-815).
 */
const isIssueMiss = (message) =>
  /\bentity not found\b/i.test(String(message)) || /\bissue not found\b/i.test(String(message));

/**
 * The chunk ids a GraphQL error batch blames, when the batch's errors carry
 * per-error `path` (linear-client attaches the raw shapes as
 * `err.graphqlErrors`; a seam that does not leaves this null and the batch is
 * bisected instead). Any error that is not an issue miss, or any path that
 * does not name one of this chunk's aliases, makes the attribution unusable →
 * null.
 */
export function issueMissesOf(err, chunk) {
  const gqlErrors = err?.graphqlErrors;
  if (!Array.isArray(gqlErrors) || gqlErrors.length === 0) return null;
  const misses = [];
  for (const ge of gqlErrors) {
    if (!isIssueMiss(ge?.message)) return null;
    const path = Array.isArray(ge?.path) ? ge.path : null;
    const m = path?.length === 1 && typeof path[0] === "string" ? /^a(\d+)$/.exec(path[0]) : null;
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(n) || n < 0 || n >= chunk.length) return null;
    misses.push(chunk[n]);
  }
  return misses.length ? [...new Set(misses)] : null;
}

/**
 * Linear state (name/type/title/url/priority/milestone/labels) per identifier, one
 * batched alias request per chunk of ≤ 50 ids per workspace: jointhubs first,
 * then pisi for whatever jointhubs did not know (findIssueProject's order) —
 * the pisi pass only while the integration switch is on (FOC-772).
 * A request that fails with per-issue misses is retried without the missing
 * ids (attributed by error path) or bisected down to single ids when no paths
 * are usable — Linear nulls `data` for a whole batch over one unknown id, so
 * siblings must be re-asked, never discarded. A miss resolves to no state and
 * no error, exactly like a null alias. Real failures (auth, network, rate
 * limit) degrade gracefully: the states that did resolve come back, plus an
 * error string the caller shows ("Linear unavailable").
 */
export async function fetchLinearStates(identifiers, { graphqlFor = defaultGraphqlFor } = {}) {
  const ids = [...new Set((identifiers ?? []).filter(isSafeLinearId))];
  const key = ids.slice().sort().join("|");
  const hit = cachedLinearStates.get(key);
  if (hit && Date.now() - hit.fetchedAtMs < LINEAR_STATES_TTL_MS) {
    return { states: hit.states, error: null, fetchedAt: hit.fetchedAt };
  }

  const states = {};
  const errors = [];
  let fetchedAt = null;
  let remaining = ids;

  // Linear answered (200 — even a miss batch is an answer), so the lookup has
  // a fetch time. A transport-level failure never reaches this.
  const markFetched = () => {
    if (fetchedAt === null) fetchedAt = new Date().toISOString();
  };

  // FOC-772: the pisi leg exists only while the integration is on — with the
  // flag off the lookup is jointhubs-only (pisi-only ids resolve as misses,
  // like any unknown id; no lookup, no stop, no error row).
  for (const workspace of workspaceEnabled("pisi") ? [undefined, "pisi"] : [undefined]) {
    if (!remaining.length) break;
    const gql = graphqlFor(workspace);
    const label = workspace ?? "jointhubs";

    // Resolve one chunk in this workspace. Returns "ok" (keep going), "stop"
    // (this workspace is done without an error) or "failed" (a real failure
    // was recorded in `errors`).
    const resolveChunk = async (chunk) => {
      const aliases = chunk.map(
        (id, n) =>
          `a${n}: issue(id: ${JSON.stringify(id)}) { identifier title url priority priorityLabel state { name type } projectMilestone { name } labels(first: 20) { nodes { id name color } } }`,
      );
      let data;
      try {
        data = await gql(`query WorkBoard {\n  ${aliases.join(" ")}\n}`, {});
      } catch (err) {
        const message = err?.message ?? String(err);
        // A missing pisi key is not Linear being unavailable: linear-client's
        // graphql() refuses the request with this exact message BEFORE any
        // network call (chooseApiKey found nothing). Skip the pass quietly —
        // the lookup still succeeds with whatever jointhubs resolved.
        if (workspace === "pisi" && message.includes("LINEAR_API_KEY not set for workspace 'pisi'")) return "stop";

        // Per-issue misses: re-ask without the missing ids when the errors
        // name their aliases; bisect when they do not. Either way one unknown
        // id ends as a silent miss — it still gets its pisi chance below.
        const misses = issueMissesOf(err, chunk);
        if (misses) {
          markFetched();
          const retry = chunk.filter((id) => !misses.includes(id));
          return retry.length ? resolveChunk(retry) : "ok";
        }
        if (isIssueMiss(message)) {
          markFetched();
          if (chunk.length === 1) return "ok"; // one unknown id: a miss, like a null alias
          const mid = Math.ceil(chunk.length / 2);
          const first = await resolveChunk(chunk.slice(0, mid));
          return first === "ok" ? resolveChunk(chunk.slice(mid)) : first;
        }

        errors.push(`${label}: ${message}`);
        return "failed";
      }
      markFetched();
      chunk.forEach((id, n) => {
        const issue = data?.[`a${n}`];
        if (issue) states[id] = linearStateOf(issue);
      });
      return "ok";
    };

    // The pass walks a snapshot: `remaining` shrinks as ids resolve, and
    // indexing the shrinking list skipped everything past the first chunk's
    // resolution (with 51+ ids those were never asked in this workspace).
    const pass = remaining.slice();
    for (let i = 0; i < pass.length; i += LINEAR_CHUNK) {
      const chunk = pass.slice(i, i + LINEAR_CHUNK).filter((id) => !states[id]);
      if (!chunk.length) continue;
      const status = await resolveChunk(chunk);
      if (status !== "ok") break;
      remaining = remaining.filter((id) => !states[id]);
      if (!remaining.length) break;
    }
  }

  const error = errors.length ? errors.join("; ") : null;
  // Cache misses too (FOC-815): "this id has no state here" is an answer, and
  // without caching a permanently unknown id re-ran the whole lookup — batch,
  // retry chain and all — on every board paint.
  if (error === null) {
    cachedLinearStates.set(key, { states, fetchedAt, fetchedAtMs: Date.now() });
  }
  return { states, error, fetchedAt };
}

// ── 5. buildBoardPayload ─────────────────────────────────────────────────────

const ticketCostOf = (costReport, taskId) => {
  const row = costReport?.tickets?.find((t) => t.taskId === taskId);
  if (!row) return null;
  return { childrenUsd: row.childrenUsd ?? 0, supervisorUsd: row.supervisorUsd ?? 0, totalUsd: row.totalUsd ?? 0 };
};

// A big finite rank rather than Infinity: Infinity - Infinity is NaN, and a
// comparator returning NaN is unspecified ordering. None (0) sorts last, ties
// break by identifier.
const PRIORITY_NONE_RANK = 1_000_000;
const priorityRank = (priority) =>
  typeof priority?.value === "number" && priority.value > 0 ? priority.value : PRIORITY_NONE_RANK;

function touchedTicketEntry(facts, linearState, costReport) {
  const cost = ticketCostOf(costReport, facts.taskId);
  // Last verdict is derived here, not stored in facts — the TicketFacts shape
  // in the plan has no lastVerdict field, and the board needs it anyway.
  const lastVerdict = facts.verdicts.length
    ? facts.verdicts.reduce((a, b) => ((b.round ?? 0) >= (a.round ?? 0) ? b : a))
    : null;
  return {
    taskId: facts.taskId,
    title: linearState?.title ?? null,
    url: linearState?.url ?? null,
    stage: deriveStage(facts, linearState),
    linearState: linearState ? { name: linearState.name, type: linearState.type } : null,
    priority: linearState?.priority ?? null,
    milestone: linearState?.milestone ?? null,
    // Normalized again here: buildBoardPayload also serves callers whose
    // linearStates did not come from fetchLinearStates (the fixture seam) —
    // the { id, name, color } contract holds regardless of the source.
    labels: normalizeLabels(linearState?.labels),
    rounds: facts.rounds,
    lastVerdict: lastVerdict
      ? { round: lastVerdict.round, verdict: lastVerdict.verdict, at: lastVerdict.at }
      : null,
    flags: deriveFlags(facts),
    cost,
    lastActivityAt: facts.lastActivityAt,
    childCount: facts.children.length,
  };
}

function readyTicketEntry(item, linearState) {
  const priority = linearState?.priority ?? {
    value: typeof item.priority === "number" ? item.priority : 0,
    name: null,
  };
  return {
    taskId: item.identifier,
    title: item.title ?? null,
    url: item.url ?? null,
    stage: "ready",
    linearState: linearState
      ? { name: linearState.name, type: linearState.type }
      : { name: item.state ?? null, type: item.stateType ?? null },
    priority,
    milestone: linearState?.milestone ?? null,
    // Ready comes from the queue payload, whose labels are name strings
    // (telemetry-server's linearQueue; labelDetails — the { id, name, color }
    // list the queue patch adds — wins when present); the enriched Linear
    // state, when the caller has one for this id, wins over both. Every shape
    // normalizes to the same { id, name, color } contract; empty stays [].
    labels: normalizeLabels(linearState?.labels ?? item.labelDetails ?? item.labels),
    rounds: 0,
    lastVerdict: null,
    flags: [],
    cost: null,
    lastActivityAt: item.updatedAt ?? null,
    childCount: 0,
  };
}

const passesFilters = (entry, filters) => {
  if (filters.milestone !== undefined && filters.milestone !== null && filters.milestone !== "") {
    if (entry.milestone !== filters.milestone) return false; // unknown milestone ≠ the asked one
  }
  if (filters.priority !== undefined && filters.priority !== null && Number.isFinite(Number(filters.priority))) {
    if (entry.priority?.value !== Number(filters.priority)) return false;
  }
  // Label filter matches by NAME (the value the UI select offers and the URL
  // carries). A ticket with no labels can never match a named label — the
  // unknown-milestone rule, applied to labels.
  if (filters.label !== undefined && filters.label !== null && filters.label !== "") {
    const wanted = String(filters.label);
    if (!Array.isArray(entry.labels) || !entry.labels.some((l) => l?.name === wanted)) return false;
  }
  return true;
};

/**
 * The GET /api/work/tickets payload. Touched tickets first (facts), then Ready
 * from the queue: open items whose identifier Fenix has not touched — a queue
 * item whose identifier is in facts is never duplicated. Sorting: a column by
 * lastActivityAt desc; Ready by priority (urgent first, none last) then id.
 */
export function buildBoardPayload({
  facts = [],
  queue = [],
  linearStates = {},
  costReport = null,
  costMeta = null,
  linearMeta = null,
  filters = {},
  now = Date.now(),
} = {}) {
  const touched = facts.map((f) => touchedTicketEntry(f, linearStates[f.taskId] ?? null, costReport));
  const byId = new Map(touched.map((t) => [t.taskId, t]));

  const ready = [];
  for (const item of queue) {
    if (!item?.identifier || byId.has(item.identifier)) continue;
    if (item.stateType === "completed" || item.stateType === "canceled") continue; // Ready is open only
    const entry = readyTicketEntry(item, linearStates[item.identifier] ?? null);
    byId.set(entry.taskId, entry);
    ready.push(entry);
  }

  const entries = [...touched, ...ready].filter((entry) => passesFilters(entry, filters));
  const buckets = new Map(BOARD_COLUMNS.map((c) => [c, []]));
  for (const entry of entries) buckets.get(entry.stage in buckets ? entry.stage : "dev").push(entry);

  for (const column of BOARD_COLUMNS) {
    if (column === "ready") continue;
    buckets
      .get(column)
      .sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")));
  }
  buckets.get("ready").sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) || String(a.taskId).localeCompare(String(b.taskId)),
  );

  return {
    computedAt: new Date(now).toISOString(),
    cost: costMeta ?? { computedAt: null, stale: false, state: "computing" },
    linear: linearMeta ?? { ok: false, error: null, fetchedAt: null },
    columns: BOARD_COLUMNS,
    tickets: BOARD_COLUMNS.flatMap((column) => buckets.get(column)),
  };
}

// ── 6. buildTicketDetail ─────────────────────────────────────────────────────

function buildTimeline(facts) {
  const events = [];
  for (const child of facts.children) {
    for (const turn of child.turns) {
      if (turn.startedAt) {
        events.push({
          at: turn.startedAt,
          kind: "spawn",
          text: `${child.childId} spawned (${child.squad ?? "?"})`,
          childId: child.childId,
          runId: child.runId,
        });
      }
      if (turn.endedAt) {
        events.push({
          at: turn.endedAt,
          kind: "exit",
          text: `${child.childId} exited${turn.exitCode != null ? ` (exit ${turn.exitCode})` : " (no exit code)"}`,
          childId: child.childId,
          runId: child.runId,
        });
      }
    }
  }
  for (const verdict of facts.verdicts) {
    events.push({
      at: verdict.at,
      kind: "verdict",
      text: `review round ${verdict.round}: ${verdict.verdict}`,
      childId: null,
      runId: null,
    });
  }
  for (const gate of facts.gates) {
    events.push({
      at: gate.createdAt,
      kind: "gate",
      text: `gate ${gate.gateId ?? "?"} created (${gate.kind ?? "?"})`,
      childId: gate.childId,
      runId: null,
    });
    if (gate.answeredAt) {
      events.push({
        at: gate.answeredAt,
        kind: "answer",
        text: `gate ${gate.gateId ?? "?"} answered`,
        childId: gate.childId,
        runId: null,
      });
    }
  }
  for (const row of facts.interventionRows) {
    events.push({
      at: row.at,
      kind: "answer",
      text: `${row.kind}${row.path ? ` ${row.path}` : ""}`,
      childId: null,
      runId: null,
    });
  }
  // Oldest first; events without a timestamp keep their place at the end
  // rather than pretending to be from the beginning of time.
  const withTs = events.filter((e) => isoMs(e.at) !== null);
  const withoutTs = events.filter((e) => isoMs(e.at) === null);
  withTs.sort((a, b) => isoMs(a.at) - isoMs(b.at));
  return [...withTs, ...withoutTs];
}

function buildEvidence(facts) {
  const evidence = [];
  for (const verdict of facts.verdicts) {
    evidence.push({
      kind: "verdict",
      label: `round ${verdict.round} ${verdict.verdict}`,
      href: null,
      path: verdict.path,
    });
  }
  const runs = new Set();
  const branches = new Set();
  for (const child of facts.children) {
    if (child.tee) {
      evidence.push({ kind: "tee", label: `${child.childId} transcript`, href: null, path: child.tee });
    }
    if (child.telemetryRunId && !runs.has(child.telemetryRunId)) {
      runs.add(child.telemetryRunId);
      evidence.push({
        kind: "run",
        label: `run ${child.telemetryRunId}`,
        href: `/runs/${child.telemetryRunId}`,
        path: null,
      });
    }
    if (child.branch) {
      const label = `${child.branch} @ ${child.baseRevision ?? "unknown"}`;
      if (!branches.has(label)) {
        branches.add(label);
        evidence.push({ kind: "branch", label, href: null, path: null });
      }
    }
  }
  return evidence;
}

/**
 * The GET /api/work/tickets/:id payload. `reconciliation` is injected (the
 * route computes it with priceChildTranscripts — per-ticket, small); this
 * module never invents numbers, so an absent one stays null.
 */
export function buildTicketDetail({
  facts,
  linearState = null,
  issue = null,
  costReport = null,
  reconciliation = null,
  now = Date.now(),
} = {}) {
  const cost = ticketCostOf(costReport, facts.taskId);
  return {
    ticket: touchedTicketEntry(facts, linearState, costReport),
    issue: issue
      ? {
          identifier: issue.identifier ?? facts.taskId,
          title: issue.title ?? null,
          url: issue.url ?? null,
          description: issue.description ?? null,
        }
      : null,
    timeline: buildTimeline(facts),
    cost: {
      childrenUsd: cost?.childrenUsd ?? null,
      supervisorUsd: cost?.supervisorUsd ?? null,
      totalUsd: cost?.totalUsd ?? null,
      reconciliation,
    },
    children: facts.children,
    evidence: buildEvidence(facts),
  };
}

// ── 7. startText ─────────────────────────────────────────────────────────────

// Control characters never survive into the Supervisor's chat — except \n and
// \t, which carry the line structure the hand-off text is read with.
const stripControl = (text) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");

/**
 * The hand-off text the Start flow shows before sending: "Start ticket FOC-123:
 * <title>", the url, then the issue description capped at maxChars total.
 */
export function startText(issue, { maxChars = 6000 } = {}) {
  const identifier = issue?.identifier ?? "";
  const header = `Start ticket ${identifier}: ${String(issue?.title ?? "")}\n${String(issue?.url ?? "")}\n\n`;
  const body = stripControl(String(issue?.description ?? ""));
  const marker = "[…truncated]";
  const budget = Math.max(0, maxChars - header.length);
  if (body.length <= budget) return header + body;
  const cut = body.slice(0, Math.max(0, budget - marker.length - 1)); // -1 for the \n before the marker
  return header + cut + "\n" + marker;
}

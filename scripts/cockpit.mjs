// scripts/cockpit.mjs — the cockpit library (FOC-783, plan §3).
//
// What the dashboard's /api/cockpit route (slice S7) will serve, as pure data:
// the Needs-you inbox (pending gates, open holds, problems), the live-children
// board, the focus ticket and the counts strip. PURE by contract: filesystem
// reads only, no network, and no process probing of its own — collectChildren
// takes the probe as a parameter (the host's /alive in Docker, processAlive
// natively).
//
// Never throws on one bad run dir: the run is skipped, or — where the state is
// something the operator must SEE rather than have hidden (an unreadable gate
// file, an unreadable holds store) — surfaced as an "unreadable" item.
//
// Path note: every reader here derives its paths from the `stateHome` argument
// instead of calling runDir()/gatesDir() in supervisor-lib.mjs — those are
// welded to LA_SUPERVISOR_STATE_HOME, and a stateHome parameter has to mean
// something even when it differs from the env seam. The lib's tolerance rules
// are kept identical where they matter: an unreadable gate file is surfaced (and
// counts as pending, hasPendingGate parity), an unreadable held request is not
// absent (readHeld parity), an unreadable holds store is an ERROR via
// validateHoldStore — never "no holds". Silence anchoring follows
// supervisor-status.mjs (FOC-271): the window runs from the LATEST of the tee's
// mtime and the live turn's startedAt, so a resumed turn is not born stalled.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  stallSilenceMs,
  supervisorStateHome,
  validateHoldStore,
} from "./supervisor-lib.mjs";

const DAY_MS = 86_400_000;

// The well-known gate kinds (supervisor-gate.mjs KINDS, §2.6), grouped by HOW
// Mateusz answers them: an open question is free text, an approval is a
// yes/no (+ note). A kind outside both sets is not a Needs-you item.
const TEXT_GATE_KINDS = ["question", "plan.gate1", "plan.gate2"];
const YESNO_GATE_KINDS = ["push-approval", "pr-approval", "cleanup-approval", "draft-approval"];

const homeOf = (stateHome) =>
  stateHome === undefined || stateHome === null ? supervisorStateHome() : stateHome;

// ── small fs readers — every one of them tolerates a missing/unreadable file ─

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

const isoMs = (value) => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

const ageMsOf = (now, iso) => {
  const t = isoMs(iso);
  return t === null ? null : Math.max(0, now - t);
};

// ── per-run readers (stateHome-parameterised; see the path note above) ───────

/** Corrupt registry → ok:false (readRegistry throws; cockpit must not). */
function readRegistryTolerant(home, runId) {
  const parsed = readJsonFile(join(home, runId, "children.json"));
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, registry: null };
  }
  return { ok: true, registry: { children: {}, rounds: {}, ...parsed.value } };
}

function triageIssueOf(home, runId) {
  const parsed = readJsonFile(join(home, runId, "triage.json"));
  const issue = parsed.ok ? parsed.value?.issue : null;
  return typeof issue === "string" && issue.trim() ? issue : null;
}

/**
 * Every gate file in the run, tolerant of a malformed one — the malformed file
 * is surfaced as `{ unreadable: true }` rather than hidden (same rule as
 * supervisor-status.pendingGates / the lib's allGates). Also returns the
 * childId → pending-gate map, which is hasPendingGate's answer for the whole
 * run in one read.
 */
function scanGates(home, runId) {
  const dir = join(home, runId, "gates");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { gates: [], pendingByChild: new Map() };
  }
  const gates = [];
  const pendingByChild = new Map();
  for (const file of files) {
    const gateId = file.replace(/\.json$/, "");
    const parsed = readJsonFile(join(dir, file));
    if (!parsed.ok) {
      gates.push({ gateId, unreadable: true, error: parsed.error });
      continue;
    }
    const gate = parsed.value;
    gates.push(gate);
    if (gate?.status === "pending" && typeof gate?.childId === "string") {
      pendingByChild.set(gate.childId, gate);
    }
  }
  return { gates, pendingByChild };
}

/** readHeld parity, against `home`: unreadable is not absent. */
function readHeldTolerant(home, runId) {
  const dir = join(home, runId, "held");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const parsed = readJsonFile(join(dir, f));
      if (!parsed.ok) return { heldId: f.replace(/\.json$/, ""), squad: null, unreadable: true };
      return parsed.value;
    })
    .sort((a, b) => String(a.heldAt).localeCompare(String(b.heldAt)));
}

/** readHolds parity, against `home`: missing → empty, unreadable/invalid → ok:false. */
function readHoldsTolerant(home, runId) {
  const path = join(home, runId, "holds.json");
  if (!existsSync(path)) return { ok: true, store: { holds: [] } };
  const parsed = readJsonFile(path);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    return { ok: true, store: validateHoldStore(parsed.value, path) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── 1. recent run ids ────────────────────────────────────────────────────────

/** Newest mtime among children.json, gates/ (dir + files) and holds.json; 0 when none exist. */
function newestRunMtimeMs(home, runId) {
  const run = join(home, runId);
  let newest = mtimeMsOf(join(run, "children.json"));
  const gates = join(run, "gates");
  newest = Math.max(newest, mtimeMsOf(gates));
  let gateFiles = [];
  try {
    gateFiles = readdirSync(gates);
  } catch {
    /* no gates dir */
  }
  for (const file of gateFiles) {
    if (file.endsWith(".json")) newest = Math.max(newest, mtimeMsOf(join(gates, file)));
  }
  return Math.max(newest, mtimeMsOf(join(run, "holds.json")));
}

/** Run ids touched within `days`, newest first. A run dir with none of the three signals is skipped. */
export function recentRunIds({ stateHome = supervisorStateHome(), now = Date.now(), days = 14 } = {}) {
  const home = homeOf(stateHome);
  const cutoff = now - days * DAY_MS;
  let entries;
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // FOC-990: `test-*` dirs are suite fixtures (supervisor-test-fixtures, the
    // triage test). A suite that leaks one into the real state home must not
    // surface its holds as Needs-you cards. No real run id starts with `test-`:
    // run ids are `<timestamp>-supervisor-<hex>`.
    if (entry.name.startsWith("test-")) continue;
    const newest = newestRunMtimeMs(home, entry.name);
    if (newest > 0 && newest >= cutoff) runs.push({ runId: entry.name, newest });
  }
  return runs
    .sort((a, b) => b.newest - a.newest || String(b.runId).localeCompare(String(a.runId)))
    .map((r) => r.runId);
}

// ── 2. the Needs-you inbox ───────────────────────────────────────────────────

/**
 * collectNeedsYou — pending gates, open (non-deferred) holds and problems,
 * newest first. Item shape: { id, category, kind, runId, taskId, childId,
 * gateId?, holdId?, createdAt, ageMs, summary, questions?, facts?, artifacts?,
 * options?, recommendation?, impact?, state, answerable, answerKind }.
 */
export function collectNeedsYou({ stateHome, now = Date.now(), runIds } = {}) {
  const home = homeOf(stateHome);
  const runs = runIds ?? recentRunIds({ stateHome: home, now });
  const items = [];

  for (const runId of runs) {
    const triageIssue = triageIssueOf(home, runId);
    const { gates } = scanGates(home, runId);
    const { ok: registryOk, registry } = readRegistryTolerant(home, runId);
    const childBy = registryOk
      ? new Map(Object.values(registry.children || {}).map((c) => [c.childId, c]))
      : new Map();

    // ── gates and approvals ──
    for (const gate of gates) {
      if (gate.unreadable) {
        items.push({
          id: `gate:${runId}:${gate.gateId}`,
          category: "gate",
          kind: "unreadable",
          runId,
          taskId: null,
          childId: null,
          gateId: gate.gateId,
          createdAt: null,
          ageMs: null,
          summary: `gates/${gate.gateId}.json is unreadable: ${gate.error}`,
          state: "unreadable",
          answerable: false,
          answerKind: "text",
        });
        continue;
      }
      const category = TEXT_GATE_KINDS.includes(gate.kind)
        ? "gate"
        : YESNO_GATE_KINDS.includes(gate.kind)
          ? "approval"
          : null;
      if (!category) continue; // not a Needs-you kind

      const child = typeof gate.childId === "string" ? childBy.get(gate.childId) : null;
      const taskId = gate.taskId ?? child?.taskId ?? triageIssue ?? null;
      const answerKind = category === "gate" ? "text" : "yesno";
      const shared = {
        id: `${category}:${runId}:${gate.gateId}`,
        category,
        kind: gate.kind,
        runId,
        taskId,
        childId: gate.childId ?? null,
        gateId: gate.gateId,
        createdAt: gate.createdAt ?? null,
        ageMs: ageMsOf(now, gate.createdAt),
        summary: gate.summary ?? "",
      };
      const payload = {
        ...(Array.isArray(gate.questions) && gate.questions.length ? { questions: gate.questions } : {}),
        ...(gate.facts && typeof gate.facts === "object" && !Array.isArray(gate.facts) && Object.keys(gate.facts).length
          ? { facts: gate.facts }
          : {}),
        ...(Array.isArray(gate.artifacts) && gate.artifacts.length ? { artifacts: gate.artifacts } : {}),
      };

      if (gate.status === "pending") {
        items.push({ ...shared, ...payload, state: "pending", answerable: true, answerKind });
        continue;
      }
      // Answered — only interesting while the child still waits for the answer
      // to be DELIVERED (supervisor-followup --gate), the gap between recording
      // and delivery where a child sits waiting on an answer that technically
      // exists. Delivered (a turn names the gateId), or the child gone, and
      // there is nothing for Mateusz here. A waiting_gate child with a pending
      // gate is already covered by the pending branch — no duplicate item.
      if (
        gate.status === "answered" &&
        child?.status === "waiting_gate" &&
        !(Array.isArray(child.turns) && child.turns.some((t) => t?.gateId === gate.gateId))
      ) {
        items.push({
          ...shared,
          ...payload,
          state: "awaiting-delivery",
          answerable: false,
          answerKind,
        });
      }
    }

    // ── holds ──
    const holdsResult = readHoldsTolerant(home, runId);
    if (!holdsResult.ok) {
      items.push({
        id: `hold:${runId}:unreadable`,
        category: "hold",
        kind: "unreadable",
        runId,
        taskId: triageIssue ?? null,
        childId: null,
        createdAt: null,
        ageMs: null,
        summary: `holds.json is unreadable: ${holdsResult.error}`,
        state: "unreadable",
        answerable: false,
        answerKind: null,
      });
    } else {
      for (const hold of holdsResult.store.holds) {
        if (hold.state !== "open") continue;
        // Deferred holds are quiet until `until` arrives (holdBlocksTurnEnd's
        // third line). presentedAt is deliberately NOT consulted: the dashboard
        // reads the store directly and must never stamp it (that is
        // `list --open`'s act, and reading is not presenting).
        const untilMs = isoMs(hold.until);
        if (untilMs !== null && untilMs > now) continue;
        items.push({
          id: `hold:${runId}:${hold.id}`,
          category: "hold",
          kind: "hold",
          runId,
          taskId: triageIssue ?? null,
          childId: null,
          holdId: hold.id,
          createdAt: hold.createdAt ?? null,
          ageMs: ageMsOf(now, hold.createdAt),
          summary: hold.question ?? "",
          ...(Array.isArray(hold.options) && hold.options.length ? { options: hold.options } : {}),
          recommendation: hold.recommendation ?? null,
          impact: hold.impact ?? null,
          state: "open",
          answerable: true,
          answerKind: "option",
        });
      }
    }

    // ── problems (read-only: "Ask the Supervisor", never answerable here) ──
    for (const child of childBy.values()) {
      const taskId = child.taskId ?? triageIssue ?? null;
      if (child.status === "crashed") {
        items.push({
          id: `problem:${runId}:${child.childId}:crashed`,
          category: "problem",
          kind: "crashed",
          runId,
          taskId,
          childId: child.childId,
          createdAt: child.endedAt ?? null,
          ageMs: ageMsOf(now, child.endedAt),
          summary: `child ${child.childId} crashed${child.exitCode != null ? ` (exit ${child.exitCode})` : ""}`,
          state: "open",
          answerable: false,
          answerKind: null,
        });
        continue;
      }
      if (LIVE_STATUSES.includes(child.status)) {
        const anchor = silenceAnchor(child, mtimeMsOf(join(home, runId, "children", `${child.childId}.jsonl`)));
        const silentMs = anchor ? now - anchor : null;
        if (silentMs !== null && silentMs >= stallSilenceMs()) {
          items.push({
            id: `problem:${runId}:${child.childId}:stalled`,
            category: "problem",
            kind: "stalled",
            runId,
            taskId,
            childId: child.childId,
            createdAt: new Date(anchor).toISOString(),
            ageMs: Math.max(0, now - anchor),
            summary: `child ${child.childId} has been silent ${Math.round(silentMs / 1000)}s — past the stall SLA`,
            state: "open",
            answerable: false,
            answerKind: null,
          });
        }
      }
      // waiting_gate children are NOT problems: their story is the gate item
      // above (pending → "pending", answered → "awaiting-delivery"). Emitting
      // the child separately would duplicate it.
    }

    for (const held of readHeldTolerant(home, runId)) {
      items.push({
        id: `problem:${runId}:${held.heldId}`,
        category: "problem",
        kind: "held-spawn",
        runId,
        taskId: held.taskId ?? triageIssue ?? null,
        childId: null,
        createdAt: held.heldAt ?? null,
        ageMs: ageMsOf(now, held.heldAt),
        summary: held.unreadable
          ? `held spawn request ${held.heldId} is unreadable`
          : `spawn for ${held.squad ?? "?"} held${held.reason ? `: ${held.reason}` : " — waiting for a slot"}`,
        state: "open",
        answerable: false,
        answerKind: null,
      });
    }

    const partialPath = join(home, runId, "partial-status.json");
    if (existsSync(partialPath)) {
      const parsed = readJsonFile(partialPath);
      const generatedAt = parsed.ok ? (parsed.value?.generatedAt ?? null) : null;
      items.push({
        id: `problem:${runId}:partial-status`,
        category: "problem",
        kind: "partial-status",
        runId,
        taskId: triageIssue ?? null,
        childId: null,
        createdAt: generatedAt,
        ageMs: ageMsOf(now, generatedAt),
        summary: !parsed.ok
          ? "partial-status.json is unreadable"
          : typeof parsed.value?.reason === "string"
            ? parsed.value.reason
            : "partial-status.json exists",
        state: "open",
        answerable: false,
        answerKind: null,
      });
    }
  }

  // Newest first; items without a timestamp (unreadable state) go last.
  return items.sort(
    (a, b) => (isoMs(b.createdAt) ?? -Infinity) - (isoMs(a.createdAt) ?? -Infinity),
  );
}

// ── 3. the children board ────────────────────────────────────────────────────

/**
 * The silence anchor, FOC-271 parity with supervisor-status: wall clock from the
 * LATEST of the tee's last write and the live (not yet ended) turn's start — a
 * resumed turn must not inherit its predecessor's silence.
 */
function silenceAnchor(entry, teeMtimeMs) {
  const turns = Array.isArray(entry.turns) ? entry.turns : [];
  const liveTurn = [...turns].reverse().find((t) => t && !t.endedAt) || null;
  const turnStart = liveTurn?.startedAt ? Date.parse(liveTurn.startedAt) : NaN;
  return Math.max(teeMtimeMs || 0, Number.isFinite(turnStart) ? turnStart : 0);
}

const CHILDREN_LIVE_RANK = { running: 0, stalled: 1, "waiting-gate": 2, unknown: 3 };

/**
 * collectChildren — every child live by registry, ended within
 * `endedWindowMs`, or holding a pending gate (a child waiting on Mateusz must
 * always be listed), status per plan §5, `probe` called ONCE with all pids of
 * registry-live children across all runs.
 */
export async function collectChildren({
  stateHome,
  now = Date.now(),
  runIds,
  probe,
  endedWindowMs = DAY_MS,
  max = 30,
} = {}) {
  const home = homeOf(stateHome);
  const runs = runIds ?? recentRunIds({ stateHome: home, now });

  const scans = [];
  for (const runId of runs) {
    const { ok, registry } = readRegistryTolerant(home, runId);
    if (!ok) continue; // a corrupt children.json must not break the other runs
    const children = Object.values(registry.children || {});
    if (!children.length) continue;
    const gateScan = scanGates(home, runId);
    // Answered gates per child: a waiting_gate child whose answer is recorded
    // but not yet DELIVERED is still waiting (the same rule collectNeedsYou
    // uses) — the board must not show it as exited.
    const answeredByChild = new Map();
    for (const gate of gateScan.gates) {
      if (!gate || gate.unreadable || gate.status !== "answered" || typeof gate.childId !== "string") continue;
      let list = answeredByChild.get(gate.childId);
      if (!list) answeredByChild.set(gate.childId, (list = []));
      list.push(gate);
    }
    scans.push({ runId, children, pendingByChild: gateScan.pendingByChild, answeredByChild });
  }

  // ONE probe for the whole board, before any status is judged.
  const liveEntries = scans.flatMap((s) => s.children.filter((c) => LIVE_STATUSES.includes(c.status)));
  let probeResult = null;
  if (liveEntries.length && typeof probe === "function") {
    probeResult = await probe([...new Set(liveEntries.map((c) => c.pid).filter((p) => Number.isInteger(p)))]);
  }

  const rows = [];
  for (const scan of scans) {
    for (const entry of scan.children) {
      const teeMtime = mtimeMsOf(join(home, scan.runId, "children", `${entry.childId}.jsonl`));
      const anchor = silenceAnchor(entry, teeMtime);
      const teeSilentMs = anchor ? now - anchor : null;
      let status;
      let detail = null;
      let exitCode = entry.exitCode ?? null;
      let undeliveredAnswer = false;

      const turns = Array.isArray(entry.turns) ? entry.turns : [];
      // Rules in order (plan §5). A pending gate outranks everything — a child
      // that is running but has asked Mateusz something IS waiting on a gate.
      if (scan.pendingByChild.has(entry.childId)) {
        status = "waiting-gate";
      } else if (entry.status === "stopped") {
        status = "stopped";
      } else if (entry.status === "exited" || entry.status === "crashed") {
        // A crash is shown as an exit with its code — the board says what
        // happened, the Needs-you inbox (kind "crashed") says it needs you.
        status = "exited";
        detail = `exit ${exitCode}`;
      } else if (entry.status === "waiting_gate") {
        // Answered but not yet delivered (no turn carries the gateId — the same
        // awaiting-delivery rule collectNeedsYou applies): the child is still
        // waiting on its answer, not done. Only a waiting_gate child with no
        // pending AND no undelivered gate has its work ended.
        const undelivered = (scan.answeredByChild.get(entry.childId) || []).some(
          (g) => !turns.some((t) => t?.gateId === g.gateId),
        );
        if (undelivered) {
          status = "waiting-gate";
          detail = "answer recorded — waiting for delivery";
          undeliveredAnswer = true;
        } else {
          status = "exited";
          exitCode = 0;
          detail = "exit 0";
        }
      } else if (LIVE_STATUSES.includes(entry.status)) {
        if (!probeResult) {
          status = "unknown";
          detail = "process probe unavailable";
        } else if (!Number.isInteger(entry.pid)) {
          status = "unknown";
          detail = "no pid recorded";
        } else if (!teeMtime) {
          status = "unknown";
          detail = "no tee";
        } else if (!probeResult[String(entry.pid)] && !probeResult[entry.pid]) {
          status = "unknown";
          detail = "process gone, no exit recorded";
        } else if (teeSilentMs !== null && teeSilentMs > stallSilenceMs()) {
          status = "stalled";
          detail = `tee silent ${Math.round(teeSilentMs / 1000)}s`;
        } else {
          status = "running";
        }
      } else {
        // Not in LIVE nor TERMINAL — an unknown registry status should not
        // exist; surface it as unknown instead of guessing.
        status = "unknown";
        detail = `registry status ${String(entry.status)}`;
      }

      const startedAt = entry.startedAt ?? turns[0]?.startedAt ?? null;
      // A terminal entry may lack endedAt; its last turn's end is the best
      // available anchor for the ended-window check.
      const endedAt = entry.endedAt ?? turns[turns.length - 1]?.endedAt ?? null;
      const endedMs = isoMs(endedAt);
      const isLive = LIVE_STATUSES.includes(entry.status);
      const hasPendingGate = scan.pendingByChild.has(entry.childId);
      // Live by registry, pending-gate and undelivered-answer children always
      // show; ended children only within the window (endedAt falling back to
      // the last turn's end).
      if (!isLive && !hasPendingGate && !undeliveredAnswer && (endedMs === null || now - endedMs > endedWindowMs)) continue;

      rows.push({
        runId: scan.runId,
        childId: entry.childId,
        taskId: entry.taskId ?? null,
        squad: entry.squad ?? null,
        model: entry.model ?? null,
        status,
        detail,
        pid: entry.pid ?? null,
        exitCode,
        startedAt,
        endedAt,
        ageMs: ageMsOf(now, startedAt),
        teeSilentMs,
        costUsd: entry.costUsd ?? null,
        // FOC-980: WHERE the cost number came from (registry-cost-recompute's
        // "transcript" / "result-max") — the UI needs it to tell "recorded at
        // turn end" apart from "no readable cost source".
        costSource: entry.costSource ?? null,
        checkedAt: new Date(now).toISOString(),
        _rank: CHILDREN_LIVE_RANK[status] ?? 10,
        _endedMs: endedMs ?? 0,
      });
    }
  }

  return rows
    .sort((a, b) => a._rank - b._rank || b._endedMs - a._endedMs)
    .slice(0, max)
    .map(({ _rank, _endedMs, ...row }) => row);
}

// ── 4. the focus ticket ──────────────────────────────────────────────────────

/**
 * triage.json `issue` of the first run (newest first) that has one; null when
 * none. FOC-769: this heuristic is now the Cockpit's FALLBACK — the declared
 * focus on the current-run record wins when there is one (cockpit-routes.mjs,
 * declaredFocusOf).
 */
export function focusTicket({ stateHome, runIds } = {}) {
  const home = homeOf(stateHome);
  const runs = runIds ?? recentRunIds({ stateHome: home });
  for (const runId of runs) {
    const issue = triageIssueOf(home, runId);
    if (issue) return { taskId: issue, runId };
  }
  return null;
}

// ── 5. the header strip ──────────────────────────────────────────────────────

/**
 * cockpitCounts — needsYou counts what Mateusz can ACT on: answerable items
 * (pending gate, open hold) plus every problem. Unreadable state and
 * awaiting-delivery rows are context, not action — they do not count.
 */
export function cockpitCounts({ needsYou, children }) {
  const items = Array.isArray(needsYou) ? needsYou : [];
  const kids = Array.isArray(children) ? children : [];
  return {
    needsYou: items.filter((it) => it?.answerable === true || it?.category === "problem").length,
    running: kids.filter((c) => c?.status === "running").length,
    stalled: kids.filter((c) => c?.status === "stalled").length,
    waitingGate: kids.filter((c) => c?.status === "waiting-gate").length,
    unknown: kids.filter((c) => c?.status === "unknown").length,
  };
}

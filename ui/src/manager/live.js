// Pure adapter for the Manager live snapshot (FOC-225 slice 2).
//
// Turns the /api/manager/snapshot response (frozen v1 contract, see
// scripts/manager-snapshot.mjs) into render-ready facts. Pure JS on purpose:
// the plain-node test harness imports this file, so no React, no JSX, no DOM.
//
// State mapping — authoritative sources only, never guessed (fenix-manager.md
// §5): the server supplies facts, this module derives states from them.
//   running    store says unended (alive=true confirms; missing liveness does
//              not negate the store — it is documented server-side in
//              missing[]; alive=false CONTRADICTS the store → unknown, never
//              "running" — no fake live activity)
//   waiting    a pending gate record for the squad — never inferred
//   failed     ended + exit_code ≠ 0
//   finished   ended + exit_code 0 — the default for ended runs; never
//              promoted by a zero exit alone
//   accepted   a supervisor pass verdict keyed to the run's task (latest
//              round); a later fail verdict removes it
//   unknown    missing/contradictory fields — rendered as unknown, documented
//   stale      snapshot-level: generatedAt older than the freshness bound

// Icon + text for every live state — never color alone (§3.4/§3.5). Chip
// color classes reuse the manager palette (mgr-chip-*); only "accepted" adds
// a new one (accent) so it reads apart from plain finished.
export const LIVE_STATE_META = {
  running: { cls: 'mgr-chip-run', glyph: '▶', label: 'running' },
  waiting: { cls: 'mgr-chip-warn', glyph: '⏸', label: 'waiting for decision' },
  failed: { cls: 'mgr-chip-fail', glyph: '✕', label: 'failed' },
  finished: { cls: 'mgr-chip-ok', glyph: '✓', label: 'finished · unverified' },
  accepted: { cls: 'mgr-chip-accepted', glyph: '★', label: 'accepted' },
  stale: { cls: 'mgr-chip-warn', glyph: '⏱', label: 'stale data' },
  unknown: { cls: 'mgr-chip-neutral', glyph: '?', label: 'unknown' },
};

function exitCodeFailed(exitCode) {
  if (exitCode == null) return null; // missing, not zero
  const n = typeof exitCode === 'number' ? exitCode : Number(exitCode);
  return Number.isFinite(n) ? n !== 0 : null; // unparsable → unknown, not failed
}

// Per-run live state. `acceptedByTask` is the snapshot's verdict map (task id
// → {round, verdict, ...}). Returns a LIVE_STATE_META key.
export function mapRunState(run, acceptedByTask = {}) {
  if (!run) return 'unknown';
  if (run.endedAt == null) {
    // Unended in the store. alive===false contradicts it (a dead console with
    // no recorded end) — that renders unknown rather than fake "running".
    return run.alive === false ? 'unknown' : 'running';
  }
  const failed = exitCodeFailed(run.exitCode);
  if (failed === null) return 'unknown'; // ended but no exit code recorded
  if (failed) return 'failed';
  const task = run.taskId ? String(run.taskId).toUpperCase() : null;
  return task && acceptedByTask[task] ? 'accepted' : 'finished';
}

// The newest ended run of a squad decides its resting state; anything live
// (gate or active run) overrides. null = no activity — render nothing, never
// invent "idle" activity.
export function squadLiveState(block, acceptedByTask = {}) {
  if (!block) return null;
  if ((block.pendingGates || []).length > 0) return 'waiting';
  if ((block.active || []).length > 0) return 'running';
  const newest = (block.recent || [])[0];
  if (!newest) return null;
  const state = mapRunState(newest, acceptedByTask);
  return state === 'running' ? 'unknown' : state; // recent rows are ended; defensive
}

// A squad block that is absent from the snapshot is an empty block, not an
// error — the squad simply has no runs in the bounded window.
export function liveBlockFor(snapshot, squadKey) {
  return snapshot?.squads?.[squadKey] || { active: [], recent: [], pendingGates: [] };
}

// Recent + active runs with their derived state attached (render-ready).
export function decorateRuns(block, acceptedByTask = {}) {
  const decorate = (run) => ({ ...run, state: mapRunState(run, acceptedByTask) });
  return {
    active: (block.active || []).map(decorate),
    recent: (block.recent || []).map(decorate),
    pendingGates: block.pendingGates || [],
  };
}

// Snapshot freshness. stale bound default: 3 poll ticks (15 s) after the last
// success — the header shows a stale warning past it and motion freezes.
export const SNAPSHOT_STALE_MS = 15000;

export function isSnapshotStale(snapshot, nowMs = Date.now(), maxAgeMs = SNAPSHOT_STALE_MS) {
  if (!snapshot || !snapshot.generatedAt) return true;
  const t = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(t)) return true;
  return nowMs - t > maxAgeMs;
}

// --- poll scheduling helpers (pure; used by the useLivePoll hook) -----------

export const POLL_BASE_MS = 5000;
export const POLL_MAX_MS = 60000;

// Backoff ×2 per consecutive failure, capped. Success resets to base.
export function nextPollIntervalMs(currentMs, { base = POLL_BASE_MS, cap = POLL_MAX_MS } = {}) {
  const cur = Number.isFinite(currentMs) && currentMs >= base ? currentMs : base;
  return Math.min(cur * 2, cap);
}

// A tick fetches only when live mode is on, nothing is in flight (never two
// overlapping requests) and the tab is visible.
export function shouldPoll({ enabled, inFlight, hidden }) {
  return !!enabled && !inFlight && !hidden;
}

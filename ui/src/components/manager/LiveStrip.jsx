// Live overlay presentation pieces for the Manager screen (FOC-225 slice 2):
// the per-squad live strip above the board and the header freshness readout.
// Presentation only — every state here was derived by manager/live.js from
// snapshot facts; nothing is inferred and nothing animates without an
// observed transition between consecutive snapshots.

import { useEffect, useState } from 'react';
import { LIVE_STATE_META, SNAPSHOT_STALE_MS, decorateRuns, squadLiveState } from '../../manager/live';
import { fmtTime } from '../../utils';

// Icon + text chip for a live state — never color alone (§3.4). The title
// carries the full label: inside the inspector's fixed-layout tables (D1) the
// chip truncates to one line, so the hover must restore what was cut.
export function LiveStateChip({ state, flash = false }) {
  const meta = LIVE_STATE_META[state] || LIVE_STATE_META.unknown;
  return (
    <span className={`mgr-chip ${meta.cls}${flash ? ' mgr-live-flash' : ''}`} title={meta.label}>
      <span aria-hidden="true">{meta.glyph}</span> {meta.label}
    </span>
  );
}

// Pending-decision badge. Squad-level v1 binding: it says THAT a decision is
// waiting — never which role, never the question text, and it carries no
// answer controls (decisions are answered in the supervisor window).
export function GateBadge({ count }) {
  if (!count) return null;
  return (
    <span className="mgr-chip mgr-live-gate" title="a supervisor gate is waiting for a decision — answer it in the supervisor window">
      <span aria-hidden="true">⏸</span> {count} pending decision{count === 1 ? '' : 's'}
    </span>
  );
}

// Squad-level live strip: derived state + active-run count + gate badge.
// An empty bounded window renders "no activity" — never fake live motion.
// Before the FIRST snapshot arrives there is no window at all, so the strip
// shows a neutral "awaiting first snapshot…" instead — "no activity" is an
// observed fact about the store and must not be rendered as a guess
// (FOC-225 cleanup round C6g).
export function SquadLiveStrip({ block, acceptedByTask = {}, flash = false, pending = false }) {
  const state = squadLiveState(block, acceptedByTask);
  const { active, pendingGates } = decorateRuns(block, acceptedByTask);
  return (
    <div className="mgr-livestrip" data-testid="mgr-livestrip">
      {pending ? (
        <span className="mgr-muted">awaiting first snapshot…</span>
      ) : state ? (
        <LiveStateChip state={state} flash={flash} />
      ) : (
        <span className="mgr-muted">no activity in the bounded window</span>
      )}
      {active.length > 0 && (
        <span className="mgr-muted">
          {active.length} active run{active.length === 1 ? '' : 's'}
        </span>
      )}
      <GateBadge count={pendingGates.length} />
    </div>
  );
}

// Header freshness: last successful fetch + stale warning + retry. Icon + text;
// the connectivity dot lives in ConnBadge (config read), this covers the live
// poll only. Re-renders once a second to age the timestamp.
export function LiveFreshness({ snapshot, error, lastSuccessAt, onRetry }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const stale = !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > SNAPSHOT_STALE_MS;
  if (error && lastSuccessAt) {
    return (
      <span className="mgr-freshness mgr-freshness-stale">
        <span aria-hidden="true">⏱</span> live update failed — showing last known from{' '}
        {fmtTime(lastSuccessAt.toISOString())}
        <button type="button" className="mgr-btn mgr-btn-sm" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  if (stale) {
    return (
      <span className="mgr-freshness mgr-freshness-stale">
        <span aria-hidden="true">⏱</span> stale data
        {lastSuccessAt ? ` — last update ${fmtTime(lastSuccessAt.toISOString())}` : ''}
        <button type="button" className="mgr-btn mgr-btn-sm" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className="mgr-freshness">
      <span className="mgr-live-dot" aria-hidden="true" />
      live · updated {fmtTime(lastSuccessAt.toISOString())}
      {snapshot?.source === 'cached' ? ' (cached)' : ''}
    </span>
  );
}

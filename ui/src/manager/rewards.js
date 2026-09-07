// Pure adapter for the Manager rewards payload (FOC-225 slice 3).
//
// Turns the /api/manager/rewards response (server facts, see
// scripts/reward-ingest.mjs buildRewardsPayload) into render-ready facts.
// Pure JS on purpose: the plain-node test harness imports this file, so no
// React, no JSX, no DOM.
//
// Hard rules (fenix-manager-rewards.md §3/§6):
//   - XP constants come from the payload (rules version included) and are
//     labelled product rules — never hardcoded in components;
//   - nothing pending is rendered as earned: a squad with no records is an
//     "awaiting verified evidence" state, never zeros;
//   - ratings are subjective and standalone: "not rated" is never 0/5, a
//     rating never carries XP and is never averaged with the acceptance
//     verdict;
//   - badges are evidence-backed (distinct task-revision counts among ACTIVE
//     awards only) — nothing unlocks anything, they are display facts.

// Badge thresholds over the squad's DISTINCT task-revision count among active
// awards (server-computed distinctRevisions). Earned and locked differ by
// GLYPH as well as fill — the locked variant is an outline form, so the state
// never rides on color alone.
export const BADGES = [
  {
    id: 'first-delivery',
    glyph: '✓',
    lockedGlyph: '○',
    label: 'first verified delivery',
    need: 1,
  },
  {
    id: 'five-deliveries',
    glyph: '★★',
    lockedGlyph: '☆☆',
    label: 'five distinct verified deliveries',
    need: 5,
  },
];

// Badge-title need phrase with the count singularized — "needs 1 distinct
// verified delivery", never "needs 1 distinct verified deliveries".
export function deliveryNeedLabel(need) {
  return `${need} distinct verified deliver${need === 1 ? 'y' : 'ies'}`;
}

// Product-rules label built FROM the payload constants — if the server ever
// ships different rules, the label follows it (version included).
export function rulesLabel(rules) {
  if (!rules || !rules.version) return null;
  return `rules ${rules.version.replace(/^xp-rules\s*/, '')} · ${rules.pointsPerAcceptedRevision} XP per accepted revision · ${rules.xpPerLevel} XP per level`;
}

export function levelFor(xp, xpPerLevel) {
  // null/undefined/'' mean "no data" — never "level 1" (Number(null) is 0).
  if (xp == null || xp === '') return null;
  const n = Number(xp);
  if (!Number.isFinite(n) || n < 0) return null;
  // xpPerLevel is a payload constant — when the payload carries no rules,
  // NO level is invented client-side (no 500 fallback): the caller renders
  // no level rather than one derived from a made-up constant.
  const per = Number(xpPerLevel);
  if (!Number.isFinite(per) || per <= 0) return null;
  return Math.floor(n / per) + 1;
}

// Non-breaking-space digit grouping for the header chip (★ L3 · 1 250 XP) —
// locale-independent so tests stay deterministic.
export function formatXp(xp) {
  if (xp == null || xp === '') return null; // "no data" is never "0 XP"
  const n = Number(xp);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function badgeList(distinctRevisions) {
  const n = Number(distinctRevisions);
  const count = Number.isFinite(n) && n > 0 ? n : 0;
  return BADGES.map((b) => ({ ...b, earned: count >= b.need }));
}

// Local, locale-stable short timestamp for record rows ("2026-09-06 12:00").
export function shortWhen(iso) {
  const t = Date.parse(iso);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return null; // unparsable → caller renders '—', never a guess
}

const KIND_META = {
  award: { glyph: '★', label: 'award' },
  revocation: { glyph: '↩', label: 'revoked' },
  rating: { glyph: '✎', label: 'rating' },
};

export function recordMeta(record) {
  return KIND_META[record?.kind] || { glyph: '?', label: 'record' };
}

// Points column for the recent-records table: +100 / −100 / rating rows show
// '—' (a rating never carries points). Missing points render '—', not 0.
export function recordPoints(record) {
  const n = Number(record?.points);
  if (!Number.isFinite(n) || record?.kind === 'rating') return null;
  return n > 0 ? `+${n}` : String(n);
}

// One squad's rewards view.
//   'loading'  payload not fetched yet
//   'error'    fetch failed (caller renders the error + retry)
//   'awaiting' squad has NO records — first-class awaiting state, never zeros
//   'ready'    squad has records (xp may still be 0 after a revocation — that
//              is an honest zero, distinct from awaiting)
export function squadRewardsView(payload, squadKey) {
  if (payload === undefined) return { state: 'loading' };
  if (payload === null) return { state: 'error' };
  const entry = payload.squads?.[squadKey];
  const rules = payload.rules || null;
  if (!entry) return { state: 'awaiting', rules };
  const level = levelFor(entry.xp, rules?.xpPerLevel);
  return {
    state: 'ready',
    rules,
    xp: entry.xp,
    level,
    distinctRevisions: entry.distinctRevisions,
    badges: badgeList(entry.distinctRevisions),
    records: entry.recent || [],
  };
}

// Latest active rating for a task id — array order is newest-first
// (server orders by id DESC), so the first match wins. null = not rated;
// callers must render "not rated", never 0/5.
export function ratingForTask(payload, taskId) {
  if (!payload || !taskId) return null;
  const key = String(taskId).toUpperCase();
  return (payload.ratings || []).find((r) => String(r.taskId || '').toUpperCase() === key) || null;
}

// Rating shown on a History row: the run's own rating when one was written
// for it, else the rating of its task — the newest row carrying that taskId,
// whichever run it was authored on (runId is provenance, taskId the anchor).
// null = not rated.
export function ratingForRun(payload, run) {
  if (!payload || !run) return null;
  if (run.runId) {
    const own = (payload.ratings || []).find((r) => r.runId === run.runId);
    if (own) return own;
  }
  return run.taskId ? ratingForTask(payload, run.taskId) : null;
}

// Held awards surface the "awaiting verified evidence" backlog: pass verdicts
// whose credit subject could not be resolved. Squad-level only — a held row
// belongs to no squad, so the count is installation-global (rendered as a
// note, never attributed).
export function heldCount(payload) {
  return Array.isArray(payload?.held) ? payload.held.length : 0;
}

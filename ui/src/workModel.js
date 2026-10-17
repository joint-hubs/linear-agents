// Work board pure helpers (FOC-784). No React, no fetch, no env access —
// everything takes what it needs as arguments so the plain-node tests
// (_tests_work.mjs) can pin the behavior outside Vite. Fixtures are shaped
// exactly like the plan's API payloads (docs/plans/dashboard-v2-work-costs.md,
// Contracts → API payloads). Accessibility rule (spec §7): colour is never the
// only signal — every flag tone rides with text, and money/age/staleness are
// words, not styling (spec §8 freshness).

// The board columns in order (spec §4.2): Ready → Plan → Dev → Review → Test →
// Landed. The label list doubles as the groupByStage key set, so a stage with
// no tickets still renders as an (empty) column.
export const STAGES = [
  { key: 'ready', label: 'Ready' },
  { key: 'plan', label: 'Plan' },
  { key: 'dev', label: 'Dev' },
  { key: 'review', label: 'Review' },
  { key: 'test', label: 'Test' },
  { key: 'landed', label: 'Landed' },
];

const STAGE_KEYS = STAGES.map((s) => s.key);

const STAGE_LABELS = {};
for (const s of STAGES) STAGE_LABELS[s.key] = s.label;

// Flag tone maps the payload's flag kind onto the status vocabulary (spec §5/§7).
// The text always travels with the tone — payload flags carry `text`, and the
// fallbacks below keep the promise when one is missing.
const FLAG_TONE = { live: 'running', gate: 'waiting', 'needs-you': 'waiting', crashed: 'danger' };
const FLAG_FALLBACK_TEXT = {
  live: 'child live',
  gate: 'waiting on a gate',
  'needs-you': 'needs you',
  crashed: 'child crashed',
};

// Timeline kind → fallback text when an entry arrives without one.
const TIMELINE_FALLBACK_TEXT = {
  spawn: 'child spawned',
  exit: 'child exited',
  verdict: 'review verdict',
  gate: 'gate',
  answer: 'answer',
};

// formatMoney(usd) — the human money text, the same rule as
// scripts/ticket-cost.mjs usd() so the dashboard equals the CLI by
// construction (plan, shared decisions): null -> "unknown", 0 -> "$0",
// >= 0.01 -> "$12.34", sub-cent -> 2 significant digits ("$0.000021").
export function formatMoney(value) {
  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return 'unknown';
  if (value === 0) return '$0';
  if (value >= 0.01) return '$' + value.toFixed(2);
  // Sub-cent: enough decimals for 2 significant digits. Negative values never
  // occur in the payloads; they fall back to 2 decimals rather than NaN math.
  const digits = value > 0 ? 1 - Math.floor(Math.log10(value)) : 2;
  return '$' + value.toFixed(Math.max(digits, 2));
}

// minutesBetween(from, to) — whole minutes, at least 1 so a just-written
// snapshot does not read "0 min old".
function minutesBetween(from, to) {
  return Math.max(1, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

// staleLabel(snapshot, now) — the freshness sentence for the cost/status
// snapshot (spec §8: every panel shows its data age; older than 5 min is
// stale). state "computing" wins (first request before any snapshot); an
// errored refresh is honest about what it still has — with a last good
// computedAt it says how old that is and that the refresh failed, without
// one it is "unavailable"; stale carries its age, otherwise the age itself.
export function staleLabel(snapshot, now) {
  const s = snapshot || {};
  if (s.state === 'computing') return 'computing…';
  const at = s.computedAt ? new Date(s.computedAt) : null;
  const valid = at !== null && !Number.isNaN(at.getTime());
  const n = now ? new Date(now) : new Date();
  if (s.state === 'error') {
    return valid
      ? 'stale — ' + minutesBetween(at, n) + ' min old (refresh failed)'
      : 'unavailable';
  }
  if (s.stale) {
    return valid ? 'stale — ' + minutesBetween(at, n) + ' min old' : 'stale';
  }
  if (valid) {
    if (n.getTime() - at.getTime() < 60_000) return 'updated just now';
    return 'updated ' + minutesBetween(at, n) + ' min ago';
  }
  return 'unavailable';
}

// ageLabel(iso, now) -> "updated 5 min ago" for a card's last activity, or
// null when there is nothing honest to say (missing/unparseable date).
function ageLabel(iso, now) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const n = now ? new Date(now) : new Date();
  if (Number.isNaN(n.getTime())) return null;
  const min = Math.floor((n.getTime() - d.getTime()) / 60_000);
  if (min < 1) return 'updated just now';
  if (min < 60) return 'updated ' + min + ' min ago';
  const h = Math.floor(min / 60);
  if (h < 24) return 'updated ' + h + ' h ago';
  return 'updated ' + Math.floor(h / 24) + ' d ago';
}

// groupByStage(tickets) -> { [stage]: tickets[] } with every stage key present
// (empty arrays kept — the board renders all six columns). A ticket whose
// stage is missing or unknown is dropped rather than silently re-homed.
export function groupByStage(tickets) {
  const out = {};
  for (const s of STAGES) out[s.key] = [];
  for (const t of tickets || []) {
    const key = t && t.stage;
    if (STAGE_KEYS.includes(key)) out[key].push(t);
  }
  return out;
}

// costLabel(cost, childCount) — the one "did this ticket cost anything" rule
// for the card and the panel (acceptance FOC-784): a ticket that has spent
// nothing yet — no children known and no spend priced — says "no cost yet",
// never "unknown" and never a fake "$0". Money when the payload prices the
// ticket (formatMoney, = the CLI), "cost unknown" when children ran but the
// payload carries no price.
export function costLabel(cost, childCount) {
  const c = cost || null;
  const total =
    c && typeof c.totalUsd === 'number' && !Number.isNaN(c.totalUsd) ? c.totalUsd : null;
  if (total != null && total !== 0) return formatMoney(total);
  if (typeof childCount === 'number' && childCount === 0) return 'no cost yet';
  if (total != null) return formatMoney(total); // priced zero with children — an honest $0
  return 'cost unknown';
}

// panelCostLabel(detail) — the same rule for the ticket side panel: the
// children come from the detail payload's array, and the Ready stage forces
// "no cost yet" even before the payload agrees.
export function panelCostLabel(detail) {
  const d = detail || null;
  const stage = d && d.ticket && d.ticket.stage;
  if (stage === 'ready') return 'no cost yet';
  const children = d && Array.isArray(d.children) ? d.children.length : null;
  return costLabel(d && d.cost, children);
}

// cardModel(ticket, now) -> the board card's view model. cost is "no cost
// yet" for Ready (nothing priced yet — no fake zero), "cost unknown" when the
// payload carries children but no cost, money text otherwise (formatMoney,
// = the CLI). labels is the normalized Linear label list (empty when the
// payload has none — never a placeholder chip).
export function cardModel(ticket, now) {
  const t = ticket || {};
  const stage = STAGE_KEYS.includes(t.stage) ? t.stage : null;
  const rounds =
    typeof t.rounds === 'number' && t.rounds > 0 ? (t.rounds === 1 ? '1 round' : t.rounds + ' rounds') : null;
  let cost = null;
  if (stage !== null) {
    cost = stage === 'ready' ? 'no cost yet' : costLabel(t.cost, t.childCount);
  }
  const flags = (Array.isArray(t.flags) ? t.flags : []).map((f) => {
    const kind = f && f.kind;
    return {
      text: (f && f.text) || FLAG_FALLBACK_TEXT[kind] || 'flag',
      tone: FLAG_TONE[kind] || 'neutral',
    };
  });
  return {
    id: t.taskId || null,
    title: t.title || '',
    stageLabel: stage ? STAGE_LABELS[stage] : null,
    labels: ticketLabels(t.labels),
    rounds,
    cost,
    flags,
    age: ageLabel(t.lastActivityAt, now),
  };
}

// timelineRows(detail) -> the ticket detail's stage timeline rows for render:
// { at, kind, text, childId, runId }. A payload entry without text gets a
// kind-derived fallback so the row never renders empty.
export function timelineRows(detail) {
  const tl = detail && detail.timeline;
  if (!Array.isArray(tl)) return [];
  return tl.map((e) => {
    const kind = (e && e.kind) || 'unknown';
    return {
      at: (e && e.at) || null,
      kind,
      text: (e && typeof e.text === 'string' && e.text) || TIMELINE_FALLBACK_TEXT[kind] || 'event',
      childId: (e && e.childId) || null,
      runId: (e && e.runId) || null,
    };
  });
}

// evidenceRows(detail) -> the ticket detail's evidence rows:
// { kind, label, href, path, copyable }. A row with an href renders as a
// link; a row with only a path renders as copyable text (copyable: true) —
// the screen never renders a bare non-link path twice.
export function evidenceRows(detail) {
  const ev = detail && detail.evidence;
  if (!Array.isArray(ev)) return [];
  return ev.map((e) => {
    const href = (e && e.href) || null;
    const path = (e && e.path) || null;
    return {
      kind: (e && e.kind) || 'unknown',
      label: (e && e.label) || (e && e.kind) || 'evidence',
      href,
      path: href ? null : path,
      copyable: !href && !!path,
    };
  });
}

// reconciliationText(reconciliation) -> the one-line cost truth for the ticket
// detail: "Children: transcripts $1.20 · telemetry $1.19 (0.99×)". No
// reconciliation (or nothing reconciled in it) -> "not reconciled yet".
export function reconciliationText(rec) {
  if (!rec || (rec.transcriptUsd == null && rec.telemetryUsd == null)) return 'not reconciled yet';
  let text =
    'Children: transcripts ' +
    formatMoney(rec.transcriptUsd) +
    ' · telemetry ' +
    formatMoney(rec.telemetryUsd);
  if (rec.ratio != null && typeof rec.ratio === 'number' && !Number.isNaN(rec.ratio)) {
    text += ' (' + rec.ratio.toFixed(2) + '×)';
  }
  if (typeof rec.note === 'string' && rec.note) text += ' — ' + rec.note;
  return text;
}

// ===== Board filters (Ready column: milestone / priority / label, plan Q1) ==

// filtersFromQuery(search) -> { milestone, priority, label } from the location
// search ("?" optional). Absent/empty values are null, not "".
export function filtersFromQuery(search) {
  const p = new URLSearchParams(search || '');
  return {
    milestone: p.get('milestone') || null,
    priority: p.get('priority') || null,
    label: p.get('label') || null,
  };
}

// queryFromFilters(filters) -> the search string for the filters ("?"-prefixed,
// stable order milestone then priority then label). No values -> "" so the URL
// stays clean.
export function queryFromFilters(filters) {
  const f = filters || {};
  const p = new URLSearchParams();
  if (f.milestone) p.set('milestone', f.milestone);
  if (f.priority) p.set('priority', f.priority);
  if (f.label) p.set('label', f.label);
  const s = p.toString();
  return s ? '?' + s : '';
}

// ===== Linear labels (task contract: { id, name, color } only) ==============

// Only a hex form may style the chip's dot (#rgb/#rgba/#rrggbb/#rrggbbaa) —
// the same rule the backend's normalizeLabel applies, re-checked client side
// so the payload can never smuggle an arbitrary string into a style.
const LABEL_COLOR_RE = /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;

// ticketLabels(labels) -> the card/panel's label list: { id, name, color }
// entries, a label without a name dropped, color kept only when it validates,
// id kept only when it is a non-empty string, capped at 20 (the payload's own
// cap). Non-array input -> [] so an absent field renders as "no labels".
export function ticketLabels(labels) {
  if (!Array.isArray(labels)) return [];
  const out = [];
  for (const raw of labels) {
    if (out.length >= 20) break;
    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name) out.push({ id: null, name, color: null });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    out.push({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : null,
      name,
      color: typeof raw.color === 'string' && LABEL_COLOR_RE.test(raw.color) ? raw.color : null,
    });
  }
  return out;
}

// labelNames(tickets) -> distinct, sorted label names across the board's
// tickets — the values the label filter select offers (the board offers what
// it can actually see, the same rule as the milestone/priority selects).
export function labelNames(tickets) {
  const out = new Set();
  for (const t of tickets || []) {
    for (const l of ticketLabels(t && t.labels)) out.add(l.name);
  }
  return [...out].sort();
}

// ===== Start dialog (plan FOC-784: confirm before the hand-off) =============

// startDialogModel(preview, { sending, result, error, loading }) -> the Start
// dialog's view model. preview is the start-preview payload
// { text, issue: { identifier, title, url }, delivery: "supervisor"|"cockpit" };
// result is the /message result ({ sent, confirmed, queued }); loading is set
// while the preview request is in flight — the dialog says "Loading…", not
// "No ticket selected.". The primary button follows the delivery: natively
// (no session host) the dialog opens the Cockpit with the text prefilled
// instead of sending (plan, Start). The button is disabled while sending,
// after it landed, and when there is nothing to send — always with a written
// reason. resultText is honest about what happened: sent, queued, or the
// error text itself.
export function startDialogModel(preview, { sending, result, error, loading } = {}) {
  const p = preview || null;
  const issue = (p && p.issue) || null;
  const delivery = (p && p.delivery) || 'supervisor';
  let disabled = false;
  let disabledReason = null;
  if (!p) {
    disabled = true;
    disabledReason = loading ? 'Loading…' : 'No ticket selected.';
  } else if (sending) {
    disabled = true;
    disabledReason = 'Sending…';
  } else if (result && (result.sent || result.queued)) {
    disabled = true;
    disabledReason = 'Already sent.';
  }
  let resultText = null;
  if (error) resultText = error;
  else if (result && result.sent) resultText = 'Sent — the Supervisor has it';
  else if (result && result.queued) resultText = 'Queued';
  return {
    title: issue && issue.identifier ? 'Start ' + issue.identifier : 'Start a ticket',
    text: p ? p.text || null : null,
    primaryLabel: !p ? '' : delivery === 'cockpit' ? 'Open in Cockpit' : 'Send to the Supervisor',
    disabled,
    disabledReason,
    resultText,
  };
}

// ===== Publish dialog (FOC-788: confirm before push / open PR) ==============

// publishDialogModel(preview, action, { sending, result, error, loading }) ->
// the Push branch / Open PR confirm dialog's view model. preview is the
// publish-preview payload ({ ticket, action, checkout, diff, checks,
// confirmToken }); result is the POST .../push|pr answer ({ ok, action, actor,
// head, prUrl? }). AC-2 in view form: checksFailed drives the dialog to show
// the checks state FIRST and prominently when anything failed — shown, never
// hard-blocking (the AC says shown, not blocked; the human decides).
// `error` is a message string or an Error carrying .data (the API's error
// name/detail ride there) — every failure is spelled out by name, never a
// bare failure, and stale-preview additionally offers a refresh.
export function publishDialogModel(preview, action, { sending, result, error, loading } = {}) {
  const p = preview || null;
  const a = action === 'pr' ? 'pr' : 'push';
  const checkout = (p && p.checkout) || null;
  const diff = (p && p.diff) || null;
  const checks = (p && p.checks) || null;
  const failing = checks && Array.isArray(checks.failing) ? checks.failing : [];

  let disabled = false;
  let disabledReason = null;
  if (!p) {
    disabled = true;
    disabledReason = loading ? 'Loading…' : 'No checkout — nothing to publish.';
  } else if (sending) {
    disabled = true;
    disabledReason = a === 'pr' ? 'Opening…' : 'Pushing…';
  } else if (result && result.ok) {
    disabled = true;
    disabledReason = 'Already done.';
  }

  let resultText = null;
  if (error) resultText = publishErrorText(error);
  else if (result && result.ok) {
    resultText = a === 'pr'
      ? 'PR opened' + (result.prUrl ? ': ' + result.prUrl : '')
      : 'Pushed ' + String(result.head || '').slice(0, 7);
  }

  return {
    title: a === 'pr' ? 'Open a pull request' : 'Push the task branch',
    primaryLabel: a === 'pr' ? 'Open PR' : 'Push branch',
    branchText: checkout ? checkout.branch : null,
    // push goes to the remote, a PR to the base branch (decision 1: main).
    targetText: !checkout ? null : a === 'pr' ? String(checkout.base || 'main') : String(checkout.remote || 'origin'),
    diffText: diff
      ? `${diff.commits ?? 0} commit(s), ${diff.files ?? 0} file(s), +${diff.insertions ?? 0}/-${diff.deletions ?? 0}`
        + (diff.dirty ? ' · uncommitted changes in the worktree (not pushed)' : '')
      : null,
    checksFailed: failing.length > 0,
    checksLines: failing.map((v) => `round ${v.round}: FAIL`),
    checksLatest: checks ? checks.latest : null,
    actorText: 'You',
    disabled,
    disabledReason,
    resultText,
    stale: Boolean(error && error.data && error.data.error === 'stale-preview'),
  };
}

// claimTag(ticket) -> the claimed-by tag's view model for the card head, or
// null when the payload carries no claim (FOC-902 §E). short is the first 6
// hex characters after the session id's "sup-" prefix — long ids truncated to
// 12 characters were cut off at the narrow card edge — and title is the full
// hover text: the sessionId travels in full in the title, never truncated in
// the tooltip.
export function claimTag(ticket) {
  const c = ticket && ticket.claimedBy;
  if (!c || typeof c.sessionId !== 'string' || !c.sessionId) return null;
  const rest = c.sessionId.startsWith('sup-') ? c.sessionId.slice(4) : c.sessionId;
  return {
    short: rest.slice(0, 6),
    title: `claimed by ${c.sessionId}${c.status ? ` (${c.status})` : ''}`,
  };
}

// Every publish failure is spelled out by its contract name (plan §5):
// no-checkout, stale-preview, push-refused, pr-failed — with the scrubbed
// detail when the server sent one.
function publishErrorText(error) {
  const name = (error && error.data && error.data.error) || null;
  const detail = (error && error.data && error.data.detail) || null;
  if (name === 'no-checkout') return 'No checkout for this ticket — nothing to publish.';
  if (name === 'stale-preview') return 'The checkout changed since the preview — preview again.';
  if (name === 'push-refused') return 'Push refused: ' + (detail || 'git did not accept the push.');
  if (name === 'pr-failed') return 'Could not open the PR: ' + (detail || 'the API refused.');
  return typeof error === 'string' ? error : ((error && error.message) || 'Publish failed.');
}
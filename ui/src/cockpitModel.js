// Cockpit pure helpers (FOC-783). No React, no env access — everything takes
// what it needs as arguments so the plain-node tests (_tests_cockpit.mjs) can
// pin the behavior outside Vite. Status vocabulary: dashboard-v2-spec §5;
// colours live in screens/cockpit.css as the --ck-* tokens.

// statusChip(child) -> { label, tone } with tone in running|waiting|ok|danger|
// neutral. The label never relies on colour alone (spec §7 accessibility).
export function statusChip(child) {
  const s = child && child.status;
  switch (s) {
    case 'running':
      return { label: 'running', tone: 'running' };
    case 'waiting-gate':
      return { label: 'waiting · gate', tone: 'waiting' };
    case 'stalled':
      return { label: 'stalled', tone: 'waiting' };
    case 'exited': {
      const ec = child && child.exitCode;
      return {
        label: 'exited ' + (typeof ec === 'number' ? ec : '?'),
        tone: ec === 0 ? 'ok' : 'danger',
      };
    }
    case 'stopped':
      return { label: 'stopped', tone: 'neutral' };
    default:
      // 'unknown' and anything unrecognised — shown as unknown, never as
      // running (spec §5).
      return { label: 'unknown', tone: 'neutral' };
  }
}

// formatAge(ms) -> "42s" | "3m 05s" | "2h 07m" | "5d 03h" | "—" when not a
// finite non-negative number. Minute/second and hour/minute pairs are zero
// padded so column values line up.
export function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return d + 'd ' + String(h).padStart(2, '0') + 'h';
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m > 0) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

// mergeConversation(prevEntries, page, { reset }) -> merged entries.
// page.entries are appended by uuid (first occurrence wins — the transcript is
// append-only, a re-read page may overlap the previous one); reset replaces
// everything (new session); the result is capped to the newest 1000 entries.
export function mergeConversation(prevEntries, page, { reset } = {}) {
  const prev = reset ? [] : prevEntries || [];
  const pageEntries = (page && page.entries) || [];
  const byUuid = new Map();
  const order = [];
  for (const e of prev) {
    const key = e && e.uuid;
    if (key == null) continue; // defensive: never merge unkeyed entries
    if (!byUuid.has(key)) {
      byUuid.set(key, e);
      order.push(key);
    }
  }
  for (const e of pageEntries) {
    const key = e && e.uuid;
    if (key == null) continue;
    if (!byUuid.has(key)) {
      byUuid.set(key, e);
      order.push(key);
    }
  }
  const CAP = 1000;
  return (order.length > CAP ? order.slice(order.length - CAP) : order).map((k) => byUuid.get(k));
}

// inboxPrimaryAction(item) -> { kind, label }. kind drives which control the
// inbox item renders: text (textarea + Answer), yesno (Approve/Reject),
// option (one button per option), ask ("Ask the Supervisor" → chat prefill),
// notify ("Tell the Supervisor" — answered but not delivered), none.
export function inboxPrimaryAction(item) {
  if (!item) return { kind: 'none', label: '' };
  if (item.state === 'awaiting-delivery') return { kind: 'notify', label: 'Tell the Supervisor' };
  switch (item.answerKind) {
    case 'text':
      return { kind: 'text', label: 'Answer' };
    case 'yesno':
      return { kind: 'yesno', label: 'Approve / Reject' };
    case 'option':
      return { kind: 'option', label: 'Choose an option' };
    default:
      // answerKind null: a problem is read-only — the human asks the
      // Supervisor about it; anything else answerable falls back to ask too.
      return item.answerable ? { kind: 'ask', label: 'Ask the Supervisor' } : { kind: 'none', label: '' };
  }
}

// hostDisabledReason(supervisor) -> the sentence for a host-level blocker
// (natively on Windows, host down), or null. Shared by chat and terminal.
function hostDisabledReason(supervisor) {
  if (supervisor.host === 'not-docker') {
    return 'Chat and Terminal run in Docker (fenix up).';
  }
  if (supervisor.host === 'unreachable') {
    return 'The Supervisor host is not reachable.';
  }
  return null;
}

// chatDisabledReason(supervisor) -> null when chat may send, otherwise the
// sentence explaining why (host problem, or an open dialog — keystrokes must
// never answer a permission prompt, plan §1).
export function chatDisabledReason(supervisor) {
  if (!supervisor) return null;
  return (
    hostDisabledReason(supervisor) ||
    (supervisor.state === 'needs-input'
      ? 'The Supervisor is asking for input — answer it in the Terminal.'
      : null)
  );
}

// terminalDisabledReason(supervisor) -> null when the Terminal tab may open,
// otherwise the sentence explaining why. Only host problems block it: a
// needs-input dialog is answered in the terminal, and an absent session is
// started by the host on connect.
export function terminalDisabledReason(supervisor) {
  if (!supervisor) return null;
  return hostDisabledReason(supervisor);
}

// ===== Conversation paging (FOC-783 chat view) =====

// The transcript can be tens of MB, so the first request is TAIL mode: no
// `after` — the server returns the LAST `limit` entries plus the end offset
// (truncated:true when older history exists). Every later request pages
// forward from that offset. The helpers keep that contract pure so the node
// tests can pin it.

// Entries requested per transcript page (matches the server default).
export const CONVERSATION_LIMIT = 200;

// buildConversationQuery({ started, offset, limit }) -> { limit, after? }.
// `after` is present only once the first page has arrived (started) — omitting
// it selects tail mode.
export function buildConversationQuery({ started, offset, limit = CONVERSATION_LIMIT }) {
  const q = { limit };
  if (started) q.after = offset;
  return q;
}

// A burst (a forward page that came back full) is followed immediately instead
// of waiting for the next 2 s tick — but one tick can never fetch forever.
export const CONVERSATION_MAX_PAGES_PER_TICK = 5;

// shouldFollowBurst(page, { forward, limit, pagesFetched }) -> fetch the next
// page right now? Only a forward page that came back with `limit` entries is
// followed; a tail page is by definition at the end of the transcript.
export function shouldFollowBurst(page, { forward, limit, pagesFetched }) {
  if (!forward) return false;
  if (pagesFetched >= CONVERSATION_MAX_PAGES_PER_TICK) return false;
  const n = page && Array.isArray(page.entries) ? page.entries.length : 0;
  return n >= limit;
}

// buildTerminalSocketUrl(base, loc, cols, rows) — pure so the tests can pass a
// fake location. base is the API base ('' = same origin, an absolute URL
// switches origin and keeps its path, a relative prefix is appended).
export function buildTerminalSocketUrl(base, loc, cols, rows) {
  const abs = /^https?:\/\//i.test(base) ? new URL(base) : null;
  const wsProto = abs
    ? abs.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
    : loc && loc.protocol === 'https:'
      ? 'wss:'
      : 'ws:';
  const host = abs ? abs.host : loc ? loc.host : '';
  const prefix = abs
    ? abs.pathname.replace(/\/+$/, '')
    : (base || '').replace(/\/+$/, '');
  return (
    wsProto + '//' + host + prefix + '/api/supervisor/terminal?cols=' + cols + '&rows=' + rows
  );
}

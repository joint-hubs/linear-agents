export function fmtUSD(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return '$' + n.toFixed(2);
}

export function fmtUSD0(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return '$' + Math.round(n);
}

export function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

export function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return mm + '-' + dd + ' ' + hh + ':' + min;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

export function elapsed(startedAt, endedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const ms = end - start;
  if (ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
  if (m > 0) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return s + 's';
}

export function taskLabel(run) {
  return run.taskId || 'untagged';
}

// Canonical run status (ux-design-v3 §3.1):
//   running  = endedAt null (still active)
//   failed   = endedAt set AND exitCode >= 1
//   done     = endedAt set AND exitCode 0 / unknown
// The backend (ledger.mjs statusFromManifest) is the source of truth and
// exposes `run.status` on every aggregated run. It uses "completed" where the
// UI vocabulary is "done" — we normalize that here. Any other backend status
// (e.g. a future "cancelled") falls through to the derived fallback so legacy
// manifests without `status` keep working. (Review cross-ref D2.)
export function statusLabel(run) {
  if (!run) return 'done';
  if (run.status) {
    if (run.status === 'running' || run.status === 'failed') return run.status;
    if (run.status === 'completed' || run.status === 'done') return 'done';
  }
  if (!run.endedAt) return 'running';
  const ec = typeof run.exitCode === 'number' ? run.exitCode : parseInt(run.exitCode, 10);
  if (Number.isFinite(ec) && ec >= 1) return 'failed';
  return 'done';
}

// A run is stale when it is still active but started more than 2 h ago.
export function isStale(run, now = new Date()) {
  if (!run || !run.startedAt || run.endedAt) return false;
  return new Date(run.startedAt).getTime() < now.getTime() - 2 * 60 * 60 * 1000;
}

function isLocalToday(iso, now) {
  if (!iso) return false;
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// Sum cost + tokens over runs that started on local today.
export function todayTotals(runs, now = new Date()) {
  const t = { costUSD: 0, inputTokens: 0, outputTokens: 0 };
  for (const r of runs || []) {
    if (!isLocalToday(r.startedAt, now)) continue;
    const rt = r.totals || {};
    t.costUSD += rt.costUSD || 0;
    t.inputTokens += rt.inputTokens || 0;
    t.outputTokens += rt.outputTokens || 0;
  }
  return t;
}

// Attention list = ambiguous runs (last 24 h) + stale runs.
// Each entry: { run, reason: 'ambiguous' | 'stale' }.
export function attentionList(runs, now = new Date()) {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const items = [];
  for (const r of runs || []) {
    if (!r) continue;
    if (r.ambiguous && r.startedAt && new Date(r.startedAt).getTime() >= cutoff) {
      items.push({ run: r, reason: 'ambiguous' });
    }
    if (isStale(r, now)) {
      items.push({ run: r, reason: 'stale' });
    }
  }
  // De-dup by runId (a run could be both ambiguous and stale).
  const seen = new Set();
  return items.filter((it) => {
    const key = it.run.runId + ':' + it.reason;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function modelMix(byModel) {
  const entries = Object.entries(byModel || {});
  const total = entries.reduce((s, [, v]) => s + (v.costUSD || 0), 0);
  return entries
    .map(([slug, v]) => ({ slug, costUSD: v.costUSD || 0, pct: total > 0 ? ((v.costUSD || 0) / total) * 100 : 0 }))
    .sort((a, b) => b.costUSD - a.costUSD);
}

export function topByCost(obj, n = 10) {
  if (!obj) return [];
  return Object.entries(obj)
    .sort(([, a], [, b]) => (b.costUSD || 0) - (a.costUSD || 0))
    .slice(0, n);
}

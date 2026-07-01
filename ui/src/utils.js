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

export function statusLabel(run) {
  if (run.endedAt) return 'done';
  if (!run.startedAt) return 'stale';
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  if (new Date(run.startedAt).getTime() > tenMinAgo) return 'running';
  return 'stale';
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

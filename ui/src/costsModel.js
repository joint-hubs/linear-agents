// Costs & quality pure helpers (FOC-785). No React, no fetch, no env access —
// everything takes what it needs as arguments so the plain-node tests
// (_tests_costs.mjs) can pin the behavior outside Vite. Fixtures are shaped
// exactly like the plan's API payloads (GET /api/costs, GET /api/quality).
// Principle (plan, shared decisions): never invented numbers — unpriced is
// "unknown", and every metric carries its written definition (FOC-785 AC2).

import { formatMoney } from './workModel.js';

// The period toggle (spec §4.4): 7d / 30d / All — keys are the `period`
// parameter values the /api/costs route takes.
export const PERIODS = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'All' },
];

// Definitions shown under/next to the numbers when the payload does not carry
// its own (the API's `definitions` map wins — the server owns the wording).
const DEFAULT_DEFINITIONS = {
  childrenPerTicket:
    'Median (p50) children cost per ticket with the p20–p80 band, over tickets with children cost > 0.',
  allInAvgPerTicket: 'Total spend in the period divided by the number of tickets.',
  totalUsd: 'All spend attributed in the period: children, Supervisor share, overhead and unattributed.',
  supervisorShare: 'Supervisor cost as a share of the total spend in the period.',
  attribution:
    'Shown while the Supervisor-attributed share is below 80 % (FOC-769): overhead plus unattributed Supervisor cost.',
};

// pct(share) -> "64 %" (0.72 -> "72 %", 63.75 % -> "63.8 %") or null when
// there is no share. The space keeps the unit from reading as a decoration.
function pct(share) {
  if (share == null || typeof share !== 'number' || Number.isNaN(share)) return null;
  return (share * 100).toFixed(1).replace(/\.0$/, '') + ' %';
}

// kpiTiles(costs) -> the four KPI tiles { key, label, value, sub, definition }
// (spec §4.4): children cost per ticket p50 with the p20–p80 band as sub,
// all-in average per ticket, total spend, Supervisor share. Null -> "unknown"
// — never a fake zero. `sub` is null when the band is not in the payload.
export function kpiTiles(costs) {
  const c = costs || {};
  const k = c.kpis || {};
  const defs = c.definitions || {};
  const cpt = k.childrenPerTicket || null;
  return [
    {
      key: 'childrenPerTicket',
      label: 'Children cost per ticket',
      value: cpt && cpt.p50 != null ? formatMoney(cpt.p50) : 'unknown',
      sub:
        cpt && cpt.p20 != null && cpt.p80 != null
          ? 'p20–p80 ' + formatMoney(cpt.p20) + '–' + formatMoney(cpt.p80)
          : null,
      definition: defs.childrenPerTicket || DEFAULT_DEFINITIONS.childrenPerTicket,
    },
    {
      key: 'allInAvgPerTicket',
      label: 'All-in average per ticket',
      value: k.allInAvgPerTicket != null ? formatMoney(k.allInAvgPerTicket) : 'unknown',
      sub: null,
      definition: defs.allInAvgPerTicket || DEFAULT_DEFINITIONS.allInAvgPerTicket,
    },
    {
      key: 'totalUsd',
      label: 'Total spend',
      value: k.totalUsd != null ? formatMoney(k.totalUsd) : 'unknown',
      sub: null,
      definition: defs.totalUsd || DEFAULT_DEFINITIONS.totalUsd,
    },
    {
      key: 'supervisorShare',
      label: 'Supervisor share',
      value: pct(k.supervisorShare) || 'unknown',
      sub: null,
      definition: defs.supervisorShare || DEFAULT_DEFINITIONS.supervisorShare,
    },
  ];
}

// attributionBanner(costs) -> null while attribution is at target (nothing to
// apologise for), otherwise { text, definition }: the honest sentence about
// how much Supervisor cost is not attributed to a ticket yet.
export function attributionBanner(costs) {
  const a = costs && costs.attribution;
  if (!a || !a.belowTarget) return null;
  const defs = (costs && costs.definitions) || {};
  return {
    text:
      'Supervisor attribution ' +
      (pct(a.attributedShare) || 'unknown') +
      ' — ' +
      formatMoney(a.overheadUsd) +
      ' overhead, ' +
      formatMoney(a.unattributedUsd) +
      ' unattributed',
    definition: defs.attribution || DEFAULT_DEFINITIONS.attribution,
  };
}

// byDayBars(byDay) -> { bars, max, summary } for the stacked children vs
// Supervisor spend-by-day chart (spec §4.4, §7: charts get role="img" and a
// text label — the summary is that label). The Supervisor segment is ALL
// Supervisor cost: supervisorUsd + overheadUsd + unattributedUsd (all three
// payload fields, acceptance FOC-785). Missing amounts count as 0 for the
// scaling; max is the tallest stacked total so the screen can scale the bars.
export function byDayBars(byDay) {
  const rows = Array.isArray(byDay) ? byDay : [];
  if (rows.length === 0) {
    return { bars: [], max: 0, summary: 'No spend recorded in this period.' };
  }
  const amount = (v) => (v != null ? v : 0);
  const bars = rows.map((r) => {
    const children = amount(r && r.childrenUsd);
    const supervisor =
      amount(r && r.supervisorUsd) + amount(r && r.overheadUsd) + amount(r && r.unattributedUsd);
    return { day: (r && r.day) || null, children, supervisor, total: children + supervisor };
  });
  const max = bars.reduce((m, b) => Math.max(m, b.total), 0);
  const total = bars.reduce((s, b) => s + b.total, 0);
  const top = bars.reduce((t, b) => (b.total > t.total ? b : t), bars[0]);
  const summary =
    'Spend by day over ' +
    bars.length +
    ' day' +
    (bars.length === 1 ? '' : 's') +
    ': total ' +
    formatMoney(total) +
    ', highest ' +
    (top.day || 'unknown day') +
    ' at ' +
    formatMoney(top.total) +
    ' (children ' +
    formatMoney(top.children) +
    ', Supervisor ' +
    formatMoney(top.supervisor) +
    ' incl. overhead and unattributed).';
  return { bars, max, summary };
}

// modelMixRows(byModel) -> one row per model: { model, cost, share, messages }.
// share arrives as a fraction in the payload and leaves as a % text.
export function modelMixRows(byModel) {
  const rows = Array.isArray(byModel) ? byModel : [];
  return rows.map((m) => ({
    model: (m && m.model) || 'unknown model',
    cost: formatMoney(m && m.usd),
    share: pct(m && m.share) || 'unknown',
    messages: m && m.messages != null ? m.messages : null,
  }));
}

// expensiveRows(mostExpensive) -> the outlier table rows with their "why"
// (the first matching rule from the plan, else "unexplained"). A payload
// "no matching rule" placeholder reads as "unexplained" (spec §4.4).
const NO_RULE = /^no matching rule$/i;

export function expensiveRows(mostExpensive) {
  const rows = Array.isArray(mostExpensive) ? mostExpensive : [];
  return rows.map((t) => {
    const raw = ((t && t.why && t.why.text) || (t && t.why && t.why.rule) || '').trim();
    return {
      taskId: (t && t.taskId) || null,
      total: formatMoney(t && t.totalUsd),
      children: formatMoney(t && t.childrenUsd),
      supervisor: formatMoney(t && t.supervisorUsd),
      why: !raw || NO_RULE.test(raw) ? 'unexplained' : raw,
    };
  });
}

// qualityCards(quality) -> the quality signal cards { key, value, definition,
// evidenceCount } (spec §4.4: each with its written definition). A share is a
// %, a count is a count, and a null value is honestly "n/a — no data".
export function qualityCards(quality) {
  const signals = quality && Array.isArray(quality.signals) ? quality.signals : [];
  return signals.map((s) => {
    const v = s && s.value;
    const has = typeof v === 'number' && !Number.isNaN(v);
    return {
      key: (s && s.key) || 'unknown',
      value: !has ? 'n/a — no data' : (s && s.unit) === 'count' ? String(v) : pct(v) || 'n/a — no data',
      definition: (s && s.definition) || null,
      evidenceCount: s && Array.isArray(s.evidence) ? s.evidence.length : 0,
    };
  });
}
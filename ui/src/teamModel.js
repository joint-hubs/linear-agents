// Team screen pure helpers (FOC-791). No React, no env access — everything
// takes what it needs as arguments so the plain-node tests (_tests_team.mjs)
// can pin the behavior outside Vite. The payload shape is the /api/team
// contract in docs/plans/foc-791-team-lineups.md §2 (binding). Everything is
// null-safe: a missing field renders "—", never throws.

export const TEAM_SCOPES = ['overall', 'group', 'ticket'];
export const TEAM_PERIODS = ['7d', '30d', '90d', 'all'];
const FILTER_KEYS = ['repo', 'milestone', 'type', 'epic', 'size'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : {});

// parseTeamQuery(search) -> { scope, period, repo, milestone, type, epic,
// size, ticket }. Defaults overall/30d; an unknown scope/period value falls
// back to the defaults instead of reaching the server. Filters keep empty
// strings so the caller can hold draft input.
export function parseTeamQuery(search) {
  const p = new URLSearchParams(search || '');
  const scope = TEAM_SCOPES.includes(p.get('scope')) ? p.get('scope') : 'overall';
  const period = TEAM_PERIODS.includes(p.get('period')) ? p.get('period') : '30d';
  const val = (k) => {
    const v = p.get(k);
    return v && v.trim() ? v.trim() : '';
  };
  return {
    scope,
    period,
    repo: val('repo'),
    milestone: val('milestone'),
    type: val('type'),
    epic: val('epic'),
    size: val('size'),
    ticket: val('ticket'),
  };
}

// teamQueryParams(state) -> the query object for GET /api/team: empty values
// omitted; the period is dropped in the ticket scope (ignored there per §2)
// and the group filters only ride the group scope.
export function teamQueryParams(state) {
  const s = obj(state);
  const scope = TEAM_SCOPES.includes(s.scope) ? s.scope : 'overall';
  const params = { scope };
  if (scope === 'ticket') {
    if (s.ticket) params.ticket = s.ticket;
    return params;
  }
  params.period = TEAM_PERIODS.includes(s.period) ? s.period : '30d';
  if (scope === 'group') {
    for (const k of FILTER_KEYS) if (s[k]) params[k] = s[k];
  }
  return params;
}

// teamQueryString(state) -> the ready query string ('' never — scope is
// always set). The URL state format: /team?scope=…&period=…&repo=…&…&ticket=….
export function teamQueryString(state) {
  return new URLSearchParams(teamQueryParams(state)).toString();
}

// diagramModel(payload) -> { you, supervisor: { model, costUsd },
// leads: [{ key, label, model, costUsd, ran, picks, sessions,
// lineup: [{ role, model, picks, pickShare, barPct, costUsd }],
// bench: [{ role, pickShare }] }] }.
// The line-up is sorted by pickShare desc; barPct = round(pickShare*100)
// clamped to 0..100. placement='bench' (or a share under the 0.05 line-up
// threshold when the payload omits placement) sends a role to the bench card;
// the lead's own row (role '_lead'/'lead', or placement='lead') never appears —
// the lead card in the tier header carries it.
export function diagramModel(payload) {
  const p = obj(payload);
  const squads = Array.isArray(p.squads) ? p.squads : [];
  const sup = obj(p.supervisor);
  const leads = squads.map((squad) => {
    const s = obj(squad);
    const lead = obj(s.lead);
    const roles = Array.isArray(s.roles) ? s.roles : [];
    const lineup = [];
    const bench = [];
    for (const r of roles) {
      const role = obj(r);
      const name = str(role.role);
      if (name === null || name === '_lead' || name === 'lead' || role.placement === 'lead') continue;
      const share = num(role.pickShare);
      const placement =
        role.placement === 'lineup' || role.placement === 'bench'
          ? role.placement
          : share != null && share < 0.05
            ? 'bench'
            : 'lineup';
      const entry = {
        role: name,
        model: str(role.model),
        picks: num(role.picks),
        pickShare: share,
        barPct: share == null ? 0 : Math.max(0, Math.min(100, Math.round(share * 100))),
        costUsd: num(role.costUsd),
      };
      if (placement === 'bench') bench.push({ role: name, pickShare: share });
      else lineup.push(entry);
    }
    lineup.sort((a, b) => (b.pickShare == null ? -1 : b.pickShare) - (a.pickShare == null ? -1 : a.pickShare));
    const key = str(s.key) || '—';
    return {
      key,
      label: key,
      model: str(lead.model),
      costUsd: num(s.costUsd),
      ran: !!s.ran,
      picks: num(s.picks),
      sessions: num(s.sessions),
      lineup,
      bench,
    };
  });
  return {
    you: true,
    supervisor: { model: str(sup.model), costUsd: num(sup.costUsd) },
    leads,
  };
}

// lineupTable(squad) -> rows for the detail table: { role, model, picks,
// pickShare, costUsd, costShare, placement, overallPickShare }. pickShare /
// costShare / overallPickShare are pre-formatted "NN %" strings (overall null
// when the payload omits it — it only exists in the group and ticket scopes);
// the lead row sits first, labelled out of the pick shares (D1: the lead is
// excluded from pickShare but its own sessions ride the table as picks). The
// payload's own lead row (role '_lead'/'lead' or placement='lead') IS the lead
// row — it is never duplicated by the role loop.
export function lineupTable(squad) {
  const s = obj(squad);
  const roles = Array.isArray(s.roles) ? s.roles : [];
  const lead = obj(s.lead);
  const isLeadRow = (r) => {
    const ro = obj(r);
    return ro.role === '_lead' || ro.role === 'lead' || ro.placement === 'lead';
  };
  const leadEntry = roles.find(isLeadRow);
  const rows = [];
  if (leadEntry || str(lead.model) != null || num(lead.costUsd) != null) {
    rows.push({
      role: 'lead (own sessions)',
      model: str(lead.model) || str(obj(leadEntry).model) || '—',
      picks: num(leadEntry ? leadEntry.picks : lead.picks),
      pickShare: '—',
      costUsd: fmtUsd(num(leadEntry ? leadEntry.costUsd : lead.costUsd)),
      costShare: fmtPct(num(lead.costShare)),
      placement: 'lead',
      overallPickShare: null,
    });
  }
  for (const r of roles) {
    const role = obj(r);
    if (isLeadRow(r)) continue;
    const overall = num(role.overallPickShare);
    rows.push({
      role: str(role.role) || '—',
      model: str(role.model) || '—',
      picks: num(role.picks),
      pickShare: fmtPct(num(role.pickShare)),
      costUsd: fmtUsd(num(role.costUsd)),
      costShare: fmtPct(num(role.costShare)),
      placement: role.placement == null ? '—' : String(role.placement),
      overallPickShare: overall == null ? null : fmtPct(overall),
    });
  }
  return rows;
}

// childrenSummary(squad) -> [{ label, greyed }] for the ticket scope —
// "dev-1 running" chips, greyed when the squad has no run in scope (the
// children list then describes a past run, not a live one).
export function childrenSummary(squad) {
  const s = obj(squad);
  const ran = !!s.ran;
  const children = Array.isArray(s.children) ? s.children : [];
  return children.map((c) => {
    const child = obj(c);
    return {
      label: (str(child.childId) || '—') + ' ' + (str(child.status) || 'unknown'),
      greyed: !ran,
    };
  });
}

// fmtUsd(v) -> "$1.20" | "$0.00" | "—" (anything that is not a finite number).
export function fmtUsd(v) {
  const n = num(v);
  return n == null ? '—' : '$' + n.toFixed(2);
}

// fmtPct(frac) -> "50%" | "0%" | "—" (rounded to whole percent).
export function fmtPct(frac) {
  const n = num(frac);
  return n == null ? '—' : Math.round(n * 100) + '%';
}

// Unit tests for the Team screen pure helpers (FOC-791).
// Self-contained Node ESM script — NO test framework, NO deps, NO network.
// Same harness pattern as src/_tests_cockpit.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: parseTeamQuery / teamQueryParams / teamQueryString (the URL state
// round-trip, defaults, per-scope rules), diagramModel (line-up/bench split,
// sorting, share-bar widths, ran=false, '_lead' exclusion, null safety),
// lineupTable (lead row first, overall share only when present),
// childrenSummary (greyed when the squad did not run) and the formatters.
// The fixture payload matches docs/plans/foc-791-team-lineups.md §2 exactly.

import assert from 'node:assert/strict';

import {
  parseTeamQuery,
  teamQueryParams,
  teamQueryString,
  diagramModel,
  lineupTable,
  childrenSummary,
  fmtUsd,
  fmtPct,
} from './teamModel.js';

// --- Minimal test harness (same shape as _tests_cockpit.mjs) -----------------

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`√ ${name}`);
  } catch (err) {
    fail++;
    console.log(`× ${name} — ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, msg) {
  assert.deepEqual(actual, expected, msg);
}

// --- Fixture (the §2 contract; 4 squads, one ran=false, one bench role) ------

const devSquad = {
  key: 'dev',
  ran: true,
  lead: { model: 'z-ai/glm-5.3-flash', costUsd: 1.2, costShare: 0.2 },
  costUsd: 6.0,
  picks: 10,
  sessions: 12,
  roles: [
    { role: 'implementer', model: 'z-ai/glm-5.3-flash', picks: 5, pickShare: 0.5, costUsd: 1.8, costShare: 0.3, placement: 'lineup', overallPickShare: 0.5 },
    { role: 'general-purpose', model: 'z-ai/glm-5.3-flash', picks: 1, pickShare: 0.475, costUsd: 1.86, costShare: 0.31, placement: 'lineup', overallPickShare: 0.08 },
    { role: 'explorer', model: 'z-ai/glm-5.3-flash', picks: 1, pickShare: 0.02, costUsd: 0.1, costShare: 0.02, placement: 'bench', overallPickShare: 0.03 },
    { role: '_lead', model: 'z-ai/glm-5.3-flash', picks: 3, pickShare: null, costUsd: 1.2, costShare: null },
  ],
  insight: 'implementer is 50 % of picks; general-purpose is 10 % of picks but 31 % of cost',
  children: [{ childId: 'dev-1', status: 'running', runId: 'run-1' }],
  links: { prompts: '/prompts?squad=dev', tools: '/settings/agent-tools', models: '/squad-config?squad=dev' },
};

const reviewSquad = {
  key: 'review',
  ran: false,
  lead: { model: 'z-ai/glm-5.3-flash', costUsd: 0, costShare: 0 },
  costUsd: 0,
  picks: 0,
  sessions: 0,
  roles: [{ role: 'reviewer', model: 'z-ai/glm-5.3-flash', picks: 0, pickShare: 0, costUsd: 0, costShare: 0, placement: 'bench' }],
  insight: '',
  children: [],
  links: { prompts: '/prompts?squad=review', tools: '/settings/agent-tools', models: '/squad-config?squad=review' },
};

const planSquad = {
  key: 'plan',
  ran: true,
  lead: { model: 'z-ai/glm-5.3-flash', costUsd: 0.4, costShare: 0.5 },
  costUsd: 0.8,
  picks: 2,
  sessions: 2,
  roles: [{ role: 'planner', model: 'z-ai/glm-5.3-flash', picks: 2, pickShare: 1, costUsd: 0.4, costShare: 0.5, placement: 'lineup', overallPickShare: 0.9 }],
  insight: 'planner is 100 % of picks',
  children: [],
  links: { prompts: '/prompts?squad=plan', tools: '/settings/agent-tools', models: '/squad-config?squad=plan' },
};

const testSquad = {
  key: 'test',
  ran: true,
  lead: { model: 'z-ai/glm-5.3-flash', costUsd: 0.6, costShare: 0.3 },
  costUsd: 2.0,
  picks: 4,
  sessions: 5,
  roles: [{ role: 'tester', model: 'z-ai/glm-5.3-flash', picks: 4, pickShare: 1, costUsd: 1.4, costShare: 0.7, placement: 'lineup', overallPickShare: 0.85 }],
  insight: 'tester is 100 % of picks',
  children: [],
  links: { prompts: '/prompts?squad=test', tools: '/settings/agent-tools', models: '/squad-config?squad=test' },
};

// The overall fixture — every number the contract names.
const FIXTURE = {
  scope: 'overall',
  period: { from: '2026-09-18T00:00:00Z', to: '2026-10-18T00:00:00Z', days: 30 },
  filters: { applied: {}, supported: ['repo', 'milestone', 'type'], unsupported: ['epic', 'size'] },
  groundTruth: 'per-message priced usage (FOC-760/761)',
  generatedAt: '2026-10-18T10:00:00Z',
  totals: { costUsd: 12.5, sessions: 40, tasks: 5, runs: 8 },
  supervisor: { model: 'claude-opus-5-5', costUsd: 3.2 },
  squads: [devSquad, reviewSquad, planSquad, testSquad],
  ticket: { id: 'FOC-123', runs: ['run-1'] },
};

// --- parseTeamQuery -----------------------------------------------------------

await test('parseTeamQuery defaults: empty search -> overall/30d, empty filters', () => {
  eq(parseTeamQuery(''), {
    scope: 'overall',
    period: '30d',
    repo: '',
    milestone: '',
    type: '',
    epic: '',
    size: '',
    ticket: '',
  });
});

await test('parseTeamQuery reads a full group query', () => {
  eq(
    parseTeamQuery('?scope=group&period=7d&repo=fenix&milestone=M8&type=bug&epic=FOC-700&size=L'),
    {
      scope: 'group',
      period: '7d',
      repo: 'fenix',
      milestone: 'M8',
      type: 'bug',
      epic: 'FOC-700',
      size: 'L',
      ticket: '',
    },
  );
});

await test('parseTeamQuery reads the ticket scope', () => {
  eq(parseTeamQuery('?scope=ticket&ticket=FOC-123').scope, 'ticket');
  eq(parseTeamQuery('?scope=ticket&ticket=FOC-123').ticket, 'FOC-123');
});

await test('parseTeamQuery unknown scope/period -> defaults (never reaches the server)', () => {
  eq(parseTeamQuery('?scope=nope&period=fortnight').scope, 'overall');
  eq(parseTeamQuery('?scope=nope&period=fortnight').period, '30d');
});

await test('parseTeamQuery(null) / missing search -> defaults', () => {
  eq(parseTeamQuery(null).scope, 'overall');
  eq(parseTeamQuery(undefined).period, '30d');
});

// --- teamQueryParams / teamQueryString ----------------------------------------

await test('teamQueryParams overall -> scope + period only (filters never ride)', () => {
  eq(
    teamQueryParams({ scope: 'overall', period: '90d', repo: 'fenix', ticket: 'FOC-1' }),
    { scope: 'overall', period: '90d' },
  );
});

await test('teamQueryParams group -> scope + period + non-empty filters', () => {
  eq(
    teamQueryParams({ scope: 'group', period: '7d', repo: 'fenix', milestone: '', type: 'bug' }),
    { scope: 'group', period: '7d', repo: 'fenix', type: 'bug' },
  );
});

await test('teamQueryParams ticket -> scope + ticket, no period, no filters', () => {
  eq(
    teamQueryParams({ scope: 'ticket', period: '7d', repo: 'fenix', ticket: 'FOC-123' }),
    { scope: 'ticket', ticket: 'FOC-123' },
  );
  eq(
    teamQueryParams({ scope: 'ticket', ticket: '' }),
    { scope: 'ticket' },
  );
});

await test('teamQueryParams unknown scope/period -> normalized defaults', () => {
  eq(teamQueryParams({ scope: 'nope', period: 'nope' }), { scope: 'overall', period: '30d' });
});

await test('teamQueryString encodes the values (URL round-trip)', () => {
  eq(teamQueryString({ scope: 'group', period: '7d', repo: 'fenix', type: 'bug' }), 'scope=group&period=7d&repo=fenix&type=bug');
  eq(teamQueryString({ scope: 'ticket', ticket: 'FOC-123' }), 'scope=ticket&ticket=FOC-123');
  eq(teamQueryString({}), 'scope=overall&period=30d');
});

await test('URL round-trip: parse(teamQueryString(state)) == state for group + ticket', () => {
  const group = { scope: 'group', period: '7d', repo: 'fenix', milestone: 'M8', type: 'bug', epic: '', size: '', ticket: '' };
  eq(parseTeamQuery('?' + teamQueryString(group)), group);
  const ticket = { scope: 'ticket', period: '30d', repo: '', milestone: '', type: '', epic: '', size: '', ticket: 'FOC-123' };
  eq(parseTeamQuery('?' + teamQueryString(ticket)), ticket);
  const overall = { scope: 'overall', period: 'all', repo: 'fenix', milestone: '', type: '', epic: '', size: '', ticket: '' };
  // Filters are dropped on purpose in the overall scope (they never ride the
  // query there) — the round-trip keeps scope + period only.
  eq(parseTeamQuery('?' + teamQueryString(overall)), { ...overall, repo: '' });
});

// --- diagramModel --------------------------------------------------------------

const diagram = diagramModel(FIXTURE);

await test('diagramModel mirrors the supervisor tier', () => {
  eq(diagram.you, true);
  eq(diagram.supervisor, { model: 'claude-opus-5-5', costUsd: 3.2 });
});

await test('diagramModel one lead card per squad, in payload order', () => {
  eq(diagram.leads.map((l) => l.key), ['dev', 'review', 'plan', 'test']);
});

await test('diagramModel lead card carries model, squad cost, ran flag', () => {
  const dev = diagram.leads[0];
  eq(dev.model, 'z-ai/glm-5.3-flash');
  eq(dev.costUsd, 6.0);
  eq(dev.ran, true);
  eq(dev.picks, 10);
  eq(dev.sessions, 12);
  eq(diagram.leads[1].ran, false);
});

await test('diagramModel lineup sorted by pickShare desc, barPct = round(share*100)', () => {
  const dev = diagram.leads[0];
  eq(dev.lineup.map((r) => r.role), ['implementer', 'general-purpose']);
  eq(dev.lineup[0].barPct, 50);
  eq(dev.lineup[1].barPct, 48); // 0.475 -> 48
  eq(dev.lineup[0].pickShare, 0.5);
  eq(dev.lineup[0].costUsd, 1.8);
});

await test('diagramModel bench holds the low-share roles with role + share', () => {
  eq(diagram.leads[0].bench, [{ role: 'explorer', pickShare: 0.02 }]);
  eq(diagram.leads[1].bench, [{ role: 'reviewer', pickShare: 0 }]);
});

await test("diagramModel the '_lead' row never becomes a line-up card", () => {
  const dev = diagram.leads[0];
  eq(dev.lineup.some((r) => r.role === '_lead'), false);
  eq(dev.bench.some((r) => r.role === '_lead'), false);
});

await test('diagramModel the payload lead row (role=lead, placement=lead) never reaches lineup/bench', () => {
  const d = diagramModel({
    squads: [
      {
        key: 'dev',
        ran: true,
        roles: [
          { role: 'lead', placement: 'lead', picks: 3, pickShare: null, costUsd: 1.2, costShare: null },
          { role: 'implementer', model: 'z-ai/glm-5.3-flash', picks: 5, pickShare: 0.5, costUsd: 1.8, costShare: 0.3, placement: 'lineup' },
          { role: 'explorer', model: 'z-ai/glm-5.3-flash', picks: 1, pickShare: 0.02, costUsd: 0.1, costShare: 0.02, placement: 'bench' },
        ],
      },
    ],
  });
  const dev = d.leads[0];
  eq(dev.lineup.map((r) => r.role), ['implementer']);
  eq(dev.bench.map((r) => r.role), ['explorer']);
  eq(dev.lineup.some((r) => r.role === 'lead' || r.role === '_lead'), false);
  eq(dev.bench.some((r) => r.role === 'lead' || r.role === '_lead'), false);
});

await test('diagramModel derives bench when placement is omitted (share < 0.05)', () => {
  const d = diagramModel({
    squads: [
      {
        key: 'dev',
        ran: true,
        roles: [
          { role: 'big', pickShare: 0.9 },
          { role: 'tiny', pickShare: 0.04 },
        ],
      },
    ],
  });
  eq(d.leads[0].lineup.map((r) => r.role), ['big']);
  eq(d.leads[0].bench.map((r) => r.role), ['tiny']);
});

await test('diagramModel barPct clamps to 0..100', () => {
  const d = diagramModel({ squads: [{ key: 'dev', ran: true, roles: [{ role: 'x', pickShare: 1.4 }] }] });
  eq(d.leads[0].lineup[0].barPct, 100);
});

await test('diagramModel null-safe: no payload, no squads, no roles -> empty tiers, never throws', () => {
  eq(diagramModel(null), { you: true, supervisor: { model: null, costUsd: null }, leads: [] });
  eq(diagramModel({}), { you: true, supervisor: { model: null, costUsd: null }, leads: [] });
  const d = diagramModel({ squads: [{ key: 'dev', ran: true }] });
  eq(d.leads[0].lineup, []);
  eq(d.leads[0].bench, []);
  eq(d.leads[0].model, null);
  eq(d.leads[0].costUsd, null);
});

// --- lineupTable ---------------------------------------------------------------

await test('lineupTable lead row first: own sessions as picks, excluded from pickShare', () => {
  const rows = lineupTable(devSquad);
  eq(rows[0], {
    role: 'lead (own sessions)',
    model: 'z-ai/glm-5.3-flash',
    picks: 3,
    pickShare: '—',
    costUsd: '$1.20',
    costShare: '20%',
    placement: 'lead',
    overallPickShare: null,
  });
});

await test('lineupTable role rows carry the formatted shares and placement', () => {
  const rows = lineupTable(devSquad).filter((r) => r.role === 'implementer');
  eq(rows, [
    {
      role: 'implementer',
      model: 'z-ai/glm-5.3-flash',
      picks: 5,
      pickShare: '50%',
      costUsd: '$1.80',
      costShare: '30%',
      placement: 'lineup',
      overallPickShare: '50%',
    },
  ]);
});

await test('lineupTable overallPickShare null when the payload omits it (overall scope)', () => {
  const noOverall = { ...devSquad, roles: devSquad.roles.map(({ overallPickShare, ...rest }) => rest) };
  eq(lineupTable(noOverall)[1].overallPickShare, null);
});

await test('lineupTable ran=false squad keeps its config roles with zeros', () => {
  const rows = lineupTable(reviewSquad);
  eq(rows.length, 2);
  eq(rows[1], {
    role: 'reviewer',
    model: 'z-ai/glm-5.3-flash',
    picks: 0,
    pickShare: '0%',
    costUsd: '$0.00',
    costShare: '0%',
    placement: 'bench',
    overallPickShare: null,
  });
});

await test('lineupTable payload lead row (role=lead, placement=lead) -> exactly ONE lead row, payload picks', () => {
  const withLeadRow = {
    key: 'dev',
    ran: true,
    lead: { model: 'z-ai/glm-5.3-flash', costUsd: 1.2, costShare: 0.2 },
    roles: [
      { role: 'lead', placement: 'lead', picks: 3, pickShare: null, costUsd: 1.2, costShare: null },
      { role: 'implementer', model: 'z-ai/glm-5.3-flash', picks: 5, pickShare: 0.5, costUsd: 1.8, costShare: 0.3, placement: 'lineup' },
    ],
  };
  const rows = lineupTable(withLeadRow);
  const leadRows = rows.filter((r) => r.placement === 'lead');
  eq(leadRows.length, 1);
  eq(leadRows[0], {
    role: 'lead (own sessions)',
    model: 'z-ai/glm-5.3-flash',
    picks: 3,
    pickShare: '—',
    costUsd: '$1.20',
    costShare: '20%',
    placement: 'lead',
    overallPickShare: null,
  });
  eq(rows.length, 2); // lead row + implementer — no duplicate lead from the role loop
});

await test('lineupTable no payload lead row -> exactly one synthesised lead row from squad.lead', () => {
  const noLeadRow = {
    key: 'dev',
    ran: true,
    lead: { model: 'z-ai/glm-5.3-flash', picks: 3, costUsd: 1.2, costShare: 0.2 },
    roles: [{ role: 'implementer', model: 'z-ai/glm-5.3-flash', picks: 5, pickShare: 0.5, costUsd: 1.8, costShare: 0.3, placement: 'lineup' }],
  };
  const rows = lineupTable(noLeadRow);
  const leadRows = rows.filter((r) => r.placement === 'lead');
  eq(leadRows.length, 1);
  eq(leadRows[0].role, 'lead (own sessions)');
  eq(leadRows[0].picks, 3);
  eq(leadRows[0].pickShare, '—');
  eq(rows.length, 2); // lead row + implementer
});

await test('lineupTable null-safe: empty squad -> no rows, never throws', () => {
  eq(lineupTable(null), []);
  eq(lineupTable({}), []);
});

// --- childrenSummary (ticket scope) ---------------------------------------------

await test('childrenSummary "dev-1 running", not greyed when the squad ran', () => {
  eq(childrenSummary(devSquad), [{ label: 'dev-1 running', greyed: false }]);
});

await test('childrenSummary greyed when the squad has no run in scope', () => {
  eq(childrenSummary({ ...reviewSquad, children: [{ childId: 'rev-1', status: 'exited' }] }), [
    { label: 'rev-1 exited', greyed: true },
  ]);
});

await test('childrenSummary null-safe: no squad / no children -> []', () => {
  eq(childrenSummary(null), []);
  eq(childrenSummary({}), []);
  eq(childrenSummary({ ran: true }), []);
});

// --- formatters -----------------------------------------------------------------

await test('fmtUsd: numbers to $x.xx, everything else to —', () => {
  eq(fmtUsd(0), '$0.00');
  eq(fmtUsd(1.2), '$1.20');
  eq(fmtUsd(12.5), '$12.50');
  eq(fmtUsd(null), '—');
  eq(fmtUsd(undefined), '—');
  eq(fmtUsd(NaN), '—');
  eq(fmtUsd(Infinity), '—');
  eq(fmtUsd('1.2'), '—');
});

await test('fmtPct: fractions to whole percents, everything else to —', () => {
  eq(fmtPct(0), '0%');
  eq(fmtPct(0.5), '50%');
  eq(fmtPct(0.475), '48%');
  eq(fmtPct(1), '100%');
  eq(fmtPct(null), '—');
  eq(fmtPct(undefined), '—');
  eq(fmtPct(NaN), '—');
  eq(fmtPct('50%'), '—');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

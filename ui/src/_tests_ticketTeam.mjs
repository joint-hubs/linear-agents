// Unit tests for the ticket-panel "Team on this ticket" block (FOC-791 slice C).
// Self-contained Node ESM script — NO test framework, NO deps, NO network.
// Same harness pattern as src/_tests_team.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: ticketTeamSummary (full payload, ran=false, empty/absent roles,
// missing payload, fixed squad order, top-pick selection excluding '_lead' and
// bench roles) and the teamQueryString link the panel builds to /team.

import assert from 'node:assert/strict';

import { ticketTeamSummary } from './workModel.js';
import { teamQueryString } from './teamModel.js';

// --- Minimal test harness (same shape as _tests_team.mjs) --------------------

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

// --- Fixtures ----------------------------------------------------------------

// The §2 contract shape, trimmed to what the summary reads. plan did not run
// (roles from the squad config, zeros); dev ran with a bench role the top pick
// must ignore; review/test absent from the payload entirely.
const payload = {
  scope: 'ticket',
  squads: [
    {
      key: 'dev',
      ran: true,
      lead: { model: 'z-ai/glm-5.3-flash', costUsd: 1.2, costShare: 0.2 },
      costUsd: 6.0,
      roles: [
        { role: 'implementer', model: 'z-ai/glm-5.3-flash', picks: 5, pickShare: 0.5, costUsd: 1.8, costShare: 0.3, placement: 'lineup' },
        { role: 'explorer', model: 'z-ai/glm-5.3-flash', picks: 1, pickShare: 0.02, costUsd: 0.1, costShare: 0.02, placement: 'bench' },
        { role: '_lead', model: 'z-ai/glm-5.3-flash', picks: 3, pickShare: null, costUsd: 1.2, costShare: null },
      ],
      children: [
        { childId: 'dev-1', status: 'running', runId: 'r1' },
        { childId: 'dev-2', status: 'done', runId: 'r2' },
      ],
    },
    {
      key: 'plan',
      ran: false,
      lead: { model: null, costUsd: 0, costShare: null },
      costUsd: 0,
      roles: [
        { role: 'planner', model: 'z-ai/glm-5.3-flash', picks: 0, pickShare: 0, costUsd: 0, costShare: 0, placement: 'lineup' },
      ],
      children: [{ childId: 'plan-9', status: 'done', runId: 'r0' }],
    },
  ],
};

// --- ticketTeamSummary --------------------------------------------------------

await test('full payload: one row per squad in the fixed plan/dev/review/test order', async () => {
  const rows = ticketTeamSummary(payload);
  eq(rows.map((r) => r.key), ['plan', 'dev', 'review', 'test']);
  eq(rows.map((r) => r.label), ['Plan', 'Dev', 'Review', 'Test']);
});

await test('ran squad: lead model, cost, top pick ignores bench and _lead', async () => {
  const dev = ticketTeamSummary(payload).find((r) => r.key === 'dev');
  eq(dev.ran, true);
  eq(dev.leadModel, 'z-ai/glm-5.3-flash');
  eq(dev.costUsd, 6.0);
  eq(dev.topPick, { role: 'implementer', pickShare: 0.5 });
});

await test('children ride as "dev-1 running" chip labels', async () => {
  const dev = ticketTeamSummary(payload).find((r) => r.key === 'dev');
  eq(dev.children, ['dev-1 running', 'dev-2 done']);
});

await test('ran=false squad: topPick null, zero cost survives, children kept', async () => {
  const plan = ticketTeamSummary(payload).find((r) => r.key === 'plan');
  eq(plan.ran, false);
  eq(plan.leadModel, null);
  eq(plan.costUsd, 0);
  eq(plan.topPick, null);
  eq(plan.children, ['plan-9 done']);
});

await test('squad absent from the payload: greyed empty row', async () => {
  const review = ticketTeamSummary(payload).find((r) => r.key === 'review');
  eq(review.ran, false);
  eq(review.leadModel, null);
  eq(review.costUsd, null);
  eq(review.topPick, null);
  eq(review.children, []);
});

await test('missing payload -> []', async () => {
  eq(ticketTeamSummary(null), []);
  eq(ticketTeamSummary(undefined), []);
  eq(ticketTeamSummary({}), []);
});

await test('roles with no numeric share never carry a topPick', async () => {
  const squad = {
    key: 'dev',
    ran: true,
    lead: { model: 'm' },
    costUsd: 1,
    roles: [
      { role: 'a', pickShare: null, placement: 'lineup' },
      { role: '_lead', pickShare: 0.9 },
    ],
  };
  eq(ticketTeamSummary({ squads: [squad] }).find((r) => r.key === 'dev').topPick, null);
});

// --- The panel's /team link ---------------------------------------------------

await test('link string: /team?scope=ticket&ticket=<display id>', async () => {
  eq(teamQueryString({ scope: 'ticket', ticket: 'FOC-123' }), 'scope=ticket&ticket=FOC-123');
  // The period and group filters never ride the ticket scope (§2: ignored).
  eq(
    teamQueryString({ scope: 'ticket', ticket: 'FOC-9', period: '7d', repo: 'fenix' }),
    'scope=ticket&ticket=FOC-9',
  );
});

// --- Summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

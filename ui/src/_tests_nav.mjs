// Unit tests for the nav areas map (FOC-804, dashboard-v2-spec §2/§3).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_cockpit.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: the NAV_AREAS table (order, ids, default routes, sub-page labels)
// and areaForPath (which area is active for a pathname, including /runs/:id →
// Work and the routes hidden from the navigation). Fixtures only — no network,
// no DOM.

import assert from 'node:assert/strict';

import { NAV_AREAS, areaForPath } from './navAreas.js';

// --- Minimal test harness (same shape as _tests_cockpit.mjs) ----------------

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

// --- NAV_AREAS table ----------------------------------------------------------

await test('exactly the six areas in the agreed order', () => {
  eq(
    NAV_AREAS.map((a) => a.id),
    ['cockpit', 'work', 'team', 'costs', 'insights', 'settings'],
  );
});

await test('default routes follow the spec table', () => {
  eq(
    NAV_AREAS.map((a) => a.defaultRoute),
    ['/', '/tasks', '/manager', '/costs', '/analysis', '/squad-config'],
  );
});

await test('labels follow the spec table', () => {
  eq(
    NAV_AREAS.map((a) => a.label),
    ['Cockpit', 'Work', 'Team', 'Costs & quality', 'Insights', 'Settings'],
  );
});

await test('Work sub-pages: Tickets, Runs, Timeline', () => {
  const work = NAV_AREAS.find((a) => a.id === 'work');
  eq(work.pages, [
    { path: '/tasks', label: 'Tickets' },
    { path: '/runs', label: 'Runs' },
    { path: '/timeline', label: 'Timeline' },
  ]);
});

await test('Team, Costs, Insights, Settings sub-pages match the spec', () => {
  eq(NAV_AREAS.find((a) => a.id === 'team').pages, [{ path: '/manager', label: 'Manager (v1)' }]);
  eq(NAV_AREAS.find((a) => a.id === 'costs').pages, [{ path: '/costs', label: 'Costs (v1)' }]);
  eq(NAV_AREAS.find((a) => a.id === 'insights').pages, [
    { path: '/analysis', label: 'Analysis' },
    { path: '/flow', label: 'Flow' },
  ]);
  eq(NAV_AREAS.find((a) => a.id === 'settings').pages, [
    { path: '/squad-config', label: 'Models & routing' },
    { path: '/prompts', label: 'Squads & prompts' },
  ]);
});

await test('Cockpit is v2 — no sub-pages', () => {
  eq(NAV_AREAS.find((a) => a.id === 'cockpit').pages, []);
});

await test('every non-cockpit default route is one of its own pages', () => {
  for (const area of NAV_AREAS) {
    if (area.id === 'cockpit') continue;
    assert(
      area.pages.some((p) => p.path === area.defaultRoute),
      `${area.id} default route ${area.defaultRoute} missing from its pages`,
    );
  }
});

// --- areaForPath --------------------------------------------------------------

await test('areaForPath("/") exactly -> cockpit', () => {
  eq(areaForPath('/'), 'cockpit');
});

await test('areaForPath work paths -> work', () => {
  eq(areaForPath('/tasks'), 'work');
  eq(areaForPath('/runs'), 'work');
  eq(areaForPath('/timeline'), 'work');
});

await test('areaForPath /runs/:id -> work (run detail belongs to Work)', () => {
  eq(areaForPath('/runs/abc-123'), 'work');
});

await test('areaForPath /manager -> team', () => {
  eq(areaForPath('/manager'), 'team');
});

await test('areaForPath /costs -> costs', () => {
  eq(areaForPath('/costs'), 'costs');
});

await test('areaForPath insights paths -> insights', () => {
  eq(areaForPath('/analysis'), 'insights');
  eq(areaForPath('/flow'), 'insights');
});

await test('areaForPath settings paths -> settings', () => {
  eq(areaForPath('/squad-config'), 'settings');
  eq(areaForPath('/prompts'), 'settings');
});

await test('areaForPath /live -> null (hidden from nav, route kept)', () => {
  eq(areaForPath('/live'), null);
});

await test('areaForPath /ft -> null (hidden from nav, route kept)', () => {
  eq(areaForPath('/ft'), null);
});

await test('areaForPath unknown path -> null', () => {
  eq(areaForPath('/nope'), null);
});

await test('areaForPath area shortcuts are not themselves areas', () => {
  // /work, /team, /insights, /settings redirect server-side (client routes);
  // nothing should light up for them until the redirect lands.
  eq(areaForPath('/work'), null);
  eq(areaForPath('/team'), null);
  eq(areaForPath('/insights'), null);
  eq(areaForPath('/settings'), null);
});

await test('areaForPath prefix does not leak between paths', () => {
  // /tasksX is not /tasks; /analysis2 is not /analysis.
  eq(areaForPath('/tasksX'), null);
  eq(areaForPath('/analysis2'), null);
});

await test('areaForPath handles a null/undefined pathname like "/"', () => {
  eq(areaForPath(null), 'cockpit');
  eq(areaForPath(undefined), 'cockpit');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

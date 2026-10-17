// Unit tests for the nav areas map (FOC-804 + task workspaces, PRD §3).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_cockpit.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: the NAV_AREAS table (order, ids, default routes, sub-page labels)
// and areaForPath (which area is active for a pathname, including /runs/:id,
// /work/:ticket and the task cockpit /work/:taskKey/cockpit → Work, the
// routes hidden from the navigation, and /cockpit → the explicit legacy
// overview). Fixtures only — no network, no DOM.

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

await test('exactly the six areas, Work first (the board is home, PRD §3)', () => {
  eq(
    NAV_AREAS.map((a) => a.id),
    ['work', 'cockpit', 'team', 'costs', 'insights', 'settings'],
  );
});

await test('default routes: Work home at /, Cockpit demoted to /cockpit', () => {
  eq(
    NAV_AREAS.map((a) => a.defaultRoute),
    ['/', '/cockpit', '/manager', '/costs', '/analysis', '/settings/keys'],
  );
});

await test('labels follow the table (Cockpit no longer the primary)', () => {
  eq(
    NAV_AREAS.map((a) => a.label),
    ['Work', 'Cockpit', 'Team', 'Costs & quality', 'Insights', 'Settings'],
  );
});

await test('Work sub-pages: Board, Runs (v1 Tickets and Timeline left the nav, FOC-784)', () => {
  const work = NAV_AREAS.find((a) => a.id === 'work');
  eq(work.pages, [
    { path: '/work', label: 'Board' },
    { path: '/runs', label: 'Runs' },
  ]);
});

await test('Team, Costs, Insights, Settings sub-pages match the spec', () => {
  eq(NAV_AREAS.find((a) => a.id === 'team').pages, [{ path: '/manager', label: 'Manager (v1)' }]);
  eq(NAV_AREAS.find((a) => a.id === 'costs').pages, [{ path: '/costs', label: 'Costs & quality' }]);
  eq(NAV_AREAS.find((a) => a.id === 'insights').pages, [
    { path: '/insights/runtime', label: 'Runtime statistics' },
    { path: '/insights/map', label: 'Task map' },
    { path: '/analysis', label: 'Analysis' },
    { path: '/flow', label: 'Flow' },
  ]);
  eq(NAV_AREAS.find((a) => a.id === 'settings').pages, [
    { path: '/settings/keys', label: 'Keys' },
    { path: '/settings/provider', label: 'Provider & routing' },
    { path: '/settings/repos', label: 'Repositories' },
    { path: '/settings/retention', label: 'Retention' },
    { path: '/settings/artifacts', label: 'Artifacts' },
    { path: '/squad-config', label: 'Advanced routing (v1)' },
    { path: '/prompts', label: 'Squads & prompts (v1)' },
  ]);
});

await test('Cockpit is the explicit legacy overview — one page at /cockpit', () => {
  eq(NAV_AREAS.find((a) => a.id === 'cockpit').pages, [{ path: '/cockpit', label: 'Overview' }]);
});

await test('every default route is its area\'s home: Work aliases /work through /, others are their own page', () => {
  for (const area of NAV_AREAS) {
    if (area.id === 'work') {
      // The board's home route / is an alias of /work — it is not listed as
      // its own sub-page tab, so this one is special-cased in areaForPath.
      assert(area.pages.some((p) => p.path === '/work'), 'Work keeps a Board page at /work');
      continue;
    }
    assert(
      area.pages.some((p) => p.path === area.defaultRoute),
      `${area.id} default route ${area.defaultRoute} missing from its pages`,
    );
  }
});

// --- areaForPath --------------------------------------------------------------

await test('areaForPath("/") exactly -> work (the board is home, PRD §3)', () => {
  eq(areaForPath('/'), 'work');
});

await test('areaForPath work paths -> work', () => {
  eq(areaForPath('/work'), 'work');
  eq(areaForPath('/runs'), 'work');
});

await test('areaForPath /work/:ticket -> work (ticket detail belongs to Work)', () => {
  eq(areaForPath('/work/FOC-123'), 'work');
});

await test('areaForPath /work/:taskKey/cockpit -> work (the task cockpit belongs to Work)', () => {
  eq(areaForPath('/work/jointhubs%3A12/cockpit'), 'work');
});

await test('areaForPath /cockpit -> cockpit (the legacy overview is explicit now)', () => {
  eq(areaForPath('/cockpit'), 'cockpit');
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
  eq(areaForPath('/insights/runtime'), 'insights');
  eq(areaForPath('/insights/map'), 'insights');
  eq(areaForPath('/analysis'), 'insights');
  eq(areaForPath('/flow'), 'insights');
});

await test('areaForPath settings paths -> settings (FOC-786 sections + the v1 screens)', () => {
  eq(areaForPath('/settings/keys'), 'settings');
  eq(areaForPath('/settings/provider'), 'settings');
  eq(areaForPath('/settings/repos'), 'settings');
  eq(areaForPath('/settings/retention'), 'settings');
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
  // /team, /insights, /settings redirect to their area's default route;
  // nothing should light up for them until the redirect lands. (/work is a
  // real route now — the board — so it lights up Work.)
  eq(areaForPath('/team'), null);
  eq(areaForPath('/insights'), null);
  eq(areaForPath('/settings'), null);
});

await test('areaForPath: /tasks and /timeline stay out of the nav (FOC-784)', () => {
  // /tasks redirects to /work; /timeline is routable but unlisted — both map
  // to no area, like /live and /ft.
  eq(areaForPath('/tasks'), null);
  eq(areaForPath('/timeline'), null);
});

await test('areaForPath prefix does not leak between paths', () => {
  // /workX is not /work; /analysis2 is not /analysis.
  eq(areaForPath('/workX'), null);
  eq(areaForPath('/analysis2'), null);
});

await test('areaForPath handles a null/undefined pathname like "/"', () => {
  eq(areaForPath(null), 'work');
  eq(areaForPath(undefined), 'work');
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

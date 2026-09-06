// Unit tests for the Manager rewards adapter (FOC-225 slice 3).
// Self-contained Node ESM script — NO test framework, NO deps.
// Runs on Node >= 18. Invoke via: `npm --prefix ui test`.
//
// Scope: manager/rewards.js is pure JS and imports fully; the components and
// api.js are NOT importable under plain node (React JSX / import.meta.env),
// so those are pinned by static source assertions at the bottom — the honest
// scope available without a DOM. The HTTP contract itself is proven by
// scripts/rewards-routes.test.mjs against the real server.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BADGES,
  badgeList,
  formatXp,
  heldCount,
  levelFor,
  ratingForRun,
  ratingForTask,
  recordMeta,
  recordPoints,
  rulesLabel,
  shortWhen,
  squadRewardsView,
} from './manager/rewards.js';

// --- Minimal test harness (same shape as _test_utils.mjs) ------------------

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

// --- rulesLabel: built FROM the payload constants, never hardcoded ----------

await test('rulesLabel renders version + both constants', () => {
  eq(
    rulesLabel({ version: 'xp-rules v1', pointsPerAcceptedRevision: 100, xpPerLevel: 500 }),
    'rules v1 · 100 XP per accepted revision · 500 XP per level',
  );
});

await test('rulesLabel follows changed server constants (not a hardcoded label)', () => {
  eq(
    rulesLabel({ version: 'xp-rules v2', pointsPerAcceptedRevision: 250, xpPerLevel: 400 }),
    'rules v2 · 250 XP per accepted revision · 400 XP per level',
  );
});

await test('rulesLabel(null / missing version) -> null (component hides the note)', () => {
  eq(rulesLabel(null), null);
  eq(rulesLabel({}), null);
  eq(rulesLabel({ pointsPerAcceptedRevision: 100, xpPerLevel: 500 }), null);
});

// --- levelFor ---------------------------------------------------------------

await test('levelFor boundaries: 0->1, 499->1, 500->2, 1250->3', () => {
  eq(levelFor(0), 1);
  eq(levelFor(499), 1);
  eq(levelFor(500), 2);
  eq(levelFor(1250), 3);
});

await test('levelFor honours the payload xpPerLevel', () => {
  eq(levelFor(999, 1000), 1);
  eq(levelFor(1000, 1000), 2);
});

await test('levelFor rejects non-finite / negative / null XP -> null (never level guesses)', () => {
  eq(levelFor(-1), null);
  eq(levelFor(undefined), null);
  eq(levelFor(null), null); // "no data" is never "level 1"
  eq(levelFor(''), null);
  eq(levelFor('many'), null);
});

// --- formatXp ---------------------------------------------------------------

await test('formatXp groups digits with a non-breaking space, locale-independent', () => {
  const G = ' '; // NBSP: the header chip must never wrap mid-number
  eq(formatXp(0), '0');
  eq(formatXp(999), '999');
  eq(formatXp(1000), `1${G}000`);
  eq(formatXp(1250), `1${G}250`);
  eq(formatXp(1234567), `1${G}234${G}567`);
});

await test('formatXp floors fractions and rejects invalid input', () => {
  eq(formatXp(999.9), '999');
  eq(formatXp(-5), null);
  eq(formatXp(null), null); // "no data" is never "0 XP"
  eq(formatXp(''), null);
});

// --- badges -------------------------------------------------------------------

await test('badge thresholds are pinned (1 and 5 distinct verified deliveries)', () => {
  eq(BADGES.map((b) => [b.id, b.need]), [
    ['first-delivery', 1],
    ['five-deliveries', 5],
  ]);
});

await test('badgeList: 0 distinct -> nothing earned, nothing pending shown as earned', () => {
  const badges = badgeList(0);
  eq(badges.filter((b) => b.earned).length, 0);
  eq(badges.length, BADGES.length);
});

await test('badgeList: 1 -> first earned only; 4 -> still first only', () => {
  eq(badgeList(1).map((b) => b.earned), [true, false]);
  eq(badgeList(4).map((b) => b.earned), [true, false]);
});

await test('badgeList: 5 -> both earned', () => {
  eq(badgeList(5).map((b) => b.earned), [true, true]);
});

await test('badgeList treats non-numeric distinctRevisions as 0', () => {
  eq(badgeList(undefined).every((b) => !b.earned), true);
});

// --- shortWhen ----------------------------------------------------------------

await test('shortWhen renders local YYYY-MM-DD HH:mm', () => {
  // Built from local components then round-tripped through toISOString, so
  // the expectation holds in every timezone.
  const iso = new Date(2026, 8, 6, 12, 30).toISOString();
  eq(shortWhen(iso), '2026-09-06 12:30');
});

await test('shortWhen: unparsable / missing -> null (caller renders —, never a guess)', () => {
  eq(shortWhen('not a date'), null);
  eq(shortWhen(undefined), null);
  eq(shortWhen(null), null);
});

// --- record meta / points -----------------------------------------------------

await test('recordMeta pins the kind glyphs (award/revocation/rating)', () => {
  eq(recordMeta({ kind: 'award' }), { glyph: '★', label: 'award' });
  eq(recordMeta({ kind: 'revocation' }), { glyph: '↩', label: 'revoked' });
  eq(recordMeta({ kind: 'rating' }), { glyph: '✎', label: 'rating' });
  eq(recordMeta({ kind: 'mystery' }), { glyph: '?', label: 'record' });
  eq(recordMeta(null), { glyph: '?', label: 'record' });
});

await test('recordPoints: award +100, revocation −100, rating never carries points', () => {
  eq(recordPoints({ kind: 'award', points: 100 }), '+100');
  eq(recordPoints({ kind: 'revocation', points: -100 }), '-100');
  eq(recordPoints({ kind: 'rating', points: 0 }), null);
});

await test('recordPoints: missing / non-finite points render null (never 0)', () => {
  eq(recordPoints({ kind: 'award' }), null);
  eq(recordPoints(null), null);
});

// --- squadRewardsView: the four states ----------------------------------------

const RULES = { version: 'xp-rules v1', pointsPerAcceptedRevision: 100, xpPerLevel: 500 };

await test('squadRewardsView: undefined payload -> loading', () => {
  eq(squadRewardsView(undefined, 'dev'), { state: 'loading' });
});

await test('squadRewardsView: null payload -> error (caller renders retry)', () => {
  eq(squadRewardsView(null, 'dev'), { state: 'error' });
});

await test('squadRewardsView: squad without records -> awaiting, NEVER zeros', () => {
  const view = squadRewardsView({ rules: RULES, squads: {} }, 'dev');
  eq(view, { state: 'awaiting', rules: RULES });
  assert.ok(!('xp' in view), 'awaiting must not carry an xp field');
  assert.ok(!('records' in view), 'awaiting must not carry records');
});

await test('squadRewardsView: missing squadKey (header, no selection) -> awaiting', () => {
  eq(squadRewardsView({ rules: RULES, squads: { dev: { xp: 100 } } }, null).state, 'awaiting');
});

await test('squadRewardsView: ready state derives level + badges + records', () => {
  const record = { id: 1, kind: 'award', points: 100, taskId: 'FOC-1', recordedAt: '2026-09-06T10:00:00Z' };
  const view = squadRewardsView(
    { rules: RULES, squads: { dev: { xp: 1250, distinctRevisions: 5, recent: [record] } } },
    'dev',
  );
  eq(view.state, 'ready');
  eq(view.xp, 1250);
  eq(view.level, 3);
  eq(view.distinctRevisions, 5);
  eq(view.badges.map((b) => b.earned), [true, true]);
  eq(view.records, [record]);
});

await test('squadRewardsView: xp 0 after revocations is an honest ready zero, not awaiting', () => {
  const view = squadRewardsView(
    { rules: RULES, squads: { dev: { xp: 0, distinctRevisions: 0, recent: [] } } },
    'dev',
  );
  eq(view.state, 'ready');
  eq(view.xp, 0);
  eq(view.level, 1);
  eq(view.badges.every((b) => !b.earned), true);
});

// --- ratings lookup -----------------------------------------------------------

await test('ratingForTask: array is newest-first, first match wins (case-insensitive)', () => {
  const payload = {
    ratings: [
      { taskId: 'FOC-1', rating: 2 },
      { taskId: 'foc-1', rating: 5 },
      { taskId: 'FOC-2', rating: 4 },
    ],
  };
  eq(ratingForTask(payload, 'foc-1').rating, 2);
  eq(ratingForTask(payload, 'FOC-2').rating, 4);
});

await test('ratingForTask: unrated task -> null (rendered as "not rated", never 0/5)', () => {
  eq(ratingForTask({ ratings: [] }, 'FOC-1'), null);
  eq(ratingForTask({ ratings: [{ taskId: 'FOC-2', rating: 3 }] }, 'FOC-1'), null);
  eq(ratingForTask(null, 'FOC-1'), null);
  eq(ratingForTask({ ratings: [{ taskId: 'FOC-2', rating: 3 }] }, null), null);
});

await test('ratingForRun: the run rating wins, else the task rating, else null', () => {
  const payload = {
    ratings: [
      { runId: 'r1', taskId: 'T1', rating: 4 },
      { taskId: 'T1', rating: 3 },
    ],
  };
  eq(ratingForRun(payload, { runId: 'r1', taskId: 'T1' }).rating, 4);
  // Another run of the same task sees the task's newest rating — runId is
  // provenance, taskId the anchor (authored-on-r1 still reads as T1's rating).
  eq(ratingForRun(payload, { runId: 'r2', taskId: 'T1' }).rating, 4);
  eq(ratingForRun(payload, { runId: 'r3', taskId: 'TX' }), null);
  eq(ratingForRun(payload, { runId: 'r2' }), null);
  eq(ratingForRun(payload, null), null);
  eq(ratingForRun(null, { runId: 'r1' }), null);
});

// --- heldCount ------------------------------------------------------------------

await test('heldCount counts the installation-global held backlog', () => {
  eq(heldCount({ held: [{}, {}] }), 2);
  eq(heldCount({ held: [] }), 0);
  eq(heldCount({}), 0);
  eq(heldCount(null), 0);
  eq(heldCount({ held: 'not-an-array' }), 0);
});

// --- static source assertions (api.js / components are not node-importable) ----

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(join(here, rel), 'utf8');

await test('AC 2 pinned at source: api.js ships NO XP submission — the rewards path is GET-only', () => {
  const apiSrc = readSrc('api.js');
  const hits = [...apiSrc.matchAll(/\/api\/manager\/rewards/g)];
  assert.ok(hits.length >= 1, 'a rewards GET helper is expected in api.js');
  for (const hit of hits) {
    // The enclosing exported function (up to the next export) must not POST.
    const end = apiSrc.indexOf('\nexport ', hit.index);
    const segment = apiSrc.slice(hit.index, end === -1 ? undefined : end);
    assert.ok(
      !/method:\s*['"]POST['"]/.test(segment),
      `no POST may target /api/manager/rewards (offset ${hit.index})`,
    );
  }
  assert.ok(!/\bpoints\b/.test(apiSrc), 'api.js must carry no points/XP submission payload');
});

await test('api.js exposes the ratings POST (the one authoring endpoint)', () => {
  const apiSrc = readSrc('api.js');
  const hit = apiSrc.indexOf("'/api/manager/ratings'");
  assert.ok(hit !== -1, 'ratings path expected');
  const end = apiSrc.indexOf('\nexport ', hit);
  assert.ok(
    /method:\s*['"]POST['"]/.test(apiSrc.slice(hit, end === -1 ? undefined : end)),
    'the ratings helper must POST',
  );
});

await test('editing.js: the guard takes the additive ratingDirty parameter (defaulted)', () => {
  const editingSrc = readSrc('manager/editing.js');
  assert.ok(
    /export function editingGuardActive\(configDirtyCount, promptDirty, ratingDirty = false\)/.test(
      editingSrc,
    ),
    'editingGuardActive must default its third parameter so existing callers stay valid',
  );
  assert.ok(/export function anyUnsaved\(/.test(editingSrc), 'anyUnsaved helper expected');
});

await test('Rewards.jsx does no IO of its own — all server access goes through api.js', () => {
  const rewardsSrc = readSrc('components/manager/Rewards.jsx');
  assert.ok(!/\bfetch\(/.test(rewardsSrc), 'no direct fetch in components');
  assert.ok(
    /from '\.\.\/\.\.\/manager\/rewards\.js'/.test(rewardsSrc),
    'components must derive their facts through the pure adapter',
  );
});

await test('wiring pins: History Rating column + header chip are actually rendered', () => {
  const inspectorSrc = readSrc('components/manager/Inspector.jsx');
  assert.ok(
    inspectorSrc.includes('<th scope="col">Rating</th>'),
    'History must expose the Rating column',
  );
  const managerSrc = readSrc('screens/Manager.jsx');
  assert.ok(
    managerSrc.includes('<RewardsHeaderChip rewards={rewards} squadKey={squadKey} />'),
    'the header chip must be wired next to the squad selector',
  );
});

// --- Summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

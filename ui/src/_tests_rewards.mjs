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
  deliveryNeedLabel,
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
  eq(levelFor(0, 500), 1);
  eq(levelFor(499, 500), 1);
  eq(levelFor(500, 500), 2);
  eq(levelFor(1250, 500), 3);
});

await test('levelFor honours the payload xpPerLevel', () => {
  eq(levelFor(999, 1000), 1);
  eq(levelFor(1000, 1000), 2);
});

await test('levelFor rejects non-finite / negative / null XP -> null (never level guesses)', () => {
  eq(levelFor(-1, 500), null);
  eq(levelFor(undefined, 500), null);
  eq(levelFor(null, 500), null); // "no data" is never "level 1"
  eq(levelFor('', 500), null);
  eq(levelFor('many', 500), null);
});

await test('levelFor without a payload xpPerLevel -> null (no 500 fallback is invented client-side)', () => {
  eq(levelFor(1250, undefined), null);
  eq(levelFor(1250, null), null);
  eq(levelFor(1250, 0), null);
  eq(levelFor(1250, -500), null);
  eq(levelFor(1250, 'many'), null);
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

await test('deliveryNeedLabel singularizes a need of 1 (never "needs 1 ... deliveries")', () => {
  eq(deliveryNeedLabel(1), '1 distinct verified delivery');
  eq(deliveryNeedLabel(2), '2 distinct verified deliveries');
  eq(deliveryNeedLabel(5), '5 distinct verified deliveries');
});

await test('badge glyphs: earned and locked are visually distinct strings, not a fill change only', () => {
  for (const b of BADGES) {
    assert.ok(b.glyph, `${b.id}: earned glyph expected`);
    assert.ok(b.lockedGlyph, `${b.id}: locked glyph expected`);
    assert.notStrictEqual(b.glyph, b.lockedGlyph, `${b.id}: earned/locked glyphs must differ`);
  }
  // badgeList carries both variants regardless of state (locked = outline
  // form), so the component can switch on earned without guessing.
  eq(badgeList(0).map((b) => [b.earned, b.glyph, b.lockedGlyph]), [
    [false, '✓', '○'],
    [false, '★★', '☆☆'],
  ]);
  eq(badgeList(5).map((b) => [b.earned, b.glyph, b.lockedGlyph]), [
    [true, '✓', '○'],
    [true, '★★', '☆☆'],
  ]);
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

await test('squadRewardsView: no rules in the payload -> level null, XP untouched (no invented constant)', () => {
  const view = squadRewardsView({ squads: { dev: { xp: 1250, distinctRevisions: 1, recent: [] } } }, 'dev');
  eq(view.state, 'ready');
  eq(view.xp, 1250);
  eq(view.rules, null);
  eq(view.level, null);
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
    inspectorSrc.includes('<th scope="col" title="Rating">Rating</th>'),
    'History must expose the Rating column (title restores the truncated header, D1)',
  );
  const managerSrc = readSrc('screens/Manager.jsx');
  assert.ok(
    managerSrc.includes('<RewardsHeaderChip rewards={rewards} squadKey={squadKey} />'),
    'the header chip must be wired next to the squad selector',
  );
});

// --- review round 5 pins (S6/S7/S8 + nitpicks) ---------------------------------

await test('S6 pinned at source: the badge glyph switches between earned and locked variants', () => {
  const src = readSrc('components/manager/Rewards.jsx');
  assert.ok(
    /\{b\.earned \? b\.glyph : b\.lockedGlyph\}/.test(src),
    'the rendered glyph must come from the earned/locked pair the adapter provides',
  );
});

await test('S6/N1 pinned at source: badge titles come from the singularizing adapter helper', () => {
  const src = readSrc('components/manager/Rewards.jsx');
  assert.ok(
    /deliveryNeedLabel\(b\.need\)/.test(src),
    'badge titles must pluralize through deliveryNeedLabel',
  );
  assert.ok(!/verified deliver\$\{/.test(src), 'no inline pluralization may remain in the component');
});

await test('S7 pinned at source: ratingSave is scoped to the run that owns the save', () => {
  const managerSrc = readSrc('screens/Manager.jsx');
  assert.ok(
    /runId: payload\.runId/.test(managerSrc),
    'saveRating must tag busy/error with the originating runId',
  );
  const inspectorSrc = readSrc('components/manager/Inspector.jsx');
  assert.ok(
    inspectorSrc.includes('ratingSave?.runId === r.runId'),
    'History rows must scope busy/error to their own run',
  );
});

await test('S8 pinned at source: staged ratings live in a screen-level map that survives eviction', () => {
  const managerSrc = readSrc('screens/Manager.jsx');
  assert.ok(
    /const \[stagedRatings, setStagedRatings\] = useState\(\{\}\)/.test(managerSrc),
    'Manager must own a runId-keyed staged-ratings map',
  );
  assert.ok(
    /Object\.keys\(stagedRatings\)\.length > 0/.test(managerSrc),
    'the unsaved-work guard must derive from the staged map, not from mounted rows',
  );
  assert.ok(
    /delete next\[payload\.runId\]/.test(managerSrc),
    'a successful save must clear that run staged entry',
  );
  assert.ok(
    /setStagedRatings\(\{\}\)/.test(managerSrc),
    'accepting the unsaved-switch confirm must clear the staged map (honest discard)',
  );
  const inspectorSrc = readSrc('components/manager/Inspector.jsx');
  assert.ok(
    inspectorSrc.includes('staged={stagedRatings?.[r.runId]}') && inspectorSrc.includes('onStage={onRatingStage}'),
    'History rows must seed and stage through the screen-level map',
  );
});

await test('N2 pinned at source: the dead ratingForRun re-export is gone from Rewards.jsx', () => {
  const src = readSrc('components/manager/Rewards.jsx');
  assert.ok(!/export \{ ratingForRun \}/.test(src), 'the re-export must be removed');
});

await test('D1 pinned at source: the inspector layout keeps both tables inside the 320px column', () => {
  const css = readSrc('screens/manager.css');
  // The rewards grid must expose one shrinkable track — the records table's
  // min-content (~477px) must never size the track past the inspector column.
  assert.ok(
    /\.mgr-rewards\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(css),
    '.mgr-rewards must declare a minmax(0, 1fr) track so the records table shrinks',
  );
  assert.ok(
    /\.mgr-rewards\s*>\s*\*\s*\{[^}]*min-width:\s*0/.test(css),
    '.mgr-rewards children must carry min-width: 0',
  );
  // Both inspector tables (History + records) go fixed-layout: auto layout let
  // their column min-content push them 118–130px past the viewport at 1440.
  assert.ok(
    /\.mgr-tabpanel table\.mgr-table\s*\{[^}]*table-layout:\s*fixed/.test(css),
    'inspector tables must be table-layout: fixed inside the tabpanel',
  );
  // Per-table column widths must stay scoped: the History root and the
  // rewards root are BOTH plain divs under the tabpanel, so an unscoped
  // `> div > table` leaks the History widths into the records table.
  assert.ok(
    /\.mgr-tabpanel > div:not\(\.mgr-rewards\) > table\.mgr-table/.test(css),
    'History column widths must carry the :not(.mgr-rewards) scope',
  );
  // The rating note input must stay flexible — a fixed px width was a
  // min-content floor that overflowed the fixed-layout Rating cell.
  assert.ok(
    !/\.mgr-rating-note\s*\{[^}]*width:\s*\d+px/.test(css),
    '.mgr-rating-note must not reintroduce a fixed px width',
  );
  // The wrap mechanism fixed layout leans on: long run/evidence tokens break
  // inside their pinned cell instead of spilling past the panel edge.
  assert.ok(
    /\.mgr-tabpanel table\.mgr-table td\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css),
    'inspector table cells must wrap anywhere so long tokens never widen the table',
  );
  // Truncation must be restorable: the state chip is the one cell that
  // ellipsizes instead of wrapping, so it carries a hover title (D1 rule —
  // truncation may hide text only when a title restores it).
  const liveStripSrc = readSrc('components/manager/LiveStrip.jsx');
  assert.ok(
    /title=\{meta\.label\}/.test(liveStripSrc),
    'the live-state chip must carry a title so inspector-table truncation restores the label',
  );
});

// --- cleanup round C6 pins ------------------------------------------------------

await test('C6a pinned at source: the flash memory resets when Live mode is left or the snapshot is lost', () => {
  const managerSrc = readSrc('screens/Manager.jsx');
  // the flash effect's early branch must CLEAR state, not just skip work
  assert.ok(
    /if \(mode !== 'live' \|\| !snapshot\) \{/.test(managerSrc),
    'the flash effect must own an explicit early branch for non-live / no-snapshot',
  );
  assert.ok(
    /prevSquadStatesRef\.current = \{\}/.test(managerSrc),
    'leaving Live mode must discard the last-seen squad states (no replayed pulses)',
  );
  assert.ok(
    /setFlashSquads\(\(current\) => \(current\.size > 0 \? new Set\(\) : current\)\)/.test(managerSrc),
    'a lingering flash set must be cleared on the same early branch',
  );
});

await test('C6g pinned at source: no snapshot yet renders a neutral placeholder, never "no activity"', () => {
  const liveStripSrc = readSrc('components/manager/LiveStrip.jsx');
  assert.ok(
    /pending \? \(/.test(liveStripSrc) && /awaiting first snapshot/.test(liveStripSrc),
    'SquadLiveStrip must gate the pre-first-fetch state behind a pending prop',
  );
  assert.ok(
    /no activity in the bounded window/.test(liveStripSrc),
    'the observed empty-store rendering must remain distinct from the placeholder',
  );
  const managerSrc = readSrc('screens/Manager.jsx');
  assert.ok(
    /pending=\{snapshot == null\}/.test(managerSrc),
    'Manager must derive pending from the absence of a snapshot, not from an empty window',
  );
});

await test('C6h pinned at source: the error-driven inspector prop is liveFailed, not liveStale', () => {
  const managerSrc = readSrc('screens/Manager.jsx');
  const inspectorSrc = readSrc('components/manager/Inspector.jsx');
  assert.ok(
    /liveFailed=\{live\.error != null\}/.test(managerSrc),
    'Manager must pass the rename through',
  );
  assert.ok(
    /liveFailed,/.test(inspectorSrc) && /\{liveFailed && \(/.test(inspectorSrc),
    'Inspector must consume the rename through',
  );
  assert.ok(!managerSrc.includes('liveStale') && !inspectorSrc.includes('liveStale'), 'the old name must be gone');
});

await test('C7 pinned at source: a note typed before a value is chosen survives the value commit', () => {
  const src = readSrc('components/manager/Rewards.jsx');
  // The staged entry is dropped only on a clean slate (both fields empty) or
  // when the re-staged pair equals the recorded rating — NEVER merely because
  // the value is still unset (that dropped note-only edits).
  assert.ok(
    /const empty = nextValue === '' && nextNote === '';/.test(src),
    'the drop condition must be "both fields empty"',
  );
  assert.ok(
    /const unchanged = nextValue === savedValue && \(nextNote \|\| ''\) === savedNote;/.test(src),
    'the drop condition must be "exactly the recorded rating re-staged"',
  );
  assert.ok(
    /empty \|\| unchanged \? null : \{ value: nextValue, note: nextNote \}/.test(src),
    'stage must store any other pair, including a note-only edit',
  );
  assert.ok(
    !/const stillDirty = nextValue !== '' &&/.test(src),
    'the old value-gated drop (which lost note-before-value input) must be gone',
  );
  // Save stays value-gated: a note-only staged entry is never dirty, so the
  // guard cannot trigger a value-less POST.
  assert.ok(
    /const dirty = value !== '' && \(value !== savedValue \|\| note !== savedNote\);/.test(src),
    'dirty must still require a chosen value',
  );
});

// --- Summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

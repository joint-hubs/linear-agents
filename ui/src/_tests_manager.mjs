// Unit tests for the Manager pure adapters (FOC-225 slice 1).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_test_utils.mjs. Invoke via: `npm --prefix ui run test`.
//
// Part 1: identity mapping from a real-shaped /api/squad-config fixture
// (squad/role/model/tools), unknown role/model handling, coordinator-only
// squads, and layout persistence incl. schema migration and corrupt-record
// recovery. Part 2: the shared squad-config working copy (staging, dirty
// counting, save payloads, save-error normalization), model suggestions,
// prompt paths, staged-vs-configured summaries, unsaved-guard predicate and
// squad role counts. Fixtures only — no network, no production config access.

import assert from 'node:assert/strict';

import {
  buildBoardModel,
  installFingerprint,
  resolveModelState,
  toolSummary,
  squadRoleCounts,
  COORDINATOR_KEY,
} from './manager/identity.js';
import {
  LAYOUT_VERSION,
  storageKey,
  clampPosition,
  defaultPositions,
  migrateLayout,
  normalizePositions,
  loadLayout,
  saveLayout,
  keyboardMoveDelta,
  MOVE_STEP,
  MOVE_STEP_LARGE,
} from './manager/layout.js';
import {
  DEFAULT_PROVIDER,
  buildSavePayload,
  buildWorkingCopy,
  countDirty,
  hasPriceEntry,
  modelSuggestions,
  normalizeSaveError,
  setAgentModel,
  setLeadModel,
} from './squadConfig/workingCopy.js';
import {
  connectivityState,
  editingGuardActive,
  promptPathFor,
  stagedModelSummary,
  switchBlocked,
  workingFingerprint,
} from './manager/editing.js';
import {
  LIVE_STATE_META,
  POLL_BASE_MS,
  POLL_MAX_MS,
  SNAPSHOT_STALE_MS,
  decorateRuns,
  isSnapshotStale,
  liveBlockFor,
  mapRunState,
  nextPollIntervalMs,
  shouldPoll,
  squadLiveState,
} from './manager/live.js';

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

// --- Fixtures (shaped like the real /api/squad-config payload) --------------

const PROVIDERS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    tiers: { opus: 'z-ai/glm-5.3-flash', sonnet: 'google/gemini-2.5-flash-lite' },
    models: ['z-ai/glm-5.3-flash', 'google/gemini-2.5-flash-lite'],
  },
  anthropic: { baseUrl: 'https://api.anthropic.com' }, // no catalogue
};

const FIXTURE = {
  squads: {
    dev: {
      lead: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      leadFiles: ['bin/dev.bat', 'bin/dev-dry.bat'],
      agents: {
        recon: { model: 'z-ai/glm-5.3-flash', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
        debugger: { model: null, tools: [] },
        implementer: { model: 'z-ai/glm-5.3-flash', tools: ['Read', 'Edit', 'Write'] },
      },
    },
    supervisor: {
      lead: 'claude-opus-4-8',
      provider: 'anthropic',
      leadFiles: ['bin/supervisor.bat'],
      agents: {},
    },
  },
  pricing: {},
  providers: PROVIDERS,
};

// --- identity: buildBoardModel ----------------------------------------------

await test('buildBoardModel sorts squads and lists coordinator card first', () => {
  const model = buildBoardModel(FIXTURE);
  eq(model.map((s) => s.key), ['dev', 'supervisor']);
  eq(model[0].cards[0].key, COORDINATOR_KEY);
  eq(model[0].cards[0].model, 'z-ai/glm-5.3-flash');
});

await test('buildBoardModel maps roles from real config with sorted keys', () => {
  const dev = buildBoardModel(FIXTURE)[0];
  eq(dev.cards.slice(1).map((c) => c.key), ['debugger', 'implementer', 'recon']);
  const recon = dev.cards.find((c) => c.key === 'recon');
  eq(recon.model, 'z-ai/glm-5.3-flash');
  eq(recon.tools, ['Read', 'Grep', 'Glob', 'Bash']);
});

await test('buildBoardModel detects unconfigured model (null) honestly', () => {
  const dev = buildBoardModel(FIXTURE)[0];
  const debugger_ = dev.cards.find((c) => c.key === 'debugger');
  eq(debugger_.model, null);
  eq(debugger_.modelState, 'unconfigured');
});

await test('buildBoardModel flags unknown model against a provider catalogue', () => {
  const withUnknown = {
    squads: {
      plan: {
        lead: null,
        provider: 'openrouter',
        leadFiles: [],
        agents: { worker: { model: 'totally/unknown-model', tools: ['Read'] } },
      },
    },
    providers: PROVIDERS,
  };
  const worker = buildBoardModel(withUnknown)[0].cards.find((c) => c.key === 'worker');
  eq(worker.modelState, 'unknown');
});

await test('model without a provider catalogue is configured, never guessed unknown', () => {
  eq(resolveModelState('claude-opus-4-8', PROVIDERS.anthropic), 'configured');
});

await test('resolveModelState accepts tier names from the tiers map', () => {
  eq(resolveModelState('opus', PROVIDERS.openrouter), 'configured');
});

await test('supervisor squad is coordinator-only (honest empty role list)', () => {
  const sup = buildBoardModel(FIXTURE)[1];
  eq(sup.coordinatorOnly, true);
  eq(sup.cards.length, 1);
  eq(sup.cards[0].key, COORDINATOR_KEY);
});

await test('buildBoardModel survives malformed squad entries', () => {
  eq(buildBoardModel({ squads: { broken: null }, providers: {} })[0].coordinatorOnly, true);
  eq(buildBoardModel(null), []);
  eq(buildBoardModel(undefined), []);
});

await test('non-string model values never reach the board', () => {
  const weird = {
    squads: {
      x: { lead: 42, provider: 'openrouter', leadFiles: [], agents: { r: { model: 7, tools: [] } } },
    },
    providers: PROVIDERS,
  };
  const [squad] = buildBoardModel(weird);
  eq(squad.cards[0].model, null);
  eq(squad.cards[1].model, null);
});

// --- identity: toolSummary ----------------------------------------------------

await test('toolSummary: none, one, two and overflow labels', () => {
  eq(toolSummary([]), { count: 0, label: 'no tools configured' });
  eq(toolSummary(['Read']), { count: 1, label: '1 tool: Read' });
  eq(toolSummary(['Read', 'Edit']), { count: 2, label: '2 tools: Read, Edit' });
  eq(toolSummary(['Read', 'Edit', 'Write', 'Bash']), { count: 4, label: '4 tools: Read, Edit +2' });
});

await test('toolSummary ignores non-string junk', () => {
  eq(toolSummary(null), { count: 0, label: 'no tools configured' });
  eq(toolSummary(['Read', 5, null]), { count: 1, label: '1 tool: Read' });
});

// --- identity: installFingerprint ---------------------------------------------

await test('installFingerprint is stable across role/model edits', () => {
  const a = installFingerprint(FIXTURE);
  const edited = JSON.parse(JSON.stringify(FIXTURE));
  edited.squads.dev.agents.recon.model = 'other/model';
  edited.squads.dev.agents.newRole = { model: 'x', tools: [] };
  eq(installFingerprint(edited), a);
});

await test('installFingerprint changes when the squad set changes', () => {
  const added = JSON.parse(JSON.stringify(FIXTURE));
  added.squads.review = { lead: null, provider: 'openrouter', leadFiles: [], agents: {} };
  assert.notEqual(installFingerprint(added), installFingerprint(FIXTURE));
});

// --- layout: positions ---------------------------------------------------------

await test('clampPosition clamps to 0..100 and coerces junk to 0', () => {
  eq(clampPosition({ x: -5, y: 120 }), { x: 0, y: 100 });
  eq(clampPosition({ x: 'a', y: NaN }), { x: 0, y: 0 });
  eq(clampPosition(null), { x: 0, y: 0 });
  eq(clampPosition({ x: 50.4, y: 3 }), { x: 50.4, y: 3 });
});

await test('defaultPositions puts coordinator top-center, specialists below', () => {
  const pos = defaultPositions([COORDINATOR_KEY, 'a', 'b', 'c']);
  eq(pos[COORDINATOR_KEY], { x: 50, y: 12 });
  eq(pos.a, { x: 16, y: 36 });
  eq(pos.b, { x: 50, y: 36 });
  eq(pos.c, { x: 84, y: 36 });
});

await test('defaultPositions: extra rows and coordinator-less squads work', () => {
  const pos = defaultPositions(['a', 'b', 'c', 'd']);
  eq(pos.d, { x: 16, y: 66 });
  eq(COORDINATOR_KEY in pos, false);
});

// --- layout: migration ----------------------------------------------------------

await test('migrateLayout passes a valid v2 record through', () => {
  const rec = { version: 2, installKey: 'k', squad: 'dev', positions: { a: { x: 1, y: 2 } }, updatedAt: 't' };
  eq(migrateLayout(rec), rec);
});

await test('migrateLayout migrates unversioned v1 record and marks it', () => {
  const v1 = { positions: { a: { x: 10, y: 20 } } };
  const out = migrateLayout(v1);
  eq(out.version, LAYOUT_VERSION);
  eq(out.positions, v1.positions);
  eq(out.migratedFromVersion, 1);
});

await test('migrateLayout rejects unknown versions and malformed records', () => {
  eq(migrateLayout({ version: 99, positions: {} }), null);
  eq(migrateLayout({ version: 2 }), null); // no positions
  eq(migrateLayout({ positions: 'nope' }), null);
  eq(migrateLayout(null), null);
  eq(migrateLayout([1, 2]), null);
  eq(migrateLayout('json'), null);
});

await test('normalizePositions drops unknown roles, fills and clamps known ones', () => {
  const out = normalizePositions(
    { a: { x: -10, y: 500 }, ghost: { x: 1, y: 1 } },
    ['a', 'b']
  );
  eq(out.a, { x: 0, y: 100 });
  eq(out.b, defaultPositions(['a', 'b']).b);
  eq('ghost' in out, false);
});

// --- layout: storage roundtrip ---------------------------------------------------

function makeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

await test('saveLayout then loadLayout roundtrips positions per install+squad', () => {
  const storage = makeStorage();
  const key = installFingerprint(FIXTURE);
  saveLayout(storage, key, 'dev', { recon: { x: 12, y: 34 } });
  const { positions, migratedFromVersion } = loadLayout(storage, key, 'dev', ['recon', 'implementer']);
  eq(migratedFromVersion, null);
  eq(positions.recon, { x: 12, y: 34 });
  eq(positions.implementer, defaultPositions(['recon', 'implementer']).implementer);
  // key is versioned and namespaced
  assert.notEqual(storage.getItem(storageKey(key, 'dev')), null);
  const raw = JSON.parse(storage.getItem(storageKey(key, 'dev')));
  eq(raw.version, LAYOUT_VERSION);
  eq(raw.squad, 'dev');
});

await test('loadLayout: corrupt JSON falls back to defaults without throwing', () => {
  const key = installFingerprint(FIXTURE);
  const storage = makeStorage({ [storageKey(key, 'dev')]: '{not json' });
  const { positions, migratedFromVersion } = loadLayout(storage, key, 'dev', ['recon']);
  eq(migratedFromVersion, null);
  eq(positions, defaultPositions(['recon']));
});

await test('loadLayout: v1 record under the v2 key migrates and reports it', () => {
  const key = installFingerprint(FIXTURE);
  const v1 = JSON.stringify({ positions: { recon: { x: 50, y: 50 } } });
  const storage = makeStorage({ [storageKey(key, 'dev')]: v1 });
  const { positions, migratedFromVersion } = loadLayout(storage, key, 'dev', ['recon']);
  eq(migratedFromVersion, 1);
  eq(positions.recon, { x: 50, y: 50 });
});

await test('loadLayout: future version falls back to defaults, never guesses', () => {
  const key = installFingerprint(FIXTURE);
  const v99 = JSON.stringify({ version: 99, positions: { recon: { x: 1, y: 1 } } });
  const storage = makeStorage({ [storageKey(key, 'dev')]: v99 });
  const { positions, migratedFromVersion } = loadLayout(storage, key, 'dev', ['recon']);
  eq(migratedFromVersion, null);
  eq(positions, defaultPositions(['recon']));
});

await test('storage failures degrade to defaults and no-op saves', () => {
  const denied = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  const key = installFingerprint(FIXTURE);
  const loaded = loadLayout(denied, key, 'dev', ['recon']);
  eq(loaded.positions, defaultPositions(['recon']));
  eq(saveLayout(denied, key, 'dev', { recon: { x: 1, y: 1 } }), null);
});

// --- working copy: staging (slice 1 part 2) ----------------------------------

await test('buildWorkingCopy normalizes legacy string agents and deep-clones', () => {
  const raw = {
    squads: { dev: { lead: 'm1', provider: 'openrouter', leadFiles: [], agents: { recon: 'm2' } } },
    pricing: { openrouter: { m1: { input: 1, output: 2 } } },
    providers: {},
  };
  const copy = buildWorkingCopy(raw);
  eq(copy.squads.dev.agents.recon, { model: 'm2', tools: [] });
  copy.squads.dev.lead = 'changed';
  copy.pricing.openrouter.m1.input = 999;
  eq(raw.squads.dev.lead, 'm1'); // source untouched
  eq(raw.pricing.openrouter.m1.input, 1);
});

await test('setAgentModel stages a model and preserves the role tools', () => {
  const copy = buildWorkingCopy(FIXTURE);
  const next = setAgentModel(copy, 'dev', 'recon', 'google/gemini-2.5-flash-lite');
  eq(next.squads.dev.agents.recon, { model: 'google/gemini-2.5-flash-lite', tools: ['Read', 'Grep', 'Glob', 'Bash'] });
  eq(copy.squads.dev.agents.recon.model, 'z-ai/glm-5.3-flash'); // previous copy untouched
});

await test('setAgentModel creates a missing agent entry and ignores unknown squads', () => {
  const copy = buildWorkingCopy(FIXTURE);
  const created = setAgentModel(copy, 'dev', 'newRole', 'm9');
  eq(created.squads.dev.agents.newRole, { model: 'm9', tools: [] });
  eq(setAgentModel(copy, 'ghost', 'recon', 'm9'), copy);
  eq(setLeadModel(copy, 'ghost', 'm9'), copy);
});

await test('setLeadModel stages the coordinator model and keeps other squad fields', () => {
  const copy = buildWorkingCopy(FIXTURE);
  const next = setLeadModel(copy, 'dev', 'other/model');
  eq(next.squads.dev.lead, 'other/model');
  eq(next.squads.dev.provider, 'openrouter');
  eq(next.squads.dev.agents, copy.squads.dev.agents);
});

await test('countDirty counts model, lead, tools, provider, pricing changes', () => {
  const base = buildWorkingCopy(FIXTURE);
  // both sides normalized the same way → clean slate (the real app compares
  // its normalized server read against the working copy)
  eq(countDirty(base, buildWorkingCopy(FIXTURE)), 0);
  let next = setAgentModel(base, 'dev', 'recon', 'other/model');
  eq(countDirty(base, next), 1);
  next = setLeadModel(next, 'dev', 'lead/model');
  eq(countDirty(base, next), 2);
  // tool order is not content (sorted comparison) — reordering is clean
  const reordered = setAgentModel(base, 'dev', 'recon', 'z-ai/glm-5.3-flash');
  reordered.squads.dev.agents.recon.tools = ['Bash', 'Read', 'Grep', 'Glob'];
  eq(countDirty(base, reordered), 0);
  // but an actual tool change counts
  const fewer = setAgentModel(base, 'dev', 'recon', 'z-ai/glm-5.3-flash');
  fewer.squads.dev.agents.recon.tools = ['Read'];
  eq(countDirty(base, fewer), 1);
  // pricing edit
  const priced = buildWorkingCopy(FIXTURE);
  priced.pricing.openrouter = { 'new/model': { input: 3, output: 4 } };
  eq(countDirty(base, priced), 1);
  // provider profile edit
  const prov = buildWorkingCopy(FIXTURE);
  prov.providers.anthropic = { ...PROVIDERS.anthropic, baseUrl: 'https://other.example' };
  eq(countDirty(base, prov), 1);
  // staging a model on the unconfigured role counts as one change
  const filled = setAgentModel(base, 'dev', 'debugger', 'some/model');
  eq(countDirty(base, filled), 1);
  // leaving the unconfigured role empty stays clean
  eq(countDirty(base, setAgentModel(base, 'dev', 'debugger', '')), 0);
});

await test('buildSavePayload sends the full working copy with the dry-run flag', () => {
  const copy = buildWorkingCopy(FIXTURE);
  const previewPayload = buildSavePayload(copy, true);
  eq(Object.keys(previewPayload).sort(), ['dryRun', 'pricing', 'providers', 'squads']);
  eq(previewPayload.dryRun, true);
  eq(buildSavePayload(copy, false).dryRun, false);
  eq(previewPayload.squads, copy.squads);
  eq(buildSavePayload(null, true).squads, {});
});

await test('normalizeSaveError keeps validation details, drops non-arrays', () => {
  const err = new Error('Validation failed');
  err.data = { error: 'Validation failed', details: ['bad model', 'bad price'] };
  eq(normalizeSaveError(err), { message: 'Validation failed', details: ['bad model', 'bad price'] });
  eq(normalizeSaveError(new Error('boom')).details, []);
  eq(normalizeSaveError({ data: { details: 'junk' } }).details, []);
  eq(normalizeSaveError(undefined).details, []);
  eq(normalizeSaveError(42).message, '42');
});

await test('modelSuggestions = provider models ∪ pricing keys, deduped', () => {
  eq(
    modelSuggestions('openrouter', PROVIDERS, { openrouter: { 'z-ai/glm-5.3-flash': {}, 'other/x': {} } }),
    ['z-ai/glm-5.3-flash', 'google/gemini-2.5-flash-lite', 'other/x']
  );
  eq(modelSuggestions('unknown', PROVIDERS, {}), []);
  eq(modelSuggestions('openrouter', null, null), []); // no provider profile → no suggestions
  eq(DEFAULT_PROVIDER, 'openrouter');
});

await test('hasPriceEntry finds pricing rows only for the same provider', () => {
  const pricing = { openrouter: { 'z-ai/glm-5.3-flash': { input: 1, output: 2 } } };
  eq(hasPriceEntry('z-ai/glm-5.3-flash', 'openrouter', pricing), true);
  eq(hasPriceEntry('z-ai/glm-5.3-flash', 'anthropic', pricing), false);
  eq(hasPriceEntry('z-ai/glm-5.3-flash', 'openrouter', undefined), false);
});

// --- manager editing helpers ---------------------------------------------------

await test('promptPathFor maps roles to agent files and the coordinator to CLAUDE.md', () => {
  eq(promptPathFor('dev', 'recon'), 'agents/dev/agents/recon.md');
  eq(promptPathFor('dev', COORDINATOR_KEY), 'agents/dev/CLAUDE.md');
  eq(promptPathFor('dev', null), null);
  eq(promptPathFor(null, 'recon'), null);
});

await test('stagedModelSummary compares configured vs staged, nulls equal empty', () => {
  eq(stagedModelSummary('m1', 'm2'), { changed: true, from: 'm1', to: 'm2' });
  eq(stagedModelSummary(null, ''), { changed: false, from: '', to: '' });
  eq(stagedModelSummary(null, 'm1'), { changed: true, from: '', to: 'm1' });
  eq(stagedModelSummary('m1', null), { changed: true, from: 'm1', to: '' });
});

await test('editingGuardActive turns on for staging or a prompt draft', () => {
  eq(editingGuardActive(0, false), false);
  eq(editingGuardActive(2, false), true);
  eq(editingGuardActive(0, true), true);
  eq(editingGuardActive(3, true), true);
  eq(editingGuardActive(NaN, false), false); // junk count never arms the guard
});

await test('squadRoleCounts: specialists exclude the lead, roster lists all', () => {
  const [dev, supervisor] = buildBoardModel(FIXTURE);
  eq(squadRoleCounts(dev), { specialists: 3, total: 4, coordinatorOnly: false });
  eq(squadRoleCounts(supervisor), { specialists: 0, total: 1, coordinatorOnly: true });
  eq(squadRoleCounts(null), { specialists: 0, total: 0, coordinatorOnly: false });
  eq(squadRoleCounts({ cards: 'junk' }), { specialists: 0, total: 0, coordinatorOnly: false });
});

// --- review regressions: tab-switch confirm + stale-preview gating -----------

await test('switchBlocked guards only when a draft exists and confirm declines', () => {
  let calls = 0;
  const confirmTrue = () => {
    calls++;
    return true;
  };
  const confirmFalse = () => {
    calls++;
    return false;
  };
  eq(switchBlocked(false, confirmFalse), false); // clean draft → never even asks
  eq(calls, 0);
  eq(switchBlocked(true, confirmFalse), true); // dirty + declined → blocked
  eq(switchBlocked(true, confirmTrue), false); // dirty + confirmed → proceed
  eq(calls, 2);
  eq(switchBlocked(undefined, confirmFalse), false); // junk dirty never blocks
  eq(calls, 2);
});

await test('workingFingerprint is order-canonical and edit-sensitive (preview gate)', () => {
  // key order is not content — structurally equal snapshots must match
  const a = workingFingerprint({ b: { y: 2, x: 1 }, a: [1, { d: 4, c: 3 }] });
  const b = workingFingerprint({ a: [1, { c: 3, d: 4 }], b: { x: 1, y: 2 } });
  eq(a, b);
  eq(workingFingerprint(null), workingFingerprint(null));
  assert.notEqual(a, workingFingerprint({ b: { y: 2, x: 1 }, a: [1, { c: 3, d: 5 }] }));
  // the gating property the Manager relies on: staging changes the fingerprint…
  const base = buildWorkingCopy(FIXTURE);
  const staged = setAgentModel(base, 'dev', 'recon', 'other/model');
  assert.notEqual(workingFingerprint(staged), workingFingerprint(base));
  // …and a preview computed before the staging can never equal the staged copy
  assert.notEqual(workingFingerprint(base), workingFingerprint(staged));
  // discard rebuilds from the same source — identity restored
  eq(workingFingerprint(buildWorkingCopy(FIXTURE)), workingFingerprint(base));
});

await test('keyboardMoveDelta scales the arrow step — Shift uses the large step', () => {
  // fenix-manager.md §3.1 item 2: arrow = small step, Shift+Arrow = large step
  eq(MOVE_STEP, 2);
  eq(MOVE_STEP_LARGE, 8);
  eq(keyboardMoveDelta('ArrowRight', false), [2, 0]); // plain press moves 2%
  eq(keyboardMoveDelta('ArrowRight', true), [8, 0]); // Shift moves 8%
  eq(keyboardMoveDelta('ArrowLeft', true), [-8, 0]);
  eq(keyboardMoveDelta('ArrowUp', true), [0, -8]);
  eq(keyboardMoveDelta('ArrowDown', false), [0, 2]);
  eq(keyboardMoveDelta('Enter', true), null); // non-move keys stay select keys
  eq(keyboardMoveDelta('a', false), null);
});

await test('connectivityState: offline on fetch failure, restored on a successful read', () => {
  // first load in flight — not online yet
  eq(connectivityState({ loading: true, readAt: null, error: null }), 'connecting');
  // failed config read → header goes offline (dot + text, fenix-manager.md §3.4)
  const failure = new Error('GET /api/squad-config failed');
  eq(connectivityState({ loading: true, readAt: null, error: failure }), 'offline');
  eq(connectivityState({ loading: false, readAt: null, error: failure }), 'offline');
  // retry in flight after a failure — error cleared, but not online until a read lands
  eq(connectivityState({ loading: true, readAt: new Date(), error: null }), 'connecting');
  // successful read restores the normal state
  eq(connectivityState({ loading: false, readAt: new Date(), error: null }), 'online');
});

// --- Slice 2: live snapshot adapter (manager/live.js) ------------------------

await test('LIVE_STATE_META: every state renders icon + text — never color alone', () => {
  const states = ['running', 'waiting', 'failed', 'finished', 'accepted', 'stale', 'unknown'];
  for (const s of states) {
    const meta = LIVE_STATE_META[s];
    assert(meta, `missing meta for ${s}`);
    assert(meta.glyph && meta.glyph.length > 0, `${s} has no icon glyph`);
    assert(meta.label && meta.label.length > 0, `${s} has no text label`);
    assert(meta.cls && meta.cls.startsWith('mgr-chip'), `${s} chip class wrong: ${meta.cls}`);
  }
});

await test('mapRunState: unended runs — store truth, liveness refines, contradiction is never "running"', () => {
  eq(mapRunState(null), 'unknown');
  eq(mapRunState({ endedAt: null, alive: true }), 'running');
  // missing liveness does not negate the store (documented server-side in missing[])
  eq(mapRunState({ endedAt: null, alive: null }), 'running');
  eq(mapRunState({ endedAt: null }), 'running');
  // a dead console with no recorded end contradicts the store — unknown, not fake running
  eq(mapRunState({ endedAt: null, alive: false }), 'unknown');
});

await test('mapRunState: ended runs — failed / finished / accepted / unknown', () => {
  const acc = { 'FOC-910': { round: 3, verdict: 'pass' } };
  eq(mapRunState({ endedAt: 'x', exitCode: 1 }), 'failed');
  eq(mapRunState({ endedAt: 'x', exitCode: '2' }), 'failed'); // string exit codes parse
  eq(mapRunState({ endedAt: 'x', exitCode: 0 }), 'finished'); // exit 0 alone never accepts
  eq(mapRunState({ endedAt: 'x', exitCode: 0, taskId: 'FOC-910' }, acc), 'accepted');
  eq(mapRunState({ endedAt: 'x', exitCode: 0, taskId: 'foc-910' }, acc), 'accepted'); // case-insensitive
  eq(mapRunState({ endedAt: 'x', exitCode: 0, taskId: 'FOC-999' }, acc), 'finished');
  eq(mapRunState({ endedAt: 'x', exitCode: 0 }, acc), 'finished');
  // missing or unparsable exit code — unknown, never guessed into finished/failed
  eq(mapRunState({ endedAt: 'x', exitCode: null }), 'unknown');
  eq(mapRunState({ endedAt: 'x' }), 'unknown');
  eq(mapRunState({ endedAt: 'x', exitCode: 'oops' }), 'unknown');
});

await test('squadLiveState: gate > active > newest recent; empty window renders nothing', () => {
  const acc = { 'FOC-910': { round: 1, verdict: 'pass' } };
  const gate = { pendingGates: [{ gateId: 'g1' }] };
  eq(squadLiveState(gate, acc), 'waiting'); // a pending gate overrides everything
  eq(squadLiveState({ ...gate, active: [{ endedAt: null, alive: true }] }, acc), 'waiting');
  eq(squadLiveState({ active: [{ endedAt: null, alive: true }], recent: [] }, acc), 'running');
  eq(squadLiveState({ active: [], recent: [{ endedAt: 'x', exitCode: 1 }] }, acc), 'failed');
  eq(squadLiveState({ active: [], recent: [{ endedAt: 'x', exitCode: 0, taskId: 'FOC-910' }] }, acc), 'accepted');
  eq(squadLiveState({ active: [], recent: [{ endedAt: 'x', exitCode: 0 }] }, acc), 'finished');
  eq(squadLiveState({ active: [], recent: [{ endedAt: 'x', exitCode: null }] }, acc), 'unknown');
  eq(squadLiveState({ active: [], recent: [] }, acc), null); // no fake idle activity
  eq(squadLiveState(null, acc), null);
});

await test('liveBlockFor + decorateRuns: absent squad is empty, rows get derived states', () => {
  // a missing snapshot or squad is an EMPTY block, not an error — no runs in
  // the bounded window, nothing invented
  const emptyShape = JSON.stringify({ active: [], recent: [], pendingGates: [] });
  eq(JSON.stringify(liveBlockFor(null, 'dev')), emptyShape);
  const empty = liveBlockFor({ squads: {} }, 'dev');
  eq(JSON.stringify(empty), emptyShape);
  const block = {
    active: [{ runId: 'a1', endedAt: null, alive: true }],
    recent: [{ runId: 'r1', endedAt: 'x', exitCode: 1 }, { runId: 'r2', endedAt: 'x', exitCode: 0 }],
    pendingGates: [{ gateId: 'g1', squad: 'dev' }],
  };
  const d = decorateRuns(block, {});
  eq(d.active[0].state, 'running');
  eq(d.recent[0].state, 'failed');
  eq(d.recent[1].state, 'finished');
  eq(d.active[0].runId, 'a1'); // original fields intact
  eq(d.pendingGates.length, 1);
});

await test('isSnapshotStale: missing/broken generatedAt is stale; age over the bound is stale', () => {
  const now = Date.parse('2026-09-06T12:00:00.000Z');
  eq(isSnapshotStale(null, now), true);
  eq(isSnapshotStale({}, now), true);
  eq(isSnapshotStale({ generatedAt: 'not-a-date' }, now), true);
  eq(isSnapshotStale({ generatedAt: '2026-09-06T11:59:57.000Z' }, now), false); // 3 s old — fresh
  eq(isSnapshotStale({ generatedAt: '2026-09-06T11:59:40.000Z' }, now), true); // 20 s — stale
  assert(SNAPSHOT_STALE_MS === 15000, `stale bound moved: ${SNAPSHOT_STALE_MS}`);
});

await test('poll helpers: backoff doubles to the cap; ticks skip in-flight, hidden and paused', () => {
  eq(POLL_BASE_MS, 5000);
  eq(POLL_MAX_MS, 60000);
  eq(nextPollIntervalMs(5000), 10000); // one failure → ×2
  eq(nextPollIntervalMs(30000), 60000); // capped
  eq(nextPollIntervalMs(60000), 60000); // stays at cap
  eq(nextPollIntervalMs(0), 10000); // garbage current falls back to base then doubles
  eq(shouldPoll({ enabled: true, inFlight: false, hidden: false }), true);
  eq(shouldPoll({ enabled: true, inFlight: true, hidden: false }), false); // never overlap
  eq(shouldPoll({ enabled: true, inFlight: false, hidden: true }), false); // hidden tab
  eq(shouldPoll({ enabled: false, inFlight: false, hidden: false }), false); // paused mode
});

// --- Summary -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

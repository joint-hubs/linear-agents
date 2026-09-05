// Unit tests for the Manager pure adapters (FOC-225 slice 1 part 1).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_test_utils.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: identity mapping from a real-shaped /api/squad-config fixture
// (squad/role/model/tools), unknown role/model handling, coordinator-only
// squads, and layout persistence incl. schema migration and corrupt-record
// recovery. Fixtures only — no network, no production config access.

import assert from 'node:assert/strict';

import {
  buildBoardModel,
  installFingerprint,
  resolveModelState,
  toolSummary,
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
} from './manager/layout.js';

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

// --- Summary -----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

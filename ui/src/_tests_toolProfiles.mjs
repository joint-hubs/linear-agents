// Unit tests for the tool-profiles UI model (P2 slice — ui/src/toolProfilesModel.js).
// Self-contained Node ESM script — NO test framework, NO deps, NO DOM. Same
// harness pattern as src/_tests_manager.mjs. Invoke directly:
//   node ui/src/_tests_toolProfiles.mjs
//
// Pins the honesty contracts of the slice plus the pure plumbing:
//   1. null = inherit vs [] = explicit none are DIFFERENT values end to end
//      (listEntry → toolMode → toolValueForMode → buildPatch, where null
//      patches to a deleted entry and [] patches to an explicit empty list) —
//      on ALL THREE layers: globalTools, squadTools.<squad>, leadTools.<squad>.
//   2. A dry-run preview is invalidated by any later staged edit
//      (stagedFingerprint + previewIsValid — the Apply guard).
//   3. Secret-shaped configuration never reaches the render path
//      (redactDeep on config, change rows and secret-named fields).
//   4. Server verification resets when connection inputs change — but NOT
//      when only the enabled flag toggles (the probe ignores it).
//   5. The inheritance chain resolves as leadTools.<squad> ?? squadTools.<squad>
//      ?? globalTools ?? null (effectiveLead mirrors resolveToolProfile) and
//      the sparse patch covers all three layers.
//   6. The STAGED enabled flag unlocks the mcp__thoughtmap__* tools in the
//      SAME Apply — a staged enable is not blocked by the catalog's stale
//      serverEnabled state (mergeCatalogs opts.mcpEnabled wins over it).
// Plus: sparse patch building with CAS payload, merged catalog (MCP tools
// only when the server counts as enabled; unknown configured names preserved),
// honest check summaries (ok only when all stages passed, dependency hint
// surfaced) and error normalization. Fixtures only — no network.

import assert from 'node:assert/strict';

import {
  REDACTED,
  SQUAD_NAME_RE,
  buildPatch,
  buildProbeBody,
  buildProfilePayload,
  catalogNames,
  connectionInputsChanged,
  describeCheck,
  dirtyPaths,
  effectiveLead,
  globalValue,
  isSecretLike,
  isSecretShapedKey,
  leadValue,
  listEntry,
  mergeCatalogs,
  normalizeTpError,
  previewIsValid,
  redactChanges,
  redactDeep,
  squadValue,
  stagedFingerprint,
  stagedFromConfig,
  toolMode,
  toolValueForMode,
} from './toolProfilesModel.js';
import { splitKnownTools } from './squadConfig/workingCopy.js';

// --- Minimal test harness (same shape as _tests_manager.mjs) ----------------

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

// --- Fixtures (shaped like the real GET /api/tool-profiles payload) ---------

const CONFIG = {
  version: 1,
  revision: 4,
  mcp: {
    thoughtmap: {
      enabled: false,
      baseUrl: 'http://thoughtmap-app:8585',
      ollamaBaseUrl: 'http://thoughtmap-ollama:11434',
      embeddingModel: 'qwen3-embedding:8b',
      clustersPath: '/fenix-integrations/thoughtmap/clusters.json',
    },
  },
  leadTools: {
    dev: ['Read', 'Task'],
  },
};

const DEFAULT_CONFIG = {
  version: 1,
  revision: 0,
  mcp: {
    thoughtmap: {
      enabled: false,
      baseUrl: 'http://thoughtmap-app:8585',
      ollamaBaseUrl: 'http://thoughtmap-ollama:11434',
      embeddingModel: 'qwen3-embedding:8b',
      clustersPath: '/fenix-integrations/thoughtmap/clusters.json',
    },
  },
  leadTools: {},
};

// A registry with all three layers set — the layered semantics fixture.
const LAYERED_CONFIG = {
  ...CONFIG,
  globalTools: ['Read', 'Grep'],
  squadTools: { dev: null, research: [] },
  leadTools: { dev: ['Read', 'Task'] },
};

// --- 1. null = inherit vs [] = explicit none --------------------------------

await test('leadValue: absent entry behaves as null (inherit)', () => {
  eq(leadValue(CONFIG, 'supervisor'), null);
});

await test('leadValue: configured entry comes back verbatim', () => {
  eq(leadValue(CONFIG, 'dev'), ['Read', 'Task']);
});

await test('globalValue/squadValue: absent entries behave as null (inherit)', () => {
  eq(globalValue(DEFAULT_CONFIG), null);
  eq(squadValue(DEFAULT_CONFIG, 'dev'), null);
  eq(listEntry(undefined), null);
});

await test('toolMode: null → inherit, [] → none, list → explicit', () => {
  eq(toolMode(null), 'inherit');
  eq(toolMode(undefined), 'inherit');
  eq(toolMode([]), 'none');
  eq(toolMode(['Read']), 'explicit');
});

await test('toolValueForMode: inherit → null, none → [], explicit → the list', () => {
  eq(toolValueForMode('inherit', ['Read']), null);
  eq(toolValueForMode('none', ['Read']), []);
  eq(toolValueForMode('explicit', ['Read', 'Grep']), ['Read', 'Grep']);
  eq(toolValueForMode('explicit', undefined), []);
});

await test('staged roundtrip: null and [] stay distinct through stagedFromConfig', () => {
  const staged = stagedFromConfig({ ...CONFIG, leadTools: { dev: [], supervisor: null } });
  eq(staged.leadTools.dev, []);
  eq(staged.leadTools.supervisor, null);
});

await test('buildPatch: inherit stages null (the merge deletes the entry)', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.leadTools.dev = null;
  const patch = buildPatch(staged, CONFIG);
  eq(patch, { leadTools: { dev: null } });
});

await test('buildPatch: explicit none stages [] (an entry that grants nothing)', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.leadTools.dev = [];
  const patch = buildPatch(staged, CONFIG);
  eq(patch, { leadTools: { dev: [] } });
});

await test('buildPatch: explicit list stages the list verbatim', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.leadTools.supervisor = ['Read'];
  const patch = buildPatch(staged, CONFIG);
  eq(patch, { leadTools: { supervisor: ['Read'] } });
});

await test('dirtyPaths: absent server entry counts as inherit — staging null is NOT dirty', () => {
  const staged = stagedFromConfig(DEFAULT_CONFIG);
  staged.leadTools.supervisor = null;
  eq(dirtyPaths(staged, DEFAULT_CONFIG), []);
});

// --- 1b. The three layers stage and patch independently ----------------------

await test('stagedFromConfig seeds all three layers', () => {
  const staged = stagedFromConfig(LAYERED_CONFIG);
  eq(staged.globalTools, ['Read', 'Grep']);
  eq(staged.squadTools, { dev: null, research: [] });
  eq(staged.leadTools, { dev: ['Read', 'Task'] });
});

await test('stagedFromConfig: a default registry stages null globalTools and empty maps', () => {
  const staged = stagedFromConfig(DEFAULT_CONFIG);
  eq(staged.globalTools, null);
  eq(staged.squadTools, {});
  eq(staged.leadTools, {});
});

await test('effectiveLead mirrors resolveToolProfile: first explicit layer wins', () => {
  eq(effectiveLead(LAYERED_CONFIG, 'dev'), { value: ['Read', 'Task'], source: 'leadTools' });
  eq(effectiveLead(LAYERED_CONFIG, 'research'), { value: [], source: 'squadTools' });
  eq(effectiveLead(LAYERED_CONFIG, 'other'), { value: ['Read', 'Grep'], source: 'globalTools' });
  eq(effectiveLead(DEFAULT_CONFIG, 'dev'), { value: null, source: 'native' });
  // An explicit [] in a layer STOPS the fall-through (it is explicit, not absent).
  eq(effectiveLead({ ...CONFIG, leadTools: {}, globalTools: ['Read'], squadTools: { dev: [] } }, 'dev'), {
    value: [],
    source: 'squadTools',
  });
});

await test('buildPatch: global inherit stages null (entry deleted), none stages []', () => {
  const staged = stagedFromConfig(LAYERED_CONFIG);
  staged.globalTools = null; // server had an explicit list
  eq(buildPatch(staged, LAYERED_CONFIG), { globalTools: null });

  const staged2 = stagedFromConfig(DEFAULT_CONFIG);
  staged2.globalTools = []; // server had none (inherit) → an explicit [] entry appears
  eq(buildPatch(staged2, DEFAULT_CONFIG), { globalTools: [] });
});

await test('buildPatch: squadTools entries are sparse — unchanged squads stay out', () => {
  const staged = stagedFromConfig(LAYERED_CONFIG);
  staged.squadTools.research = ['Bash']; // [] → explicit list
  // dev is null on both sides — NOT dirty despite the entry existing.
  eq(buildPatch(staged, LAYERED_CONFIG), { squadTools: { research: ['Bash'] } });
});

await test('buildPatch: squadTools inherit deletes only the changed entry', () => {
  const staged = stagedFromConfig(LAYERED_CONFIG);
  staged.squadTools.research = null; // [] → null deletes the entry
  eq(buildPatch(staged, LAYERED_CONFIG), { squadTools: { research: null } });
});

await test('dirtyPaths: staging inherit over an ABSENT squadTools entry is NOT dirty', () => {
  const staged = stagedFromConfig(DEFAULT_CONFIG);
  staged.squadTools.dev = null;
  eq(dirtyPaths(staged, DEFAULT_CONFIG), []);
});

await test('dirtyPaths covers thoughtmap, global, squad and lead layers independently', () => {
  const staged = stagedFromConfig(LAYERED_CONFIG);
  staged.thoughtmap.enabled = true;
  staged.globalTools = ['Read'];
  staged.squadTools.research = null;
  staged.leadTools.dev = null;
  eq(dirtyPaths(staged, LAYERED_CONFIG).sort(), [
    'globalTools',
    'leadTools.dev',
    'mcp.thoughtmap.enabled',
    'squadTools.research',
  ]);
});

await test('buildProfilePayload: one staged change carries all layers with the CAS revision', () => {
  const staged = stagedFromConfig(DEFAULT_CONFIG);
  staged.thoughtmap.enabled = true; // staged enable + tool lists in the SAME apply
  staged.globalTools = ['Read'];
  staged.squadTools = { dev: ['Bash'] };
  staged.leadTools = { dev: ['Read', 'Task'] };
  eq(buildProfilePayload(staged, DEFAULT_CONFIG, false), {
    patch: {
      mcp: { thoughtmap: { enabled: true } },
      globalTools: ['Read'],
      squadTools: { dev: ['Bash'] },
      leadTools: { dev: ['Read', 'Task'] },
    },
    dryRun: false,
    expectedRevision: 0,
  });
});

await test('SQUAD_NAME_RE: shape pre-screen for the squadTools editor', () => {
  eq(SQUAD_NAME_RE.test('dev'), true);
  eq(SQUAD_NAME_RE.test('supervisor'), true);
  eq(SQUAD_NAME_RE.test('my-squad-2'), true);
  eq(SQUAD_NAME_RE.test('Dev'), false);
  eq(SQUAD_NAME_RE.test('has space'), false);
  eq(SQUAD_NAME_RE.test(''), false);
});

// --- 2. Stale preview invalidation -------------------------------------------

await test('stagedFingerprint: same copy → same fingerprint, any edit → different', () => {
  const staged = stagedFromConfig(CONFIG);
  const before = stagedFingerprint(staged);
  staged.thoughtmap.enabled = true;
  const after = stagedFingerprint(staged);
  assert.notEqual(before, after);
  eq(stagedFingerprint(stagedFromConfig(CONFIG)), before);
});

await test('previewIsValid: a preview matches only the snapshot it described', () => {
  const staged = stagedFromConfig(CONFIG);
  const fp = stagedFingerprint(staged);
  eq(previewIsValid(fp, fp), true);
  staged.thoughtmap.baseUrl = 'http://thoughtmap-app:9999';
  eq(previewIsValid(fp, stagedFingerprint(staged)), false); // stale preview invalidated
  eq(previewIsValid(null, fp), false);
});

// --- 3. Secret-shaped configuration is never rendered ------------------------

await test('isSecretLike catches real credential shapes', () => {
  eq(isSecretLike('sk-or-v1-abcdef0123456789'), true);
  eq(isSecretLike('sk-ant-api03-x'), true);
  eq(isSecretLike('github_pat_11AAAA0123456789ABCDEFGHIJ'), true);
  eq(isSecretLike('http://thoughtmap-app:8585'), false);
});

await test('isSecretShapedKey catches credential-named fields', () => {
  eq(isSecretShapedKey('apiKey'), true);
  eq(isSecretShapedKey('api_key'), true);
  eq(isSecretShapedKey('accessToken'), true);
  eq(isSecretShapedKey('baseUrl'), false);
});

await test('redactDeep masks secret-shaped values in a config-shaped tree', () => {
  const dirty = {
    mcp: { thoughtmap: { baseUrl: 'http://thoughtmap-app:8585', apiKey: 'sk-or-v1-abcdef0123456789' } },
    leadTools: { dev: ['Read', 'ghp_AAAABBBBCCCCDDDDEEEEFFFF'] },
  };
  const clean = redactDeep(dirty);
  eq(clean.mcp.thoughtmap.baseUrl, 'http://thoughtmap-app:8585'); // honest fields survive
  eq(clean.mcp.thoughtmap.apiKey, REDACTED); // secret-named field masked
  eq(clean.leadTools.dev[1], REDACTED); // secret-shaped value masked
  eq(dirty.mcp.thoughtmap.baseUrl, 'http://thoughtmap-app:8585'); // input not mutated
});

await test('redactChanges scrubs change rows for display', () => {
  const rows = redactChanges([
    { path: 'mcp.thoughtmap.baseUrl', before: 'http://a:1', after: 'http://b:2' },
    { path: 'leadTools.dev', before: null, after: ['ghp_AAAABBBBCCCCDDDDEEEEFFFF'] },
    { token: 'lin_api_xxx' }, // secret-NAMED field: masked before its value is even looked at
  ]);
  eq(rows[0].after, 'http://b:2'); // honest values survive
  eq(rows[1].after[0], REDACTED); // secret-shaped array value masked
  eq(rows[2].token, REDACTED);
});

await test('redactDeep on a full config keeps every honest field readable', () => {
  const clean = redactDeep(CONFIG);
  eq(clean.mcp.thoughtmap.clustersPath, CONFIG.mcp.thoughtmap.clustersPath);
  eq(clean.leadTools.dev, ['Read', 'Task']);
  eq(clean.revision, 4);
});

// --- 4. Server verification reset --------------------------------------------

await test('connectionInputsChanged: same inputs → false (verification stays)', () => {
  const staged = stagedFromConfig(CONFIG);
  const form = buildProbeBody(staged.thoughtmap);
  eq(connectionInputsChanged(staged.thoughtmap, form), false);
});

await test('connectionInputsChanged: any connection input change → true (reset)', () => {
  const staged = stagedFromConfig(CONFIG);
  const form = buildProbeBody(staged.thoughtmap);
  staged.thoughtmap.baseUrl = 'http://thoughtmap-app:9999';
  eq(connectionInputsChanged(staged.thoughtmap, form), true);
  staged.thoughtmap.baseUrl = CONFIG.mcp.thoughtmap.baseUrl;
  staged.thoughtmap.embeddingModel = 'other-model:1b';
  eq(connectionInputsChanged(staged.thoughtmap, form), true);
});

await test('connectionInputsChanged: toggling enabled only does NOT reset (probe ignores it)', () => {
  const staged = stagedFromConfig(CONFIG);
  const form = buildProbeBody(staged.thoughtmap);
  staged.thoughtmap.enabled = true;
  eq(connectionInputsChanged(staged.thoughtmap, form), false);
});

await test('connectionInputsChanged: no verification recorded → false', () => {
  eq(connectionInputsChanged(CONFIG.mcp.thoughtmap, null), false);
});

// --- Patch payload + CAS ------------------------------------------------------

await test('buildPatch: unchanged staged copy → null patch (nothing to send)', () => {
  eq(buildPatch(stagedFromConfig(CONFIG), CONFIG), null);
});

await test('buildPatch: sparse — only changed thoughtmap fields ride the patch', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.thoughtmap.enabled = true;
  eq(buildPatch(staged, CONFIG), { mcp: { thoughtmap: { enabled: true } } });
});

await test('buildProfilePayload carries the read-time revision for CAS', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.thoughtmap.enabled = true;
  eq(buildProfilePayload(staged, CONFIG, false), {
    patch: { mcp: { thoughtmap: { enabled: true } } },
    dryRun: false,
    expectedRevision: 4,
  });
});

await test('buildProfilePayload: dryRun flag round-trips', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.leadTools.dev = null;
  const payload = buildProfilePayload(staged, CONFIG, true);
  eq(payload.dryRun, true);
  eq(payload.expectedRevision, 4);
  eq(payload.patch, { leadTools: { dev: null } });
});

await test('buildProfilePayload: no change → null (preview/apply disabled upstream)', () => {
  eq(buildProfilePayload(stagedFromConfig(CONFIG), CONFIG, true), null);
});

await test('dirtyPaths covers thoughtmap and leadTools independently', () => {
  const staged = stagedFromConfig(CONFIG);
  staged.thoughtmap.baseUrl = 'http://thoughtmap-app:9999';
  staged.leadTools.dev = null;
  eq(dirtyPaths(staged, CONFIG).sort(), ['leadTools.dev', 'mcp.thoughtmap.baseUrl']);
});

// --- Catalog merge ------------------------------------------------------------

const NATIVE = {
  tools: { Read: { description: 'reads files', risk: 'safe' }, Bash: { description: 'runs commands', risk: 'writes-system' } },
  riskLevels: { safe: { label: 'safe' }, 'writes-system': { label: 'writes system' } },
};

const TP_CATALOG_ENABLED = {
  tools: {
    Read: { description: 'reads files', risk: 'safe', source: 'builtin' },
    mcp__thoughtmap__search_thoughts: { source: 'mcp', serverEnabled: true, risk: 'safe', description: 'semantic search' },
    mcp__thoughtmap__list_clusters: { source: 'mcp', serverEnabled: true, risk: 'safe', description: 'clusters' },
  },
  riskLevels: {},
  servers: { thoughtmap: { transport: 'stdio' } },
};

const TP_CATALOG_DISABLED = {
  tools: {
    mcp__thoughtmap__search_thoughts: { source: 'mcp', serverEnabled: false, risk: 'safe' },
  },
  riskLevels: {},
  servers: {},
};

await test('mergeCatalogs: MCP tools selectable only when the server is enabled', () => {
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_ENABLED);
  eq(merged.mcpAvailable, true);
  assert.ok(merged.tools['mcp__thoughtmap__search_thoughts']);
  assert.ok(merged.tools['mcp__thoughtmap__list_clusters']);
  assert.ok(merged.tools.Read); // native tools kept
  eq(merged.tools.Read.source, 'builtin');
});

await test('mergeCatalogs: disabled server → MCP names stay out of the editable set', () => {
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_DISABLED);
  eq(merged.mcpAvailable, false);
  eq(merged.tools['mcp__thoughtmap__search_thoughts'], undefined);
  assert.ok(merged.tools.Read);
});

await test('mergeCatalogs: without a tool-profiles catalog the native set survives', () => {
  const merged = mergeCatalogs(NATIVE, null);
  eq(catalogNames(merged), ['Bash', 'Read']);
  eq(merged.mcpAvailable, false);
});

await test('merged catalog: unknown configured MCP names preserved, not granted', () => {
  // Server disabled in the registry but a leadTools entry names the MCP tool:
  // the merged catalog does not know it → splitKnownTools preserves it locked.
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_DISABLED);
  const split = splitKnownTools(['Read', 'mcp__thoughtmap__search_thoughts'], catalogNames(merged));
  eq(split.editable, ['Read']);
  eq(split.preserved, ['mcp__thoughtmap__search_thoughts']);
});

await test('mergeCatalogs: native risk levels win, servers metadata passes through', () => {
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_ENABLED);
  eq(merged.riskLevels['writes-system'].label, 'writes system');
  eq(merged.servers.thoughtmap.transport, 'stdio');
});

// --- Same-Apply unlock: the STAGED enabled flag overrides serverEnabled ------

await test('mergeCatalogs: a STAGED enable unlocks MCP tools even when the catalog says disabled', () => {
  // Catalog fetched before the enable was staged (serverEnabled: false) — the
  // staged checkbox must still make mcp__thoughtmap__* selectable in the same
  // Apply; the patch carries mcp.thoughtmap.enabled=true alongside the lists.
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_DISABLED, { mcpEnabled: true });
  eq(merged.mcpAvailable, true);
  assert.ok(merged.tools['mcp__thoughtmap__search_thoughts']);
  eq(merged.tools['mcp__thoughtmap__search_thoughts'].source, 'mcp');
});

await test('mergeCatalogs: a STAGED disable keeps MCP tools out even when the catalog says enabled', () => {
  const merged = mergeCatalogs(NATIVE, TP_CATALOG_ENABLED, { mcpEnabled: false });
  eq(merged.mcpAvailable, false);
  eq(merged.tools['mcp__thoughtmap__search_thoughts'], undefined);
});

await test('mergeCatalogs: without the staged flag the catalog serverEnabled decides (two-arg callers unchanged)', () => {
  eq(mergeCatalogs(NATIVE, TP_CATALOG_DISABLED).mcpAvailable, false);
  eq(mergeCatalogs(NATIVE, TP_CATALOG_ENABLED).mcpAvailable, true);
});

// --- Probe honesty ------------------------------------------------------------

await test('buildProbeBody: only non-empty connection strings ride the body', () => {
  eq(buildProbeBody({ ...CONFIG.mcp.thoughtmap, enabled: true }), {
    baseUrl: 'http://thoughtmap-app:8585',
    ollamaBaseUrl: 'http://thoughtmap-ollama:11434',
    embeddingModel: 'qwen3-embedding:8b',
    clustersPath: '/fenix-integrations/thoughtmap/clusters.json',
  });
  eq(buildProbeBody({ baseUrl: '', ollamaBaseUrl: 'http://x:1' }), { ollamaBaseUrl: 'http://x:1' });
  eq(buildProbeBody(null), {});
});

await test('describeCheck: verified ONLY when all three stages passed', () => {
  const good = describeCheck({ ok: true, stages: { initialize: true, toolsList: true, searchRoundtrip: true }, tools: ['mcp__thoughtmap__search_thoughts'], ms: 1234 });
  eq(good.ok, true);
  eq(good.passedCount, 3);
  eq(good.tools, ['mcp__thoughtmap__search_thoughts']);
  eq(good.ms, 1234);
  eq(good.failure, null);
});

await test('describeCheck: ok:false with stages → honest partial progress', () => {
  const bad = describeCheck({ ok: false, stages: { initialize: true, toolsList: false, searchRoundtrip: false }, tools: [], ms: 50 });
  eq(bad.ok, false);
  eq(bad.passedCount, 1);
  eq(bad.failure, { code: null, error: null, hint: null });
});

await test('describeCheck: dependency failure surfaces code + hint (python-unavailable)', () => {
  const bad = describeCheck({
    ok: false,
    stages: { initialize: false, toolsList: false, searchRoundtrip: false },
    tools: [],
    ms: 3,
    code: 'python-unavailable',
    hint: "the probe needs a python interpreter with the 'mcp' and 'requests' packages",
    error: 'python not found: python',
  });
  eq(bad.ok, false);
  eq(bad.failure.code, 'python-unavailable');
  assert.match(bad.failure.hint, /mcp/);
});

await test('describeCheck: non-string tool names filtered, missing fields tolerated', () => {
  const check = describeCheck({ ok: true, stages: { initialize: true, toolsList: true, searchRoundtrip: true }, tools: ['a', 5, null], ms: 'fast' });
  eq(check.tools, ['a']);
  eq(check.ms, null);
  eq(describeCheck(null), null);
});

// --- Error normalization --------------------------------------------------------

await test('normalizeTpError: the test endpoint 400 errors array becomes details', () => {
  const err = new Error('invalid');
  err.data = { error: 'invalid', errors: ['mcp.thoughtmap.baseUrl: must be an absolute http(s) URL'] };
  eq(normalizeTpError(err), {
    message: 'invalid',
    details: ['mcp.thoughtmap.baseUrl: must be an absolute http(s) URL'],
  });
});

await test('normalizeTpError: revision conflict (plain message, no array) → empty details', () => {
  const err = new Error('tool-profiles revision conflict: expected 4, the file holds 5 — re-read and retry');
  eq(normalizeTpError(err).details, []);
  assert.match(normalizeTpError(err).message, /revision conflict/);
});

await test('normalizeTpError: undefined → generic', () => {
  eq(normalizeTpError(undefined), { message: String(undefined), details: [] });
});

// --- Summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
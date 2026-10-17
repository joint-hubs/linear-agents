// Unit tests for the Settings pure helpers (FOC-786).
// Self-contained Node ESM script — NO test framework, NO deps. Same harness
// pattern as src/_tests_work.mjs. Invoke via: `npm --prefix ui run test`.
//
// Covers: keyRows (the five state texts, tone words), checkText,
// writableNote, keyFormModel (idle / sending / saved / rejected with reason /
// 503), providerView (active + source + options + custom defaults),
// providerDraft (custom mode mirrors the active selection, stored config kept
// for a deliberate toggle — the browser-proven UI mismatch regression),
// validateCustomProvider (the server's rules mirrored), priceText (the
// workModel.formatMoney rule) + routingRows (source labels, unpriced),
// repoRows (branch@head, dirty, index, worktrees, project), jobProgressText,
// retentionView (policy texts, humanBytes, free disk), artifactsView (FOC-779:
// one row per state — labels, tones, revision/refresh texts, tolerant of an
// empty or malformed payload) — and the leak guard: no model output ever
// contains a canary value passed in by mistake. Fixtures shaped like the
// plan's Settings API contracts — no network, no DOM.
// retentionView (policy texts, humanBytes, free disk, resolved / prunable /
// applied) + retentionFormState / validateRetentionForm (the FOC-780 form's
// keep-all vs days rule, the 1..36500 and 0.5 GiB bounds) — and the leak guard:
// no model output ever contains a canary value passed in by mistake. Fixtures
// shaped like the plan's Settings API contracts — no network, no DOM.

import assert from 'node:assert/strict';

import {
  keyRows,
  checkText,
  writableNote,
  keyFormModel,
  providerView,
  providerDraft,
  CUSTOM_DEFAULTS,
  validateCustomProvider,
  priceText,
  routingRows,
  repoRows,
  jobProgressText,
  jobActive,
  humanBytes,
  retentionView,
  agentToolsView,
  findingCounts,
  artifactsView,
  artifactRow,
  retentionFormState,
  validateRetentionForm,
} from './settingsModel.js';

// --- Minimal test harness (same shape as _tests_work.mjs) --------------------

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

// --- Fixtures (shaped like the plan's Settings API contracts) ----------------

// A canary that must never appear in any model output, however wrongly the
// caller shapes the payload. Injected into fields the models must not read.
const CANARY = 'sk-or-v1-CANARY-0123456789abcdef';

const keysPayload = {
  writable: true,
  keys: [
    {
      name: 'openrouter_api_key',
      label: 'OpenRouter',
      required: true,
      present: true,
      envName: 'OPENROUTER_API_KEY',
      lastCheck: { at: '2026-10-13T10:02:00.000Z', ok: true, reason: null },
    },
    {
      name: 'linear_api_key',
      label: 'Linear',
      required: false,
      present: true,
      envName: 'LINEAR_API_KEY',
      lastCheck: { at: '2026-10-13T09:00:00.000Z', ok: false, reason: '401 from Linear' },
    },
    {
      name: 'github_token',
      label: 'GitHub',
      required: true,
      present: false,
      envName: 'GITHUB_TOKEN',
      lastCheck: null,
    },
    {
      name: 'provider_api_key',
      label: 'Provider key',
      required: false,
      present: false,
      envName: 'PROVIDER_API_KEY',
      lastCheck: null,
    },
  ],
  note: 'a rotated key is used by new children at once; the Supervisor picks it up on its next fresh session',
};

const providerPayload = {
  active: 'openrouter',
  source: 'settings', // the server's word for the overlay decision
  providers: [
    {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      authStyle: 'token',
      keyName: 'openrouter_api_key',
      defaultModel: 'xiaomi/mimo-v2.6-pro',
      tiers: { large: 'anthropic/claude-sonnet-4.5', small: 'z-ai/glm-5.3-flash' },
      builtin: true,
    },
  ],
  custom: {
    baseUrl: 'http://localhost:8000',
    authStyle: 'apikey',
    keyName: 'PROVIDER_API_KEY',
    tiers: {},
    defaultModel: 'xiaomi/mimo-v2.6-pro',
  },
  effectiveOn: 'next child spawn',
};

const routingPayload = {
  provider: 'openrouter',
  rows: [
    {
      squad: 'supervisor',
      lead: 'xiaomi/mimo-v2.6-pro',
      source: 'provider-default',
      price: { input: 3, output: 15 },
      unpriced: false,
      benchmark: null,
    },
    {
      squad: 'PLAN',
      lead: 'z-ai/glm-5.3-flash',
      source: 'settings',
      price: { input: 0.0000002, output: 0.0000011 },
      unpriced: false,
      benchmark: 42,
    },
    {
      squad: 'DEV',
      lead: 'custom/local-70b',
      source: null,
      price: null,
      unpriced: true,
      benchmark: null,
    },
  ],
  models: [
    { id: 'xiaomi/mimo-v2.6-pro', price: { input: 3, output: 15 }, benchmark: 61 },
    { id: 'z-ai/glm-5.3-flash', price: { input: 0.0000002, output: 0.0000011 }, benchmark: 42 },
  ],
};

const reposPayload = {
  root: '/data/github',
  repos: [
    {
      name: 'fenix',
      origin: 'git@github.com:joint-hubs/fenix.git',
      branch: 'main',
      head: 'fd659fb',
      dirty: true,
      index: 'ready',
      worktrees: 2,
      project: 'Fenix',
    },
    {
      name: 'docs',
      origin: 'https://github.com/joint-hubs/docs.git',
      branch: 'develop',
      head: null,
      dirty: false,
      index: 'missing',
      worktrees: 0,
      project: null,
    },
  ],
  jobs: [],
};

const retentionPayload = {
  policy: 'days',
  cleanupPeriodDays: { fenix: 30, cockpit: 30 },
  usage: {
    transcriptsBytes: 2_513_573_913,
    telemetryBytes: 184_000_000,
    workspacesBytes: 512,
    stateBytes: 0,
  },
  disk: { freeBytes: 118_000_000_000 },
  computedAt: '2026-10-13T12:00:00.000Z',
  managedBy: 'FOC-780',
  partial: [],
  unreadable: { transcripts: 0, telemetry: 0, workspaces: 0, state: 0 },
};

// GET /api/artifacts (FOC-779) — one row per state, shaped like the contract:
// { computedAt, head, artifacts: [{ id, title, output, exists, outputMtime,
// age, head, digest, manifest: { head, digest, generatedAt } | null, state,
// reason, refresh, committed }] }. `age` is milliseconds (now - output mtime).
const artifactsPayload = {
  computedAt: '2026-10-15T12:00:00.000Z',
  head: 'fd659fbc1234567890abcdef',
  artifacts: [
    {
      id: 'models-map',
      title: 'Models map',
      output: 'config/models.map',
      exists: true,
      outputMtime: '2026-10-15T11:59:00.000Z',
      age: 3_660_000, // 1h 01m
      head: 'fd659fbc1234567890abcdef',
      digest: 'a1b2c3d4e5f60718',
      manifest: {
        head: 'fd659fbc1234567890abcdef',
        digest: 'a1b2c3d4e5f60718',
        generatedAt: '2026-10-15T11:59:00.000Z',
      },
      state: 'fresh',
      reason: null,
      refresh: 'watch',
      committed: false,
    },
    {
      id: 'ui-dist',
      title: 'Dashboard UI',
      output: 'ui/dist',
      exists: true,
      outputMtime: '2026-10-10T08:00:00.000Z',
      age: 5 * 86_400_000 + 3 * 3_600_000, // 5d 03h
      head: 'fd659fbc1234567890abcdef',
      digest: '9f8e7d6c5b4a3210',
      manifest: {
        head: 'aa0000000000000000000000',
        digest: '9f8e7d6c5b4a3210',
        generatedAt: '2026-10-10T08:00:00.000Z',
      },
      state: 'stale',
      reason: 'sources changed after the last generation',
      refresh: 'watch',
      committed: false,
    },
    {
      id: 'atlas-mcp',
      title: 'Atlas MCP config',
      output: 'config/atlas-mcp.json',
      exists: false,
      outputMtime: null,
      age: null,
      head: null,
      digest: null,
      manifest: null,
      state: 'missing',
      reason: 'the output file does not exist yet',
      refresh: 'launcher',
      committed: false,
    },
    {
      id: 'diagrams-png',
      title: 'Diagram PNGs',
      output: 'docs/diagrams/*.png',
      exists: true,
      outputMtime: '2026-09-30T10:00:00.000Z',
      age: null,
      head: null,
      digest: null,
      manifest: null,
      state: 'external',
      reason: null,
      refresh: 'external',
      committed: true,
    },
  ],
};
// The FOC-780 GET adds the resolved policy and the dry-run prune estimate on
// top of the shape above.
const retentionPayloadApplied = {
  ...retentionPayload,
  resolved: { keepDays: 30, cleanupPeriodDays: 30, minFreeGiB: 5 },
  prunable: { runs: 3, bytes: 4_194_304 },
};

// --- keyRows -----------------------------------------------------------------

await test('keyRows: validated key reads "set · validated HH:MM" with tone ok', () => {
  const [row] = keyRows([keysPayload.keys[0]]);
  eq(row.name, 'openrouter_api_key');
  eq(row.label, 'OpenRouter');
  eq(row.required, true);
  eq(row.present, true);
  assert.match(row.state, /^set · validated \d{2}:\d{2}$/);
  eq(row.tone, 'ok');
});

await test('keyRows: failed check reads "set · last check failed: <reason>" with tone danger', () => {
  const row = keyRows([keysPayload.keys[1]])[0];
  eq(row.state, 'set · last check failed: 401 from Linear');
  eq(row.tone, 'danger');
});

await test('keyRows: set without a check reads "set" (tone muted)', () => {
  const row = keyRows([
    { name: 'k', label: 'K', required: false, present: true, envName: 'K', lastCheck: null },
  ])[0];
  eq(row.state, 'set');
  eq(row.tone, 'muted');
});

await test('keyRows: missing required vs optional', () => {
  eq(keyRows([keysPayload.keys[2]])[0].state, 'missing (required)');
  eq(keyRows([keysPayload.keys[2]])[0].tone, 'danger');
  eq(keyRows([keysPayload.keys[3]])[0].state, 'missing (optional)');
  eq(keyRows([keysPayload.keys[3]])[0].tone, 'muted');
});

await test('keyRows([]) and keyRows(null) are empty', () => {
  eq(keyRows([]), []);
  eq(keyRows(null), []);
});

// --- checkText / writableNote -------------------------------------------------

await test('checkText: ok / failed / nothing', () => {
  eq(checkText({ ok: true }), 'check ok');
  eq(checkText({ ok: false, reason: '401 from Linear' }), 'check failed: 401 from Linear');
  eq(checkText({ ok: false }), 'check failed: no reason given');
  eq(checkText(null), null);
  eq(checkText({}), null);
});

await test('writableNote: only when writable is false', () => {
  eq(
    writableNote(false),
    'Key rotation needs the secrets mount — run ./fenix keys <name>',
  );
  eq(writableNote(true), null);
  eq(writableNote(undefined), null);
});

// --- keyFormModel -------------------------------------------------------------

await test('keyFormModel: idle renders nothing, button enabled', () => {
  eq(keyFormModel({}), { disabled: false, disabledReason: null, resultText: null, resultTone: null });
});

await test('keyFormModel: sending disables with a written reason', () => {
  const m = keyFormModel({ sending: true });
  eq(m.disabled, true);
  eq(m.disabledReason, 'Saving…');
});

await test('keyFormModel: saved with a passing check', () => {
  const m = keyFormModel({ result: { name: 'linear_api_key', saved: true, check: { ok: true } } });
  eq(m.disabled, false);
  eq(m.resultText, 'saved — check ok');
  eq(m.resultTone, 'ok');
});

await test('keyFormModel: rejected with the server reason (400 key-rejected)', () => {
  const err = new Error('key-rejected');
  err.data = { error: 'key-rejected', check: { ok: false, reason: 'invalid key for OpenRouter' } };
  const m = keyFormModel({ error: err });
  eq(m.resultText, 'rejected — invalid key for OpenRouter');
  eq(m.resultTone, 'danger');
});

await test('keyFormModel: empty and not-writable errors are named honestly', () => {
  const empty = new Error('empty');
  empty.data = { error: 'empty' };
  eq(keyFormModel({ error: empty }).resultText, 'rejected — the key is empty');
  const s503 = new Error('secrets-not-writable');
  s503.data = { error: 'secrets-not-writable' };
  eq(
    keyFormModel({ error: s503 }).resultText,
    'secrets are not writable from the dashboard — run ./fenix keys <name>',
  );
});

// --- providerView ---------------------------------------------------------------

await test('providerView: active, source, options incl. custom endpoint', () => {
  const v = providerView(providerPayload);
  eq(v.active, 'openrouter');
  eq(v.sourceText, 'settings overlay');
  eq(v.options, [
    { name: 'openrouter', label: 'openrouter' },
    { name: 'custom', label: 'custom endpoint' },
  ]);
  eq(v.hasCustom, true);
  eq(v.noteText, 'effective for the next child; the Supervisor picks it up on its next fresh session');
});

await test('providerView: custom form starts from the stored overlay values', () => {
  eq(providerView(providerPayload).custom, {
    baseUrl: 'http://localhost:8000',
    authStyle: 'apikey',
    keyName: 'PROVIDER_API_KEY',
    defaultModel: 'xiaomi/mimo-v2.6-pro',
  });
});

await test('providerView: no custom in the overlay -> form starts from the defaults', () => {
  const v = providerView({ ...providerPayload, custom: null });
  eq(v.hasCustom, false);
  eq(v.custom, CUSTOM_DEFAULTS);
  eq(v.options, [{ name: 'openrouter', label: 'openrouter' }]);
});

await test('providerView: null payload still yields a usable form', () => {
  const v = providerView(null);
  eq(v.active, null);
  eq(v.sourceText, 'default');
  eq(v.custom, CUSTOM_DEFAULTS);
});

// --- providerDraft ------------------------------------------------------------

await test('providerDraft: built-in active with a stored custom block opens in built-in mode (UI regression)', () => {
  // The browser showed the old draft (custom mode = "a custom block exists")
  // opening checked after switching back from custom: the dropdown read
  // openrouter while the custom box was ticked and Save would flip back.
  // The fix mirrors the ACTIVE selection and only loads the stored config.
  const v = providerView(providerPayload);
  eq(providerDraft(v), {
    active: 'openrouter',
    showCustom: false,
    custom: {
      baseUrl: 'http://localhost:8000',
      authStyle: 'apikey',
      keyName: 'PROVIDER_API_KEY',
      defaultModel: 'xiaomi/mimo-v2.6-pro',
    },
  });
});

await test('providerDraft: an active custom endpoint opens in custom mode, prefilled', () => {
  const v = providerView({ ...providerPayload, active: 'custom' });
  eq(providerDraft(v).showCustom, true);
  eq(providerDraft(v).custom.baseUrl, 'http://localhost:8000');
});

await test('providerDraft: no stored custom -> built-in mode from the defaults', () => {
  const dr = providerDraft(providerView({ ...providerPayload, custom: null }));
  eq(dr.showCustom, false);
  eq(dr.custom, CUSTOM_DEFAULTS);
});

await test('providerDraft: a deliberate toggle to custom shows no initial validation errors', () => {
  // The stored config is valid, so deliberately re-checking the box must not
  // render errors on mount — validation only runs while the box is shown.
  const dr = providerDraft(providerView(providerPayload));
  eq(validateCustomProvider(dr.custom), []);
});

// --- validateCustomProvider (mirrors fenix-settings.mjs) ------------------------

await test('validateCustomProvider: a valid https endpoint passes', () => {
  eq(
    validateCustomProvider({
      baseUrl: 'https://api.example.com/v1',
      authStyle: 'token',
      keyName: 'PROVIDER_API_KEY',
      defaultModel: 'xiaomi/mimo-v2.6-pro',
    }),
    [],
  );
});

await test('validateCustomProvider: plain http only for local hosts', () => {
  eq(validateCustomProvider({ baseUrl: 'http://localhost:8000', authStyle: 'token', keyName: 'PROVIDER_API_KEY' }), []);
  eq(
    validateCustomProvider({ baseUrl: 'http://api.example.com', authStyle: 'token', keyName: 'PROVIDER_API_KEY' }),
    ['base URL: http is only allowed for 127.0.0.1, localhost or host.docker.internal'],
  );
  eq(
    validateCustomProvider({ baseUrl: 'ftp://x', authStyle: 'token', keyName: 'PROVIDER_API_KEY' }),
    ['base URL: must be an absolute http(s) URL'],
  );
  eq(
    validateCustomProvider({ authStyle: 'token', keyName: 'PROVIDER_API_KEY' }),
    ['base URL: must be an absolute http(s) URL'],
  );
});

await test('validateCustomProvider: authStyle and keyName rules', () => {
  eq(
    validateCustomProvider({ baseUrl: 'https://x.dev', authStyle: 'bearer', keyName: 'PROVIDER_API_KEY' }),
    ['auth style: must be "token" or "apikey"'],
  );
  eq(
    validateCustomProvider({ baseUrl: 'https://x.dev', authStyle: 'apikey', keyName: 'bad-name' }),
    ['key name: must match /^[A-Z][A-Z0-9_]{1,63}$/'],
  );
});

// --- priceText / routingRows ------------------------------------------------------

await test('priceText uses the workModel.formatMoney rule, "unpriced" when absent', () => {
  eq(priceText({ input: 3, output: 15 }), 'in $3.00 / out $15.00');
  eq(priceText({ input: 0.0000002, output: 0.0000011 }), 'in $0.00000020 / out $0.0000011');
  eq(priceText(null), 'unpriced');
  eq(priceText({}), 'unpriced');
});

await test('routingRows: source labels, unpriced stays labelled, benchmark rides along', () => {
  const rows = routingRows(routingPayload.rows);
  eq(rows[0], {
    squad: 'supervisor',
    lead: 'xiaomi/mimo-v2.6-pro',
    leadText: 'xiaomi/mimo-v2.6-pro',
    sourceText: 'provider default',
    price: 'in $3.00 / out $15.00',
    benchmark: null,
  });
  eq(rows[1].sourceText, 'set in Settings');
  eq(rows[1].benchmark, 42);
  eq(rows[2], {
    squad: 'DEV',
    lead: 'custom/local-70b',
    leadText: 'custom/local-70b',
    sourceText: 'unset',
    price: 'unpriced',
    benchmark: null,
  });
});

await test('routingRows: an unset lead reads "(unset)", never an empty cell', () => {
  const rows = routingRows([{ squad: 'TEST', lead: null, source: null, price: null }]);
  eq(rows[0].leadText, '(unset)');
});

await test('providerView: the source label accepts the server\'s "settings" and the env source', () => {
  eq(providerView(providerPayload).sourceText, 'settings overlay');
  eq(providerView({ source: 'env' }).sourceText, 'LA_PROVIDER env');
  eq(providerView({ source: 'default' }).sourceText, 'default (openrouter)');
});

await test('routingRows: the Supervisor chain sources are labelled honestly', () => {
  const rows = routingRows([
    { squad: 'supervisor', lead: 'env-model', source: 'env', price: null },
    { squad: 'supervisor', lead: 'xiaomi/mimo-v2.6-pro', source: 'fallback', price: null },
  ]);
  eq(rows[0].sourceText, 'SUPERVISOR_MODEL env');
  eq(rows[0].leadText, 'env-model');
  eq(rows[0].price, 'unpriced');
  eq(rows[1].sourceText, 'built-in fallback');
});

// --- repoRows -----------------------------------------------------------------

await test('repoRows: branch@head, dirty, index, extra worktrees, project', () => {
  eq(repoRows(reposPayload.repos)[0], {
    name: 'fenix',
    origin: 'git@github.com:joint-hubs/fenix.git',
    headLabel: 'main@fd659fb',
    dirty: true,
    dirtyText: 'dirty',
    indexText: 'index ready',
    worktrees: 2,
    worktreesText: '2 extra worktrees',
    project: 'Fenix',
    error: null,
  });
  eq(repoRows(reposPayload.repos)[1], {
    name: 'docs',
    origin: 'https://github.com/joint-hubs/docs.git',
    headLabel: 'develop',
    dirty: false,
    dirtyText: 'clean',
    indexText: 'index missing',
    worktrees: 0,
    worktreesText: 'no extra worktrees',
    project: null,
    error: null,
  });
});

await test('repoRows: a server-side read error keeps its error text, no invented facts', () => {
  const row = repoRows([{ name: 'broken', error: 'git not a repository' }])[0];
  eq(row.headLabel, null);
  eq(row.error, 'git not a repository');
});

// --- jobProgressText / jobActive ----------------------------------------------

await test('jobProgressText: cloning shows the progress tail', () => {
  eq(
    jobProgressText({ id: 'j1', name: 'fenix', status: 'cloning', progress: 'Receiving objects:  45% (90/200)' }),
    'cloning fenix… Receiving objects:  45% (90/200)',
  );
  eq(jobProgressText({ id: 'j1', name: 'fenix', status: 'cloning', progress: '' }), 'cloning fenix…');
});

await test('jobProgressText: done / error / none', () => {
  eq(jobProgressText({ name: 'fenix', status: 'done', error: null }), 'cloned fenix');
  eq(
    jobProgressText({ name: 'fenix', status: 'error', error: 'Authentication failed' }),
    'clone failed: Authentication failed',
  );
  eq(jobProgressText(null), null);
});

await test('jobActive: true only while cloning', () => {
  eq(jobActive({ status: 'cloning' }), true);
  eq(jobActive({ status: 'done' }), false);
  eq(jobActive(null), false);
});

// --- retentionView ------------------------------------------------------------

await test('retentionView: policy texts (keep-all / days / mixed / unknown)', () => {
  eq(retentionView({ policy: 'keep-all' }).policyText, 'keep everything (default)');
  eq(retentionView(retentionPayload).policyText, '30 days');
  eq(retentionView({ policy: 'mixed', cleanupPeriodDays: { a: 7, b: 30 } }).policyText, 'mixed per squad');
  eq(retentionView({}).policyText, 'unknown');
});

await test('retentionView: usage rows humanised, free disk, save note', () => {
  const v = retentionView(retentionPayload);
  eq(v.usageRows, [
    { label: 'Transcripts', text: '2.3 GB' },
    { label: 'Telemetry', text: '175.5 MB' },
    { label: 'Workspaces', text: '512 B' },
    { label: 'Run state', text: '0 B' },
  ]);
  eq(v.freeDiskText, 'free disk: 109.9 GB');
  eq(v.note, 'a saved limit applies to the squads at once; nothing is deleted until the CLI prune runs');
  eq(v.partialText, null);
});

await test('retentionView: partial walk carries its warning; missing disk reads unknown', () => {
  const v = retentionView({ policy: 'keep-all', usage: {}, partial: ['transcripts'] });
  eq(v.partialText, 'counts are partial: transcripts');
  eq(v.freeDiskText, 'free disk: unknown');
});

// --- retentionView: resolved / prunable / applied ------------------------------

await test('retentionView: resolved policy, applied line, prunable estimate', () => {
  const v = retentionView(retentionPayloadApplied);
  eq(v.resolved, { keepAll: false, keepDays: 30, minFreeGiB: 5 });
  eq(v.appliedText, 'Claude Code cleanupPeriodDays: 30, applied to 2 squads');
  eq(v.prunable, { runs: 3, bytes: 4_194_304, bytesText: '4.0 MB', refused: null });
});

await test('retentionView: keep-all resolves keepAll true, refused prune carried', () => {
  const v = retentionView({
    policy: 'keep-all',
    cleanupPeriodDays: { fenix: 36500 },
    resolved: { keepDays: null, cleanupPeriodDays: 36500, minFreeGiB: 5 },
    prunable: { runs: 0, bytes: 0, refused: 'nothing to prune: retention keeps everything' },
  });
  eq(v.resolved, { keepAll: true, keepDays: null, minFreeGiB: 5 });
  eq(v.appliedText, 'Claude Code cleanupPeriodDays: 36500, applied to 1 squad');
  eq(v.prunable.runs, 0);
  eq(v.prunable.bytesText, '0 B');
  eq(v.prunable.refused, 'nothing to prune: retention keeps everything');
});

await test('retentionView: an older server without resolved/prunable defaults to keep-all, no estimate', () => {
  const v = retentionView(retentionPayload);
  eq(v.resolved, { keepAll: true, keepDays: null, minFreeGiB: null });
  eq(v.prunable, null);
  eq(v.appliedText, null);
});

// --- retentionFormState ---------------------------------------------------------

await test('retentionFormState: the resolved policy seeds the form, absent fields stay empty', () => {
  eq(retentionFormState(retentionView(retentionPayloadApplied)), {
    keepAll: false,
    keepDays: '30',
    minFreeGiB: '5',
  });
  eq(retentionFormState(retentionView(retentionPayload)), {
    keepAll: true,
    keepDays: '',
    minFreeGiB: '',
  });
  eq(retentionFormState(null), { keepAll: true, keepDays: '', minFreeGiB: '' });
});

// --- validateRetentionForm ------------------------------------------------------

await test('validateRetentionForm: valid keep-all ignores a stale days value', () => {
  eq(validateRetentionForm({ keepAll: true, keepDays: '7', minFreeGiB: '5' }), {
    ok: true,
    errors: [],
    payload: { keepDays: null, minFreeGiB: 5 },
  });
});

await test('validateRetentionForm: valid days and threshold', () => {
  eq(validateRetentionForm({ keepAll: false, keepDays: '30', minFreeGiB: '2.5' }), {
    ok: true,
    errors: [],
    payload: { keepDays: 30, minFreeGiB: 2.5 },
  });
  eq(validateRetentionForm({ keepAll: false, keepDays: 36500, minFreeGiB: 0.5 }).ok, true);
});

await test('validateRetentionForm: days out of range, non-integer, empty', () => {
  const msg = 'keep days: a whole number between 1 and 36500';
  eq(validateRetentionForm({ keepAll: false, keepDays: '0', minFreeGiB: '5' }).errors, [msg]);
  eq(validateRetentionForm({ keepAll: false, keepDays: '36501', minFreeGiB: '5' }).errors, [msg]);
  eq(validateRetentionForm({ keepAll: false, keepDays: '7.5', minFreeGiB: '5' }).errors, [msg]);
  eq(
    validateRetentionForm({ keepAll: false, keepDays: '', minFreeGiB: '5' }).errors,
    ['keep days: enter a whole number between 1 and 36500'],
  );
});

await test('validateRetentionForm: minFreeGiB too small or missing', () => {
  const small = validateRetentionForm({ keepAll: true, keepDays: '', minFreeGiB: '0.2' });
  eq(small.ok, false);
  eq(small.errors, ['warn below: at least 0.5 GiB']);
  const missing = validateRetentionForm({ keepAll: false, keepDays: '30', minFreeGiB: '' });
  eq(missing.ok, false);
  eq(missing.errors, ['warn below: enter the GiB threshold (0.5 or more)']);
});

await test('humanBytes: the band of shapes', () => {
  eq(humanBytes(0), '0 B');
  eq(humanBytes(512), '512 B');
  eq(humanBytes(1024), '1.0 KB');
  eq(humanBytes(184_000_000), '175.5 MB');
  eq(humanBytes(2_513_573_913), '2.3 GB');
  eq(humanBytes(null), '—');
  eq(humanBytes(-4), '—');
});

// --- Agent tools (FOC-906) ---------------------------------------------------

// Shaped like GET /api/settings/agent-tools: showAgent rows + check findings.
const agentToolsPayload = {
  root: '/repo/agents',
  agents: [
    {
      agent: 'supervisor',
      settingsPath: '/repo/agents/supervisor/settings.json',
      permissions: { allow: ['Bash(git *)', 'Read'], ask: ['Bash(git push *)'], deny: ['Danger'] },
      additionalDirectories: ['/repo/docs'],
      defaultMode: 'acceptEdits',
      hooks: { SessionStart: 2, Stop: 1 },
      mcp: [
        { server: 'atlas', reachable: true, via: '.mcp.json' },
        { server: 'stub', reachable: false, via: null, deniedBy: 'deny rule' },
      ],
      skills: [{ name: 'dev', source: 'repo' }],
    },
    {
      agent: 'flash',
      settingsPath: '/repo/agents/flash/settings.json',
      permissions: { allow: ['Read'], ask: [], deny: [] },
      hooks: {},
      mcp: [],
      skills: [],
    },
    { agent: 'broken', error: 'settings.json: invalid JSON' },
  ],
  check: {
    summary: { errors: 1, warnings: 0, infos: 2 },
    findings: [
      { level: 'info', agent: 'supervisor', list: 'allow', rule: 'Read', message: 'overlapping' },
      { level: 'error', agent: 'supervisor', list: 'deny', rule: 'Danger', message: 'too broad' },
      { level: 'warning', agent: 'flash', list: 'allow', rule: 'Read', message: 'unused' },
      { level: 'info', agent: 'supervisor', list: 'ask', rule: 'Bash(git push *)', message: 'ask covers it' },
    ],
  },
};

await test('agentToolsView: counts, lists, mcp/skills/hooks per agent', () => {
  const v = agentToolsView(agentToolsPayload);
  eq(v.root, '/repo/agents');
  eq(v.summaryText, '1 error, 0 warnings, 2 infos');
  eq(v.agents.length, 3);
  const sup = v.agents[0];
  eq(sup.agent, 'supervisor');
  eq(sup.counts, { allow: 2, ask: 1, deny: 1 });
  eq(sup.lists.deny, ['Danger']);
  eq(sup.defaultMode, 'acceptEdits');
  eq(sup.additionalDirectories, ['/repo/docs']);
  eq(sup.hooks, [
    { event: 'SessionStart', count: 2 },
    { event: 'Stop', count: 1 },
  ]);
  eq(sup.mcp, agentToolsPayload.agents[0].mcp);
  eq(sup.skills, [{ name: 'dev', source: 'repo' }]);
  eq(sup.error, null);
  const flash = v.agents[1];
  eq(flash.counts, { allow: 1, ask: 0, deny: 0 });
  eq(flash.hooks, []);
});

await test('agentToolsView: findings grouped per agent, levels ordered error > warning > info', () => {
  const v = agentToolsView(agentToolsPayload);
  eq(
    v.agents[0].findings.map((f) => f.level),
    ['error', 'info', 'info'],
  );
  eq(v.agents[0].findings[0], {
    level: 'error',
    list: 'deny',
    rule: 'Danger',
    message: 'too broad',
  });
  eq(
    v.agents[1].findings.map((f) => f.level),
    ['warning'],
  );
  eq(v.agents[2].findings, []); // the broken agent has no findings of its own
});

await test('agentToolsView: an unreadable agent file stays an error row', () => {
  const v = agentToolsView(agentToolsPayload);
  const broken = v.agents[2];
  eq(broken.agent, 'broken');
  eq(broken.error, 'settings.json: invalid JSON');
  eq(broken.counts, { allow: 0, ask: 0, deny: 0 });
  eq(broken.lists, { allow: [], ask: [], deny: [] });
  eq(broken.mcp, []);
  eq(broken.skills, []);
});

await test('agentToolsView: a null / empty payload yields empty everything', () => {
  for (const payload of [null, {}, { agents: null, check: null }]) {
    const v = agentToolsView(payload);
    eq(v.root, null);
    eq(v.summaryText, null);
    eq(v.agents, []);
  }
  // A check with a bare-string summary is tolerated (shown verbatim); a
  // summary of any other shape reads as unknown.
  const v = agentToolsView({ root: '/x', agents: [], check: { summary: 'weird' } });
  eq(v.summaryText, 'weird');
  eq(v.root, '/x');
  eq(agentToolsView({ root: '/x', agents: [], check: { summary: { errors: 'x' } } }).summaryText, null);
});

await test('agentToolsView: a malformed agent row and unknown finding level do not throw', () => {
  const v = agentToolsView({
    agents: [null, 'junk', { agent: 'a', permissions: { allow: 'not-an-array' } }],
    check: { summary: { errors: 0, warnings: 0, infos: 1 }, findings: [{ level: 'odd', agent: 'a' }] },
  });
  eq(v.agents[0], { agent: '(unknown)', error: 'malformed row' });
  eq(v.agents[2].counts, { allow: 0, ask: 0, deny: 0 }); // not-an-array -> 0
  eq(v.agents[2].findings, [{ level: 'odd', list: undefined, rule: undefined, message: undefined }]);
});

await test('findingCounts: tallies per level, zeros kept, non-array reads as none', () => {
  eq(
    findingCounts([
      { level: 'info', agent: 'a' },
      { level: 'info', agent: 'a' },
      { level: 'warning', agent: 'a' },
      { level: 'error', agent: 'a' },
    ]),
    { error: 1, warning: 1, info: 2 },
  );
  eq(findingCounts([]), { error: 0, warning: 0, info: 0 });
  eq(findingCounts(null), { error: 0, warning: 0, info: 0 });
});

await test('findingCounts: unknown or missing levels are ignored', () => {
  eq(
    findingCounts([{ level: 'odd', agent: 'a' }, { level: 'info' }, {}, 'junk', null]),
    { error: 0, warning: 0, info: 1 },
  );
});
// --- artifactsView (FOC-779) ---------------------------------------------------

await test('artifactsView: one row per state — labels, tones, refresh texts', () => {
  const rows = artifactsView(artifactsPayload).rows;
  eq(rows[0].id, 'models-map');
  eq(rows[0].stateLabel, 'fresh');
  eq(rows[0].tone, 'ok');
  eq(rows[0].refreshText, 'watched, 60 s');
  eq(rows[1].stateLabel, 'stale');
  eq(rows[1].tone, 'warn');
  eq(rows[1].refreshText, 'watched, 60 s');
  eq(rows[2].stateLabel, 'missing');
  eq(rows[2].tone, 'danger');
  eq(rows[2].refreshText, 'launcher');
  eq(rows[3].stateLabel, 'external');
  eq(rows[3].tone, 'muted');
  eq(rows[3].refreshText, 'external');
});

await test('artifactsView: revision text is head short · digest8, "—" without a head', () => {
  const rows = artifactsView(artifactsPayload).rows;
  eq(rows[0].revisionText, 'fd659fb · a1b2c3d4');
  eq(rows[1].revisionText, 'fd659fb · 9f8e7d6c');
  eq(rows[2].revisionText, '—');
  eq(rows[3].revisionText, '—');
});

await test('artifactsView: age text follows the cockpit formatAge rendering, "—" without an age', () => {
  const rows = artifactsView(artifactsPayload).rows;
  eq(rows[0].ageText, '1h 01m');
  eq(rows[1].ageText, '5d 03h');
  eq(rows[2].ageText, '—');
  eq(rows[3].ageText, '—');
});

await test('artifactsView: generatedAt passes the manifest timestamp through, null without one', () => {
  const rows = artifactsView(artifactsPayload).rows;
  eq(rows[0].generatedAtText, '2026-10-15T11:59:00.000Z');
  eq(rows[1].generatedAtText, '2026-10-10T08:00:00.000Z');
  eq(rows[2].generatedAtText, null);
  eq(rows[3].generatedAtText, null);
});

await test('artifactsView: reason rides along, output and title carried, footnote fields set', () => {
  const v = artifactsView(artifactsPayload);
  eq(v.computedAtText, '2026-10-15T12:00:00.000Z');
  eq(v.headShort, 'fd659fb');
  eq(v.rows[0].output, 'config/models.map');
  eq(v.rows[0].title, 'Models map');
  eq(v.rows[1].reason, 'sources changed after the last generation');
  eq(v.rows[3].reason, null);
  assert.ok(v.note.includes('regenerated on `fenix up`'));
  assert.ok(v.note.includes('within 60 s'));
  assert.ok(v.note.includes('external entries are reported only'));
});

await test('artifactsView: empty payload still yields a usable view', () => {
  const v = artifactsView({});
  eq(v.rows, []);
  eq(v.headShort, null);
  eq(v.computedAtText, null);
  assert.ok(typeof v.note === 'string' && v.note.length > 0);
});

await test('artifactsView: malformed payloads never throw, rows stay empty', () => {
  eq(artifactsView(null).rows, []);
  eq(artifactsView(undefined).rows, []);
  eq(artifactsView('garbage').rows, []);
  eq(artifactsView({ artifacts: 'not-a-list' }).rows, []);
  // A null member in the list becomes an empty-ish row, not a crash.
  eq(artifactRow(null).stateLabel, 'unknown');
  eq(artifactRow(null).tone, 'muted');
});

await test('artifactRow: an unknown state word shows as-is, muted — never dressed as fresh', () => {
  const row = artifactRow({ id: 'x', title: 'X', state: 'weird', refresh: 'watch' });
  eq(row.stateLabel, 'weird');
  eq(row.tone, 'muted');
});

// --- Leak guard: a canary value passed in by mistake never surfaces ----------

await test('no model output contains a canary value passed in by mistake', () => {
  const poisoned = [
    keyRows([
      {
        name: 'openrouter_api_key',
        label: 'OpenRouter',
        present: true,
        required: true,
        envName: 'OPENROUTER_API_KEY',
        value: CANARY, // a caller's mistake — the payload never carries this
        lastCheck: { at: '2026-10-13T10:02:00.000Z', ok: true, reason: null, key: CANARY },
      },
    ]),
    keyFormModel({
      result: { name: 'k', saved: true, check: { ok: true, details: { key: CANARY } } },
    }),
    keyFormModel({
      error: Object.assign(new Error('key-rejected'), {
        data: { error: 'key-rejected', check: { ok: false, reason: 'bad', details: { key: CANARY } } },
      }),
    }),
    providerView({ ...providerPayload, secret: CANARY }),
    validateCustomProvider({ ...CUSTOM_DEFAULTS, key: CANARY }),
    routingRows([{ squad: 'DEV', lead: 'm', source: null, price: null, key: CANARY }]),
    repoRows([{ name: 'fenix', branch: 'main', head: 'fd659fb', value: CANARY }]),
    jobProgressText({ name: 'fenix', status: 'cloning', progress: '40%', value: CANARY }),
    retentionView({ ...retentionPayload, value: CANARY }),
    agentToolsView({ ...agentToolsPayload, value: CANARY }),
    artifactsView({
      ...artifactsPayload,
      artifacts: [
        // The registry rows carry no key-like values — a caller's mistake here
        // must not surface either. (generatedAt/computedAt are designed
        // pass-through timestamps, like retention's — canaries go into
        // fields the model is not supposed to read.)
        { ...artifactsPayload.artifacts[0], value: CANARY },
        { ...artifactsPayload.artifacts[0], manifest: { digest: CANARY, generatedAt: null } },
      ],
    }),
    retentionFormState({ resolved: { keepAll: true, keepDays: CANARY, minFreeGiB: CANARY } }),
    validateRetentionForm({ keepAll: false, keepDays: CANARY, minFreeGiB: CANARY }),
    checkText({ ok: false, reason: 'failed', details: { key: CANARY } }),
  ];
  const dumped = JSON.stringify(poisoned);
  assert.ok(!dumped.includes(CANARY), `model output leaked a canary value: ${dumped.slice(0, 200)}`);
});

// --- Summary ----------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Settings pure helpers (FOC-786, dashboard-v2-spec §4.6). No React, no fetch,
// no env access — everything takes what it needs as arguments so the plain-node
// tests (_tests_settings.mjs) can pin the behavior outside Vite. Fixtures are
// shaped exactly like the plan's Settings API contracts. Two rules ride above
// everything else: a key VALUE never appears in any model output (the payload
// carries none, and the model only reads known state fields — the canary test
// pins this), and every state is words, not styling (spec §7: colour is never
// the only signal).

import { formatMoney } from './workModel.js';
import { formatAge } from './cockpitModel.js';

// ===== Keys ==================================================================

// checkedAt(iso) -> local "10:02", or null when the timestamp is missing or
// unparseable. The clock text is all the row shows of a check — never a value.
function checkedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// keyRow(key) -> one key row's view model. The state text carries the whole
// signal: "set · validated 10:02" / "set · last check failed: <reason>" / "set"
// / "missing (required)" / "missing (optional)" — never any part of a value.
// tone is a word (ok / danger / muted) the screen renders with the text.
export function keyRow(key) {
  const k = key || {};
  const present = k.present === true;
  const check = k.lastCheck || null;
  let state;
  let tone;
  if (present) {
    if (check && check.ok === true) {
      const at = checkedAt(check.at);
      state = at ? 'set · validated ' + at : 'set · validated';
      tone = 'ok';
    } else if (check && check.ok === false) {
      state = 'set · last check failed: ' + (check.reason || 'no reason given');
      tone = 'danger';
    } else {
      state = 'set';
      tone = 'muted';
    }
  } else {
    state = k.required === true ? 'missing (required)' : 'missing (optional)';
    tone = k.required === true ? 'danger' : 'muted';
  }
  return {
    name: k.name || null,
    label: k.label || k.name || 'key',
    required: k.required === true,
    present,
    state,
    tone,
  };
}

export function keyRows(keys) {
  return (Array.isArray(keys) ? keys : []).map(keyRow);
}

// checkText(check) -> the honest one-liner for a live check result
// { ok, reason, details }: "check ok" / "check failed: <reason>". No result
// (or no verdict in it) -> null — nothing to show.
export function checkText(check) {
  if (!check || typeof check !== 'object') return null;
  if (check.ok === true) return 'check ok';
  if (check.ok === false) return 'check failed: ' + (check.reason || 'no reason given');
  return null;
}

// writableNote(writable) -> the banner text when rotation is not available
// (GET /api/settings/keys returned writable: false); null when it is.
export function writableNote(writable) {
  return writable === false
    ? 'Key rotation needs the secrets mount — run ./fenix keys <name>'
    : null;
}

// keyFormModel({ sending, result, error }) -> the Rotate form's view model.
// result is the PUT 200 payload { name, saved, check }; error is the thrown
// Error carrying .data (400 key-rejected { check } | 400 empty | 503
// secrets-not-writable). resultText is honest about what happened: saved,
// rejected with the server's reason, or the error text itself. What was typed
// is NEVER part of the model — the screen clears the input before it is read.
export function keyFormModel({ sending, result, error } = {}) {
  const disabled = !!sending;
  const disabledReason = sending ? 'Saving…' : null;
  let resultText = null;
  let resultTone = null;
  if (error) {
    resultTone = 'danger';
    const data = error.data || {};
    const check = data.check || null;
    if (data.error === 'key-rejected') {
      resultText = 'rejected — ' + ((check && check.reason) || 'no reason given');
    } else if (data.error === 'empty') {
      resultText = 'rejected — the key is empty';
    } else if (data.error === 'secrets-not-writable') {
      resultText = 'secrets are not writable from the dashboard — run ./fenix keys <name>';
    } else {
      resultText = data.error || error.message || 'saving failed';
    }
  } else if (result && result.saved) {
    resultTone = 'ok';
    const text = checkText(result.check);
    resultText = text ? 'saved — ' + text : 'saved';
  }
  return { disabled, disabledReason, resultText, resultTone };
}

// ===== Provider ==============================================================

// The custom form's starting values when the overlay carries none yet.
export const CUSTOM_DEFAULTS = {
  baseUrl: 'http://localhost:8000',
  authStyle: 'token',
  keyName: 'PROVIDER_API_KEY',
  defaultModel: '',
};

// providerSourceLabel(source) -> where the active provider decision came from
// (the resolution order: LA_PROVIDER env > settings overlay > default; the
// server reports the overlay decision as "settings").
export function providerSourceLabel(source) {
  const labels = {
    env: 'LA_PROVIDER env',
    settings: 'settings overlay',
    overlay: 'settings overlay',
    default: 'default (openrouter)',
  };
  return labels[source] || source || 'default';
}

// providerView(payload) -> the provider section's view model: the active
// provider and where its decision came from, the select options (the payload's
// provider list + "custom endpoint" when the overlay carries one), the custom
// form's starting values (the stored overlay values, else CUSTOM_DEFAULTS),
// and the effectiveness note. No live test runs here — the screen drives it.
export function providerView(payload) {
  const p = payload || {};
  const options = (Array.isArray(p.providers) ? p.providers : [])
    .filter((pr) => pr && pr.name)
    .map((pr) => ({ name: pr.name, label: pr.builtin === false ? pr.name + ' (custom)' : pr.name }));
  if (p.custom) options.push({ name: 'custom', label: 'custom endpoint' });
  const c = p.custom || null;
  return {
    active: p.active || null,
    sourceText: providerSourceLabel(p.source),
    options,
    hasCustom: !!c,
    custom: c
      ? {
          baseUrl: c.baseUrl || CUSTOM_DEFAULTS.baseUrl,
          authStyle: c.authStyle || CUSTOM_DEFAULTS.authStyle,
          keyName: c.keyName || CUSTOM_DEFAULTS.keyName,
          defaultModel: c.defaultModel || '',
        }
      : { ...CUSTOM_DEFAULTS },
    noteText:
      'effective for the next child; the Supervisor picks it up on its next fresh session',
  };
}

// providerDraft(view) -> the panel's draft state for a providerView result:
// { active, showCustom, custom }. showCustom mirrors the ACTIVE selection
// ("custom" only when the active provider IS the custom endpoint), not the
// mere presence of a stored custom block — a built-in active with a saved
// custom config must open in built-in mode and Save must not silently switch
// it back. custom always carries the stored config's starting values (else
// CUSTOM_DEFAULTS), kept regardless of the mode so a later deliberate switch
// to custom picks up where the overlay left off.
export function providerDraft(view) {
  const v = view || {};
  return {
    active: v.active || null,
    showCustom: v.active === 'custom',
    custom: v.custom || { ...CUSTOM_DEFAULTS },
  };
}

// validateCustomProvider(custom) -> ["field: why"] mirroring the server's
// schema (fenix-settings.mjs) so the form says the same thing the API would:
// absolute http(s) URL, plain http only for local hosts, authStyle
// "token"|"apikey", keyName /^[A-Z][A-Z0-9_]{1,63}$/, defaultModel a short
// non-empty string when given. An empty check means the form may be sent.
export function validateCustomProvider(custom) {
  const errors = [];
  const c = custom || {};
  let url = null;
  try {
    url = new URL(c.baseUrl || '');
  } catch {
    /* stays null */
  }
  if (!url || !/^https?:$/.test(url.protocol)) {
    errors.push('base URL: must be an absolute http(s) URL');
  } else if (
    url.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(url.hostname)
  ) {
    errors.push('base URL: http is only allowed for 127.0.0.1, localhost or host.docker.internal');
  }
  if (c.authStyle !== 'token' && c.authStyle !== 'apikey') {
    errors.push('auth style: must be "token" or "apikey"');
  }
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(c.keyName || '')) {
    errors.push('key name: must match /^[A-Z][A-Z0-9_]{1,63}$/');
  }
  if (c.defaultModel != null && typeof c.defaultModel !== 'string') {
    errors.push('default model: must be a string');
  } else if (typeof c.defaultModel === 'string' && c.defaultModel.length > 200) {
    errors.push('default model: at most 200 characters');
  }
  return errors;
}

// ===== Routing ===============================================================

const SOURCE_LABELS = {
  settings: 'set in Settings',
  'models.json': 'models.json',
  'provider-default': 'provider default',
  env: 'SUPERVISOR_MODEL env',
  fallback: 'built-in fallback',
};

// priceText(price) -> "in $3.00 / out $15.00" in formatMoney's rule (the same
// money text as the Work board and the CLI), or "unpriced" when the row
// carries no price. Unpriced stays allowed — labelled, never blocked.
export function priceText(price) {
  const p = price || null;
  if (!p || typeof p.input !== 'number' || typeof p.output !== 'number') return 'unpriced';
  return 'in ' + formatMoney(p.input) + ' / out ' + formatMoney(p.output);
}

// routingRow(row) -> one routing table row: the squad, its current lead, where
// that decision came from, the price and the benchmark. An unset lead reads
// "(unset)" rather than an empty cell.
export function routingRow(row) {
  const r = row || {};
  return {
    squad: r.squad || '',
    lead: r.lead || null,
    leadText: r.lead || '(unset)',
    sourceText: SOURCE_LABELS[r.source] || 'unset',
    price: priceText(r.price),
    benchmark: r.benchmark || null,
  };
}

export function routingRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(routingRow);
}

// ===== Repositories ==========================================================

// repoRow(repo) -> one repository row: branch@head, dirty/clean, index
// ready/missing, extra worktrees, mapped Linear project. A row the server
// could not read keeps its error text instead of invented facts.
export function repoRow(repo) {
  const r = repo || {};
  const headLabel = r.branch
    ? r.head
      ? r.branch + '@' + r.head
      : r.branch
    : null;
  return {
    name: r.name || null,
    origin: r.origin || null,
    headLabel: r.error ? null : headLabel || '—',
    dirty: r.dirty === true,
    dirtyText: r.dirty === true ? 'dirty' : 'clean',
    indexText: r.index === 'ready' ? 'index ready' : 'index missing',
    worktrees: typeof r.worktrees === 'number' ? r.worktrees : null,
    worktreesText:
      typeof r.worktrees === 'number' && r.worktrees > 0
        ? r.worktrees === 1
          ? '1 extra worktree'
          : r.worktrees + ' extra worktrees'
        : 'no extra worktrees',
    project: r.project || null,
    error: r.error || null,
  };
}

export function repoRows(repos) {
  return (Array.isArray(repos) ? repos : []).map(repoRow);
}

// jobProgressText(job) -> the clone job's one line: what it is doing while
// cloning (the tail of git's --progress output), how it ended otherwise.
// null when there is no job.
export function jobProgressText(job) {
  if (!job || typeof job !== 'object') return null;
  if (job.status === 'cloning') {
    const raw = typeof job.progress === 'string' ? job.progress.trim() : '';
    const tail = raw ? raw.split('\n').pop().trim() : '';
    return 'cloning ' + (job.name || '') + '…' + (tail ? ' ' + tail : '');
  }
  if (job.status === 'done') {
    return 'cloned ' + (job.name || '') + (job.error ? ' — ' + job.error : '');
  }
  if (job.status === 'error') {
    return 'clone failed: ' + (job.error || 'no reason given');
  }
  return job.status || null;
}

// jobActive(job) -> true while the job still runs (the screen keeps its 1 s
// poll); false once it ended or when there is nothing to poll.
export function jobActive(job) {
  return !!job && job.status === 'cloning';
}

// ===== Retention =============================================================

// humanBytes(n) -> "854 B" / "1.4 KB" / "12.3 MB" / "5.6 GB". 1024-based, one
// decimal dropped when it is .0; anything that is not a usable number -> "—".
export function humanBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const text = u === 0 ? String(Math.round(v)) : v.toFixed(1);
  return text + ' ' + units[u];
}

const POLICY_LABELS = {
  'keep-all': 'keep everything (default)',
  mixed: 'mixed per squad',
  unknown: 'unknown',
};

// retentionView(payload) -> the retention panel's view model: the policy in
// force ("keep everything (default)" / "N days" / "mixed per squad"), the
// usage rows humanised, free disk, the resolved policy (FOC-780: keep-all
// boolean + keepDays + minFreeGiB — absent on an older server -> keep-all),
// the dry-run prune estimate (runs + humanised bytes + the server's refusal
// note, null when the response carries none), the applied-policy line
// (cleanupPeriodDays value + the squads it was written to) and the
// partial-counts warning when the walk hit its entry budget.
export function retentionView(payload) {
  const r = payload || {};
  let policyText = POLICY_LABELS[r.policy] || r.policy || 'unknown';
  if (r.policy === 'days') {
    const days = Object.values(r.cleanupPeriodDays || {}).find(
      (v) => typeof v === 'number' && Number.isFinite(v),
    );
    policyText = typeof days === 'number' ? days + ' days' : 'limited days';
  }
  const u = r.usage || {};
  const usageRows = [
    { label: 'Transcripts', text: humanBytes(u.transcriptsBytes) },
    { label: 'Telemetry', text: humanBytes(u.telemetryBytes) },
    { label: 'Workspaces', text: humanBytes(u.workspacesBytes) },
    { label: 'Run state', text: humanBytes(u.stateBytes) },
  ];
  const disk = r.disk || null;
  const partial = Array.isArray(r.partial) ? r.partial : [];

  // resolved — only the FOC-780 GET carries it; without it the form opens on
  // the default (keep everything) instead of guessing a limit.
  const res = r.resolved && typeof r.resolved === 'object' ? r.resolved : {};
  const keepDays =
    typeof res.keepDays === 'number' && Number.isFinite(res.keepDays) ? res.keepDays : null;
  const resolved = {
    keepAll: keepDays === null,
    keepDays,
    minFreeGiB:
      typeof res.minFreeGiB === 'number' && Number.isFinite(res.minFreeGiB) ? res.minFreeGiB : null,
  };

  // Applied policy — the cleanupPeriodDays value the server wrote into every
  // squad file; the squad count comes from the GET's own per-squad map.
  const appliedDays =
    typeof res.cleanupPeriodDays === 'number' && Number.isFinite(res.cleanupPeriodDays)
      ? res.cleanupPeriodDays
      : null;
  const squads =
    r.cleanupPeriodDays && typeof r.cleanupPeriodDays === 'object'
      ? Object.keys(r.cleanupPeriodDays).length
      : 0;
  const appliedText =
    appliedDays !== null
      ? 'Claude Code cleanupPeriodDays: ' +
        appliedDays +
        (squads > 0 ? ', applied to ' + squads + (squads === 1 ? ' squad' : ' squads') : '')
      : null;

  // prunable — the dry-run prune totals behind the CLI hint; refused is the
  // server's reason (keepDays null → nothing to prune).
  let prunable = null;
  const p = r.prunable;
  if (p && typeof p === 'object') {
    const bytes = typeof p.bytes === 'number' && Number.isFinite(p.bytes) ? p.bytes : -1;
    prunable = {
      runs: typeof p.runs === 'number' && Number.isFinite(p.runs) ? p.runs : 0,
      bytes: bytes >= 0 ? bytes : 0,
      bytesText: humanBytes(bytes),
      refused: typeof p.refused === 'string' ? p.refused : null,
    };
  }

  return {
    policyText,
    usageRows,
    freeDiskText:
      disk && typeof disk.freeBytes === 'number'
        ? 'free disk: ' + humanBytes(disk.freeBytes)
        : 'free disk: unknown',
    resolved,
    prunable,
    appliedText,
    note: 'a saved limit applies to the squads at once; nothing is deleted until the CLI prune runs',
    partialText: partial.length ? 'counts are partial: ' + partial.join(', ') : null,
    computedAt: r.computedAt || null,
  };
}

// ===== Agent tools (FOC-906) =================================================

// Findings sort error > warning > info; an unknown level ranks last.
const AGENT_LEVEL_RANK = { error: 0, warning: 1, info: 2 };

function agentLevelRank(level) {
  return AGENT_LEVEL_RANK[level] ?? AGENT_LEVEL_RANK.info + 1;
}

// findingCounts(findings) -> { error, warning, info } tallies for one agent's
// findings (the card header shows one chip per level with a count instead of a
// chip per finding). A finding whose level is unknown or missing counts
// nowhere — inventing a bucket would make the header disagree with the
// findings list, which labels such a level with the info colours but its own
// text. A non-array reads as no findings, never a throw.
export function findingCounts(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of Array.isArray(findings) ? findings : []) {
    if (f && typeof f === 'object' && f.level in counts) counts[f.level] += 1;
  }
  return counts;
}

// summaryText(summary) -> "2 errors, 1 warning, 3 infos" / a verbatim string /
// null. Tolerant: the server's summary is { errors, warnings, infos } numbers,
// but a malformed payload must not break the panel.
export function agentToolsSummaryText(summary) {
  if (summary && typeof summary === 'string') return summary;
  if (summary && typeof summary === 'object') {
    const { errors, warnings, infos } = summary;
    if ([errors, warnings, infos].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      return `${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${plural(infos, 'info')}`;
    }
  }
  return null;
}

// agentToolsView(payload) -> the read-only Agent tools panel's view model:
// root path, check summary text, and one row per agent — permission counts and
// lists, findings grouped by agent (levels sorted error > warning > info),
// MCP servers, skills, hooks. A row whose file could not be read keeps
// `{ agent, error }` from the payload; a null/empty payload yields empty
// everything, never a throw.
export function agentToolsView(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const byAgent = new Map();
  const findings = Array.isArray(p.check?.findings) ? p.check.findings : [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const key = f.agent ?? '(unknown)';
    if (!byAgent.has(key)) byAgent.set(key, []);
    byAgent.get(key).push({ level: f.level, list: f.list, rule: f.rule, message: f.message });
  }
  const rows = Array.isArray(p.agents) ? p.agents : [];
  const agents = rows.map((a) => {
    if (!a || typeof a !== 'object') return { agent: '(unknown)', error: 'malformed row' };
    const lists = a.permissions && typeof a.permissions === 'object' ? a.permissions : {};
    const hooks = Object.entries(a.hooks && typeof a.hooks === 'object' ? a.hooks : {})
      .filter(([, n]) => typeof n === 'number' && Number.isFinite(n))
      .map(([event, count]) => ({ event, count }))
      .sort((x, y) => (x.event < y.event ? -1 : x.event > y.event ? 1 : 0));
    const agentFindings = (byAgent.get(a.agent) || []).sort(
      (x, y) => agentLevelRank(x.level) - agentLevelRank(y.level),
    );
    return {
      agent: a.agent,
      error: typeof a.error === 'string' ? a.error : null,
      settingsPath: typeof a.settingsPath === 'string' ? a.settingsPath : null,
      counts: {
        allow: Array.isArray(lists.allow) ? lists.allow.length : 0,
        ask: Array.isArray(lists.ask) ? lists.ask.length : 0,
        deny: Array.isArray(lists.deny) ? lists.deny.length : 0,
      },
      lists: {
        allow: Array.isArray(lists.allow) ? lists.allow : [],
        ask: Array.isArray(lists.ask) ? lists.ask : [],
        deny: Array.isArray(lists.deny) ? lists.deny : [],
      },
      additionalDirectories: Array.isArray(a.additionalDirectories) ? a.additionalDirectories : [],
      defaultMode: typeof a.defaultMode === 'string' ? a.defaultMode : null,
      mcp: Array.isArray(a.mcp) ? a.mcp : [],
      skills: Array.isArray(a.skills) ? a.skills : [],
      hooks,
      findings: agentFindings,
    };
  });
  return {
    root: typeof p.root === 'string' ? p.root : null,
    summaryText: agentToolsSummaryText(p.check?.summary),
    agents,
  };
}
// ===== Artifacts (FOC-779) ===================================================

const ARTIFACT_STATES = {
  fresh: { label: 'fresh', tone: 'ok' },
  stale: { label: 'stale', tone: 'warn' },
  missing: { label: 'missing', tone: 'danger' },
  external: { label: 'external', tone: 'muted' },
};

const ARTIFACT_REFRESH = {
  start: 'on start',
  watch: 'watched, 60 s',
  launcher: 'launcher',
  external: 'external',
};

// artifactRow(a) -> one registry row's view model. stateLabel + tone follow the
// plan's vocabulary (fresh ok / stale warn / missing danger / external muted);
// an unrecognised state is shown as-is, muted — never dressed up as fresh.
// ageText humanises the route's `age` (milliseconds, now - output mtime) with
// the cockpit's formatAge rendering so ages read alike across screens.
// revisionText is the source revision the row was checked against: head short +
// " · " + the first 8 chars of the digest, or "—" when the row carries neither.
// generatedAtText carries the manifest's ISO timestamp VERBATIM — the screen
// does the locale rendering, exactly like the retention panel does with
// computedAt (the plain-node tests stay locale-independent).
export function artifactRow(a) {
  const r = a || {};
  const state = ARTIFACT_STATES[r.state] || { label: r.state || 'unknown', tone: 'muted' };
  const manifest = r.manifest && typeof r.manifest === 'object' ? r.manifest : null;
  return {
    id: r.id || null,
    title: r.title || r.id || 'artifact',
    output: r.output || null,
    stateLabel: state.label,
    tone: state.tone,
    ageText: formatAge(r.age),
    revisionText:
      typeof r.head === 'string' && r.head
        ? r.head.slice(0, 7) +
          (typeof r.digest === 'string' && r.digest ? ' · ' + r.digest.slice(0, 8) : '')
        : '—',
    generatedAtText: (manifest && manifest.generatedAt) || null,
    refreshText: ARTIFACT_REFRESH[r.refresh] || r.refresh || 'unknown',
    reason: r.reason || null,
  };
}

// artifactsView(payload) -> the read-only artifacts panel's view model: the
// rows in registry order, the computed-at stamp and repo head the footnote
// shows, and the refresh note. Tolerant of an empty or malformed payload —
// rows stay [] and the note still renders; nothing throws.
export function artifactsView(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return {
    computedAtText: p.computedAt || null,
    headShort: typeof p.head === 'string' && p.head ? p.head.slice(0, 7) : null,
    rows: (Array.isArray(p.artifacts) ? p.artifacts : []).map(artifactRow),
    note:
      'regenerated on `fenix up` / dashboard start; watched entries refresh within 60 s of a source change; external entries are reported only.',
  };
}
// retentionFormState(view) -> the retention form's initial values: number
// inputs read as strings so a missing value stays visibly empty instead of
// the browser coercing null into 0.
export function retentionFormState(view) {
  const res = view && view.resolved ? view.resolved : {};
  return {
    keepAll: res.keepAll !== false,
    keepDays:
      typeof res.keepDays === 'number' && Number.isFinite(res.keepDays) ? String(res.keepDays) : '',
    minFreeGiB:
      typeof res.minFreeGiB === 'number' && Number.isFinite(res.minFreeGiB)
        ? String(res.minFreeGiB)
        : '',
  };
}

// validateRetentionForm({ keepAll, keepDays, minFreeGiB }) -> the server's
// rules mirrored: keepDays null (keepAll) or an integer 1..36500, minFreeGiB
// a number >= 0.5. keepAll true ignores a stale keepDays — the payload always
// sends null then. Errors are user-ready lines; payload is PUT-ready or null
// fields when invalid.
export function validateRetentionForm({ keepAll, keepDays, minFreeGiB }) {
  const errors = [];
  let payloadKeepDays = null;
  if (!keepAll) {
    const raw = typeof keepDays === 'string' ? keepDays.trim() : keepDays;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (raw === '' || raw === null || raw === undefined || Number.isNaN(n)) {
      errors.push('keep days: enter a whole number between 1 and 36500');
    } else if (!Number.isInteger(n) || n < 1 || n > 36500) {
      errors.push('keep days: a whole number between 1 and 36500');
    } else {
      payloadKeepDays = n;
    }
  }
  const rawGiB = typeof minFreeGiB === 'string' ? minFreeGiB.trim() : minFreeGiB;
  const g = typeof rawGiB === 'number' ? rawGiB : Number(rawGiB);
  let payloadGiB = null;
  if (rawGiB === '' || rawGiB === null || rawGiB === undefined || Number.isNaN(g)) {
    errors.push('warn below: enter the GiB threshold (0.5 or more)');
  } else if (g < 0.5) {
    errors.push('warn below: at least 0.5 GiB');
  } else {
    payloadGiB = g;
  }
  return { ok: errors.length === 0, errors, payload: { keepDays: payloadKeepDays, minFreeGiB: payloadGiB } };
}

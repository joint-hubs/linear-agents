// scripts/telemetry-server.mjs
// Telemetry HTTP API — reads the central SQLite store (telemetry-store.mjs).
// ledger.mjs is used only for /api/flow's overview + turn-log extraction, which
// still read transcripts directly.
// Usage: node scripts/telemetry-server.mjs [--smoke]
//   --smoke: start, print ready, auto-shutdown after 10s (for CI/manual smoke test)

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { readFileSync as readFileSyncNode } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
// Reuse the shared Linear GraphQL client (linear-client.mjs) — the same layer
// linear-query.mjs is built on. A workspace-wide query (all teams) isn't
// expressible via the team-scoped linear-query CLI, so we call graphql()
// directly. No MCP, no new client (control-plane-plan §3.1, DoD "reuse
// scripts/linear-query.mjs" = reuse the Linear query layer).
import { loadEnv, graphql, chooseApiKey } from './linear-client.mjs';
import * as telemetryStore from './telemetry-store.mjs';
import { backfill, ingestKnownRuns } from './telemetry-ingest.mjs';
// Pure launch logic (validation, kickoff prompt, wrapper .bat, loopback check)
// lives in scripts/launch.mjs so it's unit-testable without the HTTP server.
import {
  SQUAD_ALLOWLIST,
  TASK_ID_RE,
  KICKOFF_TEMPLATES,
  validateLaunch,
  kickoffPrompt,
  isLocalOrigin,
  isAllowedOrigin,
  buildLaunchBat,
  spawnLauncher,
  reloadKickoffTemplates,
} from './launch.mjs';
import { readSquadConfig, writeSquadConfig, validateSlug, readToolCatalog, validateTools } from './squad-config.mjs';
import { listTerminals, flashWindowByPid, focusWindowByPid, stopByPid, isProcessAlive } from './terminals.mjs';
import {
  buildPromptTree,
  readRoleDoc,
  readLeadDoc,
  resolvePromptRefs,
  readContextFile,
  writeContextFile,
  listExternalPromptFiles,
  readExternalFile,
  writeExternalFile,
  isExternalPath,
} from './prompt-library.mjs';
import { computeOutcomes } from './delegation-outcomes.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// Load .env so the Linear API keys (LINEAR_API_KEY / LINEAR_API_KEY_PISI) are
// available to chooseApiKey() inside graphql(). Benign for other endpoints —
// loadEnv only sets vars that aren't already set.
loadEnv();

const PORT = parseInt(process.env.TELEMETRY_PORT, 10) || 7331;
const isSmoke = process.argv.includes('--smoke');

// Central SQLite store is a hard requirement (README: "Node 22.5+ — centralna
// telemetria używa node:sqlite"), not an optional lane. It used to have a
// files-based fallback selectable via LA_TELEMETRY_READ_SOURCE=files, but
// nothing ever set that var and no test ever exercised the path — it was 130+
// untested lines pretending to be a safety net. Fail loudly instead: a real
// node:sqlite outage should stop the server, not silently degrade into code
// nobody has run.
if (!telemetryStore.sqliteAvailable()) {
  console.error('[telemetry] node:sqlite unavailable — requires Node >= 22.5. Cannot start.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Ledger — dynamically imported; T-E0a builds scripts/ledger.mjs in parallel.
// If absent, endpoints return 500 until ledger is available.
// ---------------------------------------------------------------------------
let ledger;
try {
  ledger = await import('./ledger.mjs');
} catch (err) {
  console.error('Ledger module not available —', err.message);
  console.error('Endpoints will return 500 until scripts/ledger.mjs exists.');
}

// ---------------------------------------------------------------------------
// Handoff rules — declarative mapping from Linear task metadata to the squad
// that should pick it up next (control-plane-plan.md §3.1 + HOW-TO §6).
// Read once at startup. Missing/invalid file → empty rules, so every task gets
// suggestedSquad:null (queue still serves; UI shows "no suggestion").
// ---------------------------------------------------------------------------
let handoffRules = [];
try {
  const txt = await readFile(join(root, 'config', 'handoff-rules.json'), 'utf8');
  const parsed = JSON.parse(txt);
  if (Array.isArray(parsed)) handoffRules = parsed;
  else console.error('config/handoff-rules.json: expected an array');
} catch (err) {
  console.error('config/handoff-rules.json not loaded —', err.message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function corsPreflight(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

// Read + parse a JSON request body. Caps the size so a runaway client can't
// stream forever; rejects invalid JSON as a thrown error.
//
// The 8 KB default fits the control payloads (/api/launch, /api/squad-config).
// /api/prompts/file carries a whole prompt document instead — agents/dev/CLAUDE.md
// is already 8.7 KB and docs/FENIX_WORKFLOW.md is over 20 KB — so it passes a
// larger cap. Callers that take documents must opt in explicitly; the default
// stays tight.
function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) {
        req.destroy();
        const err = new Error(`body too large (>${Math.round(maxBytes / 1024)}KB)`);
        err.tooLarge = true;
        reject(err);
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Fill in consolePid from the run manifest for runs the store doesn't have it for.
 *
 * The central store ingests each manifest exactly once (immutable spool +
 * source offsets), so runs that were imported before `console_pid` existed as
 * a column never gain it — including a run that is live right now. Reading the
 * manifest directly is a cheap, bounded repair: only unfinished runs are
 * checked, and that set is a handful at most.
 */
function withManifestConsolePid(runs) {
  return runs.map((run) => {
    if (run.endedAt || run.consolePid) return run;
    try {
      const raw = readFileSyncNode(join(root, '.state', 'runs', `${run.runId}.json`), 'utf8');
      const manifest = JSON.parse(raw);
      if (!Number.isInteger(manifest.consolePid)) return run;
      return {
        ...run,
        consolePid: manifest.consolePid,
        windowTitle: run.windowTitle || manifest.windowTitle || null,
        launchedBy: run.launchedBy || manifest.launchedBy || null,
      };
    } catch {
      return run; // no manifest on disk, or unreadable — leave the run as-is
    }
  });
}

function log(method, path, status) {
  console.log(`${method} ${path} -> ${status}`);
}

async function telemetryRuns(options = {}) {
  const db = telemetryStore.openTelemetryDb();
  try { return telemetryStore.queryRuns(db, options); } finally { db.close(); }
}

async function telemetrySummary(options = {}) {
  const db = telemetryStore.openTelemetryDb();
  try { return telemetryStore.querySummary(db, options); } finally { db.close(); }
}

async function telemetryHealth() {
  const db = telemetryStore.openTelemetryDb();
  try { return { readSource: 'sqlite', ...telemetryStore.queryHealth(db) }; } finally { db.close(); }
}

/**
 * Close runs whose console window is gone.
 *
 * A run is marked `running` until the launcher calls `run-manifest end`. Close
 * the window (or let it crash) and that call never happens, so the run stays
 * "active" forever — Live kept counting a review whose window had already been
 * closed while the terminal panel, which checks the process, correctly did not.
 *
 * Two paths:
 *   - a recorded consolePid whose process is gone — definitive, close it.
 *   - no consolePid at all — close only after a long idle window
 *     (orphanRunVerdict), and record a `run_orphaned` data-quality issue so the
 *     guess is visible. Skipping these entirely was the old behaviour and it
 *     made them permanent: a run with no pid could never be closed by anything.
 *
 * @returns {number} how many runs were closed
 */
async function reconcileDeadRuns() {
  let closed = 0;
  const close = (run, endedAt, reason) => {
    telemetryStore.recordManifest(
      {
        runId: run.runId,
        squad: run.squad,
        startedAt: run.startedAt,
        endedAt: endedAt || new Date().toISOString(),
        exitCode: null,
      },
      'ended',
    );
    closed++;
    console.log(`[telemetry] reconcile: closed ${run.runId} (${reason})`);
  };

  try {
    const active = withManifestConsolePid(await telemetryRuns()).filter((r) => !r.endedAt);
    for (const run of active) {
      if (Number.isInteger(run.consolePid) && run.consolePid > 0) {
        if (isProcessAlive(run.consolePid)) continue;
        close(run, run.lastActivityAt, `console pid ${run.consolePid} gone`);
        continue;
      }
      // No pid to check. Leaving these alone made them immortal — see
      // orphanRunVerdict() for what that cost. Closing one is a guess, so it
      // also raises a data-quality issue rather than disappearing silently.
      const verdict = telemetryStore.orphanRunVerdict(run);
      if (!verdict) continue;
      close(run, verdict.endedAt, `orphan: ${verdict.reason}`);
      telemetryStore.reportDataQuality(run.runId, 'run_orphaned', {
        reason: verdict.reason,
        startedAt: run.startedAt ?? null,
        lastActivityAt: run.lastActivityAt ?? null,
      });
    }
  } catch (error) {
    console.error(`[telemetry] reconcile failed: ${error.message}`);
  }
  return closed;
}

async function ingestTelemetry() {
  try {
    const replay = telemetryStore.replayPending();
    const result = await ingestKnownRuns();
    if (replay.ingested || result.usageEvents) {
      console.log(`[telemetry] replayed=${replay.ingested} usage=${result.usageEvents}`);
    }
  } catch (error) {
    console.error(`[telemetry] background ingest failed: ${error.message}`);
  }
  reconcileDeadRuns();
}

async function bootstrapTelemetry() {
  const db = telemetryStore.openTelemetryDb();
  let runCount = 0;
  try { runCount = db.prepare('SELECT COUNT(*) AS count FROM runs').get().count; } finally { db.close(); }
  let manifestCount = 0;
  try {
    manifestCount = (await readdir(join(root, '.state', 'runs'))).filter((name) => name.endsWith('.json')).length;
  } catch {
    manifestCount = 0;
  }
  const forceBackfill = process.env.LA_TELEMETRY_FORCE_BACKFILL === '1';
  if (runCount < manifestCount || forceBackfill) {
    const result = await backfill();
    console.log(`[telemetry] backfill manifests=${result.manifests} usage=${result.usageEvents} force=${forceBackfill}`);
  }
  ingestTelemetry();
}

// ---------------------------------------------------------------------------
// Linear queue — /api/linear/queue (L1a, control-plane-plan §3.1)
// ---------------------------------------------------------------------------

// Two-step query: first list teams (cheap), then fetch each team's issues
// separately. A single nested `teams → issues(100) → labels/assignee/parent`
// query exceeds Linear's query-complexity limit ("Query too complex"), so we
// split it — each per-team query is low complexity. The handoff rules engine
// then derives suggestedSquad client-side from state + labels (read-only).
const TEAMS_QUERY = `
  query {
    teams {
      nodes {
        id
        key
        name
      }
    }
  }
`;

const TEAM_ISSUES_QUERY = `
  query($teamId: String!) {
    team(id: $teamId) {
      issues(first: 50, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          url
          state { id name type }
          priority
          estimate
          updatedAt
          assignee { id name displayName }
          labels(first: 20) { nodes { id name } }
          parent { id identifier title }
        }
      }
    }
  }
`;

// Evaluate handoff rules against a task. First match wins — rule order in the
// config is significant. `labels:["needs:*"]` is a wildcard matching any
// `needs:` label, so a blocked task routes to the human regardless of state
// (put that rule first in the config, per HOW-TO §6 "dowolny → człowiek").
//
// The wildcard is separator-agnostic: it matches BOTH the colon form
// (`needs:answer`, the HOW-TO §6 doc convention) AND the hyphen form
// (`needs-decision`, the actual label name Linear returns in this workspace).
// Linear lets you name a label either way; the doc uses `needs:` while the
// live workspace uses `needs-`, and the matcher must not let that discrepancy
// silently drop blocked tasks (JOI-68 review round 1 found 6 needs-decision
// tasks routing to null instead of human).
function suggestedSquad(task, rules) {
  const labels = new Set(task.labels || []);
  for (const rule of rules) {
    const w = rule.when || {};
    if (w.state && task.state !== w.state) continue;
    if (w.labels && w.labels.length) {
      const ok = w.labels.every((l) => {
        if (l.endsWith(':*')) {
          // Strip ":*" → stem (e.g. "needs:*" → "needs"). Match the stem
          // exactly or followed by either separator, so colon- and hyphen-
          // named labels both route.
          const stem = l.slice(0, -2);
          return [...labels].some(
            (t) => t === stem || t.startsWith(stem + ':') || t.startsWith(stem + '-'),
          );
        }
        return labels.has(l);
      });
      if (!ok) continue;
    }
    return rule.next;
  }
  return null;
}

// 60 s cache per workspace (Linear rate limits). AC3: a second call within
// 60 s is served from cache — no second Linear hit (response carries
// `cached:true` so it is observable without inspecting server logs).
const QUEUE_TTL_MS = 60_000;
let queueCache = null; // { workspace, ts, payload }

// Fetch all teams' issues for the workspace and enrich each with
// suggestedSquad. Never throws — on missing key / Linear error / timeout it
// returns a 200-grade degrade payload (tasks:[], error note) so the dashboard
// stays up and --smoke passes without network.
async function fetchLinearQueue(workspace) {
  // Pass the workspace through to graphql() so the request authenticates
  // against the RIGHT workspace key (?workspace=pisi → PISI key → pisi teams),
  // not the LINEAR_WORKSPACE env default. JOI-68 review round 1: the env-only
  // path silently returned jointhubs data for ?workspace=pisi.
  const apiKey = chooseApiKey(workspace);
  if (!apiKey) {
    return {
      workspace,
      tasks: [],
      error: `Linear API key not configured for workspace '${workspace}'`,
      fetchedAt: null,
    };
  }
  try {
    // Safety net so a hanging Linear call can't stall --smoke or the dashboard.
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Linear API timeout (8s)')), 8000),
    );
    const result = await Promise.race([
      (async () => {
        const teamsData = await graphql(TEAMS_QUERY, {}, workspace);
        const teams = teamsData?.teams?.nodes || [];
        // Fetch each team's issues in parallel — one low-complexity query each.
        const perTeam = await Promise.all(
          teams.map((t) =>
            graphql(TEAM_ISSUES_QUERY, { teamId: t.id }, workspace).then((d) => ({
              team: t,
              nodes: d?.team?.issues?.nodes || [],
            })),
          ),
        );
        return perTeam;
      })(),
      timeout,
    ]);
    const tasks = [];
    for (const { team, nodes } of result) {
      for (const n of nodes) {
        const labels = (n.labels?.nodes || []).map((l) => l.name);
        const task = {
          id: n.id,
          identifier: n.identifier,
          title: n.title,
          url: n.url,
          team: team.key,
          state: n.state?.name || null,
          stateType: n.state?.type || null,
          priority: n.priority ?? null,
          estimate: n.estimate ?? null,
          updatedAt: n.updatedAt,
          assignee: n.assignee?.displayName || n.assignee?.name || null,
          labels,
          parent: n.parent ? { identifier: n.parent.identifier, title: n.parent.title } : null,
        };
        task.suggestedSquad = suggestedSquad(task, handoffRules);
        tasks.push(task);
      }
    }
    // Most recently updated first. Tasks with suggestedSquad:null are kept
    // (Done/Canceled/Backlog) — the UI groups by suggestedSquad and ignores
    // null, but keeping them lets a future "all tasks" view reuse the payload.
    tasks.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { workspace, tasks, error: null, fetchedAt: new Date().toISOString() };
  } catch (err) {
    return { workspace, tasks: [], error: err.message, fetchedAt: null };
  }
}

// ---------------------------------------------------------------------------
// Launch — POST /api/launch (L1b, control-plane-plan §3.1 + §5)
// Spawns a NEW local terminal window running bin/<squad>.bat with LA_TASK_ID
// set (so the run is tagged → appears in Live within 5 s) and the HOW-TO §4
// kickoff prompt passed as the initial claude input (Q3 decision: full
// auto-inject — zero manual paste; overrides the §3.3 clipboard trade-off).
// Locked down: 127.0.0.1 bind + origin check, squad allowlist, taskId regex.
// ---------------------------------------------------------------------------

// Squads with a launcher (bin/<squad>.bat) AND a HOW-TO §4 kickoff template.
// (Imported from launch.mjs — see SQUAD_ALLOWLIST, KICKOFF_TEMPLATES there.)

// Write the wrapper to .state/ (gitignored) and return its path. One stable
// name per (squad, taskId) — re-launching overwrites, no file accumulation.
async function writeLaunchBat(squad, taskId, kickoff, targetRepo) {
  const wrapper = join(root, '.state', `launch-${squad}-${taskId}.bat`);
  await writeFile(wrapper, buildLaunchBat(squad, taskId, kickoff, root, targetRepo), 'utf8');
  return wrapper;
}

// ---------------------------------------------------------------------------
// Project → repo resolution (artifact-leak fix)
// A dashboard launch used to always cwd into linear-agents regardless of
// which repo the task belongs to, so squad meta-artifacts (state, plans,
// briefs) leaked into linear-agents instead of the target project. Resolve
// the issue's Linear project → config/projects.json repo before spawning;
// fall back to linear-agents (with a warning surfaced to the dashboard) when
// the project isn't set, isn't mapped, or the Linear call fails/times out.
// ---------------------------------------------------------------------------

const ISSUE_PROJECT_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      identifier
      project { id name }
    }
  }
`;

function loadProjectsConfig() {
  try {
    const raw = readFileSyncNode(join(root, 'config', 'projects.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.projects) ? parsed.projects : [];
  } catch (err) {
    console.error('[launch] config/projects.json not loaded —', err.message);
    return [];
  }
}

// taskId's workspace isn't derivable from the identifier alone (unlike
// /api/linear/queue, which takes workspace as an explicit caller param) — try
// jointhubs first (the common case), then pisi. A cross-workspace lookup just
// returns issue:null (not an error), so this is one harmless extra call, not
// a failure path.
async function findIssueProject(taskId) {
  for (const workspace of [undefined, 'pisi']) {
    const apiKey = chooseApiKey(workspace);
    if (!apiKey) continue;
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Linear API timeout (8s)')), 8000),
      );
      const data = await Promise.race([
        graphql(ISSUE_PROJECT_QUERY, { id: taskId }, workspace),
        timeout,
      ]);
      if (data?.issue) return data.issue.project?.name || null;
    } catch {
      // try the other workspace before giving up
    }
  }
  return undefined; // not found in either workspace queried
}

// Never throws — a bad/missing mapping degrades to { repo: null, warning }
// so a Linear hiccup can never block a launch.
async function resolveTaskRepo(taskId) {
  const projectName = await findIssueProject(taskId);
  if (projectName === undefined) {
    return { repo: null, warning: `could not resolve Linear project for ${taskId} — launching in linear-agents` };
  }
  if (!projectName) {
    return { repo: null, warning: `issue ${taskId} has no Linear project set — launching in linear-agents` };
  }
  const entry = loadProjectsConfig().find(
    (p) => (p.linearProject || '').toLowerCase() === projectName.toLowerCase(),
  );
  if (!entry?.repo) {
    return { repo: null, warning: `no repo mapped for Linear project "${projectName}" — launching in linear-agents` };
  }
  return { repo: entry.repo, warning: null };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    // --- CORS preflight ---
    if (method === 'OPTIONS') {
      corsPreflight(res);
      log(method, path, 204);
      return;
    }

    // --- POST /api/launch (L1b) ---
    // Spawns a local agent window. Bound to 127.0.0.1 + origin-checked (AC3),
    // squad allowlist + taskId regex (AC2). dryRun returns the kickoff + wrapper
    // content without spawning (UI preview §3.3 + smoke). target:"vm" is
    // recognized but not built in L1 (blocked on VM provisioning, §4) → 501.
    //
    // D-S1 (review round 1, 🟠 security): the bind + remoteAddress check alone
    // can't stop a cross-site browser CSRF (a malicious page in Mateusz's
    // browser has remoteAddress=127.0.0.1). Browsers send `Origin` on POST, so
    // when present we require it to be loopback — blocks cross-site spawn of a
    // credential-bearing agent while keeping the dashboard (Vite :5173) working.
    // Absent Origin (curl, --smoke, server-to-server) is allowed.
    if (method === 'POST' && path === '/api/launch') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/launch is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin: /api/launch is same-origin loopback only' });
        log(method, path, 403);
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const v = validateLaunch(body);
      if (!v.ok) {
        json(res, v.status, { error: v.error });
        log(method, path, v.status);
        return;
      }
      const { taskId, squad, target, dryRun } = v;
      const kickoff = kickoffPrompt(squad, taskId);
      const { repo: targetRepo, warning: repoWarning } = await resolveTaskRepo(taskId);
      const effectiveRepo = targetRepo || root;
      if (dryRun) {
        json(res, 200, {
          ok: true,
          dryRun: true,
          taskId,
          squad,
          target,
          kickoffPrompt: kickoff,
          launchBat: buildLaunchBat(squad, taskId, kickoff, root, targetRepo),
          targetRepo: effectiveRepo,
          ...(repoWarning ? { warning: repoWarning } : {}),
        });
        log(method, path, 200);
        return;
      }
      if (target === 'vm') {
        json(res, 501, {
          error: 'vm target not implemented in L1 (blocked on VM provisioning; see control-plane-plan §4)',
        });
        log(method, path, 501);
        return;
      }
      try {
        const launchBatPath = await writeLaunchBat(squad, taskId, kickoff, targetRepo);
        spawnLauncher(launchBatPath, effectiveRepo);
        json(res, 200, {
          ok: true,
          taskId,
          squad,
          target,
          spawned: true,
          kickoffPrompt: kickoff,
          launchBat: launchBatPath,
          targetRepo: effectiveRepo,
          ...(repoWarning ? { warning: repoWarning } : {}),
        });
        log(method, path, 200);
      } catch (err) {
        json(res, 500, { error: 'spawn failed: ' + err.message });
        log(method, path, 500);
      }
      return;
    }

    // --- POST /api/squad-config ---
    // Update squad lead/agent models and pricing. Localhost-only (same
    // origin/host check as /api/launch). dryRun=true previews without writing.
    if (method === 'POST' && path === '/api/squad-config') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/squad-config is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin: /api/squad-config is same-origin loopback only' });
        log(method, path, 403);
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }

      // Validate slugs
      const slugErrors = [];
      const slugWarnings = [];
      if (body.squads) {
        for (const [squad, squadPatch] of Object.entries(body.squads)) {
          if (squadPatch.lead !== undefined) {
            const v = validateSlug(squadPatch.lead);
            if (!v.ok) slugErrors.push(`squads.${squad}.lead: ${v.warning}`);
            else if (v.warning) slugWarnings.push(`squads.${squad}.lead: ${v.warning}`);
          }
          if (squadPatch.agents) {
            for (const [role, value] of Object.entries(squadPatch.agents)) {
              // Backward compat: string = model-only patch
              if (typeof value === 'string') {
                const v = validateSlug(value);
                if (!v.ok) slugErrors.push(`squads.${squad}.agents.${role}: ${v.warning}`);
                else if (v.warning) slugWarnings.push(`squads.${squad}.agents.${role}: ${v.warning}`);
                continue;
              }
              // Object patch: { model?, tools? }
              if (typeof value === 'object' && value !== null) {
                if (value.model !== undefined) {
                  const v = validateSlug(value.model);
                  if (!v.ok) slugErrors.push(`squads.${squad}.agents.${role}.model: ${v.warning}`);
                  else if (v.warning) slugWarnings.push(`squads.${squad}.agents.${role}.model: ${v.warning}`);
                }
                if (value.tools !== undefined) {
                  const catalog = readToolCatalog(root);
                  const tv = validateTools(value.tools, catalog);
                  if (!tv.ok) {
                    slugErrors.push(`squads.${squad}.agents.${role}.tools: ${tv.warnings.join('; ')}`);
                  } else {
                    slugWarnings.push(...tv.warnings.map((w) => `squads.${squad}.agents.${role}.tools: ${w}`));
                  }
                }
                continue;
              }
              slugErrors.push(`squads.${squad}.agents.${role}: must be a string (model) or object {model?, tools?}`);
            }
          }
        }
      }
      if (body.pricing) {
        for (const [slug, price] of Object.entries(body.pricing)) {
          // Silently skip metadata keys (_doc, _note, etc.)
          if (slug.startsWith('_')) continue;
          if (typeof price.input !== 'number' || price.input < 0 || typeof price.output !== 'number' || price.output < 0) {
            slugErrors.push(`pricing.${slug}: input/output must be numbers >= 0`);
            continue;
          }
          const v = validateSlug(slug);
          if (!v.ok) slugErrors.push(`pricing.${slug}: ${v.warning}`);
          else if (v.warning) slugWarnings.push(`pricing.${slug}: ${v.warning}`);
        }
      }
      if (slugErrors.length > 0) {
        json(res, 400, { error: 'validation failed', details: slugErrors });
        log(method, path, 400);
        return;
      }

      const dryRun = body.dryRun === true;
      const result = writeSquadConfig(
        { squads: body.squads, pricing: body.pricing },
        root,
        { dryRun },
      );
      json(res, 200, {
        changed: result.changed,
        warnings: [...slugWarnings, ...result.warnings],
        dryRun,
      });
      log(method, path, 200);
      return;
    }

    // --- POST /api/terminals/focus ---
    // Flash the taskbar button by consolePid. Localhost-only.
    // Windows blocks SetForegroundWindow from background processes, so we use
    // FlashWindowEx (taskbar flash) instead — the system-allowed attention signal.
    // 409 when no consolePid (launched before PID tracking or manually).
    if (method === 'POST' && path === '/api/terminals/focus') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/terminals/focus is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const runId = String(body.runId || '').trim();
      if (!runId) {
        json(res, 400, { error: 'runId is required' });
        log(method, path, 400);
        return;
      }
      const runs = withManifestConsolePid(await telemetryRuns());
      const run = runs.find((r) => r.runId === runId);
      if (!run) {
        json(res, 404, { error: 'run not found: ' + runId });
        log(method, path, 404);
        return;
      }
      if (!run.consolePid || !Number.isInteger(run.consolePid) || run.consolePid <= 0) {
        json(res, 409, { error: 'terminal uruchomiony przed wprowadzeniem śledzenia PID lub ręcznie — nie można go namierzyć' });
        log(method, path, 409);
        return;
      }
      // Try to raise the window first — that is what the operator actually
      // wants. Taskbar flashing is the fallback for the cases Windows does
      // refuse (e.g. the console is a tab inside Windows Terminal / VS Code,
      // where the process owns no window of its own).
      let result = focusWindowByPid(run.consolePid);
      let action = 'focus';
      if (!result.ok) {
        const flashed = flashWindowByPid(run.consolePid);
        if (flashed.ok) {
          result = flashed;
          action = 'flash';
        }
      }
      if (!result.ok) {
        json(res, 409, { error: result.error });
        log(method, path, 409);
        return;
      }
      json(res, 200, { ok: true, action });
      log(method, path, 200);
      return;
    }

    // --- POST /api/terminals/flash ---
    // Flash the taskbar button by consolePid. Localhost-only.
    // Dedicated endpoint for the new UI — same logic as /focus but with a
    // clearer name. Windows allows FlashWindowEx from background processes.
    if (method === 'POST' && path === '/api/terminals/flash') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/terminals/flash is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const runId = String(body.runId || '').trim();
      if (!runId) {
        json(res, 400, { error: 'runId is required' });
        log(method, path, 400);
        return;
      }
      const runs = withManifestConsolePid(await telemetryRuns());
      const run = runs.find((r) => r.runId === runId);
      if (!run) {
        json(res, 404, { error: 'run not found: ' + runId });
        log(method, path, 404);
        return;
      }
      if (!run.consolePid || !Number.isInteger(run.consolePid) || run.consolePid <= 0) {
        json(res, 409, { error: 'terminal uruchomiony przed wprowadzeniem śledzenia PID lub ręcznie — nie można go namierzyć' });
        log(method, path, 409);
        return;
      }
      const result = flashWindowByPid(run.consolePid);
      if (!result.ok) {
        json(res, 409, { error: result.error });
        log(method, path, 409);
        return;
      }
      json(res, 200, { ok: true });
      log(method, path, 200);
      return;
    }

    // --- POST /api/terminals/stop ---
    // Kill a terminal process by consolePid. Localhost-only.
    if (method === 'POST' && path === '/api/terminals/stop') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/terminals/stop is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const runId = String(body.runId || '').trim();
      if (!runId) {
        json(res, 400, { error: 'runId is required' });
        log(method, path, 400);
        return;
      }
      const runs = withManifestConsolePid(await telemetryRuns());
      const run = runs.find((r) => r.runId === runId);
      if (!run) {
        json(res, 404, { error: 'run not found: ' + runId });
        log(method, path, 404);
        return;
      }
      if (!run.consolePid || !Number.isInteger(run.consolePid) || run.consolePid <= 0) {
        json(res, 409, { error: 'terminal uruchomiony przed wprowadzeniem śledzenia PID lub ręcznie — nie można go namierzyć' });
        log(method, path, 409);
        return;
      }
      const result = stopByPid(run.consolePid);
      if (!result.ok) {
        json(res, 409, { error: result.error });
        log(method, path, 409);
        return;
      }
      json(res, 200, { ok: true });
      log(method, path, 200);
      return;
    }

    // --- POST /api/prompts/kickoff ---
    // Update kickoff templates in config/prompts.json. Localhost-only.
    // Atomic write (temp + rename), preserves _* keys and other squads.
    if (method === 'POST' && path === '/api/prompts/kickoff') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/prompts/kickoff is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const squad = String(body.squad || '').trim().toLowerCase();
      if (!SQUAD_ALLOWLIST.includes(squad)) {
        json(res, 400, { error: `invalid squad: must be one of ${SQUAD_ALLOWLIST.join(', ')}` });
        log(method, path, 400);
        return;
      }
      const lines = body.lines;
      if (!Array.isArray(lines) || lines.length === 0 || lines.some((l) => typeof l !== 'string' || l.trim() === '')) {
        json(res, 400, { error: 'lines must be a non-empty array of non-empty strings' });
        log(method, path, 400);
        return;
      }
      const dryRun = body.dryRun === true;
      const promptsPath = join(root, 'config', 'prompts.json');

      // Read current file, preserving all _* keys and other squads
      let current;
      try {
        const raw = await readFile(promptsPath, 'utf8');
        current = JSON.parse(raw);
      } catch {
        current = { kickoff: {} };
      }
      if (!current.kickoff) current.kickoff = {};

      const before = current.kickoff[squad] ? [...current.kickoff[squad]] : null;
      const after = [...lines];

      // Check if actually changed
      const beforeStr = JSON.stringify(before);
      const afterStr = JSON.stringify(after);
      if (beforeStr === afterStr) {
        json(res, 200, { changed: [], dryRun, warnings: ['brak zmian — treść identyczna'] });
        log(method, path, 200);
        return;
      }

      const changed = [{ file: promptsPath, before, after }];

      if (dryRun) {
        json(res, 200, { changed, dryRun: true });
        log(method, path, 200);
        return;
      }

      // Atomic write: temp file → rename
      current.kickoff[squad] = after;
      const tmp = promptsPath + '.' + Math.random().toString(36).slice(2, 10);
      try {
        await writeFile(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
        await rename(tmp, promptsPath);
      } catch (err) {
        json(res, 500, { error: 'write failed: ' + err.message });
        log(method, path, 500);
        return;
      }

      // Reload so the next launch uses the new template without server restart
      reloadKickoffTemplates();

      json(res, 200, { changed, dryRun: false });
      log(method, path, 200);
      return;
    }

    // --- POST /api/prompts/file ---
    // Write a context/prompt document (docs/ui/prompt-editing.md). Localhost-only.
    // Authorisation lives in writeContextFile: only .md files referenced by
    // some prompt, with kind auto/read, can be written — same allowlist as
    // GET /api/prompts/file. dryRun:true returns before/after without writing.
    if (method === 'POST' && path === '/api/prompts/file') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/prompts/file is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      // 1 MB: a prompt document, not a control payload. The largest one in the
      // repo (docs/FENIX_WORKFLOW.md) is ~20 KB, so this is generous headroom
      // that still bounds the request.
      try { body = await readJsonBody(req, 1024 * 1024); } catch (err) {
        const status = err.tooLarge ? 413 : 400;
        json(res, status, {
          error: err.tooLarge ? err.message : 'invalid JSON body: ' + err.message,
        });
        log(method, path, status);
        return;
      }
      const relPath = body.path;
      const dryRun = body.dryRun === true;
      // "@rootId/..." targets a configured external root (~/.claude, hermes);
      // anything else is repo-relative. Guards live in prompt-library.
      const result = isExternalPath(relPath)
        ? writeExternalFile(root, relPath, body.body, { dryRun })
        : writeContextFile(root, relPath, body.body, { dryRun });
      if (result.error) {
        const status = result.error.startsWith('forbidden')
          ? 403
          : result.error === 'not found'
            ? 404
            : 400;
        json(res, status, result);
        log(method, path, status);
        return;
      }
      json(res, 200, result);
      log(method, path, 200);
      return;
    }

    // --- POST /api/runs/task ---
    // Change or clear the task assigned to a run. Localhost-only.
    // scope: 'run' (default) → validFrom = run.startedAt (retroactive, moves all cost).
    // scope: 'now' → validFrom = now (only future usage counts toward this task).
    if (method === 'POST' && path === '/api/runs/task') {
      if (!isLocalOrigin(req.socket.remoteAddress)) {
        json(res, 403, { error: 'forbidden: /api/runs/task is 127.0.0.1 only' });
        log(method, path, 403);
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        json(res, 403, { error: 'forbidden origin' });
        log(method, path, 403);
        return;
      }
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        json(res, 400, { error: 'invalid JSON body: ' + err.message });
        log(method, path, 400);
        return;
      }
      const runId = String(body.runId || '').trim();
      if (!runId) {
        json(res, 400, { error: 'runId is required' });
        log(method, path, 400);
        return;
      }

      // Verify run exists and capture previous task
      let run, previousTaskId;
      {
        const db = telemetryStore.openTelemetryDb();
        try {
          const runs = telemetryStore.queryRuns(db, { runId });
          if (runs.length === 0) {
            json(res, 404, { error: 'przebieg nie znaleziony: ' + runId });
            log(method, path, 404);
            return;
          }
          run = runs[0];
          previousTaskId = telemetryStore.getRunTaskLinks(db, runId).current?.taskId || null;
        } finally { db.close(); }
      }

      const rawTaskId = body.taskId != null ? String(body.taskId).trim() : '';

      if (!rawTaskId) {
        // Clear task assignment — run becomes untagged
        telemetryStore.clearRunTask(runId);
        const db = telemetryStore.openTelemetryDb();
        try {
          const updated = telemetryStore.queryRuns(db, { runId })[0];
          json(res, 200, {
            ok: true, runId, taskId: null, scope: null,
            previousTaskId, movedCostUSD: updated.totals.partialCostUSD,
          });
        } finally { db.close(); }
        log(method, path, 200);
        return;
      }

      // Validate taskId format
      const taskId = rawTaskId.toUpperCase();
      if (!/^[A-Z]+-\d+$/.test(taskId)) {
        json(res, 400, { error: 'Nieprawidłowy format taskId. Wymagany format: PROJEKT-NUMER (np. FOC-123)' });
        log(method, path, 400);
        return;
      }

      const scope = body.scope || 'run';
      const validFrom = scope === 'now'
        ? new Date().toISOString()
        : (run.startedAt || new Date().toISOString());

      telemetryStore.recordTaskLink(runId, taskId, 'manual', { validFrom, confidence: 1 });

      const db = telemetryStore.openTelemetryDb();
      try {
        const updated = telemetryStore.queryRuns(db, { runId })[0];
        json(res, 200, {
          ok: true, runId, taskId, scope,
          previousTaskId, movedCostUSD: updated.totals.partialCostUSD,
        });
      } finally { db.close(); }
      log(method, path, 200);
      return;
    }

    // --- Only GET is supported beyond this point (other POST/PUT/DELETE → 404) ---
    if (method !== 'GET') {
      json(res, 404, { error: 'not found' });
      log(method, path, 404);
      return;
    }

    // --- Ledger availability check ---
    if (!ledger) {
      json(res, 500, { error: 'Ledger module not available — scripts/ledger.mjs is missing' });
      log(method, path, 500);
      return;
    }

    // --- Route matching ---

    // GET /api/telemetry/health — central-store status plus unresolved quality
    // signals. This endpoint never scans manifests/transcripts.
    if (path === '/api/telemetry/health') {
      json(res, 200, await telemetryHealth());
      log(method, path, 200);
      return;
    }

    // GET /api/runs
    if (path === '/api/runs') {
      // Default is 'current', not 'as-run'. 'as-run' replays the price set stored with
      // each run, which is the right call when prices genuinely change — but ours were
      // wrong, not old: GLM-5.2 sat at 2.03x its real rate, no model carried cacheRead
      // (so the store guessed input*0.1), and Haiku 4.5 had no price at all, which left
      // summary.costUSD null. Replaying that reproduces the error. 'as-run' stays
      // reachable via ?pricing=as-run for audit.
      const data = await telemetryRuns({ priceMode: url.searchParams.get('pricing') || 'current' });
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

    // GET /api/runs/task?runId=<id> — task link history for a run
    if (path === '/api/runs/task') {
      const runId = url.searchParams.get('runId') || '';
      if (!runId) {
        json(res, 400, { error: 'runId query param is required' });
        log(method, path, 400);
        return;
      }
      const db = telemetryStore.openTelemetryDb();
      try {
        const runs = telemetryStore.queryRuns(db, { runId });
        if (runs.length === 0) {
          json(res, 404, { error: 'przebieg nie znaleziony: ' + runId });
          log(method, path, 404);
          return;
        }
        const links = telemetryStore.getRunTaskLinks(db, runId);
        json(res, 200, links);
        log(method, path, 200);
      } finally { db.close(); }
      return;
    }

    // GET /api/runs/:runId
    const runsMatch = path.match(/^\/api\/runs\/(.+)$/);
    if (runsMatch) {
      const runId = runsMatch[1];
      const runs = await telemetryRuns({ priceMode: url.searchParams.get('pricing') || 'current' });
      const run = runs.find(r => r.runId === runId);
      if (!run) {
        json(res, 404, { error: 'not found' });
        log(method, path, 404);
      } else {
        json(res, 200, run);
        log(method, path, 200);
      }
      return;
    }

    // GET /api/summary
    if (path === '/api/summary') {
      const summary = await telemetrySummary({ priceMode: url.searchParams.get('pricing') || 'current' });
      json(res, 200, summary);
      log(method, path, 200);
      return;
    }

    // GET /api/delegation-outcomes (JOI-210)
    // Quality signal per delegation: REVIEW's own verdicts joined back onto the
    // DEV roles that produced the code. Recomputed per request — it reads 34 small
    // files and one grouped query, and a stale panel would be worse than a slow one.
    if (path === '/api/delegation-outcomes') {
      let data = null;
      try {
        data = computeOutcomes();
      } catch (error) {
        console.error('[delegation-outcomes]', error.message);
      }
      // No reviews yet is a legitimate empty state, not a failure: the panel says
      // so rather than the page breaking.
      json(res, 200, data || { tasksWithVerdict: 0, matched: 0, unmatched: 0, byTask: [], byPair: [] });
      log(method, path, 200);
      return;
    }

    // GET /api/cost-per-task
    if (path === '/api/cost-per-task') {
      const data = (await telemetrySummary({ priceMode: url.searchParams.get('pricing') || 'current' })).byTask;
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

    // GET /api/budget (B2 — ux-design-v3 §4)
    //   { budgetPerTaskUSD: env COST_BUDGET_USD_PER_TASK|null,
    //     overBudget: <.state/over-budget.json>|[],
    //     tasksOverBudget: [taskId…] derived from aggregateByTask }
    // budgetPerTaskUSD is null when the env var is unset/empty/non-numeric → the
    // panel degrades gracefully (no threshold, no over-budget list). __untagged__
    // is never treated as an over-budget "task" (it has no Linear identity).
    if (path === '/api/budget') {
      const raw = process.env.COST_BUDGET_USD_PER_TASK;
      const budget =
        raw != null && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
      const byTask = (await telemetrySummary()).byTask;
      const tasksOverBudget =
        budget != null
          ? Object.keys(byTask).filter(
              (k) => k !== '__untagged__' && (byTask[k].partialCostUSD ?? byTask[k].costUSD ?? 0) > budget,
            )
          : [];
      let overBudget = [];
      try {
        const txt = await readFile('.state/over-budget.json', 'utf8');
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) overBudget = parsed;
      } catch {
        // file absent / unreadable / invalid → empty (graceful)
      }
      json(res, 200, { budgetPerTaskUSD: budget, overBudget, tasksOverBudget });
      log(method, path, 200);
      return;
    }

    // GET /api/linear/queue?workspace=jointhubs (L1a — control-plane-plan §3.1)
    //   Linear tasks enriched with `suggestedSquad` (read-only). 60 s cache per
    //   workspace. Graceful degrade: missing key / Linear error → 200 with
    //   `tasks:[]` + `error` (never 5xx) so the dashboard stays up and --smoke
    //   passes without network. `cached:true` marks a cache hit (AC3).
    if (path === '/api/linear/queue') {
      const workspace = (url.searchParams.get('workspace') || 'jointhubs').toLowerCase();
      if (workspace !== 'jointhubs' && workspace !== 'pisi') {
        json(res, 400, { error: `unknown workspace: ${workspace}` });
        log(method, path, 400);
        return;
      }
      const nowMs = Date.now();
      if (
        queueCache &&
        queueCache.workspace === workspace &&
        nowMs - queueCache.ts < QUEUE_TTL_MS
      ) {
        json(res, 200, { ...queueCache.payload, cached: true });
        log(method, path, 200);
        return;
      }
      const payload = await fetchLinearQueue(workspace);
      queueCache = { workspace, ts: nowMs, payload };
      json(res, 200, { ...payload, cached: false });
      log(method, path, 200);
      return;
    }

    // GET /api/live
    if (path === '/api/live') {
      const cutoff = Date.now() - 10 * 60 * 1000;
      const data = (await telemetryRuns()).filter((run) =>
        !run.endedAt || new Date(run.endedAt).getTime() >= cutoff,
      );
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

    // GET /api/flow/trace?taskId=… + GET /api/flow/patterns.
    if (path === '/api/flow/trace' || path === '/api/flow/patterns') {
      const taskId = url.searchParams.get('taskId') || '';
      if (path === '/api/flow/trace' && !taskId) {
        json(res, 400, { error: 'taskId query param is required' });
        log(method, path, 400);
        return;
      }
      const db = telemetryStore.openTelemetryDb();
      try {
        const result = path === '/api/flow/trace'
          ? telemetryStore.queryTrace(db, taskId)
          : telemetryStore.queryPatterns(db, {
              squad: url.searchParams.get('squad') || undefined,
              agent: url.searchParams.get('agent') || undefined,
            });
        json(res, 200, result);
        log(method, path, 200);
      } finally {
        db.close();
      }
      return;
    }

    // GET /api/flow — interactive Overview: squad -> agent(step) aggregation.
    // Data source: scanRuns() byAgent (turn counts + model mix, see ledger).
    if (path === '/api/flow') {
      const runs = await telemetryRuns();
      const flow = ledger.aggregateFlow(runs);
      json(res, 200, { generatedAt: new Date().toISOString(), squads: flow.squads });
      log(method, path, 200);
      return;
    }

    // GET /api/flow/log?runId=<id>&agent=<key> — full turn log (model
    // responses + tool_use summaries) for one pipeline step in one run.
    // Graceful degrade: run without a locatable transcript -> 200 + error
    // field (matches /api/linear/queue convention), so the UI stays up.
    // Query params:
    //   includeUser=1 — also return user turns (operator messages)
    //   full=1        — disable text truncation (maxTextLen: null)
    if (path === '/api/flow/log') {
      const runId = url.searchParams.get('runId') || '';
      const agent = url.searchParams.get('agent') || '';
      if (!runId || !agent) {
        json(res, 400, { error: 'runId and agent query params are required' });
        log(method, path, 400);
        return;
      }
      const runs = await telemetryRuns();
      const run = runs.find((r) => r.runId === runId);
      if (!run) {
        json(res, 404, { error: 'run not found: ' + runId });
        log(method, path, 404);
        return;
      }
      const transcriptPath =
        run.transcriptPath ||
        (run.sessionId ? join(ledger.listTranscriptDir(), run.sessionId + '.jsonl') : null);
      if (!transcriptPath) {
        json(res, 200, {
          runId, agent, squad: run.squad, taskId: run.taskId,
          turns: [], error: 'no transcript located for this run',
        });
        log(method, path, 200);
        return;
      }
      const windowStart = run.startedAt ? new Date(run.startedAt).getTime() : null;
      const windowEnd = run.endedAt
        ? new Date(run.endedAt).getTime() + 60 * 1000
        : Date.now() + 60 * 1000;
      const extractOpts = { windowStart, windowEnd };
      if (url.searchParams.get('includeUser') === '1') extractOpts.includeUser = true;
      if (url.searchParams.get('full') === '1') extractOpts.maxTextLen = null;
      const turns = ledger.extractAgentTurns(transcriptPath, agent, extractOpts);
      json(res, 200, { runId, agent, squad: run.squad, taskId: run.taskId, turns });
      log(method, path, 200);
      return;
    }

    // GET /api/prompts — full prompt tree for the UI
    if (path === '/api/prompts') {
      json(res, 200, buildPromptTree(root));
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/role?squad=&role= — single role doc
    if (path === '/api/prompts/role') {
      const squad = url.searchParams.get('squad') || '';
      const role = url.searchParams.get('role') || '';
      if (!squad || !role) {
        json(res, 400, { error: 'squad and role query params are required' });
        log(method, path, 400);
        return;
      }
      const doc = readRoleDoc(squad, role, root);
      if (doc.error) {
        const status = doc.error === 'not found' ? 404 : 400;
        json(res, status, doc);
        log(method, path, status);
        return;
      }
      json(res, 200, doc);
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/lead?squad= — squad lead CLAUDE.md
    if (path === '/api/prompts/lead') {
      const squad = url.searchParams.get('squad') || '';
      if (!squad) {
        json(res, 400, { error: 'squad query param is required' });
        log(method, path, 400);
        return;
      }
      const doc = readLeadDoc(squad, root);
      if (doc.error) {
        const status = doc.error === 'not found' ? 404 : 400;
        json(res, status, doc);
        log(method, path, status);
        return;
      }
      json(res, 200, doc);
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/refs?squad=&role= — context graph behind a prompt
    // (which files the squad/role actually pulls in — docs/ui/prompt-context-tracing.md)
    if (path === '/api/prompts/refs') {
      const squad = url.searchParams.get('squad') || '';
      const role = url.searchParams.get('role') || null;
      if (!squad) {
        json(res, 400, { error: 'squad query param is required' });
        log(method, path, 400);
        return;
      }
      const result = resolvePromptRefs(root, { squad, role });
      if (result.error) {
        const status = result.error === 'not found' ? 404 : 400;
        json(res, status, result);
        log(method, path, status);
        return;
      }
      json(res, 200, result);
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/roots — editable prompt documents outside the repo
    // (~/.claude, hermes). Allowlist: config/prompt-roots.json.
    if (path === '/api/prompts/roots') {
      json(res, 200, { files: listExternalPromptFiles(root) });
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/file?path= — content of one context file.
    // Authorisation lives in readContextFile / readExternalFile: the path must
    // be referenced by some prompt AND resolve inside the repo, or match a
    // configured external root. Do not loosen it here.
    if (path === '/api/prompts/file') {
      const relPath = url.searchParams.get('path') || '';
      const doc = isExternalPath(relPath)
        ? readExternalFile(root, relPath)
        : readContextFile(root, relPath);
      if (doc.error) {
        const status = doc.error.startsWith('forbidden')
          ? 403
          : doc.error === 'not found'
            ? 404
            : 400;
        json(res, status, doc);
        log(method, path, status);
        return;
      }
      json(res, 200, doc);
      log(method, path, 200);
      return;
    }

    // GET /api/prompts/runs?squad=&limit=10 — recent runs for a squad
    if (path === '/api/prompts/runs') {
      const squad = url.searchParams.get('squad') || '';
      let limit = parseInt(url.searchParams.get('limit'), 10) || 10;
      if (limit > 50) limit = 50;
      if (limit < 1) limit = 10;
      if (!squad) {
        json(res, 400, { error: 'squad query param is required' });
        log(method, path, 400);
        return;
      }
      const allRuns = await telemetryRuns();
      const filtered = allRuns
        .filter((r) => r.squad === squad)
        .slice(0, limit)
        .map((r) => ({
          runId: r.runId,
          taskId: r.taskId || null,
          status: r.status,
          startedAt: r.startedAt,
          costUSD: r.totals?.costUSD ?? null,
          partialCostUSD: r.totals?.partialCostUSD ?? null,
          unpricedUsageCount: r.totals?.unpricedUsageCount ?? 0,
          squad: r.squad,
        }));
      json(res, 200, filtered);
      log(method, path, 200);
      return;
    }

    // GET /api/squad-config
    if (path === '/api/squad-config') {
      json(res, 200, readSquadConfig(root));
      log(method, path, 200);
      return;
    }

    // GET /api/terminals — terminal panel: alive + finished runs with window info
    if (path === '/api/terminals') {
      const runs = withManifestConsolePid(await telemetryRuns());
      const data = listTerminals(runs, { finishedLimit: 15 });
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

    // GET /api/tools — tool catalog from config/tools.json
    if (path === '/api/tools') {
      json(res, 200, readToolCatalog(root));
      log(method, path, 200);
      return;
    }

    // --- Static file serving (ui/dist) ---
    // Only for non-/api/ paths. Serves the built React dashboard so the whole
    // app runs as a single process (no Vite dev server needed in production).
    if (!path.startsWith('/api/')) {
      const uiDist = join(root, 'ui', 'dist');
      const indexPath = join(uiDist, 'index.html');

      // Resolve the requested path relative to ui/dist
      let relPath = path.replace(/^\/+/, ''); // strip leading slashes
      if (!relPath) relPath = 'index.html';
      const filePath = join(uiDist, relPath);

      // Path traversal guard: normalized path must stay inside ui/dist
      const normalized = join(uiDist, relPath);
      if (!normalized.startsWith(uiDist + '\\') && !normalized.startsWith(uiDist + '/')) {
        json(res, 403, { error: 'forbidden' });
        log(method, path, 403);
        return;
      }

      // Try to serve the file
      try {
        const st = await stat(normalized);
        const servePath = st.isDirectory() ? join(normalized, 'index.html') : normalized;

        // MIME by extension
        const ext = extname(servePath).toLowerCase();
        const mime = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.woff2': 'font/woff2',
          '.map': 'application/json',
        }[ext] || 'application/octet-stream';

        // Cache: hashed assets get immutable, index.html gets no-cache
        const cacheControl = servePath.includes('assets' + '\\') || servePath.includes('assets/')
          ? 'public, max-age=31536000, immutable'
          : ext === '.html'
            ? 'no-cache'
            : 'public, max-age=3600';

        const content = await readFile(servePath);
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': cacheControl,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(content);
        log(method, path, 200);
        return;
      } catch (err) {
        if (err.code === 'ENOENT') {
          // SPA fallback: paths without a file extension → index.html
          const hasExt = extname(path) !== '';
          if (!hasExt) {
            try {
              const indexContent = await readFile(indexPath);
              res.writeHead(200, {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*',
              });
              res.end(indexContent);
              log(method, path, 200);
              return;
            } catch (indexErr) {
              if (indexErr.code === 'ENOENT') {
                json(res, 503, { error: 'UI nie został zbudowany. Uruchom: npm --prefix ui run build' });
                log(method, path, 503);
                return;
              }
              throw indexErr;
            }
          }
          // File with extension not found → 404
          json(res, 404, { error: 'not found' });
          log(method, path, 404);
          return;
        }
        throw err;
      }
    } // end static file serving (non-/api/ paths)

    // --- Fallback: unknown path ---
    json(res, 404, { error: 'not found' });
    log(method, path, 404);
  } catch (err) {
    json(res, 500, { error: err.message });
    log(method, path, 500);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Telemetry server listening on http://127.0.0.1:${PORT} (loopback only — POST /api/launch is local-only, §5)`);

  void bootstrapTelemetry().catch((error) => console.error(`[telemetry] bootstrap failed: ${error.message}`));
  const ingestTimer = isSmoke ? null : setInterval(ingestTelemetry, 15_000);
  ingestTimer?.unref();

  if (isSmoke) {
    console.log('Smoke mode — will self-check endpoints then shut down');

    // B1: smoke now also exercises the API surface (ledger load + endpoints
    // return 200) so that additive changes to aggregateRun()'s result shape
    // are covered by more than just process startup.
    const smokePaths = [
      '/api/runs',
      '/api/summary',
      '/api/cost-per-task',
      '/api/delegation-outcomes',
      '/api/budget',
      '/api/telemetry/health',
      '/api/linear/queue?workspace=jointhubs',
      '/api/live',
      '/api/flow',
      '/api/flow/patterns',
    ];
    // L1b: also exercise POST /api/launch validation. dryRun=true returns 200
    // WITHOUT spawning a window (so smoke is safe to run in CI / headless);
    // the bad-input cases assert 400 (AC2). No real agent is started.
    // D-S1: the two origin cases assert the CSRF defense — a cross-site Origin
    // → 403, the dashboard's loopback Origin → 200 (with dryRun, no spawn).
    const smokePosts = [
      { name: 'dryRun valid', body: { taskId: 'JOI-51', squad: 'dev', target: 'local', dryRun: true }, expect: 200 },
      { name: 'bad taskId', body: { taskId: 'evil!', squad: 'dev', target: 'local' }, expect: 400 },
      { name: 'bad squad', body: { taskId: 'JOI-51', squad: 'pwn', target: 'local' }, expect: 400 },
      { name: 'bad target', body: { taskId: 'JOI-51', squad: 'dev', target: 'mars' }, expect: 400 },
      { name: 'cross-site origin', body: { taskId: 'JOI-51', squad: 'dev', target: 'local', dryRun: true }, origin: 'https://evil.com', expect: 403 },
      { name: 'dashboard origin', body: { taskId: 'JOI-51', squad: 'dev', target: 'local', dryRun: true }, origin: 'http://localhost:5173', expect: 200 },
    ];
    setTimeout(async () => {
      let failed = false;
      try {
        const base = `http://127.0.0.1:${PORT}`;
        for (const p of smokePaths) {
          const res = await fetch(base + p);
          const ok = res.ok;
          console.log(`  smoke GET ${p} -> ${res.status} ${ok ? 'OK' : 'FAIL'}`);
          if (!ok) failed = true;
        }
        for (const c of smokePosts) {
          const headers = { 'Content-Type': 'application/json' };
          if (c.origin) headers.Origin = c.origin;
          const res = await fetch(base + '/api/launch', {
            method: 'POST',
            headers,
            body: JSON.stringify(c.body),
          });
          const ok = res.status === c.expect;
          console.log(`  smoke POST /api/launch ${c.name} -> ${res.status} ${ok ? 'OK' : 'FAIL'}`);
          if (!ok) failed = true;
        }
      } catch (err) {
        console.error('  smoke fetch error:', err.message);
        failed = true;
      }

      if (failed) {
        console.error('Smoke test FAILED.');
        server.close(() => process.exit(1));
      } else {
        console.log('Smoke test complete, shutting down.');
        server.close(() => process.exit(0));
      }
    }, 500);
  }
});

// scripts/telemetry-server.mjs
// Telemetry HTTP API — reads .state/runs + transcripts via ledger.mjs
// Usage: node scripts/telemetry-server.mjs [--smoke]
//   --smoke: start, print ready, auto-shutdown after 10s (for CI/manual smoke test)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Reuse the shared Linear GraphQL client (linear-client.mjs) — the same layer
// linear-query.mjs is built on. A workspace-wide query (all teams) isn't
// expressible via the team-scoped linear-query CLI, so we call graphql()
// directly. No MCP, no new client (control-plane-plan §3.1, DoD "reuse
// scripts/linear-query.mjs" = reuse the Linear query layer).
import { loadEnv, graphql } from './linear-client.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

// Load .env so the Linear API keys (LINEAR_API_KEY / LINEAR_API_KEY_PISI) are
// available to chooseApiKey() inside graphql(). Benign for other endpoints —
// loadEnv only sets vars that aren't already set.
loadEnv();

const PORT = parseInt(process.env.TELEMETRY_PORT, 10) || 7331;
const isSmoke = process.argv.includes('--smoke');

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

function log(method, path, status) {
  console.log(`${method} ${path} -> ${status}`);
}

// ---------------------------------------------------------------------------
// Summary builder — aggregates scanRuns() output into the /api/summary shape
// ---------------------------------------------------------------------------

function buildSummary(runs) {
  const totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 };
  const bySquad = {};
  const byModel = {};
  const byDay = {};

  for (const run of runs) {
    const t = run.totals || {};
    totals.runs += 1;
    totals.inputTokens += t.inputTokens || 0;
    totals.outputTokens += t.outputTokens || 0;
    totals.costUSD += t.costUSD || 0;

    // bySquad
    const squad = run.squad || 'unknown';
    if (!bySquad[squad]) bySquad[squad] = { runs: 0, costUSD: 0, tokens: 0 };
    bySquad[squad].runs += 1;
    bySquad[squad].costUSD += t.costUSD || 0;
    bySquad[squad].tokens += (t.inputTokens || 0) + (t.outputTokens || 0);

    // byModel
    const models = run.byModel || {};
    for (const [slug, m] of Object.entries(models)) {
      if (!byModel[slug]) byModel[slug] = { tokens: 0, costUSD: 0 };
      byModel[slug].tokens += (m.inputTokens || 0) + (m.outputTokens || 0);
      byModel[slug].costUSD += m.costUSD || 0;
    }

    // byDay — extract YYYY-MM-DD from startedAt ISO string
    const day = (run.startedAt || '').slice(0, 10);
    if (day) {
      if (!byDay[day]) byDay[day] = { runs: 0, costUSD: 0 };
      byDay[day].runs += 1;
      byDay[day].costUSD += t.costUSD || 0;
    }
  }

  return { totals, bySquad, byModel, byDay, byTask: ledger.aggregateByTask(runs) };
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
function suggestedSquad(task, rules) {
  const labels = new Set(task.labels || []);
  for (const rule of rules) {
    const w = rule.when || {};
    if (w.state && task.state !== w.state) continue;
    if (w.labels && w.labels.length) {
      const ok = w.labels.every((l) => {
        if (l.endsWith(':*')) {
          const prefix = l.slice(0, -1);
          return [...labels].some((t) => t.startsWith(prefix));
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
  const apiKey =
    workspace === 'pisi' ? process.env.LINEAR_API_KEY_PISI : process.env.LINEAR_API_KEY;
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
        const teamsData = await graphql(TEAMS_QUERY);
        const teams = teamsData?.teams?.nodes || [];
        // Fetch each team's issues in parallel — one low-complexity query each.
        const perTeam = await Promise.all(
          teams.map((t) =>
            graphql(TEAM_ISSUES_QUERY, { teamId: t.id }).then((d) => ({
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

    // --- Only GET is supported (POST/PUT/DELETE → 404) ---
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

    // GET /api/runs
    if (path === '/api/runs') {
      const data = await ledger.scanRuns();
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

    // GET /api/runs/:runId
    const runsMatch = path.match(/^\/api\/runs\/(.+)$/);
    if (runsMatch) {
      const runId = runsMatch[1];
      const runs = await ledger.scanRuns();
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
      const runs = await ledger.scanRuns();
      const summary = buildSummary(runs);
      json(res, 200, summary);
      log(method, path, 200);
      return;
    }

    // GET /api/cost-per-task
    if (path === '/api/cost-per-task') {
      const data = await ledger.aggregateByTask(await ledger.scanRuns());
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
      const byTask = ledger.aggregateByTask(await ledger.scanRuns());
      const tasksOverBudget =
        budget != null
          ? Object.keys(byTask).filter(
              (k) => k !== '__untagged__' && (byTask[k].costUSD || 0) > budget,
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
      const data = await ledger.liveRuns();
      json(res, 200, data);
      log(method, path, 200);
      return;
    }

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

server.listen(PORT, () => {
  console.log(`Telemetry server listening on http://localhost:${PORT}`);

  if (isSmoke) {
    console.log('Smoke mode — will self-check endpoints then shut down');

    // B1: smoke now also exercises the API surface (ledger load + endpoints
    // return 200) so that additive changes to aggregateRun()'s result shape
    // are covered by more than just process startup.
    const smokePaths = [
      '/api/runs',
      '/api/summary',
      '/api/cost-per-task',
      '/api/budget',
      '/api/linear/queue?workspace=jointhubs',
      '/api/live',
    ];
    setTimeout(async () => {
      let failed = false;
      try {
        const base = `http://localhost:${PORT}`;
        for (const p of smokePaths) {
          const res = await fetch(base + p);
          const ok = res.ok;
          console.log(`  smoke ${p} -> ${res.status} ${ok ? 'OK' : 'FAIL'}`);
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

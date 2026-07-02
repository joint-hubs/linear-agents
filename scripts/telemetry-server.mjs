// scripts/telemetry-server.mjs
// Telemetry HTTP API — reads .state/runs + transcripts via ledger.mjs
// Usage: node scripts/telemetry-server.mjs [--smoke]
//   --smoke: start, print ready, auto-shutdown after 10s (for CI/manual smoke test)

import { createServer } from 'node:http';

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
    const smokePaths = ['/api/runs', '/api/summary', '/api/cost-per-task', '/api/live'];
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

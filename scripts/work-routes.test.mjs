// Route-level tests for the Work board and Costs & quality endpoints
// (telemetry-server.mjs's FOC-784/785 block, implemented in work-routes.mjs).
//
// Follows cockpit-routes.test.mjs: the REAL telemetry-server spawned (twice:
// Docker mode against a fake session host, native mode without
// FENIX_SUPERVISOR_HOST) with fully isolated seams — LA_TELEMETRY_DB,
// LA_TELEMETRY_HOME, LA_DATA_HOME, LA_SQUAD_HOME, LA_SUPERVISOR_STATE_HOME
// and LA_STATE_ROOT under one tmp dir — so the live stores and the repo's
// real .state tree are never touched.
//
// Linear is never contacted: the TEST-ONLY seam FENIX_LINEAR_FAKE_FILE (read
// by linearQueue in telemetry-server.mjs and by the issue/states fetches in
// work-routes.mjs, both guarded by NODE_ENV=test) serves a fixture file with
// the /api/linear/queue tasks and one issue per touched ticket.
//
// Proven here, over HTTP:
//   - the cost snapshot manager: the first /api/costs answers "computing"
//     while the cost-snapshot child runs, then "ok" with real numbers from
//     the temp store; /api/quality likewise;
//   - GET /api/costs?period= and /api/quality?period=: payloads and the 400
//     for a period outside 7d|30d|all;
//   - GET /api/work/tickets: payload shape, cost/linear meta, the touched
//     tickets' stages (dev from the child squad, landed from the Linear
//     state type) and the Ready column from the shared queue cache;
//   - GET /api/work/tickets/:id: 404 for an unknown non-queue id, 400 for a
//     non-identifier, the detail's cost reconciliation (transcript truth vs
//     telemetry vs registry, the missing-cost note);
//   - GET /api/work/tickets/:id/start-preview: the hand-off text, delivery
//     "supervisor" with a host / "cockpit" natively, 404 for an unknown
//     Linear issue;
//   - POST /api/work/tickets/:id/start: forwarded to the host /message
//     verbatim, 400 for a mismatched/missing text, 403 foreign origin,
//     503 docker-only natively;
//   - the publish trio (FOC-788): GET .../publish-preview (checkout, diff,
//     checks, confirmToken), POST .../push|pr — the guards and body shape,
//     the token binding (409 stale-preview, a moved head included) and 404
//     no-checkout with no action offered; the in-process block below drives
//     the same routes against a REAL git fixture (the push lands on a local
//     bare remote, the PR posts through a fake fetch) and proves the audit
//     trio, with the comment sink failing closed offline.
//
// The server children are ALWAYS killed in finally.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openTelemetryDb, makeEvent, applyEvent, pricingSnapshot } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";
import { cwdToHashName } from "./ledger.mjs";
import { spawnTestServer } from "./test-spawn.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ── fixtures: one tmp tree for every seam ────────────────────────────────────
//
// The env seams are set on THIS process before any library is imported (the
// same pattern cost-snapshot.test.mjs uses) — the cost-snapshot child the
// server spawns inherits them, and the in-process unit block below reads the
// same fixture. The seams are set here and left set (the static audit rejects
// unsetting them).

const dir = mkdtempSync(join(tmpdir(), "work-routes-"));
const dataHome = join(dir, "data"); // LA_DATA_HOME
const squadHome = join(dir, "agents"); // LA_SQUAD_HOME: transcript lookup
const supState = join(dir, "sup-state"); // LA_SUPERVISOR_STATE_HOME: registries
const runsDir = join(dir, "state-root", "runs"); // LA_STATE_ROOT
const dbPath = join(dir, "telemetry.sqlite");
const childWorktree = join(dir, "wt-work-1"); // the child's cwd (need not exist)

process.env.LA_TELEMETRY_DB = dbPath;
process.env.LA_TELEMETRY_HOME = join(dir, "telemetry-home");
process.env.LA_DATA_HOME = dataHome;
process.env.LA_SQUAD_HOME = squadHome;
process.env.LA_SUPERVISOR_STATE_HOME = supState;
process.env.LA_STATE_ROOT = join(dir, "state-root");

mkdirSync(join(dataHome, "supervisor"), { recursive: true });
mkdirSync(join(dataHome, "run"), { recursive: true });
// The host token the session-host client reads per request.
writeFileSync(join(dataHome, "run", "host.token"), "work-routes-test-token", "utf8");
mkdirSync(join(supState, "run-a"), { recursive: true });
mkdirSync(join(supState, "run-b"), { recursive: true });
mkdirSync(runsDir, { recursive: true });

// A valid sqlite store so the server's own bootstrap has somewhere to go.
{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

const NOW = "2026-10-13T12:00:00.000Z";
const T1 = "2026-10-13T08:00:00.000Z"; // dev-1 turn 1 start
const T2 = "2026-10-13T09:00:00.000Z"; // dev-1 turn 1 end
const T3 = "2026-10-13T10:00:00.000Z"; // dev-1 turn 2 start — the rework cutoff
const T4 = "2026-10-13T11:00:00.000Z"; // dev-1 turn 2 end

// ── the FOC-788 publish fixture: wt-work-1 is a REAL checkout ────────────────
//
// main ("seed") plus one work commit on the managed branch. Origin's FETCH
// URL is GitHub-shaped (the PR path parses owner/repo from it and posts
// through the test's fake fetch) while its PUSH URL is the local bare
// origin.git — a real `git push` lands offline and can never reach a
// network. The bare starts with main only; the publish tests assert the
// branch appears there, at exactly the pushed head.
const DEV_BRANCH = "work-1-dev-abc123def456"; // the spawn shape <teamKey>-<n>-<slug>-<hash12>
const ORIGIN_BARE = join(dir, "origin.git");
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return String(r.stdout ?? "").replace(/\r\n/g, "\n").trimEnd();
};

git(["init", "-b", "main", childWorktree]);
git(["config", "user.name", "Fixture"], childWorktree);
git(["config", "user.email", "fixture@example.invalid"], childWorktree);
writeFileSync(join(childWorktree, "README.md"), "seed\n");
git(["add", "README.md"], childWorktree);
git(["commit", "-m", "seed"], childWorktree);
git(["init", "--bare", ORIGIN_BARE]);
git(["symbolic-ref", "HEAD", "refs/heads/main"], ORIGIN_BARE);
git(["remote", "add", "origin", "https://github.com/joint-hubs/linear-agents"], childWorktree);
git(["remote", "set-url", "--push", "origin", ORIGIN_BARE], childWorktree);
git(["checkout", "-b", DEV_BRANCH], childWorktree);
writeFileSync(join(childWorktree, "feature.txt"), "feature\n");
git(["add", "feature.txt"], childWorktree);
git(["commit", "-m", "dev work"], childWorktree);
const DEV_HEAD = git(["rev-parse", "HEAD"], childWorktree);
const BASE_SHA = git(["rev-parse", "main"], childWorktree);

// run-a: WORK-1, one dev child whose transcript, telemetry run and registry
// cost all exist — the clean reconciliation case. Its child record carries
// the branch/worktree/baseRevision the publish checkout discovery reads.
writeFileSync(join(supState, "run-a", "children.json"), JSON.stringify({
  runId: "run-a",
  children: {
    "dev-1": {
      childId: "dev-1", squad: "dev", taskId: "WORK-1", status: "exited",
      sessionId: "sess-child-1", telemetryRunId: "tel-1", worktree: childWorktree,
      branch: DEV_BRANCH, baseRevision: BASE_SHA,
      costUsd: 0.005, model: "m1", startedAt: T1, endedAt: T4,
      turns: [
        { startedAt: T1, endedAt: T2, exitCode: 0 },
        { startedAt: T3, endedAt: T4, exitCode: 0 },
      ],
    },
  },
  rounds: {},
}), "utf8");
writeFileSync(join(supState, "run-a", "triage.json"), JSON.stringify({ issue: "WORK-1" }), "utf8");

// The verdict fixture (blocker regression, FOC-784 review): the server's
// collectTicketFacts runs on the supervisor-lib path (LA_SUPERVISOR_STATE_HOME
// is set), so the verdict reads go through readRegistry/roundsFor/verdictPath.
// Before the verdictPath import fix, a ticket WITH verdict files threw a
// ReferenceError there — every /api/work, /api/costs and /api/quality request
// 500'd. The records carry the real shape (round + verdict + recordedAt).
mkdirSync(join(supState, "run-a", "verdicts"), { recursive: true });
writeFileSync(join(supState, "run-a", "verdicts", "work-1-round1.json"),
  JSON.stringify({ round: 1, verdict: "fail", taskId: "WORK-1", recordedAt: T2 }), "utf8");
writeFileSync(join(supState, "run-a", "verdicts", "work-1-round2.json"),
  JSON.stringify({ round: 2, verdict: "pass", taskId: "WORK-1", recordedAt: T4 }), "utf8");

// run-b: WORK-2, one plan child with NO transcript, NO telemetry run and NO
// registry cost — the missing-cost note case.
writeFileSync(join(supState, "run-b", "children.json"), JSON.stringify({
  runId: "run-b",
  children: {
    "plan-1": {
      childId: "plan-1", squad: "plan", taskId: "WORK-2", status: "exited",
      sessionId: "sess-child-2", telemetryRunId: null, worktree: join(dir, "wt-work-2"),
      costUsd: null, model: "m1", startedAt: T1, endedAt: T2,
      turns: [{ startedAt: T1, endedAt: T2, exitCode: 0 }],
    },
  },
  rounds: {},
}), "utf8");
writeFileSync(join(supState, "run-b", "triage.json"), JSON.stringify({ issue: "WORK-2" }), "utf8");

// The dev child's transcript, priced by priceChildTranscripts' default
// pricing (the same the route uses) — two merged-by-id assistant messages.
const transcriptDir = join(squadHome, "dev", "projects", cwdToHashName(childWorktree));
mkdirSync(transcriptDir, { recursive: true });
writeFileSync(join(transcriptDir, "sess-child-1.jsonl"), [
  JSON.stringify({ type: "assistant", message: { id: "msg_1", model: "deepseek-v4-flash", usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  JSON.stringify({ type: "assistant", message: { id: "msg_2", model: "deepseek-v4-flash", usage: { input_tokens: 2000, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } } }),
  "",
].join("\n"), "utf8");

// ── the telemetry store: one priced child run with a rework split ────────────

let usageSeq = 0;
function usage(db, runId, at, inputTokens, { model = "deepseek-v4-flash" } = {}) {
  usageSeq++;
  return applyEvent(db, makeEvent("usage.recorded", {
    runId, agentKey: "_lead", model,
    observedAt: at, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  }, {
    runId, observedAt: at, sourceKind: "transcript",
    sourcePath: `C:/sessions/${runId}.jsonl`, sourceOffset: usageSeq,
  }));
}

{
  const db = openTelemetryDb(dbPath);
  applyEvent(db, makeEvent("run.started", { runId: "tel-1", squad: "dev", startedAt: T1 }, {
    runId: "tel-1", observedAt: T1, sourceKind: "test",
  }));
  applyEvent(db, makeEvent("task.linked", { runId: "tel-1", taskId: "WORK-1", source: "launch", confidence: 1 }, {
    runId: "tel-1", observedAt: T1, sourceKind: "test",
  }));
  usage(db, "tel-1", "2026-10-13T09:30:00.000Z", 100_000); // turn 1
  usage(db, "tel-1", "2026-10-13T10:30:00.000Z", 50_000);  // turn 2 — rework
  db.close();
}

// The expected per-run numbers, from the same CLI the server spawns (cutoff =
// turn 2's start, exactly what the route derives from the registry).
const cutoffsPath = join(dir, "cutoffs.json");
writeFileSync(cutoffsPath, JSON.stringify({ "tel-1": T3 }), "utf8");
const cli = spawnSync(process.execPath, [
  join(__dir, "cost-snapshot.mjs"), "--json", "--db", dbPath, "--cutoffs", cutoffsPath,
], { encoding: "utf8", env: { ...process.env } });
assert.equal(cli.status, 0, `cost-snapshot CLI failed: ${cli.stderr}`);
const expectedSnapshot = JSON.parse(cli.stdout);
const close = (a, b) => Math.abs(a - b) < 1e-9;

// The expected transcript truth, priced the same way the route prices it.
const expectedTranscript = priceChildTranscripts({
  configDir: join(squadHome, "dev"), cwd: childWorktree, sessionId: "sess-child-1",
});
assert.ok(expectedTranscript && expectedTranscript.costUsd != null && expectedTranscript.costUsd > 0,
  "fixture transcript must price");

// ── the TEST-ONLY Linear fixture ─────────────────────────────────────────────

const linearFixturePath = join(dir, "linear-fake.json");
writeFileSync(linearFixturePath, JSON.stringify({
  queue: {
    tasks: [{
      identifier: "WORK-3", title: "Ready ticket", url: "https://linear.app/jointhubs/issue/WORK-3",
      team: "FEN", state: "Todo", stateType: "unstarted", priority: 2, estimate: 3,
      updatedAt: NOW, assignee: null, labels: ["fenix"], parent: null, suggestedSquad: "dev",
    }],
    error: null,
    fetchedAt: NOW,
  },
  issues: {
    "WORK-1": {
      identifier: "WORK-1", title: "Fix the widget", url: "https://linear.app/jointhubs/issue/WORK-1",
      description: "Please fix the widget.\nStep two: verify it.",
      state: { name: "In Progress", type: "started" },
    },
    "WORK-2": {
      identifier: "WORK-2", title: "Land the docs", url: "https://linear.app/jointhubs/issue/WORK-2",
      description: "Docs task.",
      state: { name: "Done", type: "completed" },
    },
    "WORK-3": {
      identifier: "WORK-3", title: "Ready ticket", url: "https://linear.app/jointhubs/issue/WORK-3",
      description: "Ready to start.",
      state: { name: "Todo", type: "unstarted" },
    },
  },
}), "utf8");

// The publish paths are hermetic (FOC-788): the audit comment sink would
// otherwise spawn linear-ops with a real key and post to LIVE Linear, and the
// push executor reads a GitHub token before it touches git. Both are pinned
// here — an empty key plus the no-.env seam make the sink fail closed
// offline, and the secrets dir carries a fixture token (its remote is a local
// path, so git never needs it). Set here, left set — like the LA_* seams.
process.env.NODE_ENV = "test";
process.env.FENIX_LINEAR_FAKE_FILE = linearFixturePath;
process.env.LA_LINEAR_NO_ENV_FILE = "1";
process.env.LINEAR_API_KEY = "";
const fixtureSecrets = join(dir, "secrets-fixture");
mkdirSync(fixtureSecrets, { recursive: true });
writeFileSync(join(fixtureSecrets, "github_token"), "fixture-token\n");
process.env.LA_SECRETS_DIR = fixtureSecrets;

// ── the fake session host ────────────────────────────────────────────────────

const hostCalls = []; // { method, url, body }

const fakeHost = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw || null; }
  hostCalls.push({ method: req.method, url: req.url, body });
  if (req.url === "/message") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent: true, confirmed: true, queued: false }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => fakeHost.listen(0, "127.0.0.1", resolve));
const HOST_URL = `http://127.0.0.1:${fakeHost.address().port}`;

// ── server spawns ────────────────────────────────────────────────────────────

const baseEnv = {
  ...process.env,
  NODE_ENV: "test",
  FENIX_LINEAR_FAKE_FILE: linearFixturePath,
  FENIX_COST_SNAPSHOT_TTL_MS: "60000",
};

// Shared spawn helper (FOC-840): free port + health poll + tree-kill stop().
const spawnWorkServer = (env) => spawnTestServer({
  script: join(__dir, "telemetry-server.mjs"),
  env,
  label: "work-routes",
});

async function call(port, method, path, { origin = "http://localhost:5173", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll an endpoint until `predicate(body)` holds, or fail after `ms`. */
async function pollUntil(port, path, predicate, ms = 30000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(port, "GET", path);
    if (last.status === 200 && last.body && predicate(last.body)) return last;
    await sleep(200);
  }
  throw new Error(`poll timeout on ${path}: ${JSON.stringify(last?.body).slice(0, 300)}`);
}

// ── run the two server scenarios ─────────────────────────────────────────────

let servers = [];
try {
  // ── Docker mode: fake host + fake Linear ─────────────────────────────────
  {
    const spawned = await spawnWorkServer({ ...baseEnv, FENIX_SUPERVISOR_HOST: HOST_URL });
    servers.push(spawned);
    const child = spawned.child;
    const P = spawned.port;

    // The FIRST board request, before any cost snapshot exists: the cost meta
    // says "computing" and stale must be false with it (consistent with
    // /api/costs), and the route must answer 200 — before the verdictPath
    // import fix the facts sweep threw on WORK-1's verdict files and this 500'd.
    const boardFirst = await call(P, "GET", "/api/work/tickets");
    check("board first -> 200, computing with stale false",
      boardFirst.status === 200 && boardFirst.body?.cost?.state === "computing" && boardFirst.body?.cost?.stale === false,
      JSON.stringify(boardFirst.body?.cost));
    const boardFirstWork1 = (boardFirst.body?.tickets ?? []).find((t) => t.taskId === "WORK-1");
    check("board first WORK-1 has two verdict rounds, last PASS (lib verdict path)",
      boardFirstWork1?.rounds === 2 && boardFirstWork1?.lastVerdict?.verdict === "PASS"
        && boardFirstWork1?.lastVerdict?.round === 2,
      JSON.stringify(boardFirstWork1?.lastVerdict));

    // The FIRST /api/costs request: the snapshot child has not run yet — the
    // route answers "computing" with null numbers immediately, never a
    // blocked event loop (FOC-547).
    const costs1 = await call(P, "GET", "/api/costs");
    check("costs first -> 200 computing", costs1.status === 200 && costs1.body?.state === "computing",
      JSON.stringify(costs1.body).slice(0, 200));
    check("costs computing -> null kpis, no invented numbers",
      costs1.body?.kpis?.totalUsd === null && costs1.body?.period === "30d" && costs1.body?.stale === false,
      JSON.stringify(costs1.body?.kpis));

    // The snapshot child lands (temp store) → "ok" with the real numbers.
    const costs = await pollUntil(P, "/api/costs", (b) => b.state === "ok");
    check("costs -> ok, stale false", costs.body?.stale === false && typeof costs.body?.computedAt === "string",
      JSON.stringify({ state: costs.body?.state, computedAt: costs.body?.computedAt }));
    check("costs kpis totalUsd = the child run's cost",
      close(costs.body?.kpis?.totalUsd, expectedSnapshot.runs["tel-1"].usd),
      `totalUsd=${costs.body?.kpis?.totalUsd} expected=${expectedSnapshot.runs["tel-1"].usd}`);
    check("costs kpis childrenPerTicket has one ticket with cost",
      costs.body?.kpis?.childrenPerTicket?.n === 1 && close(costs.body?.kpis?.childrenPerTicket?.p50, expectedSnapshot.runs["tel-1"].usd),
      JSON.stringify(costs.body?.kpis?.childrenPerTicket));
    check("costs byModel carries the priced model",
      (costs.body?.byModel ?? []).some((m) => m.usd > 0), JSON.stringify(costs.body?.byModel));
    check("costs mostExpensive names WORK-1 with a why",
      (costs.body?.mostExpensive ?? []).some((t) => t.taskId === "WORK-1" && typeof t.why?.rule === "string"),
      JSON.stringify(costs.body?.mostExpensive));
    check("costs carries definitions", typeof costs.body?.definitions?.totalUsd === "string");

    const costs7 = await call(P, "GET", "/api/costs?period=7d");
    check("costs 7d -> 200 with the period", costs7.status === 200 && costs7.body?.period === "7d", JSON.stringify(costs7.body?.period));
    const costsAll = await call(P, "GET", "/api/costs?period=all");
    check("costs all -> 200", costsAll.status === 200 && costsAll.body?.period === "all", JSON.stringify(costsAll.body?.period));
    const badPeriod = await call(P, "GET", "/api/costs?period=5d");
    check("costs bad period -> 400", badPeriod.status === 400, `got ${badPeriod.status}`);

    // /api/quality — the four signals, with landingYield counting WORK-1
    // (dev child, Linear state started → not landed) in the denominator.
    const quality = await call(P, "GET", "/api/quality?period=all");
    check("quality -> 200 ok", quality.status === 200 && quality.body?.state === "ok", JSON.stringify(quality.body).slice(0, 200));
    check("quality four signals",
      JSON.stringify((quality.body?.signals ?? []).map((s) => s.key).sort())
      === '["firstTimeRight","interventionsPerTicket","landingYield","reworkShare"]',
      JSON.stringify(quality.body?.signals?.map((s) => s.key)));
    const yieldSignal = (quality.body?.signals ?? []).find((s) => s.key === "landingYield");
    check("quality landingYield: WORK-1 has a dev child and is not landed",
      yieldSignal?.denominator === 1 && yieldSignal?.numerator === 0 && yieldSignal?.value === 0,
      JSON.stringify(yieldSignal));
    const badQuality = await call(P, "GET", "/api/quality?period=fortnight");
    check("quality bad period -> 400", badQuality.status === 400, `got ${badQuality.status}`);

    // The shared Linear queue: the fixture seam serves it, cached:false.
    const queue = await call(P, "GET", "/api/linear/queue?workspace=jointhubs");
    check("linear queue via the fake seam", queue.status === 200 && queue.body?.tasks?.[0]?.identifier === "WORK-3",
      JSON.stringify(queue.body).slice(0, 200));

    // GET /api/work/tickets — the board.
    const board = await pollUntil(P, "/api/work/tickets", (b) => b.cost?.state === "ok");
    check("board -> 200 with the contract keys",
      ["computedAt", "cost", "linear", "columns", "tickets"].every((k) => k in board.body),
      Object.keys(board.body ?? {}).join(","));
    check("board cost meta ok and not stale",
      board.body?.cost?.state === "ok" && board.body?.cost?.stale === false && typeof board.body?.cost?.computedAt === "string",
      JSON.stringify(board.body?.cost));
    check("board linear meta ok",
      board.body?.linear?.ok === true && board.body?.linear?.error === null && typeof board.body?.linear?.fetchedAt === "string",
      JSON.stringify(board.body?.linear));
    check("board columns are the six stages",
      JSON.stringify(board.body?.columns) === '["ready","plan","dev","review","test","landed"]',
      JSON.stringify(board.body?.columns));
    const byId = Object.fromEntries((board.body?.tickets ?? []).map((t) => [t.taskId, t]));
    check("board WORK-1 stage dev from the latest child's squad",
      byId["WORK-1"]?.stage === "dev", JSON.stringify(byId["WORK-1"]));
    check("board WORK-1 cost from the snapshot",
      close(byId["WORK-1"]?.cost?.childrenUsd, expectedSnapshot.runs["tel-1"].usd)
        && close(byId["WORK-1"]?.cost?.totalUsd, expectedSnapshot.runs["tel-1"].usd),
      JSON.stringify(byId["WORK-1"]?.cost));
    check("board WORK-2 landed from the Linear state type",
      byId["WORK-2"]?.stage === "landed" && byId["WORK-2"]?.linearState?.type === "completed",
      JSON.stringify(byId["WORK-2"]));
    check("board WORK-1 carries the fixture title",
      byId["WORK-1"]?.title === "Fix the widget"
        && byId["WORK-1"]?.url === "https://linear.app/jointhubs/issue/WORK-1"
        && byId["WORK-1"]?.linearState?.name === "In Progress"
        && byId["WORK-1"]?.priority === null
        && byId["WORK-1"]?.milestone === null,
      JSON.stringify(byId["WORK-1"]));
    check("board WORK-3 ready from the queue (not touched)",
      byId["WORK-3"]?.stage === "ready" && byId["WORK-3"]?.title === "Ready ticket",
      JSON.stringify(byId["WORK-3"]));

    // (The queue CACHE is shared with the board by construction — both call
    // the same linearQueue() getter; the fake seam bypasses the cache, so a
    // `cached` flag is not observable here.)

    // GET /api/work/tickets/WORK-1 — the detail with the clean reconciliation.
    const detail = await call(P, "GET", "/api/work/tickets/WORK-1");
    check("detail -> 200", detail.status === 200, JSON.stringify(detail.body).slice(0, 200));
    check("detail ticket is WORK-1", detail.body?.ticket?.taskId === "WORK-1", JSON.stringify(detail.body?.ticket));
    check("detail ticket carries rounds 2 and lastVerdict PASS",
      detail.body?.ticket?.rounds === 2 && detail.body?.ticket?.lastVerdict?.verdict === "PASS"
        && detail.body?.ticket?.lastVerdict?.round === 2,
      JSON.stringify(detail.body?.ticket?.lastVerdict));
    check("detail timeline carries both verdict events, FAIL then PASS",
      JSON.stringify((detail.body?.timeline ?? []).filter((e) => e.kind === "verdict").map((e) => e.text))
        === '["review round 1: FAIL","review round 2: PASS"]',
      JSON.stringify(detail.body?.timeline?.filter((e) => e.kind === "verdict")));
    check("detail issue carries the description",
      detail.body?.issue?.identifier === "WORK-1" && detail.body?.issue?.description?.includes("fix the widget"),
      JSON.stringify(detail.body?.issue));
    check("detail children list the dev child", (detail.body?.children ?? []).length === 1, JSON.stringify(detail.body?.children));
    check("detail timeline is an array", Array.isArray(detail.body?.timeline));
    const rec = detail.body?.cost?.reconciliation;
    check("detail reconciliation transcriptUsd = the transcript truth",
      rec && close(rec.transcriptUsd, expectedTranscript.costUsd),
      `transcriptUsd=${rec?.transcriptUsd} expected=${expectedTranscript.costUsd}`);
    check("detail reconciliation telemetryUsd = the snapshot's run cost",
      rec && close(rec.telemetryUsd, expectedSnapshot.runs["tel-1"].usd),
      `telemetryUsd=${rec?.telemetryUsd} expected=${expectedSnapshot.runs["tel-1"].usd}`);
    check("detail reconciliation registryUsd = the registry costUsd",
      rec && close(rec.registryUsd, 0.005), `registryUsd=${rec?.registryUsd}`);
    check("detail reconciliation ratio = telemetry / transcript",
      rec && rec.ratio != null && close(rec.ratio, rec.telemetryUsd / rec.transcriptUsd), JSON.stringify(rec));
    check("detail reconciliation has nothing missing", rec?.note === null, JSON.stringify(rec?.note));

    // GET /api/work/tickets/WORK-2 — the missing-cost note case.
    const detail2 = await call(P, "GET", "/api/work/tickets/WORK-2");
    const rec2 = detail2.body?.cost?.reconciliation;
    check("detail WORK-2 reconciliation notes the missing costs",
      rec2 && rec2.note !== null && rec2.ratio === null && rec2.transcriptUsd === 0 && rec2.registryUsd === 0,
      JSON.stringify(rec2));

    // Unknown / malformed ids.
    const unknown = await call(P, "GET", "/api/work/tickets/WORK-404");
    check("detail unknown non-queue id -> 404", unknown.status === 404, `got ${unknown.status}`);
    const malformed = await call(P, "GET", "/api/work/tickets/work-1");
    check("detail malformed id -> 400", malformed.status === 400, `got ${malformed.status}`);

    // A malformed percent-encoding must be a clean 400, not an unhandled
    // decodeURIComponent throw.
    const badPct = await call(P, "GET", "/api/work/tickets/%ZZ");
    check("detail %ZZ -> 400 bad-id", badPct.status === 400 && badPct.body?.error === "bad-id", JSON.stringify(badPct.body));
    const badPctPreview = await call(P, "GET", "/api/work/tickets/%ZZ/start-preview");
    check("start-preview %ZZ -> 400 bad-id", badPctPreview.status === 400 && badPctPreview.body?.error === "bad-id",
      JSON.stringify(badPctPreview.body));
    const badPctStart = await call(P, "POST", "/api/work/tickets/%ZZ/start", { body: { text: "Start ticket %ZZ: x" } });
    check("start %ZZ -> 400 bad-id", badPctStart.status === 400 && badPctStart.body?.error === "bad-id",
      JSON.stringify(badPctStart.body));

    // GET /api/work/tickets/WORK-1/start-preview — the hand-off text.
    const preview = await call(P, "GET", "/api/work/tickets/WORK-1/start-preview");
    check("preview -> 200 supervisor delivery",
      preview.status === 200 && preview.body?.delivery === "supervisor", JSON.stringify(preview.body));
    check("preview text is the hand-off for THIS ticket",
      typeof preview.body?.text === "string"
      && preview.body.text.startsWith("Start ticket WORK-1: Fix the widget")
      && preview.body.text.includes("fix the widget"),
      JSON.stringify(preview.body?.text));
    check("preview issue block", preview.body?.issue?.identifier === "WORK-1" && typeof preview.body?.issue?.url === "string",
      JSON.stringify(preview.body?.issue));
    const previewUnknown = await call(P, "GET", "/api/work/tickets/WORK-404/start-preview");
    check("preview unknown Linear issue -> 404", previewUnknown.status === 404, `got ${previewUnknown.status}`);

    // POST /api/work/tickets/WORK-1/start — forwarded to the host /message.
    hostCalls.length = 0;
    const start = await call(P, "POST", "/api/work/tickets/WORK-1/start", { body: { text: preview.body.text } });
    check("start -> host 200 pass-through", start.status === 200 && start.body?.sent === true, JSON.stringify(start));
    check("start forwards the text verbatim to /message",
      hostCalls.find((c) => c.url === "/message")?.body?.text === preview.body.text,
      JSON.stringify(hostCalls));

    // The guards: mismatched text, missing text, foreign origin.
    hostCalls.length = 0;
    const mismatch = await call(P, "POST", "/api/work/tickets/WORK-1/start", { body: { text: "Start ticket WORK-2: other" } });
    check("start mismatched text -> 400", mismatch.status === 400, JSON.stringify(mismatch));
    const empty = await call(P, "POST", "/api/work/tickets/WORK-1/start", { body: {} });
    check("start without text -> 400", empty.status === 400, JSON.stringify(empty));
    const foreign = await call(P, "POST", "/api/work/tickets/WORK-1/start", {
      origin: "https://evil.example", body: { text: preview.body.text },
    });
    check("start foreign origin -> 403", foreign.status === 403, `got ${foreign.status}`);
    check("start guards forward nothing to the host", hostCalls.length === 0, JSON.stringify(hostCalls));

    // ── the publish trio mounts (FOC-788): the preview shape, the guards ──
    // and body shape, the token binding, and no-checkout with no action
    // offered. The refusals below all stop BEFORE an executor can run —
    // asserted as no audit line and no branch on the bare remote.
    const pp = await call(P, "GET", "/api/work/tickets/WORK-1/publish-preview?action=push");
    check("publish-preview -> 200 with checkout, diff, checks, confirmToken",
      pp.status === 200 && pp.body?.ticket === "WORK-1" && pp.body?.action === "push"
        && pp.body?.checkout?.branch === DEV_BRANCH && pp.body?.checkout?.head === DEV_HEAD
        && pp.body?.diff?.commits === 1 && pp.body?.diff?.dirty === false
        && typeof pp.body?.confirmToken === "string" && /^[0-9a-f]{64}$/.test(pp.body.confirmToken),
      JSON.stringify(pp.body).slice(0, 300));
    check("publish-preview checks = local verdicts: latest PASS, the FAIL round shown (AC-2)",
      pp.body?.checks?.latest === "PASS" && pp.body?.checks?.failing?.length === 1
        && pp.body?.checks?.failing?.[0]?.round === 1,
      JSON.stringify(pp.body?.checks).slice(0, 300));
    const ppBadAction = await call(P, "GET", "/api/work/tickets/WORK-1/publish-preview?action=nope");
    check("publish-preview bad action -> 400 bad-action",
      ppBadAction.status === 400 && ppBadAction.body?.error === "bad-action", JSON.stringify(ppBadAction.body));
    const ppNone = await call(P, "GET", "/api/work/tickets/WORK-3/publish-preview?action=push");
    check("publish-preview untouched ticket -> 404 no-checkout, no action offered",
      ppNone.status === 404 && ppNone.body?.error === "no-checkout" && ppNone.body?.reason === "no-children",
      JSON.stringify(ppNone.body));

    const pushPath = "/api/work/tickets/WORK-1/push";
    const confirmBody = (token) => ({ confirmToken: token, actor: "human", actorId: "mateusz" });
    const ppForeign = await call(P, "POST", pushPath, { origin: "https://evil.example", body: confirmBody("x") });
    check("publish push foreign origin -> 403", ppForeign.status === 403, `got ${ppForeign.status}`);
    const ppNoToken = await call(P, "POST", pushPath, { body: { actor: "human", actorId: "mateusz" } });
    check("publish push without confirmToken -> 400",
      ppNoToken.status === 400 && ppNoToken.body?.error === "confirmToken (string) is required",
      JSON.stringify(ppNoToken.body));
    const ppBadActor = await call(P, "POST", pushPath, { body: { confirmToken: "x", actor: "robot", actorId: "mateusz" } });
    check("publish push non-human/ai actor -> 400",
      ppBadActor.status === 400 && ppBadActor.body?.error === 'actor must be "human" or "ai"',
      JSON.stringify(ppBadActor.body));
    const ppStale = await call(P, "POST", pushPath, { body: confirmBody("f".repeat(64)) });
    check("publish push wrong token -> 409 stale-preview",
      ppStale.status === 409 && ppStale.body?.error === "stale-preview", JSON.stringify(ppStale.body));
    const prStale = await call(P, "POST", "/api/work/tickets/WORK-1/pr", { body: confirmBody("f".repeat(64)) });
    check("publish pr wrong token -> 409 before any API call",
      prStale.status === 409 && prStale.body?.error === "stale-preview", JSON.stringify(prStale.body));
    check("publish refusals ran no executor — no audit line, no branch on the bare",
      !existsSync(join(dir, "state-root", "publish-actions.jsonl")) && git(["ls-remote", "--heads", ORIGIN_BARE], dir) === "",
      git(["ls-remote", "--heads", ORIGIN_BARE], dir));

    await spawned.stop();
  }

  // ── Native mode (no FENIX_SUPERVISOR_HOST) ───────────────────────────────
  {
    const spawned = await spawnWorkServer({ ...baseEnv });
    servers.push(spawned);
    const child = spawned.child;
    const P = spawned.port;

    const preview = await call(P, "GET", "/api/work/tickets/WORK-1/start-preview");
    check("preview native -> delivery cockpit",
      preview.status === 200 && preview.body?.delivery === "cockpit", JSON.stringify(preview.body));

    const start = await call(P, "POST", "/api/work/tickets/WORK-1/start", {
      body: { text: preview.body?.text ?? "Start ticket WORK-1: Fix the widget" },
    });
    check("start native -> 503 docker-only", start.status === 503 && start.body?.error === "docker-only",
      JSON.stringify(start));

    const board = await call(P, "GET", "/api/work/tickets");
    check("board native -> 200 (same seams)", board.status === 200 && Array.isArray(board.body?.tickets),
      JSON.stringify(board.body).slice(0, 200));
    await spawned.stop();
  }
} catch (err) {
  failed++;
  failures.push(`unexpected error — ${err?.stack || err}`);
  for (const s of servers) if (s.child.stderrBuf) console.error(`[child stderr] ${s.child.stderrBuf}`);
} finally {
  for (const s of servers) await s.stop();
  fakeHost.close();
}

// ── the cost snapshot manager, in-process (unit level) ───────────────────────

{
  const { getCostSnapshot, resetWorkRoutesState } = await import("./work-routes.mjs");
  try {
    resetWorkRoutesState();
    const first = getCostSnapshot();
    check("unit: before any snapshot the state is computing",
      first.state === "computing" && first.snapshot === null, JSON.stringify(first));

    // One refresh in flight: a second call does not start a second child.
    const second = getCostSnapshot();
    check("unit: refresh is single-flight", second.state === "computing", JSON.stringify(second));

    let landed = null;
    for (let i = 0; i < 300 && !landed; i++) {
      await sleep(100);
      const s = getCostSnapshot();
      if (s.state === "ok") landed = s;
    }
    check("unit: the snapshot lands ok with the store's windows",
      landed?.snapshot?.windows?.all != null && Array.isArray(landed.snapshot.windows.all.tickets),
      JSON.stringify(landed?.error));
  } catch (err) {
    failed++;
    failures.push(`unit block — ${err?.stack || err}`);
  }

  resetWorkRoutesState(); // back to the defaults for anything after this file
}

// ── the shared facts cache, in-process ───────────────────────────────────────

{
  const { ticketFacts, resetWorkRoutesState } = await import("./work-routes.mjs");
  try {
    process.env.FENIX_WORK_FACTS_TTL_MS = "60000";
    resetWorkRoutesState(); // clears the cache
    // The lib path in-process (LA_SUPERVISOR_STATE_HOME is set): before the
    // verdictPath import fix this sweep threw a ReferenceError on WORK-1's
    // verdict files.
    const a = ticketFacts();
    const b = ticketFacts();
    check("unit: facts are shared within the TTL", a === b && a.some((f) => f.taskId === "WORK-1"),
      `shared=${a === b}`);
    const w1 = a.find((f) => f.taskId === "WORK-1");
    check("unit: WORK-1 carries the verdict fixture — rounds 2, FAIL then PASS",
      w1?.rounds === 2 && JSON.stringify(w1.verdicts.map((v) => [v.round, v.verdict])) === '[[1,"FAIL"],[2,"PASS"]]',
      JSON.stringify(w1?.verdicts));
    resetWorkRoutesState();
    const c = ticketFacts();
    check("unit: resetWorkRoutesState clears the facts cache", c !== a);
  } catch (err) {
    failed++;
    failures.push(`facts-cache unit block — ${err?.stack || err}`);
  } finally {
    delete process.env.FENIX_WORK_FACTS_TTL_MS;
  }
}

// ── the publish routes end-to-end, in-process (FOC-788) ──────────────────────
//
// handleWorkRoute with fake req/res/ctx against the REAL git fixture: the
// push lands on the local bare remote (offline by construction), the PR path
// posts through a fake global fetch, and the audit trio lands in the temp
// state root — with the comment sink failing closed offline (the empty key +
// no-.env seam above), which is itself part of the proof.
{
  const { handleWorkRoute, resetWorkRoutesState } = await import("./work-routes.mjs");
  const json = (res, status, body) => { res.__status = status; res.__body = body; };
  const ctx = {
    readJsonBody: async (req) => req.__body,
    respondBodyError: (res, err) => { json(res, 400, { error: String(err?.message ?? err) }); return 400; },
    json,
    log: () => {},
    isLocalOrigin: (addr) => addr === "127.0.0.1",
    isAllowedOrigin: (origin) => origin === "http://localhost:5173",
  };
  const callRoute = async (method, path, { body, origin = "http://localhost:5173", addr = "127.0.0.1" } = {}) => {
    const req = { method, headers: { origin }, socket: { remoteAddress: addr }, __body: body };
    const res = {};
    const handled = await handleWorkRoute(req, res, new URL(path, "http://localhost:5173"), ctx);
    return { handled, status: res.__status, body: res.__body };
  };
  const jsonlPath = join(dir, "state-root", "publish-actions.jsonl");
  const readJsonl = () => (existsSync(jsonlPath)
    ? readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []);
  try {
    resetWorkRoutesState();

    // stale-head 409: the confirm binds the head, so a commit between the
    // preview and the confirm invalidates its token — and nothing runs.
    const before = await callRoute("GET", "/api/work/tickets/WORK-1/publish-preview?action=push");
    check("unit: publish-preview handled in-process",
      before.handled === true && before.status === 200, JSON.stringify(before.body).slice(0, 200));
    writeFileSync(join(childWorktree, "feature2.txt"), "more\n");
    git(["add", "feature2.txt"], childWorktree);
    git(["commit", "-m", "stale-head work"], childWorktree);
    const moved = await callRoute("POST", "/api/work/tickets/WORK-1/push", {
      body: { confirmToken: before.body.confirmToken, actor: "human", actorId: "mateusz" },
    });
    check("unit: publish push with a moved head -> 409 stale-preview",
      moved.status === 409 && moved.body?.error === "stale-preview", JSON.stringify(moved.body));
    check("unit: the stale confirm ran nothing", readJsonl().length === 0, `lines=${readJsonl().length}`);

    // push success: the exact refspec lands the branch on the local bare at
    // the pushed head, and the audit line says who confirmed it.
    const fresh = await callRoute("GET", "/api/work/tickets/WORK-1/publish-preview?action=push");
    const pushed = await callRoute("POST", "/api/work/tickets/WORK-1/push", {
      body: { confirmToken: fresh.body.confirmToken, actor: "human", actorId: "mateusz" },
    });
    check("unit: publish push -> 200 ok with the published head",
      pushed.status === 200 && pushed.body?.ok === true && pushed.body?.action === "push"
        && pushed.body?.actor === "human" && pushed.body?.head === fresh.body?.checkout?.head,
      JSON.stringify(pushed.body));
    check("unit: the push really landed on the bare (branch at exactly the head)",
      git(["ls-remote", "--heads", ORIGIN_BARE], dir)
        .includes(`${fresh.body.checkout.head}\trefs/heads/${DEV_BRANCH}`),
      git(["ls-remote", "--heads", ORIGIN_BARE], dir));
    const afterPush = readJsonl();
    check("unit: the push audit line names the branch, the actor and ok",
      afterPush.length === 1 && afterPush[0].action === "push" && afterPush[0].branch === DEV_BRANCH
        && afterPush[0].actor === "human" && afterPush[0].actorId === "mateusz" && afterPush[0].ok === true,
      JSON.stringify(afterPush).slice(0, 300));

    // pr success: the route posts through the fetch seam (the fixture's
    // fetch URL is GitHub-shaped), and the PR URL lands in response + record.
    const realFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return { status: 201, text: async () => JSON.stringify({ html_url: "https://github.com/joint-hubs/linear-agents/pull/7", number: 7 }) };
    };
    try {
      const prPreview = await callRoute("GET", "/api/work/tickets/WORK-1/publish-preview?action=pr");
      const pr = await callRoute("POST", "/api/work/tickets/WORK-1/pr", {
        body: { confirmToken: prPreview.body.confirmToken, actor: "ai", actorId: "session-test" },
      });
      check("unit: publish pr -> 200 ok with the PR URL",
        pr.status === 200 && pr.body?.ok === true && pr.body?.action === "pr"
          && pr.body?.prUrl === "https://github.com/joint-hubs/linear-agents/pull/7",
        JSON.stringify(pr.body));
      const prPost = fetchCalls.length === 1 ? JSON.parse(fetchCalls[0].opts.body) : {};
      check("unit: the PR POST is head=branch, base=main, titled from the issue",
        fetchCalls.length === 1 && fetchCalls[0].url.endsWith("/repos/joint-hubs/linear-agents/pulls")
          && prPost.head === DEV_BRANCH && prPost.base === "main" && prPost.title === "WORK-1: Fix the widget",
        JSON.stringify({ urls: fetchCalls.map((c) => c.url), prPost }));
      const afterPr = readJsonl();
      check("unit: the pr audit line carries the PR URL and the ai actor",
        afterPr.length === 2 && afterPr[1].action === "pr"
          && afterPr[1].prUrl === "https://github.com/joint-hubs/linear-agents/pull/7"
          && afterPr[1].actor === "ai" && afterPr[1].actorId === "session-test",
        JSON.stringify(afterPr).slice(-300));

      // pr-failed: the API refuses -> 502 pr-failed with the reason, and the
      // failed attempt is audited too (ok:false, the error name recorded).
      globalThis.fetch = async () => ({ status: 422, text: async () => JSON.stringify({ message: "Validation Failed" }) });
      const prPreview2 = await callRoute("GET", "/api/work/tickets/WORK-1/publish-preview?action=pr");
      const prFail = await callRoute("POST", "/api/work/tickets/WORK-1/pr", {
        body: { confirmToken: prPreview2.body.confirmToken, actor: "human", actorId: "mateusz" },
      });
      check("unit: publish pr refused by the API -> 502 pr-failed with the reason",
        prFail.status === 502 && prFail.body?.error === "pr-failed"
          && String(prFail.body?.detail).includes("GitHub 422: Validation Failed"),
        JSON.stringify(prFail.body));
      const afterFail = readJsonl();
      check("unit: the refused PR is audited too (ok:false, error named)",
        afterFail.length === 3 && afterFail[2].ok === false && afterFail[2].error === "pr-failed",
        JSON.stringify(afterFail.slice(-1)).slice(0, 300));
    } finally {
      globalThis.fetch = realFetch;
    }

    // A child that recorded no branch has no checkout — the reason names
    // which half is missing, and nothing is offered (WORK-2's plan child).
    const noBranch = await callRoute("GET", "/api/work/tickets/WORK-2/publish-preview?action=push");
    check("unit: publish-preview without a recorded branch -> 404 no-checkout",
      noBranch.status === 404 && noBranch.body?.error === "no-checkout"
        && noBranch.body?.reason === "branch-or-worktree-unrecorded",
      JSON.stringify(noBranch.body));
  } catch (err) {
    failed++;
    failures.push(`publish routes unit block — ${err?.stack || err}`);
  } finally {
    resetWorkRoutesState();
  }
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\nwork-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

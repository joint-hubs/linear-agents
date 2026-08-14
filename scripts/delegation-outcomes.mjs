#!/usr/bin/env node
/**
 * scripts/delegation-outcomes.mjs — join review verdicts back onto the delegations
 * that produced the code (JOI-210).
 *
 * The system measures cost everywhere and quality nowhere. Telemetry knows the DEV
 * implementer on GLM-5.2 cost $37.15; it does not know whether that code passed
 * review first time or came back twice. Without that, "is GLM better than DeepSeek
 * on implementer" can only be argued from public benchmarks — see
 * docs/prd/model-role-fit-analysis.md, which stops at exactly this wall.
 *
 * Nothing new has to be produced. REVIEW already writes a verdict per round to
 * .state/reviews/<taskId>-round<N>.md and keeps a round counter in
 * .state/review-rounds.json. This reads both and attributes them to the delegations
 * recorded in telemetry for the same task.
 *
 * Signal, weakest to strongest:
 *   rounds == 1 and clean  → the work passed first time
 *   rounds  > 1            → each extra round is rework the delegation caused
 *   blocker present        → not a nitpick; the change could not ship
 *
 * Usage:
 *   node scripts/delegation-outcomes.mjs              # model x role summary
 *   node scripts/delegation-outcomes.mjs --by-task    # per-task detail
 *   node scripts/delegation-outcomes.mjs --json
 *   node scripts/delegation-outcomes.mjs --csv <dir>  # export outcomes_by_task.csv,
 *                                                      # outcomes_by_pair.csv, usage_by_role_model.csv,
 *                                                      # task_delegations.csv
 *                                                      # (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §5)
 *
 * Read-only. Touches .state/ and the telemetry DB, writes nothing except the files named
 * explicitly by --csv <dir>.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWS = join(ROOT, ".state", "reviews");
const ROUNDS = join(ROOT, ".state", "review-rounds.json");
const DB_PATH = process.env.LA_TELEMETRY_DB
  || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "linear-agents", "telemetry", "telemetry.sqlite");

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const BY_TASK = args.includes("--by-task");
const CSV_DIR = (() => {
  const i = args.indexOf("--csv");
  return i >= 0 ? args[i + 1] : null;
})();

// ── read the verdicts REVIEW already wrote ────────────────────────────────────

/**
 * Parse one review round file. The format is REVIEW's own output (see
 * agents/review/CLAUDE.md §4), so this reads what the squad genuinely produced
 * rather than a shape invented here.
 */
function parseReview(path, taskId, round) {
  const text = readFileSync(path, "utf8");
  const head = text.slice(0, 2000);

  // "**Status:** 🔴 blocker → RETURN to DEV"  /  "... Clean — handing to TEST"
  const returned = /RETURN to DEV/i.test(head);
  const blocker = /🔴|\bblocker\b/i.test(head);

  // Conventional Comments markers. Only `issue:` blocks; the rest are advisory,
  // so counting them separately keeps "noisy but shippable" apart from "broken".
  const count = (marker) => (text.match(new RegExp(`\\b${marker}\\s*(\\(|:)`, "gi")) || []).length;

  return {
    taskId, round, returned, blocker,
    issues: count("issue"),
    nitpicks: count("nitpick"),
    suggestions: count("suggestion"),
    reviewRunId: (head.match(/\*\*Run:\*\*\s*`([^`]+)`/) || [])[1] || null,
  };
}

function loadReviews() {
  if (!existsSync(REVIEWS)) return [];
  const out = [];
  for (const file of readdirSync(REVIEWS)) {
    const m = file.match(/^(.+)-round(\d+)\.md$/);
    if (!m) continue;
    try {
      out.push(parseReview(join(REVIEWS, file), m[1], Number(m[2])));
    } catch { /* an unreadable round is not worth failing the whole report */ }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.round - b.round);
}

/** Per task: how many rounds it took, and whether it ever hit a blocker. */
function outcomesByTask(reviews) {
  const byTask = new Map();
  for (const r of reviews) {
    const cur = byTask.get(r.taskId) || { taskId: r.taskId, rounds: 0, blockers: 0, issues: 0, returned: 0 };
    cur.rounds = Math.max(cur.rounds, r.round);
    cur.blockers += r.blocker ? 1 : 0;
    cur.issues += r.issues;
    cur.returned += r.returned ? 1 : 0;
    byTask.set(r.taskId, cur);
  }
  // A task reviewed once and not sent back is the clean case. Anything that came
  // back at least once cost a rework cycle somebody paid for.
  for (const t of byTask.values()) t.firstPassClean = t.rounds === 1 && t.returned === 0;
  return byTask;
}

// ── join to the delegations that produced the work ────────────────────────────

/**
 * Which delegations worked on this task, per telemetry. Uses run_task_links so a
 * turn counts for the task that was actually linked AT THAT MOMENT — the same
 * temporal rule the cost views use, otherwise a retagged run would move its
 * quality signal too.
 */
function delegationsByTask(db) {
  const rows = db.prepare(`
    SELECT l.task_id AS taskId, r.squad AS squad, u.agent_key AS agent, u.model AS model,
           COUNT(*) AS turns, ROUND(SUM(COALESCE(c.cost_usd, 0)), 4) AS usd,
           SUM(u.input_tokens) AS inputTokens, SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_read_tokens) AS cacheReadTokens, SUM(u.cache_creation_tokens) AS cacheCreationTokens
    FROM usage_facts u
    JOIN runs r            ON r.run_id = u.run_id
    JOIN run_task_links l  ON l.run_id = u.run_id
                           AND u.observed_at >= l.valid_from
                           AND (l.valid_to IS NULL OR u.observed_at < l.valid_to)
    LEFT JOIN cost_facts c ON c.run_id = u.run_id AND c.usage_id = u.usage_id
    WHERE l.role = 'primary' AND u.agent_key IS NOT NULL
    GROUP BY l.task_id, r.squad, u.agent_key, u.model
  `).all();
  // Token sums riding along on the same rows computeOutcomes() already builds from this
  // function — additive fields, existing consumers (computeOutcomes -> pair.usd) only read
  // the columns they already knew about, so this cannot change their behaviour.
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
    byTask.get(row.taskId).push(row);
  }
  return byTask;
}

/**
 * `z-ai/glm-5.2` and `z-ai/glm-5.2-20260616` are one model under two ids; leaving
 * them apart splits a small sample into two smaller ones and invents a difference
 * (27% clean vs 100%) that is an artefact of the id, not of the model.
 */
function normaliseModel(model) {
  return String(model || "?").replace(/-\d{8}$/, "");
}
const isNoiseModel = (m) => !m || m === "<synthetic>" || m === "synthetic";
// Ephemeral sub-agent ids (`agent-a83cd8...`) are one-off handles, not roles.
const isNoiseAgent = (a) => !a || /^agent-[0-9a-f]{8,}/i.test(a);

/**
 * `claude-4.8-opus-20260528` (after date-strip: `claude-4.8-opus`) and `claude-opus-4.8` are
 * the same model logged two ways — telemetry has both forms in the wild. Reorder
 * `claude-<version>-<name>` to `claude-<name>-<version>` so both collapse onto the id used in
 * 00_LLM_PRICE (01_LLM_EVAL). Only touches that one naming pattern; every other model already
 * matches as-is.
 */
function bareModel(model) {
  let s = normaliseModel(model).replace(/^.*\//, "");
  const m = s.match(/^claude-(\d+\.\d+)-([a-z]+)$/);
  if (m) s = `claude-${m[2]}-${m[1]}`;
  return s;
}

// ── report ────────────────────────────────────────────────────────────────────

/**
 * Compute the whole report. Exported so telemetry-server can serve it without
 * shelling out to this CLI. Returns null when there is nothing to read, rather
 * than throwing — a dashboard panel must degrade, not take the page down.
 */
export function computeOutcomes({ dbPath = DB_PATH } = {}) {
  const reviews = loadReviews();
  if (!reviews.length) return null;
  const taskOutcomes = outcomesByTask(reviews);

  // The round counter is REVIEW's own state; it may know about tasks whose round
  // files were cleaned up, so fold it in without overwriting a parsed verdict.
  if (existsSync(ROUNDS)) {
    const counter = JSON.parse(readFileSync(ROUNDS, "utf8"));
    for (const [taskId, rounds] of Object.entries(counter)) {
      if (!taskOutcomes.has(taskId)) {
        taskOutcomes.set(taskId, { taskId, rounds, blockers: 0, issues: 0, returned: rounds - 1, firstPassClean: rounds === 1, roundsOnly: true });
      } else {
        taskOutcomes.get(taskId).rounds = Math.max(taskOutcomes.get(taskId).rounds, rounds);
      }
    }
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const delegations = delegationsByTask(db);

  // model x role: how did work from this pairing fare downstream
  const pair = new Map();
  let matched = 0, unmatched = 0;
  for (const [taskId, outcome] of taskOutcomes) {
    const dels = delegations.get(taskId);
    if (!dels) { unmatched++; continue; }
    matched++;
    for (const d of dels) {
      // Only DEV is on trial. REVIEW writes the verdict, and PLAN/TEST/CADENCE
      // touch the same task without producing the code being judged — crediting a
      // cadence digest with a review round it had no hand in is not a weak signal,
      // it is a wrong one.
      if (d.squad !== "dev") continue;
      if (isNoiseAgent(d.agent) || isNoiseModel(d.model)) continue;
      const key = `${d.agent}|${normaliseModel(d.model)}`;
      const cur = pair.get(key) || { squad: d.squad, agent: d.agent, model: normaliseModel(d.model), tasks: 0, clean: 0, rounds: 0, blockers: 0, usd: 0 };
      cur.tasks++;
      cur.clean += outcome.firstPassClean ? 1 : 0;
      cur.rounds += outcome.rounds;
      cur.blockers += outcome.blockers > 0 ? 1 : 0;
      cur.usd += d.usd || 0;
      pair.set(key, cur);
    }
  }

  return {
    tasksWithVerdict: taskOutcomes.size,
    matched,
    unmatched,
    byTask: [...taskOutcomes.values()],
    byPair: [...pair.values()].sort((a, b) => b.tasks - a.tasks),
  };
}

// ── canonical role taxonomy (mirrors ROLES[].id in 01_LLM_EVAL/data_analysis.R) ─────────────

/**
 * `worker` in data_analysis.R is explicitly a combined bucket — label "Worker / flash / push"
 * — so all three real agent_key values fold into it. Roles a squad has but that were never
 * modelled theoretically (spec-review, discovery, root-cause, runner, scenario-gen, retro,
 * collector) fall to "other", same as telemetry noise (Explore, general-purpose, ephemeral
 * agent-<hash> subagent ids, <synthetic>).
 */
const ROLE_MAP = {
  _lead: "lead",
  implementer: "impl",
  refactorer: "refac",
  debugger: "debug",
  recon: "recon",
  deep: "deep",
  security: "sec",
  "first-pass": "first",
  spec: "spec",
  decomposer: "decomp",
  deployer: "deploy",
  worker: "worker",
  flash: "worker",
  push: "worker",
  digest: "digest",
};

function normalizeRole(agentKey) {
  return ROLE_MAP[agentKey] || "other";
}

// ── all-squad usage volume, independent of REVIEW verdicts ─────────────────────────────────

function loadUsageTurns(db) {
  return db.prepare(`
    SELECT u.run_id AS runId, u.agent_key AS agentKey, u.model AS model, u.observed_at AS observedAt,
           u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
           u.cache_read_tokens AS cacheReadTokens, u.cache_creation_tokens AS cacheCreationTokens,
           r.squad AS squad, COALESCE(c.cost_usd, 0) AS costUsd
    FROM usage_facts u
    JOIN runs r ON r.run_id = u.run_id
    LEFT JOIN cost_facts c ON c.run_id = u.run_id AND c.usage_id = u.usage_id
    WHERE u.agent_key IS NOT NULL
  `).all();
}

function loadPrimaryTaskLinks(db) {
  return db.prepare(`
    SELECT run_id AS runId, task_id AS taskId, valid_from AS validFrom, valid_to AS validTo
    FROM run_task_links WHERE role = 'primary'
  `).all();
}

function indexLinksByRun(links) {
  const byRun = new Map();
  for (const l of links) {
    if (!byRun.has(l.runId)) byRun.set(l.runId, []);
    byRun.get(l.runId).push(l);
  }
  return byRun;
}

function taskIdForTurn(linksByRun, runId, observedAt) {
  for (const l of linksByRun.get(runId) || []) {
    if (observedAt >= l.validFrom && (l.validTo == null || observedAt < l.validTo)) return l.taskId;
  }
  return null;
}

/** Monday of the UTC week containing `observedAt`, as YYYY-MM-DD — the trend bucket (PRD §6 pkt 9). */
function isoWeekStart(observedAt) {
  const d = new Date(observedAt);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Volume (turns/tokens/cost) per (squad, agent_key, model, week), across ALL squads. Unlike
 * the DEV-only `pair` map in computeOutcomes(), this needs no REVIEW verdict, so it also
 * covers plan/test/cadence where "clean/rounds" has no meaning but tokens and cost still do.
 * `week_start` is included so the same file answers both the totals views (group_by ignoring
 * week) and the time-trend view (group_by keeping week) — one export, two uses.
 */
function usageByRoleModel(db) {
  const turns = loadUsageTurns(db);
  const linksByRun = indexLinksByRun(loadPrimaryTaskLinks(db));
  const map = new Map();
  for (const t of turns) {
    if (isNoiseAgent(t.agentKey) || isNoiseModel(t.model)) continue;
    const model = normaliseModel(t.model);
    const week = isoWeekStart(t.observedAt);
    const key = `${t.squad}|${t.agentKey}|${model}|${week}`;
    const cur = map.get(key) || {
      squad: t.squad, agent_key: t.agentKey, canonical_role: normalizeRole(t.agentKey), model,
      week_start: week,
      turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      cost_usd: 0, taskIds: new Set(), runIds: new Set(),
    };
    cur.turns += 1;
    cur.input_tokens += t.inputTokens || 0;
    cur.output_tokens += t.outputTokens || 0;
    cur.cache_read_tokens += t.cacheReadTokens || 0;
    cur.cache_creation_tokens += t.cacheCreationTokens || 0;
    cur.cost_usd += t.costUsd || 0;
    cur.runIds.add(t.runId);
    const taskId = taskIdForTurn(linksByRun, t.runId, t.observedAt);
    if (taskId) cur.taskIds.add(taskId);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((r) => ({
      squad: r.squad, agent_key: r.agent_key, canonical_role: r.canonical_role, model: r.model,
      week_start: r.week_start,
      turns: r.turns, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
      cost_usd: Math.round(r.cost_usd * 10000) / 10000,
      distinct_tasks: r.taskIds.size, distinct_runs: r.runIds.size,
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || b.turns - a.turns);
}

/**
 * Flattened task × delegation rows (all squads) — the grain the per-task ±1 sensitivity
 * analysis needs (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §7 step 5): which role AND
 * model actually touched a given task, with its tokens/cost, so the R side can join each task
 * to the theoretical parameters of the model that worked it.
 */
function taskDelegationRows(db) {
  const delegations = delegationsByTask(db);
  const rows = [];
  for (const [taskId, dels] of delegations) {
    for (const d of dels) {
      if (isNoiseAgent(d.agent) || isNoiseModel(d.model)) continue;
      rows.push({
        task_id: taskId, squad: d.squad, agent_key: d.agent, canonical_role: normalizeRole(d.agent),
        model: normaliseModel(d.model), model_bare: bareModel(d.model),
        turns: d.turns, input_tokens: d.inputTokens || 0, output_tokens: d.outputTokens || 0,
        cache_read_tokens: d.cacheReadTokens || 0, cache_creation_tokens: d.cacheCreationTokens || 0,
        cost_usd: d.usd || 0,
      });
    }
  }
  return rows.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

// ── CSV export (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §5) ────────────────────────

function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => toCsvValue(row[c])).join(","));
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Builds the three CSV exports for 01_LLM_EVAL. Opens its own DB handle rather than reusing
 * computeOutcomes()'s internals, so the function telemetry-server imports stays untouched —
 * this is purely additive.
 */
function buildCsvExports(dir) {
  mkdirSync(dir, { recursive: true });

  const result = computeOutcomes();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const delegations = delegationsByTask(db);

  const taskRows = (result ? result.byTask : []).map((t) => ({
    task_id: t.taskId,
    squad_key_prefix: (t.taskId.match(/^([A-Za-z]+)-/) || [null, "OTHER"])[1],
    rounds: t.rounds,
    returned_count: t.returned,
    blockers: t.blockers,
    issues: t.issues,
    nitpicks: t.nitpicks || 0,
    suggestions: t.suggestions || 0,
    first_pass_clean: t.firstPassClean,
    has_delegation_match: delegations.has(t.taskId),
  }));
  writeCsv(join(dir, "outcomes_by_task.csv"),
    ["task_id", "squad_key_prefix", "rounds", "returned_count", "blockers", "issues",
      "nitpicks", "suggestions", "first_pass_clean", "has_delegation_match"], taskRows);

  const pairRows = (result ? result.byPair : []).map((p) => ({
    // computeOutcomes()'s pair map only ever aggregates squad==="dev" delegations
    // (see the `if (d.squad !== "dev") continue;` guard above) — squad is a
    // literal here, not read off `p`, but it must be present so a consumer can
    // join this file by (squad, agent_key, model) and not silently leak DEV-only
    // quality numbers onto another squad that happens to share an agent_key+model
    // (e.g. "_lead"/"z-ai/glm-5.2" also exists under squad=review).
    squad: "dev",
    agent_key: p.agent,
    canonical_role: normalizeRole(p.agent),
    model: p.model,
    model_bare: bareModel(p.model),
    tasks: p.tasks,
    clean_pct: p.tasks ? Math.round((p.clean / p.tasks) * 1000) / 10 : null,
    avg_rounds: p.tasks ? Math.round((p.rounds / p.tasks) * 100) / 100 : null,
    blocker_rate: p.tasks ? Math.round((p.blockers / p.tasks) * 1000) / 10 : null,
    cost_usd: Math.round(p.usd * 10000) / 10000,
    cost_per_clean_task: p.clean ? Math.round((p.usd / p.clean) * 100) / 100 : null,
    sample_size_flag: p.tasks < 5 ? "low" : "ok",
  }));
  writeCsv(join(dir, "outcomes_by_pair.csv"),
    ["squad", "agent_key", "canonical_role", "model", "model_bare", "tasks", "clean_pct",
      "avg_rounds", "blocker_rate", "cost_usd", "cost_per_clean_task", "sample_size_flag"], pairRows);

  const usageRows = usageByRoleModel(db).map((r) => ({ ...r, model_bare: bareModel(r.model) }));
  writeCsv(join(dir, "usage_by_role_model.csv"),
    ["squad", "agent_key", "canonical_role", "model", "model_bare", "week_start", "turns",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd",
      "distinct_tasks", "distinct_runs"],
    usageRows);

  const taskDelegationRowsData = taskDelegationRows(db);
  writeCsv(join(dir, "task_delegations.csv"),
    ["task_id", "squad", "agent_key", "canonical_role", "model", "model_bare", "turns",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"],
    taskDelegationRowsData);

  db.close();
  return {
    outcomesByTask: taskRows.length,
    outcomesByPair: pairRows.length,
    usageByRoleModel: usageRows.length,
    taskDelegations: taskDelegationRowsData.length,
    dir,
  };
}

function main() {
  if (CSV_DIR) {
    const outDir = resolve(CSV_DIR);
    const summary = buildCsvExports(outDir);
    console.log(`\n[delegation-outcomes] CSV -> ${summary.dir}`);
    console.log(`  outcomes_by_task.csv    (${summary.outcomesByTask} wierszy)`);
    console.log(`  outcomes_by_pair.csv    (${summary.outcomesByPair} wierszy)`);
    console.log(`  usage_by_role_model.csv (${summary.usageByRoleModel} wierszy)`);
    console.log(`  task_delegations.csv    (${summary.taskDelegations} wierszy)\n`);
    return;
  }

  const result = computeOutcomes();
  if (!result) {
    console.error("[delegation-outcomes] brak plików w .state/reviews/ — nie ma z czego liczyć");
    process.exit(1);
  }
  const { tasksWithVerdict, matched, unmatched, byTask, byPair } = result;
  const taskOutcomes = new Map(byTask.map((t) => [t.taskId, t]));
  const pair = new Map(byPair.map((p) => [`${p.agent}|${p.model}`, p]));

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  Zadania z werdyktem REVIEW: ${taskOutcomes.size}  ·  dopasowane do delegacji: ${matched}  ·  bez delegacji w telemetrii: ${unmatched}\n`);

  if (BY_TASK) {
    console.log("  zadanie      rund  zwrotów  blokerów  issues  czysto?");
    console.log("  " + "─".repeat(60));
    for (const t of [...taskOutcomes.values()].sort((a, b) => b.rounds - a.rounds || a.taskId.localeCompare(b.taskId))) {
      console.log(`  ${t.taskId.padEnd(12)} ${String(t.rounds).padStart(4)} ${String(t.returned).padStart(8)} ${String(t.blockers).padStart(9)} ${String(t.issues).padStart(7)}  ${t.firstPassClean ? "tak" : "nie"}${t.roundsOnly ? "   (tylko licznik)" : ""}`);
    }
    console.log("");
    return;
  }

  const rows = [...pair.values()].filter(p => p.tasks > 0).sort((a, b) => b.tasks - a.tasks);
  console.log("  rola DEV            model                        zadań  czysto  śr.rund  z blokerem   koszt");
  console.log("  " + "─".repeat(96));
  for (const p of rows) {
    const cleanPct = ((p.clean / p.tasks) * 100).toFixed(0) + "%";
    console.log(
      `  ${p.agent.padEnd(20)}${(p.model || "?").padEnd(29)}` +
      `${String(p.tasks).padStart(5)}${cleanPct.padStart(8)}${(p.rounds / p.tasks).toFixed(1).padStart(9)}` +
      `${String(p.blockers).padStart(12)}${("$" + p.usd.toFixed(2)).padStart(9)}`,
    );
  }
  console.log(`\n  „czysto" = review przeszedł za pierwszym razem bez zwrotu. Tylko role DEV —`);
  console.log(`  to one wytwarzają kod, który REVIEW ocenia.`);
  console.log(`\n  OGRANICZENIE: werdykt zadania przypisywany jest KAŻDEJ roli DEV, która go`);
  console.log(`  dotknęła. Gdy recon i implementer pracowali nad tym samym zadaniem, oba dostają`);
  console.log(`  ten sam wynik — nie wiadomo, które spowodowało zwrot. Do rozróżnienia trzeba`);
  console.log(`  powiązać findings review z plikami, a pliki z konkretną delegacją.`);
  console.log(`  Przy próbce rzędu kilku zadań to sygnał do obserwacji, nie werdykt o modelu.\n`);
}

// Only run the CLI when executed directly. telemetry-server imports
// computeOutcomes() from here; without this guard every server start would print
// the whole report to stdout.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

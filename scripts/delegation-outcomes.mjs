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
 *
 * Read-only. Touches .state/ and the telemetry DB, writes nothing.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
           COUNT(*) AS turns, ROUND(SUM(COALESCE(c.cost_usd, 0)), 4) AS usd
    FROM usage_facts u
    JOIN runs r            ON r.run_id = u.run_id
    JOIN run_task_links l  ON l.run_id = u.run_id
                           AND u.observed_at >= l.valid_from
                           AND (l.valid_to IS NULL OR u.observed_at < l.valid_to)
    LEFT JOIN cost_facts c ON c.usage_id = u.usage_id
    WHERE l.role = 'primary' AND u.agent_key IS NOT NULL
    GROUP BY l.task_id, r.squad, u.agent_key, u.model
  `).all();
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

// ── report ────────────────────────────────────────────────────────────────────

function main() {
  const reviews = loadReviews();
  if (!reviews.length) {
    console.error("[delegation-outcomes] brak plików w .state/reviews/ — nie ma z czego liczyć");
    process.exit(1);
  }
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

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
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

  if (AS_JSON) {
    console.log(JSON.stringify({
      tasksWithVerdict: taskOutcomes.size, matched, unmatched,
      byTask: [...taskOutcomes.values()],
      byPair: [...pair.values()],
    }, null, 2));
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

main();

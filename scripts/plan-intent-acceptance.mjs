// scripts/plan-intent-acceptance.mjs — FOC-758 acceptance harness.
//
// The acceptance bar: on the arm-A attempt 3/4 reads (the live evidence where
// one regeneration overran TWO quote fields at once — FOC-236), runPlanIntentNode
// ends `done` in ≤ 1 regeneration in 5 of 5 runs against the live API.
//
// The PRODUCTION spine is what runs: composeIntentInputs → createDefaultGenerator
// → runPlanIntentNode with the step's real output schema compiled the way the
// runner compiles it (Ajv, allErrors — FOC-758's concrete-violation problems).
// No stubbed generator, no trimmed payload.
//
// Resumable by construction: each invocation appends one JSONL result row per
// run it executes (PLAN_INTENT_ACCEPTANCE_RESULTS, default
// .state/foc-758-acceptance/results.jsonl) and runs at most
// PLAN_INTENT_ACCEPTANCE_NEW (default 1) NEW runs, so the worst-case two
// generator calls (2 × G_TIMEOUT_MS) stay inside one foreground command.
// The final line is always `N/M` (passes over required runs) and the exit
// code is 0 only when every recorded run passed and none is missing.
//
// Secrets: the API key is read from OPENROUTER_API_KEY and never printed,
// never written to the results, never sent anywhere but the provider.
//
// Usage: node scripts/plan-intent-acceptance.mjs
// Exit 0 = acceptance met · 1 = not met yet · 2 = wiring error

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { loadGraph } from "./graph-validate.mjs";
import { createDefaultGenerator } from "./graph-runner.mjs";
import { composeIntentInputs, runPlanIntentNode } from "./plan-intent.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const FIXTURE = join(__dir, "fixtures", "plan-intent-arma-reads.json");
const RESULTS = process.env.PLAN_INTENT_ACCEPTANCE_RESULTS
  ?? join(ROOT, ".state", "foc-758-acceptance", "results.jsonl");
const RUNS = Number(process.env.PLAN_INTENT_ACCEPTANCE_RUNS ?? 5);
const MAX_NEW = Number(process.env.PLAN_INTENT_ACCEPTANCE_NEW ?? 1);

/**
 * Pure summary over the recorded rows: a run passes when the node ended done
 * (attempts 1 = zero regenerations, 2 = the one regeneration — the loop caps
 * at 2, so anything recorded as done is within the bar). Exported for the
 * offline tests in plan-intent.test.mjs.
 */
export function summarize(rows, runs = RUNS) {
  const passes = rows.filter((r) => r?.status === "done").length;
  return {
    passes,
    total: rows.length,
    met: rows.length >= runs && passes === rows.length,
    line: `${passes}/${runs}`,
  };
}

// FOC-758 (d): the acceptance bar is TWO conditions — done in ≤ 1 regeneration
// in RUNS/RUNS runs AND every serving provider on the pinned route. The pin
// slugs come from config/models.json providerPins (order: wafer, fireworks).
// Provider names arrive as OpenRouter's display names ("Wafer", "Fireworks
// AI", "OpenInference", ...) — match the pin slugs case-insensitively so a
// display name that contains its slug still counts as pinned.
const PINNED_SLUGS = ["wafer", "fireworks"];

/** Every distinct serving provider in the rows that is NOT on the pinned route. */
export function offPinnedProviders(rows) {
  return [...new Set(rows.flatMap((r) => r?.providers ?? []))]
    .filter((p) => !PINNED_SLUGS.some((slug) => p?.toLowerCase().includes(slug)));
}

/** The run's shadow-ledger evidence: total cost, providers seen, per-call outcomes. */
function shadowStats(shadowDir) {
  try {
    const lines = readFileSync(join(shadowDir, "decisions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return {
      costUsd: lines.reduce((sum, l) => sum + (typeof l?.usage?.cost === "number" ? l.usage.cost : 0), 0),
      providers: [...new Set(lines.map((l) => l?.provider).filter(Boolean))],
      outcomes: lines.map((l) => (l.ok ? "ok" : l?.error?.code ?? "error")),
    };
  } catch {
    return { costUsd: null, providers: [], outcomes: [] };
  }
}

async function runOnce({ n, apiKey, step, validate, reads }) {
  const runId = `foc-758-acceptance-${n}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const shadowDir = join(dirname(RESULTS), runId);
  mkdirSync(shadowDir, { recursive: true });
  const generator = createDefaultGenerator({ apiKey, runId, taskKey: "FOC-758", shadowDir });
  const startedAt = Date.now();
  let result;
  try {
    result = await runPlanIntentNode({ stepId: "plan.intent", step, reads, generator, validate });
  } catch (err) {
    result = { status: "failed", error: { code: err?.code ?? "provider_error", message: err?.message ?? "node threw" } };
  }
  const stats = shadowStats(shadowDir);
  const row = {
    n,
    ts: new Date().toISOString(),
    status: result.status,
    attempts: result.attempts ?? null,
    costUsd: stats.costUsd,
    providers: stats.providers,
    callOutcomes: stats.outcomes,
    wallMs: Date.now() - startedAt,
    ...(result.error ? { error: result.error } : {}),
    ...(Array.isArray(result.problems) && result.problems.length ? { problems: result.problems } : {}),
  };
  appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
  return row;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("acceptance: OPENROUTER_API_KEY is absent — the harness rides the live API and refuses to fake it");
    return 2;
  }

  // The fixture is external input: validate its shape before anything runs.
  let reads;
  try {
    reads = JSON.parse(readFileSync(FIXTURE, "utf8"));
  } catch (err) {
    console.error(`acceptance: the fixture ${FIXTURE} is not readable JSON: ${err.message}`);
    return 2;
  }
  if (typeof reads?.["inbox.entry"] !== "string" || !reads["inbox.entry"].trim()
    || !Array.isArray(reads?.["plan.dor.gaps"]) || reads["plan.dor.gaps"].length === 0) {
    console.error(`acceptance: the fixture must carry a non-empty "inbox.entry" string and "plan.dor.gaps" array`);
    return 2;
  }
  composeIntentInputs(reads); // fail fast on a malformed fixture — before any spend

  const step = loadGraph().nodes.plan.steps["plan.intent"];
  // The runner's own compile posture (FOC-758): allErrors so the rejection
  // carries EVERY violation, not only the first one.
  const validate = new Ajv({ allErrors: true }).compile(step.output);

  const rows = [];
  if (existsSync(RESULTS)) {
    for (const line of readFileSync(RESULTS, "utf8").split("\n").filter((l) => l.trim())) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        console.error(`acceptance: a results line is not readable JSON — delete ${RESULTS} to restart the count`);
        return 2;
      }
    }
  }

  const done = rows.length;
  const todo = Math.min(MAX_NEW, Math.max(0, RUNS - done));
  for (let i = 0; i < todo; i++) {
    const row = await runOnce({ n: done + i + 1, apiKey, step, validate, reads });
    rows.push(row); // the tally must count what THIS invocation ran too
    const cost = row.costUsd === null ? "cost n/a" : `cost $${row.costUsd.toFixed(6)}`;
    const outcome = row.status === "done"
      ? `done (attempts ${row.attempts}, ${row.attempts === 1 ? "0 regenerations" : "1 regeneration"})`
      : `FAILED (${row.error?.code}: ${row.error?.message ?? ""})`;
    console.log(`run ${row.n}: ${outcome} — ${cost}, ${(row.wallMs / 1000).toFixed(1)}s`
      + ` — providers: ${row.providers.length ? row.providers.join(", ") : "none recorded"}`);
    if (row.problems?.length) console.log(`  problems: ${row.problems.join(" | ")}`);
  }

  const summary = summarize(rows, RUNS);
  if (todo === 0 && done < RUNS) {
    // Nothing new ran (MAX_NEW=0 or a caller miscount) — say so, don't judge.
    console.log(`acceptance: ${summary.line} recorded, ${RUNS - done} run(s) still owed — invoke again`);
    return 1;
  }
  console.log(`acceptance: ${summary.line}`);
  // Two kinds of miss, kept apart because they fail differently: a run where
  // NO attempt returned ok never gave the loop a map to regenerate (the
  // provider environment killed every call); a run that saw at least one ok
  // call and still failed is a loop miss. Both stay in the N/M tally.
  const noMap = rows.filter((r) => r?.status !== "done" && !(r?.callOutcomes ?? []).includes("ok"));
  const loopMisses = rows.filter((r) => r?.status !== "done" && (r?.callOutcomes ?? []).includes("ok"));
  if (noMap.length) {
    console.log(`no-map environment misses: ${noMap.length} of ${rows.length}`
      + ` (the provider never returned a map: ${noMap.map((r) => (r.callOutcomes ?? []).join("+")).join(", ")})`);
  }
  if (loopMisses.length) {
    console.log(`loop misses (a map arrived, the run still failed): ${loopMisses.length}`
      + ` (${loopMisses.map((r) => `${r.error?.code}: ${(r.error?.message ?? "").slice(0, 120)}`).join(" | ")})`);
  }
  if (!summary.met) {
    console.log(`acceptance NOT met — the bar is done in ≤ 1 regeneration in ${RUNS}/${RUNS} runs`);
    return 1;
  }
  // Second half of the bar (FOC-758 d): every serving provider must sit on the
  // pinned route. Reported independently of the convergence tally.
  const offPinned = offPinnedProviders(rows);
  if (offPinned.length) {
    console.log(`acceptance NOT met — pinned route {${PINNED_SLUGS.join(", ")}} violated:`
      + ` served by ${offPinned.join(", ")}`);
    return 1;
  }
  console.log(`acceptance met — done in ≤ 1 regeneration in ${summary.passes} of ${RUNS} runs`
    + `, every serving provider on the pinned route {${PINNED_SLUGS.join(", ")}}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(`acceptance: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}

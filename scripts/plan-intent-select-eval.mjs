// scripts/plan-intent-select-eval.mjs — FOC-516: measure the FULL live
// plan.intent → plan.intent.select pipeline on the FOC-515 eval set.
//
// For each fixture case the harness runs the SAME two node calls a live graph
// run executes, against the real transports: runPlanIntentNode with the
// runner's default [G] generator (the map), then — over the map it produced —
// runPlanIntentSelectNode with the real decision-call seam caller (the ONE
// plan.intent.select.score call per map, two noul verdicts per interpretation).
// Usage and cost come off the FOC-449 event lines both transports wrote (the
// same ledger a live run produces), joined per taskKey (case id).
//
// A case whose map is rejected, aborted or fails closed is recorded as
// SKIPPED — there is no map to select from, and fabricating one would measure
// nothing. The skip and its reason are the measurement.
//
// Scoring is human: the harness ships the raw selection record per case (the
// routed questions/confirmations/understood lines/assumptions with their
// options and impact probabilities) plus mechanical facts (per-route counts,
// cap overflow, alternatives-override fires, usage, cost, latency). The graded
// table lives in the run report + docs/benchmark/plan-intent-eval.md (sibling
// section to the FOC-515 map eval).
//
// CLI:
//   node scripts/plan-intent-select-eval.mjs [--fixture <path>] [--out-dir <dir>]
//        [--ids <a,b,c>] [--limit <n>] [--run-id <id>] [--timeout <ms>]
//        [--caller-timeout <ms>]
// Artifacts (gitignored, under .state/foc-516/select-eval/<timestamp>/):
//   outputs.jsonl  — one line per case: the map facts, the selection record, usage, cost
//   summary.json   — aggregate: counts, route tallies, overflow, tokens, cost, latency
//   table.txt      — compact per-case table
//   <run-id>/decisions.jsonl — the FOC-449 event lines themselves
// Artifacts are incremental: run the 12 cases in batches with --ids into the
// same --out-dir and the summary covers everything measured so far. An id
// already present in outputs.jsonl is never re-measured.
// Exit 0 = run completed (skips and failures are measurements); exit 3 = no
// OPENROUTER_API_KEY, nothing measured.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { loadGraph } from "./graph-validate.mjs";
import { createDefaultGenerator } from "./graph-runner.mjs";
import { createDecisionCaller } from "./decision-call.mjs";
import { runPlanIntentNode } from "./plan-intent.mjs";
import { runPlanIntentSelectNode } from "./plan-intent-select.mjs";
import { buildInputs } from "./plan-intent-eval.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

const FIXTURE_PATH = join(__dir, "plan-intent-eval-fixture.json");

function schemaValidator(schema) {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema ?? { type: "object" });
}

/** Rows an earlier invocation into this outDir already measured. */
function loadRows(outDir) {
  try {
    return readFileSync(join(outDir, "outputs.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Read the FOC-449 event lines a run wrote, grouped by taskKey. */
function readEventLines(shadowDir) {
  const byTask = new Map();
  let text;
  try {
    text = readFileSync(join(shadowDir, "decisions.jsonl"), "utf8");
  } catch {
    return byTask;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const line_ = JSON.parse(line);
      if (line_.type === "event" && typeof line_.taskKey === "string") {
        const list = byTask.get(line_.taskKey) ?? [];
        list.push(line_);
        byTask.set(line_.taskKey, list);
      }
    } catch {
      // A torn line is skipped, never guessed at.
    }
  }
  return byTask;
}

/** Cost from config/models.json pricing (OpenRouter scope), USD. */
function costOf(model, usage) {
  if (typeof usage?.cost === "number") return usage.cost;
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null;
  let pricing;
  try {
    pricing = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8")).pricing?.openrouter || {};
  } catch {
    return null;
  }
  const row = pricing[model];
  if (!row || typeof row.input !== "number" || typeof row.output !== "number") return null;
  return (usage.inputTokens / 1e6) * row.input + (usage.outputTokens / 1e6) * row.output;
}

function usageSum(lines) {
  if (!lines.length) return null;
  return {
    calls: lines.length,
    inputTokens: lines.reduce((n, l) => n + (l.usage?.inputTokens ?? 0), 0),
    outputTokens: lines.reduce((n, l) => n + (l.usage?.outputTokens ?? 0), 0),
  };
}

/** Write outputs.jsonl in fixture order. */
function writeOutputs(outDir, rows, source) {
  const order = new Map(source.map((i, n) => [i.id, n]));
  const sorted = [...rows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "outputs.jsonl"), sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Latency percentile over measured per-case durations (ms). */
function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

/**
 * Run the eval: per fixture case ONE real map call + ONE real selection node
 * run, artifacts under outDir. Incremental and idempotent — rows already
 * present are kept and never re-measured; deps are injectable for offline
 * tests.
 */
export async function runAll({
  fixturePath = FIXTURE_PATH,
  outDir,
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  // Same budget posture as the FOC-515 map eval: 300s per call is the decided
  // contract figure; wider budgets via --timeout / --caller-timeout are named
  // in the artifacts. The selection's scoring call sees the WHOLE map at once,
  // so it gets its own flag rather than the map's budget.
  timeoutMs = 300000,
  callerTimeoutMs = 300000,
  runId = "foc-516-select-eval",
  issues: issuesOverride,
  limit,
  ids,
} = {}) {
  if (!outDir || typeof outDir !== "string") throw new TypeError("outDir is required — artifacts land under it");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const source = issuesOverride ?? fixture.issues;
  if (!Array.isArray(source) || source.length === 0) throw new TypeError("fixture carries no cases — nothing to measure");
  let issues = source.slice(0, Number.isInteger(limit) ? limit : undefined);
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids);
    issues = issues.filter((i) => wanted.has(i.id));
    if (!issues.length) throw new TypeError(`--ids ${ids.join(",")} matches no fixture case`);
  }

  const graph = loadGraph().nodes?.plan;
  const intentStep = graph?.steps?.["plan.intent"];
  const selectStep = graph?.steps?.["plan.intent.select"];
  if (!intentStep || !selectStep) throw new TypeError("config/graph.json is missing the plan.intent / plan.intent.select steps — the eval drives the runner's real step objects");
  const shadowDir = join(outDir, runId);
  mkdirSync(shadowDir, { recursive: true });
  const selectValidateRaw = schemaValidator(selectStep.output);
  const selectSchemaErrors = [];
  const selectValidate = (raw) => {
    const ok = selectValidateRaw(raw) === true;
    if (!ok) selectSchemaErrors.push(JSON.parse(JSON.stringify(selectValidateRaw.errors ?? [])));
    return ok;
  };

  const rows = loadRows(outDir);
  const done = new Set(rows.map((r) => r.id));
  for (const issue of issues) {
    if (done.has(issue.id)) continue;
    selectSchemaErrors.length = 0;
    const inputs = buildInputs(issue);
    const row = {
      id: inputs.id,
      title: inputs.title,
      taskType: inputs.taskType,
      gaps: inputs.gaps,
      hasGroundTruth: inputs.hasGroundTruth,
    };
    const startedAt = Date.now();
    try {
      // Stage 1 — the map, exactly as the FOC-515 eval drove it.
      const generator = createDefaultGenerator({
        apiKey,
        runId,
        taskKey: inputs.id,
        shadowDir,
        fetchImpl,
        timeoutMs,
      });
      const map = await runPlanIntentNode({
        stepId: "plan.intent",
        step: intentStep,
        reads: {
          "inbox.entry": inputs.entry,
          "plan.dor.gaps": inputs.gaps,
          "intake.taskType": inputs.taskType,
        },
        generator,
        validate: schemaValidator(intentStep.output),
        maps: {},
        presented: {},
      });
      row.mapStatus = map.status;
      row.mapVersion = map.mapVersion ?? null;
      row.mapAttempts = map.attempts ?? null;
      if (map.status !== "done") {
        // No map → nothing to select from. The skip IS the measurement.
        row.ok = false;
        row.skipped = `map ${map.status}${map.error ? ` (${map.error.code})` : ""}`;
        row.error = map.error ?? null;
        row.durationMs = Date.now() - startedAt;
        rows.push(row);
        writeOutputs(outDir, rows, source);
        continue;
      }
      const items = Array.isArray(map.output?.interpretations) ? map.output.interpretations : [];
      row.mapItems = items.length;
      row.sources = items.reduce((acc, it) => {
        if (it?.source in acc) acc[it.source]++;
        return acc;
      }, { stated: 0, inferred: 0, unknown: 0 });

      // Stage 2 — the selection over that map: the node-internal [J] call via
      // the real seam caller (A0, one call per map).
      const caller = createDecisionCaller({
        apiKey,
        shadowDir,
        runId,
        taskKey: inputs.id,
        fetchImpl,
        timeoutMs: callerTimeoutMs,
      });
      const selection = await runPlanIntentSelectNode({
        stepId: "plan.intent.select",
        reads: {
          "plan.intent.record": { stepId: "plan.intent", key: "plan.intent", status: "done", output: map.output },
        },
        caller,
        validate: selectValidate,
      });
      row.selectionStatus = selection.status;
      row.selection = selection.output ?? null;
      row.scores = selection.scores ?? null;
      row.eventId = selection.eventId ?? null;
      row.confidence = selection.confidence ?? null;
      row.dedupedIds = selection.dedupedIds ?? [];
      if (selection.status === "done") {
        row.ok = true;
        row.schemaValid = selectValidate(selection.output) === true;
        const out = selection.output;
        row.routeCounts = {
          questions: out.questions.length,
          confirmations: out.confirmations.length,
          understood: out.understood.length,
          assumptions: out.assumptions.length,
        };
        row.capOverflow = out.assumptions.filter((a) => typeof a.reason === "string" && a.reason.includes("question cap")).length;
        row.alternativesOverride = out.questions.filter((q) => q.options?.some((o) => o.reason === "the map's current reading")).length;
      } else {
        row.ok = false;
        row.error = selection.error;
      }
      if (selectSchemaErrors.length) row.schemaErrors = selectSchemaErrors.map((list) => list.slice(0, 12));
      row.durationMs = Date.now() - startedAt;
    } catch (err) {
      row.ok = false;
      row.skipped = null;
      row.error = {
        code: typeof err?.code === "string" ? err.code : "unknown",
        message: typeof err?.message === "string" ? err.message.slice(0, 200) : "unknown",
      };
      row.durationMs = Date.now() - startedAt;
    }
    rows.push(row);
    // Persist as we go — a serial 12-case run is long.
    writeOutputs(outDir, rows, source);
  }

  // Usage/cost join: the [G] map lines and the [J] score lines are joined
  // separately (different endpoints, different models).
  const events = readEventLines(shadowDir);
  for (const row of rows) {
    const lines = events.get(row.id) ?? [];
    const gLines = lines.filter((l) => l.decisionId === "plan.intent");
    const scoreLines = lines.filter((l) => l.decisionId === "plan.intent.select.score");
    row.mapCalls = gLines.length;
    row.scoreCalls = scoreLines.length;
    row.mapUsage = usageSum(gLines);
    row.scoreUsage = usageSum(scoreLines);
    const costs = [...gLines, ...scoreLines].map((l) => costOf(l.model, l.usage)).filter((c) => c != null);
    row.cost = costs.length ? costs.reduce((n, c) => n + c, 0) : null;
    row.models = [...new Set(lines.map((l) => l.model).filter(Boolean))];
  }

  const okRows = rows.filter((r) => r.ok);
  const skipped = rows.filter((r) => r.skipped);
  const withUsage = rows.filter((r) => r.mapUsage || r.scoreUsage);
  const latencies = rows.map((r) => r.durationMs);
  const routeTotal = (name) => okRows.reduce((n, r) => n + (r.routeCounts?.[name] ?? 0), 0);
  const summary = {
    ranAt: new Date().toISOString(),
    fixture: fixturePath,
    runId,
    budgets: { mapTimeoutMs: timeoutMs, scoreTimeoutMs: callerTimeoutMs },
    cases: rows.length,
    selectOk: okRows.length,
    skipped: skipped.length,
    skippedIds: skipped.map((r) => r.id),
    failed: rows.filter((r) => !r.ok && !r.skipped).map((r) => r.id),
    schemaValid: okRows.filter((r) => r.schemaValid === true).length,
    routes: {
      questions: routeTotal("questions"),
      confirmations: routeTotal("confirmations"),
      understood: routeTotal("understood"),
      assumptions: routeTotal("assumptions"),
    },
    capOverflowCases: okRows.filter((r) => r.capOverflow > 0).map((r) => r.id),
    alternativesOverrideCases: okRows.filter((r) => r.alternativesOverride > 0).map((r) => r.id),
    mapCalls: rows.reduce((n, r) => n + (r.mapCalls ?? 0), 0),
    scoreCalls: rows.reduce((n, r) => n + (r.scoreCalls ?? 0), 0),
    mapInputTokens: withUsage.reduce((n, r) => n + (r.mapUsage?.inputTokens ?? 0), 0),
    mapOutputTokens: withUsage.reduce((n, r) => n + (r.mapUsage?.outputTokens ?? 0), 0),
    scoreInputTokens: withUsage.reduce((n, r) => n + (r.scoreUsage?.inputTokens ?? 0), 0),
    scoreOutputTokens: withUsage.reduce((n, r) => n + (r.scoreUsage?.outputTokens ?? 0), 0),
    totalCostUsd: rows.reduce((n, r) => n + (r.cost ?? 0), 0),
    latencyMs: {
      basis: "pipeline wall-clock per case (map call + selection), aborts included",
      min: percentile(latencies, 0),
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      max: percentile(latencies, 100),
    },
    model: [...new Set(rows.map((r) => r.models ?? []).flat())],
    scoring: "human — see docs/benchmark/plan-intent-eval.md (FOC-516 sibling section)",
  };

  const order = new Map(source.map((i, n) => [i.id, n]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  writeOutputs(outDir, rows, source);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "table.txt"), renderTable(rows, summary));
  return summary;
}

function renderTable(rows, summary) {
  const lines = [
    `plan.intent.select eval — ${summary.ranAt} — model: ${summary.model.join(", ") || "n/a"}`,
    `cases ${summary.cases} · selection ok ${summary.selectOk} · skipped (no map) ${summary.skipped} · failed ${summary.failed.length} · schema-valid ${summary.schemaValid}`,
    `routes: questions ${summary.routes.questions} · confirmations ${summary.routes.confirmations} · understood ${summary.routes.understood} · assumptions ${summary.routes.assumptions}`,
    `cap-overflow cases: ${summary.capOverflowCases.join(", ") || "-"} · alternatives-override cases: ${summary.alternativesOverrideCases.join(", ") || "-"}`,
    `calls: map ${summary.mapCalls} · score ${summary.scoreCalls} · tokens map ${summary.mapInputTokens}/${summary.mapOutputTokens} · score ${summary.scoreInputTokens}/${summary.scoreOutputTokens} · cost $${summary.totalCostUsd.toFixed(6)}`,
    `latency ms (pipeline wall-clock) p50 ${summary.latencyMs.p50 ?? "-"} · p90 ${summary.latencyMs.p90 ?? "-"} · max ${summary.latencyMs.max ?? "-"}`,
    "",
    "id       ok  map  items st/in/un  q/c/u/a  cap+ovr  ms       cost USD  skipped/errors",
  ];
  for (const r of rows) {
    const rc = r.routeCounts;
    lines.push(
      [
        r.id.padEnd(8),
        String(r.ok),
        String(r.mapStatus ?? "-").padEnd(6),
        String(r.mapItems ?? "-").padEnd(5),
        r.sources ? `${r.sources.stated}/${r.sources.inferred}/${r.sources.unknown}` : "-",
        rc ? `${rc.questions}/${rc.confirmations}/${rc.understood}/${rc.assumptions}`.padEnd(8) : "-",
        String(r.capOverflow ?? "-").padEnd(8),
        String(r.durationMs ?? "-").padEnd(8),
        r.cost != null ? r.cost.toFixed(6) : "-",
        r.skipped ?? (r.ok ? "-" : (r.error?.code ?? "unknown")),
      ].join("  "),
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("plan-intent-select-eval: OPENROUTER_API_KEY is absent — nothing measured (exit 3)");
    return 3;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = flag("out-dir") ?? join(root, ".state", "foc-516", "select-eval", stamp);
  const intFlag = (name) => {
    const raw = flag(name);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n)) {
      console.error(`plan-intent-select-eval: --${name} must be an integer`);
      process.exit(2);
    }
    return n;
  };
  const idsRaw = flag("ids");
  const ids = idsRaw !== undefined ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const summary = await runAll({
    fixturePath: flag("fixture") ?? FIXTURE_PATH,
    outDir,
    limit: intFlag("limit"),
    ids,
    runId: flag("run-id") ?? "foc-516-select-eval",
    ...(flag("timeout") ? { timeoutMs: intFlag("timeout") } : {}),
    ...(flag("caller-timeout") ? { callerTimeoutMs: intFlag("caller-timeout") } : {}),
  });
  console.log(readFileSync(join(outDir, "table.txt"), "utf8"));
  console.log(`artifacts: ${outDir}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`plan-intent-select-eval: ${err?.message || err}`);
      process.exit(1);
    });
}
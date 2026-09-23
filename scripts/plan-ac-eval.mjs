// scripts/plan-ac-eval.mjs — FOC-475 AC4: measure the plan.ac [G] node — the
// generator call PLUS its node-internal plan.ac.testable gate loop — against
// the 12 Fenix issues whose acceptance criteria Mateusz already wrote.
//
// For each fixture issue the harness builds the SAME input partition the
// runner hands a live plan.ac step (title + accepted-scope summary + the DoR
// facts + the candidate files, all composed deterministically by THIS caller
// — the node has no tools and no repo access), then drives the REAL node loop
// (runPlanAcNode with the runner's own default generator and the real
// decision-call seam caller — the exact composition a live graph run uses).
// Usage and cost come off the FOC-449 event lines the transports wrote — the
// same ledger a live run produces, never a second meter.
//
// Scoring (testable / covers scope / no duplicates, pass/partial/fail) is
// human: an LLM grader would need its own validation, so the harness ships
// the raw outputs plus mechanical facts (schema validity, criterion counts,
// kind/evidence distribution, per-criterion gate verdicts, attempts,
// escalations, latency, tokens, cost) and the graded table lives in the run
// report + docs/benchmark/plan-ac-eval.md. A FAIL verdict here is a
// measurement, not an error (codegraph-benchmark posture).
//
// Input partition (FOC-475 design, decided point 4):
//   - `issueId` is the fixture id; `title` the issue title;
//   - the scope summary is the description with (a) the AC ground-truth
//     section stripped — from the "## Acceptance [Cc]riteria" heading or the
//     inline "**Acceptance criteria:**" / "**AC:**" marker to the next "## "
//     heading OR the next line-start "**Key:**" bold marker (or EOF) — and
//     (b) the terminal "<!-- fenix-roadmap-… -->" metadata block stripped;
//     the DoD section STAYS: it is the issue's own dictated text (plan.dod's
//     ground truth, not plan.ac's answer key) and a real dictated entry would
//     carry it;
//   - `dorFacts` are the line-start "**Key:**" fact lines of the stripped
//     text (Source/Scope/Deliverable-style constraint lines), excluding the
//     AC/DoD section markers themselves, capped at 200 chars each, max 8;
//     none → null;
//   - `candidateFiles` are the backticked repo-ish paths in the stripped
//     text (with a trailing ":line[,line]" reference suffix removed) —
//     deduped in first-appearance order, capped at 12.
//
// Honest-eval rule: land the prompt, run the eval ONCE, record what comes
// out — fixing transport/schema bugs is fine; do NOT iterate the prompt
// against the ground truth (criteriaVersion discipline).
//
// CLI:
//   node scripts/plan-ac-eval.mjs [--fixture <path>] [--out-dir <dir>]
//        [--limit <n>] [--run-id <id>] [--timeout <ms>]
// Artifacts (gitignored, under .state/foc-475/eval/<timestamp>/):
//   outputs.jsonl  — one line per issue: inputs as built, output, usage, cost
//   summary.json   — aggregate: counts, tokens, cost, models
//   table.txt      — compact per-issue table
//   <run-id>/decisions.jsonl — the FOC-449 event lines themselves
// Exit 0 = run completed (some rows may have failed calls or escalations —
// that is a measurement); exit 3 = no OPENROUTER_API_KEY, nothing measured.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { createDecisionCaller } from "./decision-call.mjs";
import { loadGraph } from "./graph-validate.mjs";
import { createDefaultGenerator } from "./graph-runner.mjs";
import { runPlanAcNode } from "./plan-ac.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// The in-repo twin of the supervisor's fixture-acs.json — the SAME file the
// plan.dod eval measures against: 12 Fenix issues, AC ground truth in 11/12.
const FIXTURE_PATH = join(__dir, "plan-dod-eval-fixture.json");

// The AC ground-truth section, in its three shapes: a "## Acceptance
// [Cc]riteria" heading (9 issues) or the inline "**Acceptance criteria:**" /
// "**AC:**" marker (FOC-441, FOC-443). FOC-406 carries neither — its ACs
// were never written, so it has NO ground truth and is excluded from the
// coverage aggregate (reported UNKNOWN, never scored a fake pass).
const AC_HEADING = /^## Acceptance [Cc]riteria[^\n]*(?:\n|$)/m;
const AC_INLINE = /\*\*(?:Acceptance criteria|AC):\*\*/;
// A section ends at the next "## " heading OR the next line-start "**Key:**"
// bold marker (FOC-441/443's inline AC sections run into "**Definition of
// done:**" / "**DoD:**", not a heading).
const SECTION_START = /^## [^\n]*(?:\n|$)|^\*\*[^*\n]+:\*\*/m;
// Roadmap metadata is a terminal block: from the marker to end-of-text.
const ROADMAP_BLOCK = /[ \t]*<!-- fenix-roadmap[\s\S]*$/;

// The bold-keyed markers that OPEN a ground-truth section — never dorFacts.
const SECTION_MARKER_KEYS = /^(?:acceptance criteria|ac|definition of done|dod)$/i;

function stripRoadmap(text) {
  return text.replace(ROADMAP_BLOCK, "").trimEnd();
}

/**
 * Build the plan.ac input partition for one fixture issue. Pure.
 * Returns { id, issueId, title, scopeSummary, dorFacts, candidateFiles,
 * acGroundTruth, hasGroundTruth }. Throws TypeError on a malformed fixture
 * row — the fixture is external input and gets validated, not trusted.
 *
 * Deterministic composition rules (documented, no repo access):
 *   - dorFacts: the line-start "**Key:**" fact lines of the stripped text
 *     (the Source/Scope/Deliverable-style constraints the dictated entry
 *     carries), excluding the AC/DoD section markers, each capped at 200
 *     chars, at most 8; none → null.
 *   - candidateFiles: backticked repo-ish paths in the stripped text (a
 *     trailing ":line[,line]" reference suffix removed), deduped in
 *     first-appearance order, at most 12.
 */
export function buildInputs(issue) {
  if (!issue || typeof issue !== "object") throw new TypeError("fixture row is not an object");
  const { id, title, description } = issue;
  if (typeof id !== "string" || !id.trim()) throw new TypeError("fixture row: id missing");
  if (typeof title !== "string" || !title.trim()) throw new TypeError(`fixture row ${id}: title missing`);
  if (typeof description !== "string") throw new TypeError(`fixture row ${id}: description missing`);

  // Ground truth first: locate the AC section, then cut it out of the scope
  // text. The section spans from the marker to the next section start (a
  // "## " heading or a line-start bold marker) or EOF.
  let acGroundTruth = null;
  let scopeText = description;
  const marker = AC_HEADING.exec(description) ?? AC_INLINE.exec(description);
  if (marker) {
    const start = marker.index + marker[0].length;
    const next = SECTION_START.exec(description.slice(start));
    const end = next ? start + next.index : description.length;
    acGroundTruth = stripRoadmap(description.slice(start, end)).trim() || null;
    scopeText = description.slice(0, marker.index) + description.slice(end);
  }
  const stripped = stripRoadmap(scopeText).replace(/\n{3,}/g, "\n\n").trim();

  const dorFacts = [];
  for (const line of stripped.split("\n")) {
    const m = /^\*\*([^*\n]+):\*\*/.exec(line.trim());
    if (!m || SECTION_MARKER_KEYS.test(m[1])) continue;
    dorFacts.push(line.trim().slice(0, 200));
    if (dorFacts.length >= 8) break;
  }

  const candidateFiles = [];
  for (const match of stripped.matchAll(/`([^`\n]+)`/g)) {
    const path = match[1].replace(/(:\d[\d,\-]*)+$/, "");
    if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\.(?:mjs|json|md|jsx?|ts|yml|bat)$/.test(path)) continue;
    if (!candidateFiles.includes(path)) candidateFiles.push(path);
    if (candidateFiles.length >= 12) break;
  }

  return {
    id: id.trim(),
    issueId: id.trim(),
    title,
    scopeSummary: stripped,
    dorFacts: dorFacts.length ? dorFacts : null,
    candidateFiles,
    acGroundTruth,
    hasGroundTruth: acGroundTruth !== null,
  };
}

/** Read the FOC-449 event lines a run wrote, keyed by taskKey (arrays — a
 * node-internal loop makes up to two [G] calls and up to two gate calls per
 * issue; every line is kept, never overwritten). */
function readEventLines(shadowDir) {
  const byTask = new Map();
  let text;
  try {
    text = readFileSync(join(shadowDir, "decisions.jsonl"), "utf8");
  } catch {
    return byTask; // no successful call wrote a line — nothing to join
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const line_ = JSON.parse(line);
      if (line_.type === "event" && typeof line_.taskKey === "string") {
        if (!byTask.has(line_.taskKey)) byTask.set(line_.taskKey, []);
        byTask.get(line_.taskKey).push(line_);
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

function schemaValidator(schema) {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema ?? { type: "object" });
}

/** Sum the usage of a set of event lines; null when none carries numbers. */
function usageSum(lines) {
  const usable = (lines ?? []).filter((l) => l.usage && (l.usage.inputTokens != null || l.usage.outputTokens != null));
  if (!usable.length) return null;
  return {
    inputTokens: usable.reduce((n, l) => n + (l.usage.inputTokens ?? 0), 0),
    outputTokens: usable.reduce((n, l) => n + (l.usage.outputTokens ?? 0), 0),
    calls: usable.length,
  };
}

/**
 * Run the eval: one real plan.ac node execution (generator + gate loop) per
 * fixture issue, artifacts under outDir. Returns the summary object (also
 * written as summary.json). Deps are injectable so tests drive it offline
 * (fetchImpl stub, explicit issues list).
 */
export async function runAll({
  fixturePath = FIXTURE_PATH,
  outDir,
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  // 300s: the plan.dod eval measured cheap-tier calls at 25–300s against the
  // runner's 120s default — the measurement gives the model its headroom and
  // reports the latency; the runner default stays fail-closed.
  timeoutMs = 300000,
  // The gate rides the decisions endpoint (measured ~11s for yes/no; 12
  // instances ride one call) — 120s headroom, fail-closed beyond it.
  callerTimeoutMs = 120000,
  runId = "foc-475-eval",
  issues: issuesOverride,
  limit,
} = {}) {
  if (!outDir || typeof outDir !== "string") throw new TypeError("outDir is required — artifacts land under it");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const source = issuesOverride ?? fixture.issues;
  if (!Array.isArray(source) || source.length === 0) throw new TypeError("fixture carries no issues — nothing to measure");
  const issues = source.slice(0, Number.isInteger(limit) ? limit : undefined);

  const step = loadGraph().nodes?.plan?.steps?.["plan.ac"];
  if (!step) throw new TypeError("config/graph.json has no plan.ac step — the eval drives the runner's real step object");
  const shadowDir = join(outDir, runId);
  mkdirSync(shadowDir, { recursive: true });
  const validate = schemaValidator(step.output);

  const rows = [];
  for (const issue of issues) {
    const inputs = buildInputs(issue);
    const row = {
      id: inputs.id,
      title: inputs.title,
      hasGroundTruth: inputs.hasGroundTruth,
      scopeSummary: inputs.scopeSummary,
      dorFacts: inputs.dorFacts,
      candidateFiles: inputs.candidateFiles,
      acGroundTruth: inputs.acGroundTruth,
    };
    const startedAt = Date.now();
    try {
      // The REAL node loop a live graph run executes: the default [G]
      // transport + the real decision-call seam for the testable gate.
      const generator = createDefaultGenerator({
        apiKey,
        runId,
        taskKey: inputs.id,
        shadowDir,
        fetchImpl,
        timeoutMs,
      });
      const caller = createDecisionCaller({
        apiKey,
        shadowDir,
        runId,
        taskKey: inputs.id,
        fetchImpl,
        timeoutMs: callerTimeoutMs,
      });
      const result = await runPlanAcNode({
        stepId: "plan.ac",
        step,
        reads: {
          "inbox.entry": {
            issueId: inputs.issueId,
            title: inputs.title,
            scopeSummary: inputs.scopeSummary,
            dorFacts: inputs.dorFacts,
          },
          "features.list": inputs.candidateFiles,
        },
        generator,
        caller,
        validate,
      });
      row.ok = result.status === "done";
      if (result.status === "done") {
        row.output = result.output;
        row.schemaValid = validate(result.output) === true;
        row.attempts = result.attempts;
        row.regenerated = result.attempts > 1;
        row.scores = result.scores;
      } else {
        row.error = result.error;
        row.escalated = result.error?.code === "escalated";
        if (result.escalation) {
          row.escalation = result.escalation;
          row.escalated = true;
        }
      }
      row.durationMs = Date.now() - startedAt;
      if (!inputs.hasGroundTruth) row.note = "no ground truth in fixture — excluded from the coverage aggregate, reported UNKNOWN";
    } catch (err) {
      row.ok = false;
      row.error = {
        code: typeof err?.code === "string" ? err.code : "unknown",
        message: typeof err?.message === "string" ? err.message.slice(0, 200) : "unknown",
      };
      row.durationMs = Date.now() - startedAt;
    }
    rows.push(row);
  }

  // Usage/cost join: the transports appended one event line per successful
  // call (taskKey = issue id) — the same ledger a live run produces. The
  // [G] calls (decisionId plan.ac) and the gate calls (plan.ac.testable) are
  // joined separately: different endpoints, different models.
  const events = readEventLines(shadowDir);
  for (const row of rows) {
    const lines = events.get(row.id) ?? [];
    const gLines = lines.filter((l) => l.decisionId === "plan.ac");
    const gateLines = lines.filter((l) => l.decisionId === "plan.ac.testable");
    row.gCalls = gLines.length;
    row.gateCalls = gateLines.length;
    row.usage = usageSum(gLines);
    row.gateUsage = usageSum(gateLines);
    const costs = [...gLines, ...gateLines].map((l) => costOf(l.model, l.usage)).filter((c) => c != null);
    row.cost = costs.length ? costs.reduce((n, c) => n + c, 0) : null;
    row.models = [...new Set(lines.map((l) => l.model).filter(Boolean))];
    row.gLatencyMs = gLines.reduce((n, l) => n + (l.durationMs ?? 0), 0) || null;
  }

  const okRows = rows.filter((r) => r.ok);
  const schemaValid = okRows.filter((r) => r.schemaValid === true);
  const withUsage = okRows.filter((r) => r.usage);
  const withGateUsage = rows.filter((r) => r.gateUsage);
  const summary = {
    ranAt: new Date().toISOString(),
    fixture: fixturePath,
    runId,
    issues: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    schemaValid: schemaValid.length,
    regenerated: okRows.filter((r) => r.regenerated).length,
    escalated: rows.filter((r) => r.escalated).length,
    gateAttemptsTotal: rows.reduce((n, r) => n + (r.gateCalls ?? 0), 0),
    noGroundTruth: rows.filter((r) => !r.hasGroundTruth).map((r) => r.id),
    totalInputTokens: withUsage.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0),
    totalOutputTokens: withUsage.reduce((n, r) => n + (r.usage.outputTokens ?? 0), 0),
    totalGateInputTokens: withGateUsage.reduce((n, r) => n + (r.gateUsage.inputTokens ?? 0), 0),
    totalGateOutputTokens: withGateUsage.reduce((n, r) => n + (r.gateUsage.outputTokens ?? 0), 0),
    totalCostUsd: rows.reduce((n, r) => n + (r.cost ?? 0), 0),
    costNote: rows.filter((r) => r.ok).length && rows.every((r) => r.cost == null)
      ? "no successful call carried a usable usage row — costs are NOT in the totals"
      : null,
    model: [...new Set(rows.flatMap((r) => r.models ?? []))],
    scoring: "human — see docs/benchmark/plan-ac-eval.md and the run report",
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "outputs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "table.txt"), renderTable(rows, summary));
  return summary;
}

function renderTable(rows, summary) {
  const lines = [
    `plan.ac eval — ${summary.ranAt} — models: ${summary.model.join(", ") || "n/a"}`,
    `issues ${summary.issues} · ok ${summary.ok} · failed ${summary.failed} · schema-valid ${summary.schemaValid} · regenerated ${summary.regenerated} · escalated ${summary.escalated}`,
    `[G] tokens in ${summary.totalInputTokens} · out ${summary.totalOutputTokens} · gate tokens in ${summary.totalGateInputTokens} · out ${summary.totalGateOutputTokens} · cost $${summary.totalCostUsd.toFixed(6)}${summary.costNote ? ` (${summary.costNote})` : ""}`,
    "",
    "id       ok  schema  acs  minP    regen  esc    ms       in/out tok   cost USD",
  ];
  for (const r of rows) {
    const acs = Array.isArray(r.output?.acs) ? r.output.acs : [];
    const verdicts = (r.scores ?? r.escalation?.criteria ?? []).map((s) => s?.verdict).filter((v) => typeof v === "number");
    const minP = verdicts.length ? Math.min(...verdicts).toFixed(2) : "-";
    lines.push(
      [
        r.id.padEnd(8),
        String(r.ok),
        r.ok ? String(r.schemaValid).padEnd(6) : "-".padEnd(6),
        String(acs.length).padEnd(4),
        minP.padEnd(7),
        String(r.regenerated ?? false).padEnd(6),
        String(r.escalated ?? false).padEnd(6),
        String(r.gLatencyMs ?? "-").padEnd(8),
        r.usage ? `${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}` : "-",
        r.cost != null ? r.cost.toFixed(6) : "-",
      ].join("  "),
    );
  }
  if (summary.noGroundTruth.length) lines.push("", `no ground truth (UNKNOWN, excluded from coverage): ${summary.noGroundTruth.join(", ")}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("plan-ac-eval: OPENROUTER_API_KEY is absent — nothing measured (exit 3)");
    return 3;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = flag("out-dir") ?? join(root, ".state", "foc-475", "eval", stamp);
  const limitRaw = flag("limit");
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw !== undefined && !Number.isInteger(limit)) {
    console.error("plan-ac-eval: --limit must be an integer");
    return 2;
  }
  const summary = await runAll({
    fixturePath: flag("fixture") ?? FIXTURE_PATH,
    outDir,
    limit,
    runId: flag("run-id") ?? "foc-475-eval",
    ...(flag("timeout") ? { timeoutMs: Number.parseInt(flag("timeout"), 10) } : {}),
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
      console.error(`plan-ac-eval: ${err?.message || err}`);
      process.exit(1);
    });
}
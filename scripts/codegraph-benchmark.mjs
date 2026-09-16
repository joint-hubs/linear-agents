#!/usr/bin/env node
// scripts/codegraph-benchmark.mjs — FOC-114 CodeGraph navigation benchmark.
//
// Runs the graph arm of the benchmark: every question from the frozen manifest
// (codegraph-benchmark-questions.json) through scripts/code-intel.mjs against
// this tree's .codegraph index, grades the answers against grep-verified ground
// truth, and records correctness, output volume (bytes, lines) and elapsed wall
// time per question.
//
// Usage:
//   node scripts/codegraph-benchmark.mjs [--direct <results.json>]... [--out <dir>]
//                                        [--manifest <path>]
//
//   --direct    merge separately-collected direct-search arm results (JSON array
//               of { id, verdict: pass|fail|unanswered, toolCalls, transcript,
//               notes? }); ids must match manifest questions. The direct arm is
//               run by the lead with fresh bounded agents — see the budget rule
//               in the manifest and docs/benchmark/codegraph-navigation.md.
//   --out       output directory (default .state/foc-114/benchmark/, gitignored);
//               writes results.json, table.txt and one raw <id>.out per question.
//   --manifest  alternate questions manifest (default: next to this script).
//
// COST HONESTY: this harness meters wall time and output volume only. Token
// cost is recorded as the manifest's costStatement ("inconclusive — shell arm,
// no token metering; agent-arm pricing out of slice") — never a number.
//
// Exit codes: 0 = run completed (a FAIL verdict is a measurement, not an error);
// 3 = at least one question ungraded — the wrapper refused (missing index or CLI
//     not on PATH), so the results are UNKNOWN, not a measurement; build the
//     index first (`codegraph init`). Outputs are still written for inspection.
// 2 = harness misuse (missing manifest, direct-arm id not in the manifest).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
export const WRAPPER = join(__dirname, "code-intel.mjs");
const DEFAULT_MANIFEST = join(__dirname, "codegraph-benchmark-questions.json");
const DEFAULT_OUT = join(ROOT, ".state", "foc-114", "benchmark");

// ── pure core (exported for codegraph-benchmark.test.mjs) ────────────────────

/**
 * Grade one answer against one manifest question. Expected paths are matched
 * against the combined output with separators normalized, because CLI output
 * uses forward slashes while Node paths on win32 do not.
 */
export function gradeAnswer(output, question) {
  if (question.groundTruthKind === "judgement") return { verdict: "manual", missing: [] };
  const hay = (output || "").replace(/\\/g, "/");
  const missing = question.expectedContains.filter((needle) => !hay.includes(needle));
  return { verdict: missing.length === 0 ? "pass" : "fail", missing };
}

/**
 * Grade one tool result row. A wrapper refusal (exit 3 — missing index or CLI
 * not on PATH) is UNKNOWN, never a graded answer: grading it as `fail` would
 * turn the tool's own "a negative result right now would be a lie" into a
 * confident negative — the exact failure mode FOC-114 exists to expose
 * (review round 1). Exit-3 rows come back `ungraded` and the run exits 3.
 */
export function gradeRow(exitCode, output, question) {
  if (exitCode === 3) return { verdict: "ungraded", missing: [] };
  return gradeAnswer(output, question);
}

/**
 * Merge direct-arm entries into graded graph-arm results. Unknown ids are a
 * harness-misuse error — a silently dropped direct answer would look like an
 * unanswered question in the combined table.
 */
export function mergeDirect(results, directEntries) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return directEntries.map((entry) => {
    const graph = byId.get(entry.id);
    if (!graph) throw new Error(`direct-arm entry "${entry.id}" matches no manifest question`);
    return {
      id: entry.id,
      graphVerdict: graph.verdict,
      directVerdict: entry.verdict ?? "unanswered",
      toolCalls: entry.toolCalls ?? null,
      transcript: entry.transcript ?? null,
      notes: entry.notes ?? "",
    };
  });
}

/** Fixed-width human table. Rows: {id, class, verb, verdict, bytes, lines, ms, missing}. */
export function renderTable(rows, { costStatement, directRows = null }) {
  const line = (s) => `  ${s}`;
  const out = [];
  out.push(line("id                       class                 verb      verdict  bytes  lines     ms"));
  out.push(line("----------------------- -------------------- --------- ------- ------ ------ -------"));
  for (const r of rows) {
    out.push(
      line(
        `${r.id.padEnd(24).slice(0, 24)} ${r.class.padEnd(20).slice(0, 20)} ${r.verb.padEnd(9).slice(0, 9)} ` +
          `${r.verdict.padEnd(8)} ${String(r.bytes).padStart(6)} ${String(r.lines).padStart(6)} ${String(r.ms).padStart(7)}`,
      ),
    );
    if (r.missing?.length) out.push(line(`  ^ missing: ${r.missing.join(", ")}`));
  }
  out.push(line(""));
  out.push(line(`cost: ${costStatement}`));
  if (directRows) {
    out.push(line(""));
    out.push(line("combined (AC3): graph arm vs direct-search arm"));
    out.push(line("id                       graph    direct       toolCalls"));
    out.push(line("----------------------- -------- ------------ ---------"));
    for (const d of directRows) {
      out.push(
        line(
          `${d.id.padEnd(24).slice(0, 24)} ${d.graphVerdict.padEnd(8)} ${d.directVerdict.padEnd(12)} ${String(d.toolCalls ?? "-").padStart(9)}`,
        ),
      );
    }
    out.push(line(""));
    out.push(line(`cost: ${costStatement}`));
  }
  return out.join("\n");
}

// ── runner ───────────────────────────────────────────────────────────────────

function usage(code = 2) {
  console.error(
    [
      "Usage: node scripts/codegraph-benchmark.mjs [--direct <results.json>]... [--out <dir>] [--manifest <path>]",
      "",
      "Runs every manifest question through scripts/code-intel.mjs (graph arm), grades against",
      "ground truth, writes results.json + table.txt + per-question raw output to --out.",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { direct: [], out: DEFAULT_OUT, manifest: DEFAULT_MANIFEST };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--direct") opts.direct.push(argv[++i]);
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "--manifest") opts.manifest = argv[++i];
    else usage(2);
  }
  return opts;
}

const shellVersion = () => {
  // Same resolution path as the wrapper (shell:true on win32), so this names
  // the binary the graph arm actually talked to.
  const r = spawnSync("codegraph", ["--version"], { shell: true, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : "unavailable";
};

const gitHead = () =>
  (spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout || "").trim();

function runGraphArm(manifest) {
  const rows = [];
  const details = [];
  for (const q of manifest.questions) {
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [WRAPPER, q.verb, ...q.args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const ms = Date.now() - t0;
    const output = (res.stdout || "") + (res.stderr || "");
    const { verdict, missing } = gradeRow(res.status, output, q);
    const row = {
      id: q.id,
      class: q.class,
      verb: q.verb,
      verdict,
      missing,
      bytes: Buffer.byteLength(output, "utf8"),
      lines: output.split("\n").length,
      ms,
      exitCode: res.status,
    };
    rows.push(row);
    // The exact output that was graded, persisted as the per-question sidecar.
    details.push({ ...row, output, question: q.question, args: q.args, groundTruthKind: q.groundTruthKind });
  }
  return { rows, details };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(opts.manifest, "utf8"));

  const { rows, details } = runGraphArm(manifest);

  const directRows = [];
  for (const path of opts.direct) {
    let entries;
    try {
      entries = JSON.parse(readFileSync(resolve(path), "utf8"));
    } catch (err) {
      console.error(`[benchmark] cannot read direct-arm results "${path}": ${err.message}`);
      process.exit(2);
    }
    if (!Array.isArray(entries)) {
      console.error(`[benchmark] direct-arm file "${path}" must be a JSON array of entries`);
      process.exit(2);
    }
    try {
      directRows.push(...mergeDirect(details, entries));
    } catch (err) {
      console.error(`[benchmark] ${err.message}`);
      process.exit(2);
    }
  }

  const results = {
    benchmark: manifest.benchmark,
    generatedAt: new Date().toISOString(),
    repoRoot: ROOT,
    worktreeRevision: gitHead(),
    cliResolvedByShell: shellVersion(),
    cost: manifest.costStatement,
    directArmBudgetRule: manifest.directArmBudgetRule,
    directArmProvided: opts.direct.length > 0,
    directArmSources: opts.direct,
    summary: {
      total: rows.length,
      pass: rows.filter((r) => r.verdict === "pass").length,
      fail: rows.filter((r) => r.verdict === "fail").length,
      manual: rows.filter((r) => r.verdict === "manual").length,
      ungraded: rows.filter((r) => r.verdict === "ungraded").length,
      totalMs: rows.reduce((acc, r) => acc + r.ms, 0),
    },
    questions: details,
    combined: directRows.length ? directRows : null,
  };

  mkdirSync(opts.out, { recursive: true });
  for (const detail of details) {
    writeFileSync(join(opts.out, `${detail.id}.out`), detail.output);
  }

  const table = renderTable(rows, {
    costStatement: manifest.costStatement,
    directRows: directRows.length ? directRows : null,
  });

  // Keep the bulky raw output out of results.json; sidecar files carry it.
  const questionsForJson = details.map(({ output, ...rest }) => ({ ...rest, sidecar: `${rest.id}.out` }));
  writeFileSync(join(opts.out, "results.json"), JSON.stringify({ ...results, questions: questionsForJson }, null, 2) + "\n");
  writeFileSync(join(opts.out, "table.txt"), table + "\n");

  console.log(table);
  console.log(`\nsummary: ${results.summary.pass} pass, ${results.summary.fail} fail, ${results.summary.manual} manual, ${results.summary.ungraded} ungraded (${results.summary.totalMs} ms total)`);
  console.log(`results: ${join(opts.out, "results.json")}`);
  console.log(`raw answers: ${join(opts.out, "<question-id>.out")}`);
  if (results.summary.ungraded > 0) {
    console.error(
      `\n[benchmark] ${results.summary.ungraded} question(s) ungraded: the wrapper refused ` +
        `(UNKNOWN, not a measurement). Results were written for inspection, but this run ` +
        `does not grade the frozen set — build the index first: codegraph init`,
    );
    process.exit(3);
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[benchmark] ${err.message}`);
    process.exit(2);
  });
}

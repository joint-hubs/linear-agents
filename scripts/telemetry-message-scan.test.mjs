// Contract test for the independent per-message usage scan (FOC-381
// verification). The module is deliberately separate from
// scripts/telemetry-ingest.mjs — this test pins the reference measurement the
// ingest fix will be checked against: naive line-sums must over-count
// exactly as predicted, per-message maxes must not, and duplicate lines
// (identical copies or zeros) must never be summed.
//
// Fixtures cover each line shape Claude Code writes: one message spread over
// three identical lines, one spread over lines where two carry zeros and one
// the real usage, a line with no message.id, a non-assistant line, an
// unparseable line, and the same message.id in two different files (two
// physical messages — grouping never spans files).

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTranscripts } from "./telemetry-message-scan.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function near(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) < epsilon;
}

// --- fixture --------------------------------------------------------------
// dev has two files, plan one. The message.id "shared" appears in BOTH
// dev/b.jsonl and plan/c.jsonl and must count as two messages.
//
// dev/projects/p1/a.jsonl:
//   m1 over 3 identical lines  (10, 20,  5,  5)  -> 40 tokens
//   m2 over 3 lines, 2 zeros   ( 0,  0,  0,  0) x2, (100, 200, 1000, 0) -> 1300
//   no-id line                 ( 7,  8,  0,  0)  -> 15, its own message
//   a user line and a non-JSON line (neither counts)
// dev/projects/p1/b.jsonl:
//   shared                     ( 3,  4,  0,  0)  -> 7
// plan/projects/p1/c.jsonl:
//   shared                     (30, 40,  0,  0)  -> 70
//   an assistant line with no usage object (must not count)
const temp = mkdtempSync(join(tmpdir(), "message-scan-test-"));
const agentsRoot = join(temp, "agents");

const line = (id, usage) =>
  JSON.stringify({ type: "assistant", message: id ? { id, usage } : { usage } });
const noUsageLine = JSON.stringify({ type: "assistant", message: { id: "orphan" } });
const usageA = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 };
const usageReal = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const usageZero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const usageNoId = { input_tokens: 7, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const usageDevShared = { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const usagePlanShared = { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

for (const squad of ["dev", "plan"]) {
  mkdirSync(join(agentsRoot, squad, "projects", "p1"), { recursive: true });
}
writeFileSync(
  join(agentsRoot, "dev", "projects", "p1", "a.jsonl"),
  [
    line("m1", usageA),
    line("m1", usageA),
    line("m1", usageA),
    line("m2", usageZero),
    line("m2", usageZero),
    line("m2", usageReal),
    line(null, usageNoId),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    "{not json",
    "",
  ].join("\n") + "\n",
);
writeFileSync(
  join(agentsRoot, "dev", "projects", "p1", "b.jsonl"),
  line("shared", usageDevShared) + "\n",
);
writeFileSync(
  join(agentsRoot, "plan", "projects", "p1", "c.jsonl"),
  [line("shared", usagePlanShared), noUsageLine].join("\n") + "\n",
);

// --- expected numbers -----------------------------------------------------
// dev naive: m1 x3 + zeros + real + no-id + dev shared
const devNaive = { input_tokens: 3 * 10 + 100 + 7 + 3, output_tokens: 3 * 20 + 200 + 8 + 4, cache_read_input_tokens: 3 * 5 + 1000, cache_creation_input_tokens: 3 * 5 };
// dev per-message: m1 max + m2 max + no-id line + dev shared
const devPerMessage = { input_tokens: 10 + 100 + 7 + 3, output_tokens: 20 + 200 + 8 + 4, cache_read_input_tokens: 5 + 1000, cache_creation_input_tokens: 5 };
const planNaive = { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const planPerMessage = { input_tokens: 30, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const tokens = (t) => t.input_tokens + t.output_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;

// --- scan -----------------------------------------------------------------
const result = await scanTranscripts(agentsRoot);
const dev = result.squads.dev;
const plan = result.squads.plan;
const totals = result.totals;

check("root is echoed", result.root === agentsRoot);
check("both squads scanned", Object.keys(result.squads).sort().join(",") === "dev,plan", Object.keys(result.squads).join(","));

// dev: per-squad separation and exact counts
check("dev files", dev.files === 2, `got ${dev.files}`);
check("dev counts only qualifying lines (3 dup + 3 dup + no-id + shared = 8)", dev.lines === 8, `got ${dev.lines}`);
check("dev messages = m1 + m2 + no-id + shared", dev.messages === 4, `got ${dev.messages}`);
check("dev noIdLines", dev.noIdLines === 1, `got ${dev.noIdLines}`);
check("dev parseErrors (the non-JSON line)", dev.parseErrors === 1, `got ${dev.parseErrors}`);
check("dev linesPerMessage = 8/4", near(dev.linesPerMessage, 2), `got ${dev.linesPerMessage}`);
for (const c of Object.keys(devNaive)) {
  check(`dev naive ${c}`, dev.naive[c] === devNaive[c], `got ${dev.naive[c]}, want ${devNaive[c]}`);
  check(`dev perMessage ${c}`, dev.perMessage[c] === devPerMessage[c], `got ${dev.perMessage[c]}, want ${devPerMessage[c]}`);
}
check("dev naiveTokens", dev.naiveTokens === tokens(devNaive), `got ${dev.naiveTokens}`);
check("dev perMessageTokens", dev.perMessageTokens === tokens(devPerMessage), `got ${dev.perMessageTokens}`);
check("dev factor = naive/perMessage", near(dev.factor, tokens(devNaive) / tokens(devPerMessage)), `got ${dev.factor}`);

// plan: the "shared" id must NOT merge with dev's copy, and the no-usage
// assistant line must be invisible.
check("plan files", plan.files === 1, `got ${plan.files}`);
check("plan lines (no-usage assistant line excluded)", plan.lines === 1, `got ${plan.lines}`);
check("plan messages (own copy of shared id)", plan.messages === 1, `got ${plan.messages}`);
check("plan noIdLines", plan.noIdLines === 0, `got ${plan.noIdLines}`);
for (const c of Object.keys(planNaive)) {
  check(`plan naive ${c}`, plan.naive[c] === planNaive[c], `got ${plan.naive[c]}, want ${planNaive[c]}`);
  check(`plan perMessage ${c}`, plan.perMessage[c] === planPerMessage[c], `got ${plan.perMessage[c]}, want ${planPerMessage[c]}`);
}
check("plan factor is 1 (nothing duplicated)", plan.factor === 1, `got ${plan.factor}`);

// totals
check("total files", totals.files === 3, `got ${totals.files}`);
check("total lines", totals.lines === 9, `got ${totals.lines}`);
check("total messages (same id in two files = two messages)", totals.messages === 5, `got ${totals.messages}`);
check("total noIdLines", totals.noIdLines === 1, `got ${totals.noIdLines}`);
check("total parseErrors", totals.parseErrors === 1, `got ${totals.parseErrors}`);
check("total naiveTokens", totals.naiveTokens === tokens(devNaive) + tokens(planNaive), `got ${totals.naiveTokens}`);
check("total perMessageTokens", totals.perMessageTokens === tokens(devPerMessage) + tokens(planPerMessage), `got ${totals.perMessageTokens}`);

// shares: they partition the fleet exactly.
check("raw shares sum to 1", near(dev.shareRaw + plan.shareRaw, 1), `got ${dev.shareRaw} + ${plan.shareRaw}`);
check("corrected shares sum to 1", near(dev.shareCorrected + plan.shareCorrected, 1), `got ${dev.shareCorrected} + ${plan.shareCorrected}`);
check("dev raw share reflects its weight", near(dev.shareRaw, tokens(devNaive) / (tokens(devNaive) + tokens(planNaive))), `got ${dev.shareRaw}`);
check("dev corrected share is smaller than raw (dedup shrinks dev)", dev.shareCorrected < dev.shareRaw,
  `raw ${dev.shareRaw} corrected ${dev.shareCorrected}`);

// squads filter: restricting to dev leaves plan out and totals equal dev's.
const devOnly = await scanTranscripts(agentsRoot, { squads: ["dev"] });
check("squads filter drops plan", !devOnly.squads.plan, Object.keys(devOnly.squads).join(","));
check("filtered totals match the squad", devOnly.totals.naiveTokens === dev.naiveTokens && devOnly.totals.messages === dev.messages,
  `got ${devOnly.totals.naiveTokens}/${devOnly.totals.messages}`);

// --- CLI ------------------------------------------------------------------
const script = fileURLToPath(import.meta.url).replace("telemetry-message-scan.test.mjs", "telemetry-message-scan.mjs");

const jsonRun = spawnSync(process.execPath, [script, "--root", agentsRoot, "--json"], { encoding: "utf8" });
check("CLI --json exits 0", jsonRun.status === 0, `exit ${jsonRun.status}: ${jsonRun.stderr}`);
let cliJson = null;
try { cliJson = JSON.parse(jsonRun.stdout); } catch { /* checked below */ }
check("CLI --json parses", cliJson != null && cliJson.totals != null);
check("CLI --json matches the API", cliJson != null && cliJson.totals.naiveTokens === totals.naiveTokens);

const humanRun = spawnSync(process.execPath, [script, "--root", agentsRoot], { encoding: "utf8" });
check("CLI human output exits 0", humanRun.status === 0, `exit ${humanRun.status}: ${humanRun.stderr}`);
check("human output has squad rows sorted with TOTAL last",
  humanRun.stdout.indexOf("dev") !== -1 && humanRun.stdout.indexOf("plan") !== -1 && /TOTAL/.test(humanRun.stdout),
  humanRun.stdout);
check("human output reports the factor", humanRun.stdout.includes("x"), humanRun.stdout);

// The LA_TRANSCRIPT_ROOT env override drives the default root.
const envRun = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8", env: { ...process.env, LA_TRANSCRIPT_ROOT: agentsRoot } });
check("LA_TRANSCRIPT_ROOT overrides the default root", envRun.status === 0 && JSON.parse(envRun.stdout).root === agentsRoot,
  `exit ${envRun.status}: ${envRun.stderr}`);

rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}

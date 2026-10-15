// Contract test for scripts/model-benchmarks.mjs — the AA intelligence index
// the Settings routing table's Benchmark column shows.
//
// Uses temp fixture files shaped exactly like config/model-benchmarks.json
// (the extraction docs/ui/refresh-model-data.py produces); never invents a
// score and never touches the network. The real snapshot is only smoke-tested
// shape-wise: a refresh moves the numbers, so tests pin the behaviour, not
// the values — except where the data source itself guarantees them.

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { benchmarkFor } from "./model-benchmarks.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

// --- fixtures (exact refresh-model-data.py extraction shape) -----------------

const temp = mkdtempSync(join(tmpdir(), "model-benchmarks-test-"));

// Unique name per fixture: the module re-reads on every call, but unique
// files keep each test's meaning independent of the others.
function writeFixture(content, name = "bench-" + Math.random().toString(36).slice(2) + ".json") {
  const path = join(temp, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  return path;
}

const SHAPE = {
  source: "Artificial Analysis intelligence index via OpenRouter (docs/ui/refresh-model-data.py)",
  snapshot: "2026-09-03",
  models: {
    "z-ai/glm-5.3-flash": [{ e: "default", intel: 57.5 }],
    "vendor/defaults-first": [
      { e: "default", intel: 61.2 },
      { e: "high", intel: 55.0 },
    ],
    "vendor/default-unscored": [
      { e: "default" }, // variant exists but AA gave it no intelligence index
      { e: "off", intel: 42.6 },
      { e: "max", intel: 55.3 },
    ],
    "vendor/no-default": [
      { e: "off", intel: 42.6 },
      { e: "max", intel: 55.3 },
    ],
    "vendor/unscored-only": [{ e: "high" }],
    "vendor/zero": [{ e: "default", intel: 0 }],
    "vendor/string-score": [{ e: "default", intel: "57.5" }],
    "vendor/empty-vars": [],
  },
};

const FIXTURE = writeFixture(SHAPE);

// --- the score itself ---------------------------------------------------------

test("a default-effort variant wins even when it is not first", () => {
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: FIXTURE }) === 61.2);
});

test("no default variant -> the first scored variant stands in (array order)", () => {
  assert(benchmarkFor("vendor/no-default", "openrouter", { path: FIXTURE }) === 42.6);
});

test("a default variant without a score falls through to the first scored variant", () => {
  assert(benchmarkFor("vendor/default-unscored", "openrouter", { path: FIXTURE }) === 42.6);
});

test("zero is a recorded score, not an absence", () => {
  assert(benchmarkFor("vendor/zero", "openrouter", { path: FIXTURE }) === 0);
});

test("a string score is not a number -> no invented Number() coercion", () => {
  assert(benchmarkFor("vendor/string-score", "openrouter", { path: FIXTURE }) === null);
});

test("a model with no scored variant reads null", () => {
  assert(benchmarkFor("vendor/unscored-only", "openrouter", { path: FIXTURE }) === null);
  assert(benchmarkFor("vendor/empty-vars", "openrouter", { path: FIXTURE }) === null);
});

test("an unknown model reads null", () => {
  assert(benchmarkFor("no-such/model", "openrouter", { path: FIXTURE }) === null);
  assert(benchmarkFor("no-such/model", "openrouter", { path: join(temp, "missing.json") }) === null);
});

// --- provider isolation -------------------------------------------------------

test("non-openrouter providers have no recorded scores", () => {
  assert(benchmarkFor("vendor/defaults-first", "anthropic", { path: FIXTURE }) === null);
  assert(benchmarkFor("vendor/defaults-first", "custom", { path: FIXTURE }) === null);
});

test("provider defaults to openrouter", () => {
  assert(benchmarkFor("vendor/defaults-first", undefined, { path: FIXTURE }) === 61.2);
});

// --- unavailable snapshot ------------------------------------------------------

test("a missing file reads null, never a throw", () => {
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: join(temp, "absent.json") }) === null);
});

test("broken JSON reads null", () => {
  const path = writeFixture("{ not json");
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path }) === null);
});

test("an absent or invalid snapshot date makes the whole file unavailable", () => {
  const noSnapshot = writeFixture({ source: "x", models: SHAPE.models });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: noSnapshot }) === null);
  const badSnapshot = writeFixture({ snapshot: 20260903, models: SHAPE.models });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: badSnapshot }) === null);
  const emptySnapshot = writeFixture({ snapshot: "", models: SHAPE.models });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: emptySnapshot }) === null);
});

test("a malformed models map reads null (array, missing, primitive)", () => {
  const arrayModels = writeFixture({ snapshot: "2026-09-03", models: [] });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: arrayModels }) === null);
  const noModels = writeFixture({ snapshot: "2026-09-03" });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: noModels }) === null);
  const primitiveModels = writeFixture({ snapshot: "2026-09-03", models: "no" });
  assert(benchmarkFor("vendor/defaults-first", "openrouter", { path: primitiveModels }) === null);
});

test("a malformed entry (object, not array) reads null", () => {
  const objEntry = writeFixture({ snapshot: "2026-09-03", models: { "vendor/obj": { e: "default", intel: 1 } } });
  assert(benchmarkFor("vendor/obj", "openrouter", { path: objEntry }) === null);
});

test("a non-string model id reads null", () => {
  assert(benchmarkFor(null, "openrouter", { path: FIXTURE }) === null);
  assert(benchmarkFor(undefined, "openrouter", { path: FIXTURE }) === null);
  assert(benchmarkFor("", "openrouter", { path: FIXTURE }) === null);
  assert(benchmarkFor(42, "openrouter", { path: FIXTURE }) === null);
});

// --- the real snapshot (shape only — a refresh moves the values) ---------------

const REAL = join(__dir, "..", "config", "model-benchmarks.json");

test("the checked-in snapshot serves a finite score for a default-effort model", () => {
  const r = benchmarkFor("z-ai/glm-5.3-flash");
  assert(typeof r === "number" && Number.isFinite(r), `got ${r}`);
});

test("the checked-in snapshot serves a finite score via the fallback path", () => {
  // claude-sonnet-5 records no default-effort variant; the first scored one answers.
  const r = benchmarkFor("anthropic/claude-sonnet-5");
  assert(typeof r === "number" && Number.isFinite(r), `got ${r}`);
});

test("the checked-in snapshot exists and declares its snapshot date", () => {
  assert(existsSync(REAL), "config/model-benchmarks.json must be checked in");
  const data = JSON.parse(readFileSync(REAL, "utf8"));
  assert(typeof data.snapshot === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.snapshot), `snapshot=${data.snapshot}`);
  assert(data.models && Object.keys(data.models).length > 0, "models must not be empty");
});

// --- teardown ------------------------------------------------------------------

rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);

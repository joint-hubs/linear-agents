// scripts/check.test.mjs — does scripts/check.mjs still catch what it exists for?
//
// check.mjs keeps config/models.map and agents/*/agents/*.md in two-way
// agreement. The forward direction (key → file) was always checked; the
// reverse was not, and the failure it lets through is a cost defect: a role
// file with no models.map key is launched by bin/agent.bat on its hardcoded
// fallback `z-ai/glm-5.2` (bin/agent.bat:27) instead of the intended
// glm-5.3-flash — roughly 17x the price — with nothing failing.
//
// The mutation below is the proof the reverse check can fail: delete one
// key, the run must go red naming that key, then the file is restored
// byte-identical.
//
// FOC-779 added two pulls on the map's existence: it is gitignored now, so a
// fresh clone has none — check.mjs regenerates it from config/models.json
// through its exported ensureModelsMap() (the same seam the run itself uses)
// instead of reporting MISSING. The last test proves that on a temp copy of
// the repo layout.
//
// Run: node scripts/check.test.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureModelsMap } from "./check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(ROOT, "config", "models.map");
// The mutated key must be one whose slug is still covered by other keys, so
// that check 1 (frontmatter model values) stays quiet and the only red is
// the reverse check naming the orphaned role file.
const MUTATED_KEY = "dev.flash";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}
const fail = (msg) => { throw new Error(msg); };

function runCheck() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "check.mjs")], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "").trim() };
}

// The map is generated + gitignored: make sure it exists before the mutation
// below reads it — through the same seam check.mjs itself regenerates with.
ensureModelsMap({ root: ROOT });

console.log("\ncheck.mjs dwukierunkowa zgodnosc models.map <-> role files");

test("check.mjs is green on the tree as committed", () => {
  const { code, out } = runCheck();
  if (code !== 0) fail("expected exit 0, got " + code + ":\n" + out);
  if (!out.includes("0 violations")) fail("expected a clean report, got:\n" + out);
});

test("mutation: deleting '" + MUTATED_KEY + "' turns the run red, naming the orphaned role file", () => {
  const original = readFileSync(MAP);
  const mutated = Buffer.from(
    original.toString("utf8").replace(new RegExp("^" + MUTATED_KEY + "=.*\\r?\\n", "m"), ""),
    "utf8"
  );
  if (mutated.equals(original)) fail("mutation did not apply — no '" + MUTATED_KEY + "=' line in config/models.map");
  try {
    writeFileSync(MAP, mutated);
    const { code, out } = runCheck();
    if (code !== 1) fail("expected exit 1 with the key deleted, got " + code + ":\n" + out);
    if (!out.includes(MUTATED_KEY)) fail("violation does not name '" + MUTATED_KEY + "':\n" + out);
  } finally {
    writeFileSync(MAP, original);
  }
  if (!readFileSync(MAP).equals(original)) fail("config/models.map was not restored byte-identical");
});

// --- FOC-350: Opus alias must be claude-opus-5 across all config surfaces --

const MODELS_JSON = join(ROOT, "config", "models.json");
const NATIVE_MAP = join(ROOT, "config", "models.native.map");

test("models.json ids.opus is anthropic/claude-opus-5", () => {
  const config = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
  if (config.ids === undefined || config.ids.opus !== "anthropic/claude-opus-5")
    fail("ids.opus=" + (config.ids && config.ids.opus) + ", expected anthropic/claude-opus-5");
});

test("models.native.map plan.lead and plan.spec-review are claude-opus-5", () => {
  const lines = readFileSync(NATIVE_MAP, "utf8").split(/\r?\n/);
  const kv = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    kv[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  const lead = kv["plan.lead"];
  const review = kv["plan.spec-review"];
  if (lead !== "claude-opus-5") fail("plan.lead=" + lead + ", expected claude-opus-5");
  if (review !== "claude-opus-5") fail("plan.spec-review=" + review + ", expected claude-opus-5");
});

test("mutation: changing models.native.map plan.lead to claude-opus-4-8 turns check red", () => {
  const original = readFileSync(NATIVE_MAP);
  const mutated = Buffer.from(
    original.toString("utf8").replace(
      /^plan\.lead=.*$/m,
      "plan.lead=claude-opus-4-8"
    ),
    "utf8"
  );
  if (mutated.equals(original)) fail("mutation did not apply — no plan.lead= line");
  try {
    writeFileSync(NATIVE_MAP, mutated);
    const { code, out } = runCheck();
    if (code !== 1) fail("expected exit 1 with plan.lead=claude-opus-4-8, got " + code + ":\n" + out);
    if (!out.includes("claude-opus-4-8")) fail("violation does not name the bad value:\n" + out);
  } finally {
    writeFileSync(NATIVE_MAP, original);
  }
  if (!readFileSync(NATIVE_MAP).equals(original)) fail("models.native.map was not restored byte-identical");
});

// ── FOC-779: a fresh clone has no config/models.map — the run regenerates it ──

// A minimal native map with the six required roles at allowed values, so the
// only moving part in the fixture is the models.map regeneration.
const NATIVE_MAP_FIXTURE = [
  "plan.lead=claude-opus-5",
  "plan.discovery=claude-opus-5",
  "plan.spec=claude-opus-5",
  "plan.spec-review=claude-opus-5",
  "plan.decomposer=claude-opus-5",
  "plan.push=claude-opus-5",
].join("\n") + "\n";

test("fresh clone: without config/models.map the run regenerates it and stays green", () => {
  const tmp = mkdtempSync(join(tmpdir(), "foc-check-clone-"));
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    mkdirSync(join(tmp, "config", "linear"), { recursive: true });
    mkdirSync(join(tmp, "agents", "plan", "agents"), { recursive: true });

    // the copied check.mjs derives its root from its own location, so the
    // fixture needs the generator (the seam it spawns) beside the copy
    copyFileSync(join(ROOT, "scripts", "check.mjs"), join(tmp, "scripts", "check.mjs"));
    copyFileSync(join(ROOT, "scripts", "gen-model-map.mjs"), join(tmp, "scripts", "gen-model-map.mjs"));

    // check 7 runs the linear CLI surface: stubs that exit 2 with a Usage line
    const linearStub = 'process.stderr.write("Usage: node <stub>\\n"); process.exit(2);\n';
    writeFileSync(join(tmp, "scripts", "linear-query.mjs"), linearStub, "utf8");
    writeFileSync(join(tmp, "scripts", "linear-ops.mjs"), linearStub, "utf8");

    // one routing area + one id → map lines `plan.discovery=…` and `_id.testmodel=…`
    writeFileSync(
      join(tmp, "config", "models.json"),
      JSON.stringify({ ids: { testmodel: "vendor/test-model" }, routing: { plan: { discovery: "testmodel" } } }, null, 2),
      "utf8",
    );
    writeFileSync(join(tmp, "config", "models.native.map"), NATIVE_MAP_FIXTURE, "utf8");
    writeFileSync(join(tmp, "config", "linear", "labels.json"), '{"groups":{},"flags":[]}', "utf8");
    // the one map key needs a role file whose model is one of the map's slugs
    writeFileSync(
      join(tmp, "agents", "plan", "agents", "discovery.md"),
      "---\nmodel: vendor/test-model\n---\nBody.\n",
      "utf8",
    );

    const r = spawnSync(process.execPath, [join(tmp, "scripts", "check.mjs")], { encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status !== 0) fail("expected exit 0 after regeneration, got " + r.status + ":\n" + out);
    if (!out.includes("regenerated")) fail("the run should report the regeneration:\n" + out);
    const mapPath = join(tmp, "config", "models.map");
    if (!existsSync(mapPath)) fail("config/models.map was not regenerated");
    if (!readFileSync(mapPath, "utf8").includes("plan.discovery=vendor/test-model")) {
      fail("the regenerated map does not route plan.discovery:\n" + readFileSync(mapPath, "utf8"));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}

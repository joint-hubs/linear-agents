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
// Run: node scripts/check.test.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}

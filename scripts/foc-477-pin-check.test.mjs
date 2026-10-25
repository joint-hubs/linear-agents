// scripts/foc-477-pin-check.test.mjs — the arm-A plan.spec model pin (FOC-477, protocol Q10).
//
// What has to hold: the pin comes from the campaign register (never a guess); a campaign squad home
// carries ONLY the launch allowlist (no history, no auth) with every subagent model set to the pin;
// preflight fails on every layer that is not the pin (lead resolution, subagent frontmatter, the
// SUBAGENT_MODEL env override); verify never turns "cannot know" into a pass.
//
// Run: node scripts/foc-477-pin-check.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  blobShas,
  buildSquadHome,
  evaluateBoundary,
  evaluatePreflight,
  evaluateUsage,
  frontmatterModel,
  gNodeModelFrom,
  modelsFactsFrom,
  readBoundary,
  readPin,
  subagentModels,
  withFrontmatterModel,
} from "./foc-477-pin-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "foc-477-pin-check.mjs");
const PIN = "z-ai/glm-5.3-flash";
const MIMO = "xiaomi/mimo-v2.6-pro";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const cleanup = [];
const tmp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `foc477-pin-${label}-`));
  cleanup.push(dir);
  return dir;
};
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

function fixtureRegister(dir, model = PIN, boundary = { files: {} }) {
  const path = join(dir, "runs.json");
  writeFileSync(path, JSON.stringify(model === null ? { armARuns: [] } : { planSpecPin: { model, boundary } }));
  return path;
}

// A squad home as the repo keeps it: the plan squad on mimo, plus the things that must NOT travel.
function fixtureSquadRoot(dir) {
  const plan = join(dir, "plan");
  write(join(plan, "CLAUDE.md"), "# plan lead\n");
  write(join(plan, "settings.json"), '{"permissions":{}}\n');
  write(join(plan, "agents", "spec.md"), `---\nname: spec\nmodel: ${MIMO}\ntools: Read\n---\nbody of spec\n`);
  write(join(plan, "agents", "spec-review.md"), `---\r\nname: spec-review\r\nmodel: ${MIMO}\r\n---\r\nbody\r\n`);
  write(join(plan, "agents", "discovery.md"), `---\nname: discovery\nmodel: ${PIN}\n---\nalready on the pin\n`);
  write(join(plan, "agents", "pinned-crlf.md"), `---\r\nname: pinned-crlf\r\nmodel: ${PIN}\r\ntools: Read\r\n---\r\nalready on the pin, CRLF\r\n`);
  write(join(plan, "agents", "nomodel.md"), `---\nname: nomodel\n---\ninherits\n`);
  write(join(plan, "skills", "run.md"), "runbook\n");
  write(join(plan, "projects", "p", "sess.jsonl"), '{"history":true}\n');
  write(join(plan, ".credentials.json"), '{"token":"nope"}');
  write(join(plan, ".claude.json"), '{"hasTrustDialogAccepted":true}');
  write(join(dir, "_shared", "skills", "codegraph.md"), "shared skill\n");
  return dir;
}

// ── the pin ──────────────────────────────────────────────────────────────────
console.log("\nthe pin");

test("readPin reads planSpecPin.model from the register and refuses a register without it", () => {
  const dir = tmp("pin");
  assert.equal(readPin(fixtureRegister(dir)), PIN);
  assert.throws(() => readPin(fixtureRegister(dir, null)), /no planSpecPin\.model/);
  assert.throws(() => readPin(join(dir, "missing.json")), /cannot read the campaign register/);
});

test("the real register pins plan.spec to glm-5.3-flash (Q10)", () => {
  assert.equal(readPin(), PIN);
});

// ── frontmatter ──────────────────────────────────────────────────────────────
console.log("\nfrontmatter");

test("frontmatterModel finds the model, LF or CRLF, and null when there is none", () => {
  assert.equal(frontmatterModel(`---\nname: a\nmodel: ${MIMO}\n---\nx`), MIMO);
  assert.equal(frontmatterModel(`---\r\nname: a\r\nmodel: ${MIMO}\r\n---\r\nx`), MIMO);
  assert.equal(frontmatterModel("---\nname: a\n---\nx"), null);
  assert.equal(frontmatterModel("no frontmatter\nmodel: not-this\n"), null);
});

test("withFrontmatterModel rewrites, adds when absent, keeps line endings, leaves a body 'model:' alone", () => {
  assert.equal(frontmatterModel(withFrontmatterModel(`---\nname: a\nmodel: ${MIMO}\n---\nx`, PIN)), PIN);
  const added = withFrontmatterModel("---\nname: a\n---\nx", PIN);
  assert.equal(frontmatterModel(added), PIN);
  // CRLF: exactly the original bytes with the one value swapped — no doubled CR, no LF-only line
  const crlf = withFrontmatterModel(`---\r\nname: a\r\ndescription: d\r\nmodel: ${MIMO}\r\ntools: Read\r\n---\r\nx\r\n`, PIN);
  assert.equal(crlf, `---\r\nname: a\r\ndescription: d\r\nmodel: ${PIN}\r\ntools: Read\r\n---\r\nx\r\n`);
  const crlfAdded = withFrontmatterModel("---\r\nname: a\r\ntools: Read\r\n---\r\nx\r\n", PIN);
  assert.equal(crlfAdded, `---\r\nname: a\r\ntools: Read\r\nmodel: ${PIN}\r\n---\r\nx\r\n`);
  // already on the pin: byte-identical, so squad-home does not report it as rewritten
  const pinned = `---\r\nname: a\r\nmodel: ${PIN}\r\ntools: Read\r\n---\r\nx\r\n`;
  assert.equal(withFrontmatterModel(pinned, PIN), pinned);
  const body = withFrontmatterModel(`---\nname: a\nmodel: ${MIMO}\n---\nmodel: ${MIMO}\n`, PIN);
  assert.ok(body.endsWith(`\nmodel: ${MIMO}\n`), "the body's own 'model:' line is not touched");
  assert.equal(withFrontmatterModel("plain text", PIN), "plain text");
});

// ── the campaign squad home ──────────────────────────────────────────────────
console.log("\nthe campaign squad home");

test("squad-home copies only the launch allowlist, with every subagent on the pin", () => {
  const src = fixtureSquadRoot(tmp("src"));
  const out = join(tmp("out"), "home");
  const built = buildSquadHome({ srcRoot: src, outDir: out, pin: PIN });
  assert.deepEqual(built.rewritten, ["nomodel.md", "spec-review.md", "spec.md"]);
  for (const { file, model } of subagentModels(join(out, "plan"))) assert.equal(model, PIN, file);
  assert.equal(readFileSync(join(out, "plan", "agents", "spec.md"), "utf8"), `---\nname: spec\nmodel: ${PIN}\ntools: Read\n---\nbody of spec\n`);
  // a CRLF checkout (Windows) comes out as the same bytes with the one value swapped; a CRLF file already on the pin is copied untouched
  assert.equal(readFileSync(join(out, "plan", "agents", "spec-review.md"), "utf8"), `---\r\nname: spec-review\r\nmodel: ${PIN}\r\n---\r\nbody\r\n`);
  assert.equal(
    readFileSync(join(out, "plan", "agents", "pinned-crlf.md"), "utf8"),
    readFileSync(join(src, "plan", "agents", "pinned-crlf.md"), "utf8"),
  );
  assert.equal(readFileSync(join(out, "plan", "CLAUDE.md"), "utf8"), "# plan lead\n");
  assert.ok(existsSync(join(out, "plan", "skills", "run.md")) && existsSync(join(out, "_shared", "skills", "codegraph.md")));
  assert.ok(!existsSync(join(out, "plan", "projects")), "history never travels");
  assert.ok(!existsSync(join(out, "plan", ".credentials.json")) && !existsSync(join(out, "plan", ".claude.json")), "auth/user state never travels");
  const marker = JSON.parse(readFileSync(join(out, "PIN.json"), "utf8"));
  assert.equal(marker.model, PIN);
  assert.ok(marker.files["plan/agents/spec.md"] && !("plan/.credentials.json" in marker.files));
  // the source is untouched
  assert.equal(frontmatterModel(readFileSync(join(src, "plan", "agents", "spec.md"), "utf8")), MIMO);
});

test("squad-home rebuilds over its own previous output but refuses a foreign directory", () => {
  const src = fixtureSquadRoot(tmp("src2"));
  const base = tmp("out2");
  const out = join(base, "home");
  buildSquadHome({ srcRoot: src, outDir: out, pin: PIN });
  write(join(out, "plan", "stale.txt"), "stale");
  buildSquadHome({ srcRoot: src, outDir: out, pin: PIN });
  assert.ok(!existsSync(join(out, "plan", "stale.txt")), "a rebuild starts clean");

  const foreign = join(base, "foreign");
  write(join(foreign, "keep.txt"), "mine");
  assert.throws(() => buildSquadHome({ srcRoot: src, outDir: foreign, pin: PIN }), /not a foc-477 squad home/);
  assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "mine");
  assert.doesNotThrow(() => buildSquadHome({ srcRoot: src, outDir: foreign, pin: PIN, force: true }));
});

test("squad-home refuses a source without the plan squad", () => {
  assert.throws(() => buildSquadHome({ srcRoot: tmp("empty"), outDir: join(tmp("o3"), "h"), pin: PIN }), /no plan squad/);
});

// ── preflight ────────────────────────────────────────────────────────────────
console.log("\npreflight");

const ok = { pin: PIN, lead: { model: PIN, source: "settings:routing.plan" }, subagents: [{ file: "spec.md", model: PIN }], env: {} };

test("evaluatePreflight passes only when the lead, every subagent and the env are the pin", () => {
  assert.equal(evaluatePreflight(ok).ok, true);
  assert.equal(evaluatePreflight({ ...ok, env: { CLAUDE_CODE_SUBAGENT_MODEL: PIN } }).ok, true, "an env override equal to the pin is fine");
});

test("evaluatePreflight names every layer that is off the pin", () => {
  const lead = evaluatePreflight({ ...ok, lead: { model: MIMO, source: "routing:plan" } });
  assert.equal(lead.ok, false);
  assert.equal(lead.checks[0].actual, MIMO);
  assert.match(lead.checks[0].detail, /routing:plan/);
  const sub = evaluatePreflight({ ...ok, subagents: [{ file: "spec.md", model: MIMO }, { file: "x.md", model: null }] });
  assert.deepEqual(sub.checks.filter((c) => !c.ok).map((c) => c.name), ["plan subagent spec.md", "plan subagent x.md"]);
  const env = evaluatePreflight({ ...ok, env: { CLAUDE_CODE_SUBAGENT_MODEL: MIMO } });
  assert.equal(env.checks.at(-1).ok, false);
  assert.equal(evaluatePreflight({ ...ok, lead: { model: null, source: null } }).ok, false, "an unresolved lead is not a pass");
});

// ── the instrument boundary ──────────────────────────────────────────────────
console.log("\nthe instrument boundary");

const BLOB = "a".repeat(40);

test("evaluateBoundary: matching blobs and [G] model pass; a drifted blob, a missing file and a moved [G] model fail", () => {
  const recorded = { files: { "scripts/a.mjs": BLOB, "scripts/b.mjs": "b".repeat(40) }, gNode: { id: PIN } };
  const good = evaluateBoundary({ recorded, actualBlobs: { "scripts/a.mjs": BLOB, "scripts/b.mjs": "b".repeat(40) }, gNodeModel: PIN });
  assert.ok(good.every((c) => c.ok) && good.length === 3);
  const bad = evaluateBoundary({ recorded, actualBlobs: { "scripts/a.mjs": "c".repeat(40), "scripts/b.mjs": null }, gNodeModel: MIMO });
  assert.deepEqual(bad.filter((c) => !c.ok).map((c) => c.name), ["instrument file scripts/a.mjs", "instrument file scripts/b.mjs", "[G] nodes' model (models.json routing.plan.discovery)"]);
});

test("evaluateBoundary: the [G] provider pin and the recorded price rows are held too", () => {
  const order = ["wafer", "fireworks"];
  const recorded = {
    files: {},
    gNode: { id: PIN, providerPin: { order, allowFallbacks: false } },
    prices: { [PIN]: { input: 0.075, output: 0.25, cacheRead: 0.015 } },
  };
  const holds = {
    recorded,
    actualBlobs: {},
    gNodeModel: PIN,
    gNodeProviderPin: { order, allowFallbacks: false },
    actualPrices: { [PIN]: { input: 0.075, output: 0.25, cacheRead: 0.015, provenance: "free text is not compared" } },
  };
  const good = evaluateBoundary(holds);
  assert.ok(good.every((c) => c.ok) && good.length === 3, JSON.stringify(good));
  const moved = evaluateBoundary({
    ...holds,
    gNodeProviderPin: { order: ["fireworks", "wafer"], allowFallbacks: false },
    actualPrices: { [PIN]: { input: 0.075, output: 0.5, cacheRead: 0.015 } },
  });
  assert.deepEqual(moved.filter((c) => !c.ok).map((c) => c.name), ["[G] nodes' provider pin (models.json providerPins['plan.discovery'])", `price row ${PIN}`]);
  const gone = evaluateBoundary({ ...holds, gNodeProviderPin: null, actualPrices: {} });
  assert.deepEqual(gone.filter((c) => !c.ok).length, 2);
  assert.equal(gone.find((c) => c.name === `price row ${PIN}`).actual, null);
});

test("modelsFactsFrom reads the discovery provider pin and the pricing.openrouter rows, null for what is missing", () => {
  const dir = tmp("facts");
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify({ providerPins: { "plan.discovery": { order: ["wafer"], allowFallbacks: false } }, pricing: { openrouter: { [PIN]: { input: 0.075 } } } }));
  assert.deepEqual(modelsFactsFrom([PIN, MIMO], path), { providerPin: { order: ["wafer"], allowFallbacks: false }, prices: { [PIN]: { input: 0.075 }, [MIMO]: null } });
  assert.deepEqual(modelsFactsFrom([PIN], join(dir, "nope.json")), { providerPin: null, prices: { [PIN]: null } });
});

test("evaluateBoundary: no recorded boundary is a failure, not a pass", () => {
  const checks = evaluateBoundary({ recorded: null, actualBlobs: {}, gNodeModel: PIN });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.equal(evaluatePreflight({ ...ok, boundary: checks }).ok, false);
});

test("blobShas hashes real files like git does, and says null for a missing one", () => {
  const shas = blobShas(["scripts/foc-477-pin-check.mjs", "scripts/no-such-file.mjs"]);
  assert.match(shas["scripts/foc-477-pin-check.mjs"], /^[0-9a-f]{40}$/);
  assert.equal(shas["scripts/no-such-file.mjs"], null);
});

test("gNodeModelFrom resolves routing.plan.discovery through ids", () => {
  const dir = tmp("gnode");
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify({ ids: { flash: PIN }, routing: { plan: { discovery: "flash" } } }));
  assert.equal(gNodeModelFrom(path), PIN);
  writeFileSync(path, JSON.stringify({ routing: { plan: {} } }));
  assert.equal(gNodeModelFrom(path), null);
  assert.equal(gNodeModelFrom(join(dir, "nope.json")), null);
});

test("readBoundary reads planSpecPin.boundary and returns null when it is absent", () => {
  const dir = tmp("rb");
  assert.deepEqual(readBoundary(fixtureRegister(dir, PIN, { files: { "x.mjs": BLOB } })), { files: { "x.mjs": BLOB } });
  assert.equal(readBoundary(fixtureRegister(dir, null)), null);
});

// ── verify ───────────────────────────────────────────────────────────────────
console.log("\nverify");

test("evaluateUsage: only the pin is ok; any other model, an unknown model or a bad --model is a mismatch", () => {
  assert.equal(evaluateUsage({ pin: PIN, byModel: { [PIN]: { messages: 12, usd: 0.02 } }, requested: PIN }).status, "ok");
  const sub = evaluateUsage({ pin: PIN, byModel: { [PIN]: { messages: 12, usd: 0.02 }, [MIMO]: { messages: 3, usd: 0.1 } } });
  assert.equal(sub.status, "mismatch");
  assert.deepEqual(sub.offenders, [MIMO]);
  assert.equal(evaluateUsage({ pin: PIN, byModel: { unknown: { messages: 1, usd: null } } }).status, "mismatch");
  assert.equal(evaluateUsage({ pin: PIN, byModel: { [PIN]: { messages: 1, usd: 0 } }, requested: MIMO }).status, "mismatch");
});

test("evaluateUsage: no transcript is UNKNOWN, never ok", () => {
  assert.equal(evaluateUsage({ pin: PIN, byModel: null }).status, "unknown");
  assert.equal(evaluateUsage({ pin: PIN, byModel: {} }).status, "unknown");
});

// ── the CLI, end to end ──────────────────────────────────────────────────────
console.log("\nthe CLI");

const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: "", ...env } });

test("squad-home then preflight: the campaign environment is pinned, the plain one is not", () => {
  const base = tmp("cli");
  const register = fixtureRegister(base);
  const src = fixtureSquadRoot(join(base, "src"));
  const out = join(base, "home");
  const overlay = join(base, "settings.json");
  writeFileSync(overlay, JSON.stringify({ provider: { active: null, custom: null }, routing: { plan: { lead: PIN } } }));
  const mimoOverlay = join(base, "settings-mimo.json");
  writeFileSync(mimoOverlay, JSON.stringify({ provider: { active: null, custom: null }, routing: { plan: { lead: MIMO } } }));

  const built = run(["squad-home", "--out", out, "--register", register], { LA_SQUAD_HOME: src });
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /LA_SQUAD_HOME=.*--model z-ai\/glm-5\.3-flash/);

  const pinned = run(["preflight", "--register", register, "--json"], { LA_SQUAD_HOME: out, LA_SETTINGS_FILE: overlay });
  assert.equal(pinned.status, 0, pinned.stdout + pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).ok, true);

  // the same overlay, but the repo-style squad home (subagents still on mimo): refused
  const unpinned = run(["preflight", "--register", register, "--json"], { LA_SQUAD_HOME: src, LA_SETTINGS_FILE: overlay });
  assert.equal(unpinned.status, 1);
  assert.deepEqual(JSON.parse(unpinned.stdout).checks.filter((c) => !c.ok).map((c) => c.name).sort(), ["plan subagent nomodel.md", "plan subagent spec-review.md", "plan subagent spec.md"]);

  // pinned subagents but a lead that resolves to mimo: refused too
  const badLead = run(["preflight", "--register", register, "--json"], { LA_SQUAD_HOME: out, LA_SETTINGS_FILE: mimoOverlay });
  assert.equal(badLead.status, 1);
  assert.equal(JSON.parse(badLead.stdout).checks[0].actual, MIMO);
});

test("preflight holds the recorded blobs: a matching boundary passes, a drifted one is refused", () => {
  const base = tmp("cli-boundary");
  const src = fixtureSquadRoot(join(base, "src"));
  const home = join(base, "home");
  const overlay = join(base, "settings.json");
  writeFileSync(overlay, JSON.stringify({ provider: { active: null, custom: null }, routing: { plan: { lead: PIN } } }));
  const built = run(["squad-home", "--out", home, "--register", fixtureRegister(base)], { LA_SQUAD_HOME: src });
  assert.equal(built.status, 0, built.stderr);
  const file = "scripts/foc-477-pin-check.mjs";
  const matching = fixtureRegister(tmp("rg1"), PIN, { files: { [file]: blobShas([file])[file] } });
  const okRun = run(["preflight", "--register", matching, "--json"], { LA_SQUAD_HOME: home, LA_SETTINGS_FILE: overlay });
  assert.equal(okRun.status, 0, okRun.stdout + okRun.stderr);
  assert.ok(JSON.parse(okRun.stdout).checks.some((c) => c.name === `instrument file ${file}` && c.ok));
  const drifted = fixtureRegister(tmp("rg2"), PIN, { files: { [file]: BLOB } });
  const bad = run(["preflight", "--register", drifted, "--json"], { LA_SQUAD_HOME: home, LA_SETTINGS_FILE: overlay });
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout).checks.filter((c) => !c.ok).map((c) => c.name), [`instrument file ${file}`]);
});

test("an unreadable pin is a usage-class exit, not a pass", () => {
  const register = fixtureRegister(tmp("nopin"), null);
  assert.equal(run(["preflight", "--register", register]).status, 2);
});

test("verify: an unknown child is exit 2, a child without a transcript is exit 3 (never ok)", () => {
  const base = tmp("verify");
  const register = fixtureRegister(base);
  const state = join(base, "state");
  const runId = "2026-10-25T10-00-00-000-supervisor-ab12";
  write(join(state, runId, "children.json"), JSON.stringify({
    version: 1,
    children: { "plan-1": { childId: "plan-1", squad: "plan", status: "exited", worktree: join(base, "wt"), sessionId: "sess-1", turns: [], launchConfigDir: join(base, "launch") } },
  }));
  const env = { LA_SUPERVISOR_STATE_HOME: state };
  assert.equal(run(["verify", "--run", runId, "--child", "ghost", "--register", register], env).status, 2);
  const unknown = run(["verify", "--run", runId, "--child", "plan-1", "--register", register, "--json"], env);
  assert.equal(unknown.status, 3, unknown.stdout + unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).status, "unknown");
});

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`failed: ${failures.join(" | ")}`);
  process.exit(1);
}

#!/usr/bin/env node
// scripts/foc-477-pin-check.mjs — hold the arm-A `plan.spec` child on ONE model (FOC-477, protocol Q10).
//
// Q10 (Mateusz, 2026-10-10, reaffirmed 2026-10-25): the arm-A plan.spec PLAN child runs on
// z-ai/glm-5.3-flash for all 10 counted runs, because that is what arm B's PLAN children ran on.
// Model routing v2 (FOC-964, 2026-10-21) moved the PLAN lead, spec and spec-review to
// xiaomi/mimo-v2.6-pro — in models.json AND in the plan subagents' frontmatter — which would
// price arm A on a model 3.5-6x dearer and bias the cost axis. This script keeps the campaign
// off that, without touching a frozen instrument file or production routing.
//
// Where a plan.spec child's model can come from (strongest first):
//   1. an explicit `--model` on supervisor-spawn                  -> the campaign always passes it
//   2. the settings overlay `routing.plan.lead`                   -> safety net for a spawn without it
//   3. models.json `routing.plan` (lead ?? default ?? worker)     -> v2 says mimo; overridden by 1 and 2
//   4. the subagents' frontmatter `model:` (agents/plan/agents/*.md; the spec author is a subagent)
//      -> v2 says mimo. Only a campaign squad home (LA_SQUAD_HOME) can change it without editing
//      the tracked files.
//   5. CLAUDE_CODE_SUBAGENT_MODEL in the environment              -> must be unset or the pin
//
// The same preflight also holds the INSTRUMENT BOUNDARY the register records (planSpecPin.boundary):
// the git blob sha of every file whose behaviour feeds an arm-A number (graph-runner, the plan
// nodes, graph.json, decisions.json, egress screen, decision-call, the launcher), the model the
// [G] nodes resolve to (models.json routing.plan.discovery) with its provider pin (Q8), and the price
// rows of the models that price the number. A drifted blob, model, pin or rate means the run would
// not share an instrument with the other nine — so it does not start.
//
// Commands (the pin itself is read from docs/research/foc-477-runs.json -> planSpecPin.model):
//   squad-home --out <dir> [--force]   copy the plan squad's launch inputs (the same allowlist the
//                                      launcher copies: CLAUDE.md, settings.json, agents/, skills/,
//                                      plus _shared/skills) into <dir> with every subagent's model:
//                                      set to the pin. Spawn the plan.spec child with
//                                      LA_SQUAD_HOME=<dir> and --model <pin>.
//   preflight [--json]                 with THIS environment, what does a plan spawn resolve to at
//                                      each layer? Exit 1 on any layer that is not the pin.
//   verify --run <id> --child <id> [--json]
//                                      after the child ended: which models its transcripts (lead +
//                                      subagents) actually used. Exit 1 if any is not the pin, 3 if
//                                      that cannot be known (no/unreadable transcript) — never a pass.
// Exit: 0 ok | 1 mismatch | 2 usage / unreadable pin | 3 unknown.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { squadConfigDir, squadConfigRoot } from "./fenix-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
export const REGISTER = join(ROOT, "docs", "research", "foc-477-runs.json");
const SQUAD = "plan";
// The same allowlist agent-launch-profile.mjs copies into a launch dir: nothing else of the squad
// dir (projects/ history, auth state) ever travels.
const COPY_FILES = ["CLAUDE.md", "settings.json"];
const COPY_DIRS = ["agents", "skills"];
const MARKER = "PIN.json";

// ── the pin ──────────────────────────────────────────────────────────────────

/** The model the register pins plan.spec to; throws when the register does not carry one. */
export function readPin(registerPath = REGISTER) {
  let register;
  try {
    register = JSON.parse(readFileSync(registerPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the campaign register ${registerPath}: ${err.message}`);
  }
  const model = register?.planSpecPin?.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error(`${registerPath} has no planSpecPin.model — the pin is recorded there, not guessed`);
  }
  return model.trim();
}

/** The recorded instrument boundary ({ files: { path: blobSha }, gNode?: { id } }) or null when the register has none. */
export function readBoundary(registerPath = REGISTER) {
  try {
    const boundary = JSON.parse(readFileSync(registerPath, "utf8"))?.planSpecPin?.boundary;
    return boundary && typeof boundary === "object" && boundary.files && typeof boundary.files === "object" ? boundary : null;
  } catch {
    return null;
  }
}

const pinShape = (pin) => JSON.stringify({ order: pin?.order ?? null, allowFallbacks: pin?.allowFallbacks ?? null });
const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * Compare the recorded boundary with what is on disk.
 * @param {{ recorded: object|null, actualBlobs: Record<string,string|null>, gNodeModel: string|null,
 *           gNodeProviderPin?: object|null, actualPrices?: Record<string, object|null> }} input
 */
export function evaluateBoundary({ recorded, actualBlobs, gNodeModel, gNodeProviderPin = null, actualPrices = {} }) {
  if (!recorded) {
    return [{ name: "instrument boundary recorded", expected: "planSpecPin.boundary in the register", actual: null, detail: "nothing to hold the instrument against", ok: false }];
  }
  const checks = [];
  for (const [path, want] of Object.entries(recorded.files).sort(([a], [b]) => a.localeCompare(b))) {
    const have = actualBlobs?.[path] ?? null;
    checks.push({ name: `instrument file ${path}`, expected: want.slice(0, 12), actual: have ? have.slice(0, 12) : null, detail: "git blob sha", ok: have === want });
  }
  if (recorded.gNode?.id) {
    checks.push({
      name: "[G] nodes' model (models.json routing.plan.discovery)",
      expected: recorded.gNode.id,
      actual: gNodeModel,
      detail: "what graph-runner resolves for every [G] call",
      ok: gNodeModel === recorded.gNode.id,
    });
  }
  if (recorded.gNode?.providerPin) {
    checks.push({
      name: "[G] nodes' provider pin (models.json providerPins['plan.discovery'])",
      expected: pinShape(recorded.gNode.providerPin),
      actual: gNodeProviderPin ? pinShape(gNodeProviderPin) : null,
      detail: "upstream order + allow_fallbacks (protocol Q8) — routing, but it prices the call",
      ok: Boolean(gNodeProviderPin) && pinShape(gNodeProviderPin) === pinShape(recorded.gNode.providerPin),
    });
  }
  for (const [model, want] of Object.entries(recorded.prices ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const have = actualPrices?.[model] ?? null;
    const keys = PRICE_KEYS.filter((k) => want[k] !== undefined);
    checks.push({
      name: `price row ${model}`,
      expected: keys.map((k) => `${k} ${want[k]}`).join(", "),
      actual: have ? keys.map((k) => `${k} ${have[k] ?? "—"}`).join(", ") : null,
      detail: "models.json pricing.openrouter, USD per million tokens — the rate usage.cost is priced at",
      ok: Boolean(have) && keys.every((k) => have[k] === want[k]),
    });
  }
  return checks;
}

/** The models.json facts the boundary also holds: the [G] provider pin and the price rows of `models`. */
export function modelsFactsFrom(models, modelsJsonPath = join(ROOT, "config", "models.json")) {
  try {
    const json = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
    const rows = json?.pricing?.openrouter ?? {};
    return {
      providerPin: json?.providerPins?.["plan.discovery"] ?? null,
      prices: Object.fromEntries(models.map((m) => [m, rows[m] ?? null])),
    };
  } catch {
    return { providerPin: null, prices: Object.fromEntries(models.map((m) => [m, null])) };
  }
}

/** git blob shas of repo-relative `paths` (null for a file that cannot be hashed). */
export function blobShas(paths, root = ROOT) {
  const out = {};
  for (const path of paths) {
    const res = spawnSync("git", ["hash-object", path], { cwd: root, encoding: "utf8" });
    out[path] = res.status === 0 ? res.stdout.trim() : null;
  }
  return out;
}

/** The model id graph-runner resolves for its [G] calls: models.json routing.plan.discovery through ids. */
export function gNodeModelFrom(modelsJsonPath = join(ROOT, "config", "models.json")) {
  try {
    const models = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
    const alias = models?.routing?.plan?.discovery;
    return typeof alias === "string" ? (models?.ids?.[alias] ?? alias) : null;
  } catch {
    return null;
  }
}

// ── frontmatter ──────────────────────────────────────────────────────────────

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The `model:` of a markdown file's frontmatter, or null. */
export function frontmatterModel(text) {
  const block = FRONTMATTER.exec(text);
  if (!block) return null;
  const line = /^model:[ \t]*(\S+)[ \t]*$/m.exec(block[1]);
  return line ? line[1] : null;
}

/** `text` with the frontmatter `model:` set to `model` (added when absent); no frontmatter -> unchanged. */
export function withFrontmatterModel(text, model) {
  const block = FRONTMATTER.exec(text);
  if (!block) return text;
  // The body keeps the line endings it has; only the delimiters and an appended line use `eol`.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = block[1];
  const next = /^model:[ \t]*\S*[ \t]*$/m.test(body)
    ? body.replace(/^model:[ \t]*\S*[ \t]*$/m, () => `model: ${model}`)
    : `${body}${eol}model: ${model}`;
  return text.replace(FRONTMATTER, () => `---${eol}${next}${eol}---`);
}

/** [{ file, model }] for every agents/*.md under a squad dir. */
export function subagentModels(squadDir) {
  const dir = join(squadDir, "agents");
  let names;
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return names.map((file) => ({ file, model: frontmatterModel(readFileSync(join(dir, file), "utf8")) }));
}

// ── preflight (pure) ─────────────────────────────────────────────────────────

/**
 * @param {{ pin: string, lead: { model: string|null, source: string|null }, subagents: Array<{file:string, model:string|null}>, env: object }} input
 * @returns {{ ok: boolean, checks: Array<{ name: string, expected: string, actual: string|null, detail: string, ok: boolean }> }}
 */
export function evaluatePreflight({ pin, lead, subagents, env, boundary = [] }) {
  const checks = [];
  checks.push({
    name: "plan child lead, spawned without --model",
    expected: pin,
    actual: lead?.model ?? null,
    detail: lead?.source ?? "unresolved",
    ok: lead?.model === pin,
  });
  for (const { file, model } of subagents) {
    checks.push({
      name: `plan subagent ${file}`,
      expected: pin,
      actual: model,
      detail: model === null ? "no model: in the frontmatter — it would inherit" : "frontmatter model:",
      ok: model === pin,
    });
  }
  const override = typeof env?.CLAUDE_CODE_SUBAGENT_MODEL === "string" ? env.CLAUDE_CODE_SUBAGENT_MODEL.trim() : "";
  checks.push({
    name: "CLAUDE_CODE_SUBAGENT_MODEL",
    expected: `${pin} or unset`,
    actual: override === "" ? null : override,
    detail: "an env override beats every frontmatter",
    ok: override === "" || override === pin,
  });
  checks.push(...boundary);
  return { ok: checks.every((c) => c.ok), checks };
}

// ── verify (pure) ────────────────────────────────────────────────────────────

/**
 * @param {{ pin: string, byModel: Record<string, {messages:number, usd:number|null}>|null, requested?: string|null }} input
 * @returns {{ status: "ok"|"mismatch"|"unknown", models: Array<{model:string, messages:number, usd:number|null}>, offenders: string[], reason?: string }}
 */
export function evaluateUsage({ pin, byModel, requested = null }) {
  if (!byModel || Object.keys(byModel).length === 0) {
    return { status: "unknown", models: [], offenders: [], reason: "no assistant messages priced — the child's transcript was not found or not readable" };
  }
  const models = Object.entries(byModel).map(([model, v]) => ({ model, messages: v.messages, usd: v.usd }));
  const offenders = models.filter((m) => m.model !== pin).map((m) => m.model);
  if (typeof requested === "string" && requested !== "" && requested !== pin) offenders.push(`requested:${requested}`);
  return { status: offenders.length ? "mismatch" : "ok", models, offenders };
}

// ── squad home ───────────────────────────────────────────────────────────────

function copyTree(src, dst, files, rewrite) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      copyTree(from, to, files, rewrite);
    } else if (st.isFile()) {
      let data = readFileSync(from);
      const r = rewrite?.(name, data);
      if (r !== undefined) data = r;
      writeFileSync(to, data);
      files.push({ path: to, sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
}

/**
 * Build a campaign squad home: the plan squad's launch inputs with every subagent model set to the pin.
 * Refuses a non-empty `outDir` that is not a previous squad home of this script (unless force).
 */
export function buildSquadHome({ srcRoot = squadConfigRoot(), outDir, pin, squad = SQUAD, force = false }) {
  const out = resolve(outDir);
  if (existsSync(out)) {
    const populated = readdirSync(out).length > 0;
    if (populated && !existsSync(join(out, MARKER)) && !force) {
      throw new Error(`${out} exists and is not a foc-477 squad home — refusing to overwrite it`);
    }
    if (populated) rmSync(out, { recursive: true, force: true });
  }
  const srcSquad = join(srcRoot, squad);
  if (!existsSync(srcSquad)) throw new Error(`no ${squad} squad at ${srcSquad}`);
  const files = [];
  const rewritten = [];
  const dstSquad = join(out, squad);
  mkdirSync(dstSquad, { recursive: true });
  for (const name of COPY_FILES) {
    const from = join(srcSquad, name);
    if (existsSync(from) && statSync(from).isFile()) {
      const data = readFileSync(from);
      writeFileSync(join(dstSquad, name), data);
      files.push({ path: join(dstSquad, name), sha256: createHash("sha256").update(data).digest("hex") });
    }
  }
  for (const name of COPY_DIRS) {
    const from = join(srcSquad, name);
    if (!existsSync(from) || !statSync(from).isDirectory()) continue;
    copyTree(from, join(dstSquad, name), files, name === "agents"
      ? (file, data) => {
          if (!file.endsWith(".md")) return undefined;
          const text = data.toString("utf8");
          const next = withFrontmatterModel(text, pin);
          if (next !== text) rewritten.push(file);
          return Buffer.from(next, "utf8");
        }
      : undefined);
  }
  const shared = join(srcRoot, "_shared", "skills");
  if (existsSync(shared) && statSync(shared).isDirectory()) copyTree(shared, join(out, "_shared", "skills"), files);
  writeFileSync(
    join(out, MARKER),
    `${JSON.stringify({
      kind: "foc-477 campaign squad home",
      model: pin,
      squad,
      builtAt: new Date().toISOString(),
      sourceRoot: srcRoot,
      subagentsRewritten: rewritten.sort(),
      files: Object.fromEntries(files.map((f) => [relative(out, f.path).split("\\").join("/"), f.sha256])),
    }, null, 2)}\n`,
  );
  return { outDir: out, files: files.length, rewritten: rewritten.sort() };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--force") args[a.slice(2)] = true;
    else if (["--out", "--run", "--child", "--register"].includes(a)) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

const usage = () => {
  console.error("usage: foc-477-pin-check.mjs squad-home --out <dir> [--force] | preflight [--json] | verify --run <id> --child <id> [--json]");
  process.exit(2);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const verb = args._[0];
  let pin;
  try {
    pin = readPin(args.register || REGISTER);
  } catch (err) {
    console.error(`foc-477-pin-check: ${err.message}`);
    process.exit(2);
  }

  if (verb === "squad-home") {
    if (!args.out) usage();
    try {
      const built = buildSquadHome({ outDir: args.out, pin, force: Boolean(args.force) });
      console.log(`squad home: ${built.outDir} (${built.files} files; subagents set to ${pin}: ${built.rewritten.join(", ") || "none needed"})`);
      console.log(`spawn the plan.spec child with:  LA_SQUAD_HOME=${built.outDir}  node scripts/supervisor-spawn.mjs --squad plan --model ${pin} …`);
    } catch (err) {
      console.error(`foc-477-pin-check: ${err.message}`);
      process.exit(2);
    }
    return;
  }

  if (verb === "preflight") {
    const { readSquadConfig } = await import("./squad-config.mjs");
    const planSquad = readSquadConfig().squads?.[SQUAD];
    const recorded = readBoundary(args.register || REGISTER);
    const facts = modelsFactsFrom(Object.keys(recorded?.prices ?? {}));
    const result = evaluatePreflight({
      pin,
      lead: { model: planSquad?.lead ?? null, source: planSquad?.leadSource ?? null },
      subagents: subagentModels(squadConfigDir(SQUAD)),
      env: process.env,
      boundary: evaluateBoundary({
        recorded,
        actualBlobs: recorded ? blobShas(Object.keys(recorded.files)) : {},
        gNodeModel: gNodeModelFrom(),
        gNodeProviderPin: facts.providerPin,
        actualPrices: facts.prices,
      }),
    });
    if (args.json) console.log(JSON.stringify({ pin, squadHome: squadConfigRoot(), ...result }, null, 2));
    else {
      console.log(`pin: ${pin}   squad home: ${squadConfigRoot()}`);
      for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.actual ?? "—"} (${c.detail})${c.ok ? "" : `  — want ${c.expected}`}`);
      console.log(result.ok ? "preflight: every layer resolves to the pin and the instrument matches the recorded boundary" : "preflight: NOT READY — do not start a counted run");
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (verb === "verify") {
    if (!args.run || !args.child) usage();
    const { readRegistry } = await import("./supervisor-lib.mjs");
    const { priceChildTranscripts } = await import("./transcript-cost.mjs");
    let entry;
    try {
      entry = readRegistry(args.run).children?.[args.child];
    } catch (err) {
      console.error(`foc-477-pin-check: cannot read run ${args.run}: ${err.message}`);
      process.exit(2);
    }
    if (!entry) {
      console.error(`foc-477-pin-check: no child ${args.child} in run ${args.run}`);
      process.exit(2);
    }
    const priced = priceChildTranscripts({
      configDir: entry.launchConfigDir || squadConfigDir(entry.squad),
      cwd: entry.worktree,
      sessionId: entry.sessionId,
      sessionIds: [entry.sessionId].filter(Boolean),
    });
    const verdict = evaluateUsage({ pin, byModel: priced?.byModel ?? null, requested: typeof entry.model === "string" ? entry.model : null });
    if (args.json) console.log(JSON.stringify({ pin, run: args.run, child: args.child, ...verdict }, null, 2));
    else {
      console.log(`pin: ${pin}   child: ${args.run}/${args.child}`);
      for (const m of verdict.models) console.log(`${m.model === pin ? "ok  " : "FAIL"} ${m.model}: ${m.messages} message(s)${m.usd === null ? ", unpriced" : `, $${m.usd.toFixed(6)}`}`);
      console.log(verdict.status === "ok" ? "verify: only the pin" : verdict.status === "unknown" ? `verify: UNKNOWN — ${verdict.reason}` : `verify: OFF THE PIN — ${verdict.offenders.join(", ")} (the run goes to the exclusions bucket)`);
    }
    process.exit(verdict.status === "ok" ? 0 : verdict.status === "unknown" ? 3 : 1);
  }

  usage();
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) await main();

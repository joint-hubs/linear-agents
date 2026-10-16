// Route-level tests for the Settings endpoints (FOC-786 slice G, implemented
// in settings-routes.mjs). Two layers, in the work-routes.test.mjs style:
//
//   Unit block — handleSettingsRoute called IN-PROCESS with setSettingsDeps()
//   stubs (the checks never touch the network), a stub ctx, and fully
//   isolated env seams (LA_SECRETS_DIR, LA_SETTINGS_FILE, LA_DATA_HOME,
//   LA_PROVIDER_CONFIG, LA_PROVIDER_ENV_FILE under one tmp dir).
//
//   Integration block — the REAL telemetry-server spawned once against a
//   local fake check server (provider/Linear/GitHub endpoints) and a local
//   bare git repo, exercising the live checks, the in-place key writes, the
//   overlay round-trips, the clone job and the retention snapshot.
//
// THE CANARY DISCIPLINE: every good/bad key below is a canary. No response,
// log line, key-checks.json content or captured server stdout/stderr may
// ever contain one — asserted everywhere it could leak.
//
// The env seams are set and left set; LA_TELEMETRY_DB / LA_TELEMETRY_HOME
// are NEVER deleted (the static audit forbids it). Server children are
// ALWAYS killed in finally.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  handleSettingsRoute, setSettingsDeps,
} from "./settings-routes.mjs";
import {
  checkProviderKey, checkLinearKey, checkGithubToken,
} from "./key-check.mjs";
import { readSquadConfig as realReadSquadConfig } from "./squad-config.mjs";
import { benchmarkFor as realBenchmarkFor } from "./model-benchmarks.mjs";
import { writeSettings as realWriteSettings } from "./fenix-settings.mjs";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { ensureViews } from "./telemetry-canonical.mjs";

const POSIX = process.platform !== "win32";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Canary keys — the fake endpoints accept/reject on the BAD substring.
const GOOD_OR = "sk-or-v1-CANARYGOOD0001";
const BAD_OR = "sk-or-v1-CANARYBAD0002";
const GOOD_PROV = "prov-CANARY-GOOD-0003";
const BAD_PROV = "prov-CANARY-BAD-0004";
const LIN_CANARY = "lin_api_CANARY-CHILD";
const GOOD_GH = "ghp_CANARYGOOD0005";
// The provider PUT's optional key candidate (unit-block only — it never
// reaches the integration child, but the leak greps stay uniform).
const CAND_PROV = "prov-CANARY-CAND-GOOD-0006";
const CAND_BAD = "prov-CANARY-reject-CAND-0007";
const ALL_CANARIES = [GOOD_OR, BAD_OR, GOOD_PROV, BAD_PROV, LIN_CANARY, GOOD_GH, CAND_PROV, CAND_BAD];

// ════════════════════════════════════════════════════════════════════════════
// Unit block — in-process, stubbed checks
// ════════════════════════════════════════════════════════════════════════════

const unitDir = mkdtempSync(join(tmpdir(), "settings-routes-unit-"));
const unitSecrets = join(unitDir, "secrets");
const unitConfig = join(unitDir, "config");
const unitData = join(unitDir, "data");
mkdirSync(unitSecrets, { recursive: true });
mkdirSync(unitConfig, { recursive: true });
mkdirSync(unitData, { recursive: true });

// Normalize the key env so `present` starts false for every name (an empty
// string counts as unset for the key logic).
process.env.OPENROUTER_API_KEY = "";
process.env.PROVIDER_API_KEY = "";
process.env.LINEAR_API_KEY = "";
process.env.GITHUB_TOKEN = "";
process.env.GH_TOKEN = "";
process.env.LA_SECRETS_DIR = unitSecrets;
process.env.LA_SETTINGS_FILE = join(unitConfig, "settings.json");
process.env.LA_DATA_HOME = unitData;
process.env.LA_PROVIDER_ENV_FILE = join(unitDir, "missing.env");
process.env.LA_PROVIDER = "";
// The Supervisor routing row's chain starts at SUPERVISOR_MODEL — pin its
// absence so the row resolves down the chain deterministically (restored
// before the integration block; the child pins its own value anyway).
const PREV_SUPERVISOR_MODEL = process.env.SUPERVISOR_MODEL;
delete process.env.SUPERVISOR_MODEL;

// A tiny hermetic models.json fixture: routing supervisor+dev, pricing for
// the routed alias and the cheap tier.
const FIXTURE_BASEURL = "https://or.example/api";
writeFileSync(join(unitConfig, "models.json"), JSON.stringify({
  providers: {
    openrouter: {
      baseUrl: FIXTURE_BASEURL,
      authEnv: "OPENROUTER_API_KEY",
      authStyle: "token",
      defaultModel: "prov/m1",
      tiers: { opus: "prov/m-big", sonnet: "prov/m-mid", haiku: "prov/m-small", smallFast: "prov/m-tiny" },
    },
  },
  ids: { glm: "prov/glm" },
  routing: {
    supervisor: { default: "glm" },
    dev: { worker: "glm" },
  },
  pricing: {
    openrouter: {
      "prov/glm": { input: 1, output: 2 },
      "prov/m-tiny": { input: 0.1, output: 0.2 },
    },
  },
}), "utf8");
process.env.LA_PROVIDER_CONFIG = join(unitConfig, "models.json");

// The stub checks: reject any key whose value contains "reject".
const stubCalls = { provider: [], linear: [], github: [] };
const stubResult = (value) => (String(value || "").includes("reject")
  ? { ok: false, reason: "stub reject" }
  : { ok: true, reason: "stub accepted" });

setSettingsDeps({
  checks: {
    checkProviderKey: async (args) => { stubCalls.provider.push(args); return stubResult(args.key); },
    checkLinearKey: async (args) => { stubCalls.linear.push(args); return stubResult(args.key); },
    checkGithubToken: async (args) => { stubCalls.github.push(args); return stubResult(args.token); },
  },
  // Routing pricing must come from the fixture, not the repo's real
  // models.json — pin the squad-config root.
  readSquadConfig: (root) => realReadSquadConfig(root ?? unitDir),
  cachedRetention: async () => ({
    policy: "unknown", cleanupPeriodDays: {},
    usage: { transcriptsBytes: 0, telemetryBytes: 0, workspacesBytes: 0, stateBytes: 0 },
    disk: null, computedAt: "2026-10-13T12:00:00.000Z", managedBy: "FOC-780",
    partial: [], unreadable: { transcripts: 0, telemetry: 0, workspaces: 0, state: 0 },
  }),
  startClone: ({ url }) => (String(url).includes("bad") ? { error: "stub refused" } : { jobId: "stub-job-1" }),
});

const REAL_CHECKS = { checkProviderKey, checkLinearKey, checkGithubToken };

// A stub req/res/ctx pair — the same guard + body + send contract the real
// server passes.
async function unit(method, path, { body, origin = "http://localhost:5173" } = {}) {
  const req = {
    method,
    headers: { origin },
    socket: { remoteAddress: "127.0.0.1" },
    __body: body === undefined ? "" : JSON.stringify(body),
  };
  const res = {};
  const ctx = {
    readJsonBody: async (r, cap = 8192) => {
      const raw = r.__body || "";
      if (raw.length > cap) { const e = new Error("too large"); e.tooLarge = true; throw e; }
      return JSON.parse(raw); // empty body throws, like the server's parser
    },
    respondBodyError: (r, err) => {
      r.__status = err?.tooLarge ? 413 : 400;
      r.__body = { error: "bad body" };
      return r.__status;
    },
    json: (r, status, payload) => { r.__status = status; r.__body = payload; },
    log: () => {},
    isLocalOrigin: () => true,
    isAllowedOrigin: (o) => o === "http://localhost:5173",
  };
  const handled = await handleSettingsRoute(req, res, new URL(path, "http://127.0.0.1"), ctx);
  return { handled, status: res.__status, body: res.__body };
}

// ── keys: GET shape, guards, refusal, save ───────────────────────────────────

{
  const r = await unit("GET", "/api/settings/keys");
  check("unit keys GET -> 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check("unit keys GET writable true", r.body?.writable === true);
  const names = (r.body?.keys || []).map((k) => k.name);
  check("unit keys GET allow-list exactly",
    JSON.stringify(names.sort()) === JSON.stringify(["github_token", "linear_api_key", "openrouter_api_key", "provider_api_key"]),
    JSON.stringify(names));
  check("unit keys GET shape", (r.body?.keys || []).every((k) =>
    typeof k.label === "string" && typeof k.required === "boolean"
    && typeof k.present === "boolean" && typeof k.envName === "string"
    && (k.lastCheck === null || (typeof k.lastCheck.at === "string" && typeof k.lastCheck.ok === "boolean"))));
  check("unit keys GET all absent initially", (r.body?.keys || []).every((k) => k.present === false));
  check("unit keys GET carries the note", typeof r.body?.note === "string" && r.body.note.includes("Supervisor"));
  const raw = JSON.stringify(r.body);
  check("unit keys GET has no canary", ALL_CANARIES.every((c) => !raw.includes(c)));
}

{
  const r = await unit("PUT", "/api/settings/keys/not_a_key", { body: { value: "x" } });
  check("unit keys PUT unknown name -> 404", r.status === 404, JSON.stringify(r.body));
  const foreign = await unit("PUT", "/api/settings/keys/openrouter_api_key",
    { body: { value: "x" }, origin: "http://evil.example" });
  check("unit keys PUT foreign origin -> 403", foreign.status === 403);
}

{
  const prev = process.env.LA_SECRETS_DIR;
  delete process.env.LA_SECRETS_DIR; // test-only: 503 path (LA_TELEMETRY_* are never touched)
  try {
    const r = await unit("PUT", "/api/settings/keys/linear_api_key", { body: { value: "x" } });
    check("unit keys PUT no secrets dir -> 503", r.status === 503 && r.body?.error === "secrets-not-writable",
      JSON.stringify(r.body));
    const g = await unit("GET", "/api/settings/keys");
    check("unit keys GET writable false without dir", g.body?.writable === false);
  } finally {
    process.env.LA_SECRETS_DIR = prev;
  }
}

{
  const r = await unit("PUT", "/api/settings/keys/openrouter_api_key", { body: { value: "   " } });
  check("unit keys PUT empty -> 400 empty", r.status === 400 && r.body?.error === "empty", JSON.stringify(r.body));
  const noBody = await unit("PUT", "/api/settings/keys/openrouter_api_key");
  check("unit keys PUT missing body -> 400", noBody.status === 400);
}

{
  const r = await unit("PUT", "/api/settings/keys/linear_api_key", { body: { value: "reject-me" } });
  check("unit keys PUT rejected -> 400 key-rejected",
    r.status === 400 && r.body?.error === "key-rejected" && r.body?.check?.ok === false,
    JSON.stringify(r.body));
  check("unit keys PUT rejected wrote nothing", !exists(join(unitSecrets, "linear_api_key")));
}

{
  const r = await unit("PUT", "/api/settings/keys/openrouter_api_key", { body: { value: `  ${GOOD_OR}  ` } });
  check("unit keys PUT accepted -> 200 saved", r.status === 200 && r.body?.saved === true && r.body?.name === "openrouter_api_key",
    JSON.stringify(r.body).slice(0, 200));
  const file = join(unitSecrets, "openrouter_api_key");
  check("unit keys PUT file content is the canary", readText(file) === GOOD_OR);
  if (POSIX) {
    check("unit keys PUT file mode 0600", (statSync(file).mode & 0o777) === 0o600);
  }
  check("unit keys PUT response has no canary", !JSON.stringify(r.body).includes(GOOD_OR));
  check("unit keys PUT env set", process.env.OPENROUTER_API_KEY === GOOD_OR);
  const ledger = readText(join(unitData, "settings", "key-checks.json"));
  check("unit lastCheck recorded ok", JSON.parse(ledger)?.openrouter_api_key?.ok === true);
  check("unit lastCheck ledger has no canary", !ledger.includes(GOOD_OR));
  // The check call saw the trimmed value and the fixture's cheapest tier.
  const call = stubCalls.provider.at(-1);
  check("unit provider check got the key + cheap tier",
    call?.key === GOOD_OR && call?.model === "prov/m-tiny" && call?.baseUrl === FIXTURE_BASEURL,
    JSON.stringify({ ...call, key: call?.key ? "..." : null }));
}

{
  // Pre-existing file: the inode must survive (bind mounts pin it).
  const file = join(unitSecrets, "openrouter_api_key");
  const before = statSync(file).ino;
  const r = await unit("PUT", "/api/settings/keys/openrouter_api_key", { body: { value: GOOD_OR } });
  check("unit keys PUT re-save -> 200", r.status === 200);
  if (POSIX) check("unit keys PUT inode unchanged", statSync(file).ino === before);
}

{
  const r = await unit("POST", "/api/settings/keys/openrouter_api_key/validate");
  check("unit validate stored key -> ok", r.status === 200 && r.body?.name === "openrouter_api_key"
    && r.body?.check?.ok === true, JSON.stringify(r.body));
  check("unit validate used the stored value", stubCalls.provider.at(-1)?.key === GOOD_OR);
  const none = await unit("POST", "/api/settings/keys/linear_api_key/validate");
  check("unit validate with no stored key -> ok false",
    none.status === 200 && none.body?.check?.ok === false && /no key stored/.test(none.body?.check?.reason || ""));
  process.env.LINEAR_API_KEY = "lin-unit-good";
  const team = await unit("POST", "/api/settings/keys/linear_api_key/validate", { body: { teamKey: "FEN" } });
  check("unit validate forwards teamKey", team.status === 200 && stubCalls.linear.at(-1)?.teamKey === "FEN"
    && stubCalls.linear.at(-1)?.key === "lin-unit-good");
}

{
  const r = await unit("PUT", "/api/settings/keys/github_token", { body: { value: GOOD_GH } });
  check("unit github PUT -> 200", r.status === 200);
  check("unit github PUT sets both env spellings",
    process.env.GITHUB_TOKEN === GOOD_GH && process.env.GH_TOKEN === GOOD_GH);
  check("unit github check got the token", stubCalls.github.at(-1)?.token === GOOD_GH);
}

{
  // The mounted file is authoritative: a CLI rotation is seen without a
  // restart even though the process env keeps the stale start-up value.
  process.env.OPENROUTER_API_KEY = "stale-env-openrouter-key";
  const present = await unit("GET", "/api/settings/keys");
  check("unit stale env: file wins for present",
    (present.body?.keys || []).find((k) => k.name === "openrouter_api_key")?.present === true,
    JSON.stringify(present.body?.keys));
  const v = await unit("POST", "/api/settings/keys/openrouter_api_key/validate");
  check("unit stale env: validate reads the fresh file value",
    v.status === 200 && stubCalls.provider.at(-1)?.key === GOOD_OR,
    JSON.stringify({ key: stubCalls.provider.at(-1)?.key ? "..." : null }));
  process.env.OPENROUTER_API_KEY = GOOD_OR; // restore the post-PUT state

  // An existing-but-EMPTY file means the key was cleared: env must not
  // resurrect it.
  writeFileSync(join(unitSecrets, "linear_api_key"), "", "utf8");
  const cleared = await unit("GET", "/api/settings/keys");
  check("unit empty file: present false despite stale env",
    (cleared.body?.keys || []).find((k) => k.name === "linear_api_key")?.present === false,
    JSON.stringify((cleared.body?.keys || []).find((k) => k.name === "linear_api_key")));
  const v2 = await unit("POST", "/api/settings/keys/linear_api_key/validate");
  check("unit empty file: validate reports no key stored",
    v2.status === 200 && v2.body?.check?.ok === false && /no key stored/.test(v2.body?.check?.reason || ""),
    JSON.stringify(v2.body));
  process.env.LINEAR_API_KEY = ""; // the env spelling no longer matters
}


{
  setSettingsDeps({benchmarkFor: (model, provider) => model === "prov/glm" && provider === "openrouter" ? 42 : null});
  try {
    const result = await unit("GET", "/api/settings/routing");
    check("unit routing exposes scored lead benchmark", result.body?.rows?.find(row => row.squad === "dev")?.benchmark === 42);
    check("unit routing exposes scored candidate benchmark", result.body?.models?.find(model => model.id === "prov/glm")?.benchmark === 42);
    check("unit unknown benchmark remains unavailable", result.body?.models?.find(model => model.id === "prov/m-tiny")?.benchmark === null);
  } finally { setSettingsDeps({benchmarkFor: realBenchmarkFor}); }
}

// ── routing (before the provider tests: the overlay's active stays default) ──

{
  const r = await unit("GET", "/api/settings/routing");
  check("unit routing GET -> 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  check("unit routing GET provider default", r.body?.provider === "openrouter");
  const squads = (r.body?.rows || []).map((row) => row.squad);
  check("unit routing rows = routing keys + supervisor",
    JSON.stringify(squads) === JSON.stringify(["dev", "supervisor"]), JSON.stringify(squads));
  const dev = r.body?.rows?.find((row) => row.squad === "dev");
  check("unit routing dev row from models.json, priced",
    dev?.lead === "prov/glm" && dev?.source === "models.json"
    && dev?.price?.input === 1 && dev?.price?.output === 2 && dev?.unpriced === false
    && dev?.benchmark === null, JSON.stringify(dev));
  const sup = r.body?.rows?.find((row) => row.squad === "supervisor");
  check("unit routing supervisor row = the entrypoint chain, not models.json routing",
    sup?.lead === "prov/m1" && sup?.source === "provider-default" && sup?.unpriced === true,
    JSON.stringify(sup));
  check("unit routing models list from the provider's pricing scope",
    JSON.stringify((r.body?.models || []).map((mm) => mm.id)) === JSON.stringify(["prov/glm", "prov/m-tiny"])
    && r.body.models[0].benchmark === null, JSON.stringify(r.body?.models));
}

{
  const put = await unit("PUT", "/api/settings/routing", { body: { squad: "dev", lead: "prov/m-tiny" } });
  const dev = put.body?.rows?.find((row) => row.squad === "dev");
  check("unit routing PUT -> settings row priced",
    put.status === 200 && dev?.lead === "prov/m-tiny" && dev?.source === "settings"
    && dev?.price?.input === 0.1, JSON.stringify(dev));
  check("unit routing PUT persisted", JSON.parse(readText(process.env.LA_SETTINGS_FILE))?.routing?.dev?.lead === "prov/m-tiny");
  const back = await unit("PUT", "/api/settings/routing", { body: { squad: "dev", lead: null } });
  const devBack = back.body?.rows?.find((row) => row.squad === "dev");
  check("unit routing PUT null -> back to models.json",
    back.status === 200 && devBack?.lead === "prov/glm" && devBack?.source === "models.json");
  check("unit routing PUT null deleted the overlay entry",
    JSON.parse(readText(process.env.LA_SETTINGS_FILE))?.routing?.dev === undefined);
  const bad = await unit("PUT", "/api/settings/routing", { body: { squad: "nosuch", lead: "m" } });
  check("unit routing PUT unknown squad -> 400", bad.status === 400 && bad.body?.error === "unknown squad");
}

{
  // The Supervisor row follows the entrypoint's chain: SUPERVISOR_MODEL >
  // overlay lead > provider default > the hard-coded fallback.
  process.env.SUPERVISOR_MODEL = "prov/env-model";
  const envRow = (await unit("GET", "/api/settings/routing")).body?.rows?.find((row) => row.squad === "supervisor");
  check("unit routing supervisor env hop wins", envRow?.lead === "prov/env-model" && envRow?.source === "env",
    JSON.stringify(envRow));
  delete process.env.SUPERVISOR_MODEL;

  const put = await unit("PUT", "/api/settings/routing", { body: { squad: "supervisor", lead: "prov/m-tiny" } });
  const supRow = put.body?.rows?.find((row) => row.squad === "supervisor");
  check("unit routing supervisor settings hop priced",
    put.status === 200 && supRow?.lead === "prov/m-tiny" && supRow?.source === "settings"
    && supRow?.price?.input === 0.1, JSON.stringify(supRow));
  const back = await unit("PUT", "/api/settings/routing", { body: { squad: "supervisor", lead: null } });
  const supBack = back.body?.rows?.find((row) => row.squad === "supervisor");
  check("unit routing supervisor cleared -> provider default",
    back.status === 200 && supBack?.lead === "prov/m1" && supBack?.source === "provider-default",
    JSON.stringify(supBack));
}

{
  // Overlay-only squads: listed in GET and clearable via PUT. Setting a
  // brand-new squad name stays a 400 — the valid set is the listed rows.
  const put = await unit("PUT", "/api/settings/routing", { body: { squad: "aux", lead: "prov/glm" } });
  check("unit routing PUT squad absent from the rows -> 400",
    put.status === 400 && put.body?.error === "unknown squad", JSON.stringify(put.body));

  writeFileSync(process.env.LA_SETTINGS_FILE, JSON.stringify({
    provider: { active: null, custom: null },
    routing: { aux: { lead: "prov/glm" } },
  }), "utf8");
  const g = await unit("GET", "/api/settings/routing");
  const aux = g.body?.rows?.find((row) => row.squad === "aux");
  check("unit routing overlay-only squad listed in GET, priced",
    g.status === 200 && aux?.lead === "prov/glm" && aux?.source === "settings" && aux?.price?.input === 1,
    JSON.stringify(aux));
  const gone = await unit("PUT", "/api/settings/routing", { body: { squad: "aux", lead: null } });
  check("unit routing overlay-only squad cleared via PUT",
    gone.status === 200 && !gone.body?.rows?.some((row) => row.squad === "aux"),
    JSON.stringify(gone.body?.rows?.map((row) => row.squad)));
  check("unit routing overlay-only squad entry deleted from the overlay",
    JSON.parse(readText(process.env.LA_SETTINGS_FILE))?.routing?.aux === undefined);
}

// ── provider ──────────────────────────────────────────────────────────────────

{
  const g = await unit("GET", "/api/settings/provider");
  check("unit provider GET -> 200 default", g.status === 200 && g.body?.active === "openrouter"
    && g.body?.source === "default" && g.body?.custom === null, JSON.stringify(g.body).slice(0, 200));
  const or = (g.body?.providers || []).find((p) => p.name === "openrouter");
  check("unit provider GET builtin entry",
    or?.baseUrl === FIXTURE_BASEURL && or?.keyName === "OPENROUTER_API_KEY" && or?.builtin === true
    && typeof or?.defaultModel === "string", JSON.stringify(or));
  check("unit provider GET effectiveOn note", typeof g.body?.effectiveOn === "string" && g.body.effectiveOn.includes("child"));

  const bad = await unit("PUT", "/api/settings/provider", { body: { active: "nosuch" } });
  check("unit provider PUT unknown provider -> 400 invalid",
    bad.status === 400 && bad.body?.error === "invalid", JSON.stringify(bad.body));

  const ok = await unit("PUT", "/api/settings/provider", { body: { active: "openrouter" } });
  check("unit provider PUT builtin -> 200 with check",
    ok.status === 200 && ok.body?.check?.ok === true && ok.body?.active === "openrouter", JSON.stringify(ok.body).slice(0, 200));
}

{
  // custom with a failing check: settings must stay untouched.
  process.env.PROVIDER_API_KEY = "reject-me-prov";
  const fail = await unit("PUT", "/api/settings/provider", { body: {
    active: "custom",
    custom: { baseUrl: "http://127.0.0.1:9", authStyle: "token", keyName: "PROVIDER_API_KEY",
      tiers: { smallFast: "cm" }, defaultModel: "cm" },
  } });
  check("unit provider PUT failing check -> 400 provider-check-failed",
    fail.status === 400 && fail.body?.error === "provider-check-failed" && fail.body?.check?.ok === false,
    JSON.stringify(fail.body));
  check("unit provider PUT failing check left settings untouched",
    JSON.parse(readText(process.env.LA_SETTINGS_FILE))?.provider?.active === "openrouter");

  process.env.PROVIDER_API_KEY = GOOD_PROV;
  const ok = await unit("PUT", "/api/settings/provider", { body: {
    active: "custom",
    custom: { baseUrl: "http://127.0.0.1:9", authStyle: "token", keyName: "PROVIDER_API_KEY",
      tiers: { smallFast: "cm" }, defaultModel: "cm" },
  } });
  check("unit provider PUT custom ok -> 200", ok.status === 200 && ok.body?.active === "custom"
    && ok.body?.custom?.baseUrl === "http://127.0.0.1:9", JSON.stringify(ok.body).slice(0, 200));
  const stored = JSON.parse(readText(process.env.LA_SETTINGS_FILE));
  check("unit provider PUT custom persisted", stored?.provider?.active === "custom"
    && stored?.provider?.custom?.keyName === "PROVIDER_API_KEY");

  const test = await unit("POST", "/api/settings/provider/test", { body: { active: "openrouter" } });
  check("unit provider/test -> { check }", test.status === 200 && typeof test.body?.check?.ok === "boolean",
    JSON.stringify(test.body));
}

{
  // The optional key candidate (the onboarding path): validate the candidate
  // against the NEW provider first; a refusal leaves settings + secrets
  // untouched, a pass saves the key file and then the settings.
  const customBlock = { baseUrl: "http://127.0.0.1:9", authStyle: "token", keyName: "PROVIDER_API_KEY",
    tiers: { smallFast: "cm" }, defaultModel: "cm" };
  const before = readText(process.env.LA_SETTINGS_FILE);
  const rejected = await unit("PUT", "/api/settings/provider",
    { body: { active: "custom", custom: customBlock, key: { value: CAND_BAD } } });
  check("unit provider PUT candidate rejected -> 400 provider-check-failed",
    rejected.status === 400 && rejected.body?.error === "provider-check-failed" && rejected.body?.check?.ok === false,
    JSON.stringify(rejected.body));
  check("unit provider PUT candidate rejected left settings untouched",
    readText(process.env.LA_SETTINGS_FILE) === before);
  check("unit provider PUT candidate rejected wrote no key file", !exists(join(unitSecrets, "provider_api_key")));
  check("unit provider PUT candidate rejected: no canary in response", !JSON.stringify(rejected.body).includes(CAND_BAD));

  const fresh = await unit("PUT", "/api/settings/provider",
    { body: { active: "custom", custom: customBlock, key: { value: `  ${CAND_PROV}  ` } } });
  check("unit provider PUT candidate fresh setup -> 200",
    fresh.status === 200 && fresh.body?.active === "custom" && fresh.body?.check?.ok === true,
    JSON.stringify(fresh.body).slice(0, 200));
  check("unit provider PUT candidate saved the trimmed key file",
    readText(join(unitSecrets, "provider_api_key")) === CAND_PROV);
  check("unit provider PUT candidate env set", process.env.PROVIDER_API_KEY === CAND_PROV);
  check("unit provider PUT candidate: no canary in response", !JSON.stringify(fresh.body).includes(CAND_PROV));
  const ledger = readText(join(unitData, "settings", "key-checks.json"));
  check("unit provider PUT candidate lastCheck recorded, no value",
    JSON.parse(ledger)?.provider_api_key?.ok === true && !ledger.includes(CAND_PROV));
  check("unit provider PUT candidate persisted settings",
    JSON.parse(readText(process.env.LA_SETTINGS_FILE))?.provider?.active === "custom");
  const call = stubCalls.provider.at(-1);
  check("unit provider candidate check hit the custom endpoint",
    call?.baseUrl === "http://127.0.0.1:9" && call?.key === CAND_PROV,
    JSON.stringify({ ...call, key: call?.key ? "..." : null }));

  const empty = await unit("PUT", "/api/settings/provider", { body: { active: "custom", key: { value: "   " } } });
  check("unit provider PUT candidate empty -> 400 empty",
    empty.status === 400 && empty.body?.error === "empty", JSON.stringify(empty.body));
}


{
  const before = readText(process.env.LA_SETTINGS_FILE);
  const invalid = await unit("PUT", "/api/settings/provider", {body: {active: "custom", custom: null}});
  check("unit active custom config cannot be deleted", invalid.status === 400);
  check("unit invalid custom deletion preserves settings", readText(process.env.LA_SETTINGS_FILE) === before);
  const keyPath = join(unitSecrets, "provider_api_key");
  const oldKey = readText(keyPath);
  const oldEnv = process.env.PROVIDER_API_KEY;
  const oldLedger = readText(join(unitData, "settings", "key-checks.json"));
  setSettingsDeps({writeSettings: () => { throw new Error("simulated settings write failure"); }});
  try {
    const refused = await unit("PUT", "/api/settings/provider", {body: {active: "custom", key: {value: GOOD_PROV}}});
    check("unit provider settings write failure is reported", refused.status >= 400);
    check("unit provider settings write failure restores mounted key", readText(keyPath) === oldKey);
    check("unit provider settings write failure preserves env", process.env.PROVIDER_API_KEY === oldEnv);
    check("unit provider settings write failure preserves overlay", readText(process.env.LA_SETTINGS_FILE) === before);
    check("unit provider settings write failure preserves ledger", readText(join(unitData, "settings", "key-checks.json")) === oldLedger);
    check("unit provider settings write failure response has no candidate", !JSON.stringify(refused.body).includes(GOOD_PROV));
  } finally { setSettingsDeps({writeSettings: realWriteSettings}); }
}


{
  // A long-lived API can inherit a launcher-resolved provider. Only a real
  // user override may mask the current overlay (same rule as fresh spawn).
  const names = ["LA_PROVIDER", "LA_PROVIDER_SOURCE", "LA_PROVIDER_RESOLVED"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, {LA_PROVIDER: "openrouter", LA_PROVIDER_SOURCE: "settings", LA_PROVIDER_RESOLVED: "openrouter"});
    const provider = await unit("GET", "/api/settings/provider");
    check("unit provider GET ignores inherited stale provider", provider.body?.active === "custom" && provider.body?.source === "settings");
    const routing = await unit("GET", "/api/settings/routing");
    check("unit routing scope ignores inherited stale provider", routing.body?.provider === "custom");
    process.env.LA_PROVIDER_SOURCE = "env";
    const explicit = await unit("GET", "/api/settings/provider");
    check("unit provider GET preserves explicit env override", explicit.body?.active === "openrouter" && explicit.body?.source === "env");
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// ── repos + retention stubs ──────────────────────────────────────────────────

{
  const ok = await unit("POST", "/api/settings/repos", { body: { url: "owner/name" } });
  check("unit repos POST -> 202 jobId", ok.status === 202 && ok.body?.jobId === "stub-job-1", JSON.stringify(ok.body));
  const refused = await unit("POST", "/api/settings/repos", { body: { url: "bad-url" } });
  check("unit repos POST refused -> 400", refused.status === 400 && typeof refused.body?.error === "string");
  const ret = await unit("GET", "/api/settings/retention");
  check("unit retention GET -> 200 shape", ret.status === 200 && ret.body?.managedBy === "FOC-780"
    && typeof ret.body?.usage?.transcriptsBytes === "number", JSON.stringify(ret.body).slice(0, 200));
  const nope = await unit("GET", "/api/settings/definitely-not");
  check("unit unmatched settings path -> 404", nope.status === 404);
  const wrongMethod = await unit("DELETE", "/api/settings/retention");
  check("unit wrong method -> 405", wrongMethod.status === 405);
}

// ── agent-tools: read-only GET over the effective root (FOC-906) ─────────────

{
  const prevSquad = process.env.LA_SQUAD_HOME;
  const squadDir = join(unitDir, "agents");
  mkdirSync(join(squadDir, "alpha"), { recursive: true });
  writeFileSync(join(squadDir, "alpha", "settings.json"), JSON.stringify({
    permissions: { allow: ["Read"], ask: ["Bash(git push:*)"], deny: [] },
  }, null, 2), "utf8");
  mkdirSync(join(squadDir, "broken"), { recursive: true });
  writeFileSync(join(squadDir, "broken", "settings.json"), "{not json", "utf8");
  process.env.LA_SQUAD_HOME = squadDir;
  try {
    const r = await unit("GET", "/api/settings/agent-tools");
    check("unit agent-tools GET -> 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    check("unit agent-tools GET root is the effective root", r.body?.root === squadDir);
    const alpha = (r.body?.agents || []).find((a) => a.agent === "alpha");
    check("unit agent-tools GET healthy row", alpha?.permissions?.allow?.[0] === "Read"
      && alpha?.permissions?.ask?.[0] === "Bash(git push:*)"
      && Array.isArray(alpha?.mcp) && Array.isArray(alpha?.skills), JSON.stringify(alpha).slice(0, 200));
    const broken = (r.body?.agents || []).find((a) => a.agent === "broken");
    check("unit agent-tools GET broken row is an error row, not a 500",
      typeof broken?.error === "string" && /not valid JSON/.test(broken.error), JSON.stringify(broken));
    check("unit agent-tools GET check block", typeof r.body?.check?.summary?.errors === "number"
      && Array.isArray(r.body?.check?.findings));
    const wrong = await unit("PUT", "/api/settings/agent-tools");
    check("unit agent-tools PUT -> 405", wrong.status === 405);
  } finally {
    if (prevSquad === undefined) delete process.env.LA_SQUAD_HOME;
    else process.env.LA_SQUAD_HOME = prevSquad;
  }
}

// Restore the real deps (the integration child is a fresh process anyway,
// but keep this process honest).
setSettingsDeps({ checks: REAL_CHECKS, readSquadConfig: (root) => realReadSquadConfig(root) });
if (PREV_SUPERVISOR_MODEL === undefined) delete process.env.SUPERVISOR_MODEL;
else process.env.SUPERVISOR_MODEL = PREV_SUPERVISOR_MODEL;

// ════════════════════════════════════════════════════════════════════════════
// Integration block — the REAL server against fake check endpoints
// ════════════════════════════════════════════════════════════════════════════

const dir = mkdtempSync(join(tmpdir(), "settings-routes-int-"));
const curatedMapBefore = readFileSync(new URL("../config/projects.json", import.meta.url), "utf8");
const dataHome = join(dir, "data");
const secrets = join(dir, "secrets");
const dbPath = join(dir, "telemetry.sqlite");
mkdirSync(secrets, { recursive: true });
mkdirSync(join(dir, "agents"), { recursive: true });
mkdirSync(join(dir, "workspaces"), { recursive: true });

// FOC-906: agents for the read-only agent-tools GET (one healthy, one broken).
mkdirSync(join(dir, "agents", "agent-a"), { recursive: true });
writeFileSync(join(dir, "agents", "agent-a", "settings.json"), JSON.stringify({
  permissions: { allow: ["Read", "Bash(ls:*)"], ask: [], deny: ["Bash(git push:*)"] },
}, null, 2), "utf8");
mkdirSync(join(dir, "agents", "agent-broken"), { recursive: true });
writeFileSync(join(dir, "agents", "agent-broken", "settings.json"), "{not json", "utf8");

{
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();
}

// ── the fake check endpoints (provider /v1/messages, Linear, GitHub) ─────────

const fakeChecks = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const auth = req.headers.authorization || req.headers["x-api-key"] || "";
  const bad = String(auth).includes("BAD");
  if (req.url === "/v1/messages" && req.method === "POST") {
    if (bad) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "denied" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1" }));
    return;
  }
  if (req.url === "/linear" && req.method === "POST") {
    if (bad) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { viewer: { id: "v1", name: "Canary" }, teams: { nodes: [{ key: "FEN", name: "Fenix" }] } } }));
    return;
  }
  if (req.url === "/gh" && req.method === "GET") {
    if (bad) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": "repo" });
    res.end(JSON.stringify({ login: "canary-user" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});

await new Promise((resolve) => fakeChecks.listen(0, "127.0.0.1", resolve));
const CHECKS_URL = `http://127.0.0.1:${fakeChecks.address().port}`;

// ── a local bare repo for the clone test ─────────────────────────────────────

function gitRun(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const seedDir = join(dir, "seed-src");
const bareDir = join(dir, "seedrepo");
gitRun(dir, "init", seedDir);
gitRun(seedDir, "config", "user.email", "test@example.com");
gitRun(seedDir, "config", "user.name", "test");
writeFileSync(join(seedDir, "README.md"), "# seed\n", "utf8");
gitRun(seedDir, "add", ".");
gitRun(seedDir, "commit", "-m", "seed");
gitRun(dir, "clone", "--bare", seedDir, bareDir);
const BARE_URL = pathToFileURL(bareDir).href;

// ── the server child ─────────────────────────────────────────────────────────

const childEnv = {
  ...process.env,
  NODE_ENV: "test",
  // Isolated seams under the integration tmp tree.
  LA_SECRETS_DIR: secrets,
  LA_SETTINGS_FILE: join(dir, "config", "settings.json"),
  LA_DATA_HOME: dataHome,
  LA_PROJECTS_FILE: join(dir, "projects.json"),
  LA_GITHUB_ROOT: join(dir, "workspaces"),
  LA_SQUAD_HOME: join(dir, "agents"),
  LA_SUPERVISOR_STATE_HOME: join(dir, "sup-state"),
  LA_STATE_ROOT: join(dir, "state-root"),
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  // Hermetic provider resolution: no real .env, no LA_PROVIDER, but the
  // OpenRouter base URL moves to the fake endpoint.
  LA_PROVIDER: "",
  LA_PROVIDER_ENV_FILE: join(dir, "missing.env"),
  LA_PROVIDER_CONFIG: "",
  LA_PROVIDER_BASEURL_OPENROUTER: CHECKS_URL,
  LA_LINEAR_CHECK_URL: `${CHECKS_URL}/linear`,
  LA_GITHUB_CHECK_URL: `${CHECKS_URL}/gh`,
  // No key in the child env except the Linear canary the validate test reads.
  OPENROUTER_API_KEY: "",
  PROVIDER_API_KEY: "",
  LINEAR_API_KEY: LIN_CANARY,
  GITHUB_TOKEN: "",
  GH_TOKEN: "",
  // Pin the top of the Supervisor chain so the routing row resolves down to
  // the provider default deterministically.
  SUPERVISOR_MODEL: "",
  FENIX_REPOS_ALLOW_LOCAL: "1",
};

function spawnServer(env) {
  const freePortP = new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  return freePortP.then((port) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(fileURLToPath(new URL(".", import.meta.url)), "telemetry-server.mjs")], {
      env: { ...env, TELEMETRY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdoutBuf = "";
    child.stderrBuf = "";
    child.stdout.on("data", (c) => { child.stdoutBuf += c; });
    child.stderr.on("data", (c) => { child.stderrBuf += c; });
    resolve({ child, port });
  }));
}

async function waitForServer(port, child, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server not ready");
}

async function call(port, method, path, { origin = "http://localhost:5173", body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json, raw: json === null ? await res.text().catch(() => "") : JSON.stringify(json) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(port, path, predicate, ms = 30000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await call(port, "GET", path);
    if (last.status === 200 && last.body && predicate(last.body)) return last;
    await sleep(200);
  }
  throw new Error(`poll timeout on ${path}: ${JSON.stringify(last?.body).slice(0, 300)}`);
}

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

function readText(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

// ── run the integration scenario ─────────────────────────────────────────────

let child = null;
try {
  const spawned = await spawnServer(childEnv);
  child = spawned.child;
  const P = spawned.port;
  await waitForServer(P, child);

  // keys: shape, no canaries, guards
  {
    const r = await call(P, "GET", "/api/settings/keys");
    check("int keys GET -> 200 writable", r.status === 200 && r.body?.writable === true, r.raw.slice(0, 200));
    const or = (r.body?.keys || []).find((k) => k.name === "openrouter_api_key");
    const lin = (r.body?.keys || []).find((k) => k.name === "linear_api_key");
    check("int keys GET present flags", or?.present === false && lin?.present === true, JSON.stringify({ or, lin }));
    check("int keys GET no canary", ALL_CANARIES.every((c) => !r.raw.includes(c)));

    const unknown = await call(P, "PUT", "/api/settings/keys/not_a_key", { body: { value: "x" } });
    check("int keys PUT unknown -> 404", unknown.status === 404);

    const foreign = await call(P, "PUT", "/api/settings/keys/openrouter_api_key",
      { body: { value: "x" }, origin: "http://evil.example" });
    check("int keys PUT foreign origin -> 403", foreign.status === 403);
  }

  // wrong key refused, nothing written
  {
    const r = await call(P, "PUT", "/api/settings/keys/openrouter_api_key", { body: { value: BAD_OR } });
    check("int keys PUT wrong -> 400 key-rejected",
      r.status === 400 && r.body?.error === "key-rejected" && r.body?.check?.ok === false, r.raw.slice(0, 200));
    check("int keys PUT wrong wrote nothing", !exists(join(secrets, "openrouter_api_key")));
    check("int keys PUT wrong response has no canary", !r.raw.includes(BAD_OR));
  }

  // right key saved in place
  {
    writeFileSync(join(secrets, "openrouter_api_key"), "seed-placeholder", "utf8");
    const before = statSync(join(secrets, "openrouter_api_key")).ino;
    const r = await call(P, "PUT", "/api/settings/keys/openrouter_api_key", { body: { value: GOOD_OR } });
    check("int keys PUT good -> 200 saved", r.status === 200 && r.body?.saved === true, r.raw.slice(0, 200));
    const file = join(secrets, "openrouter_api_key");
    check("int keys PUT file content", readText(file) === GOOD_OR, JSON.stringify(readText(file)));
    if (POSIX) {
      check("int keys PUT mode 0600", (statSync(file).mode & 0o777) === 0o600);
      check("int keys PUT inode unchanged", statSync(file).ino === before);
    }
    check("int keys PUT response has no canary", !r.raw.includes(GOOD_OR));
    const ledger = readText(join(dataHome, "settings", "key-checks.json"));
    check("int lastCheck recorded, no value", JSON.parse(ledger)?.openrouter_api_key?.ok === true && !ledger.includes(GOOD_OR));
  }

  // Linear validate via the fake endpoint, with and without a team
  {
    const ok = await call(P, "POST", "/api/settings/keys/linear_api_key/validate", { body: { teamKey: "FEN" } });
    check("int linear validate ok", ok.status === 200 && ok.body?.check?.ok === true, ok.raw.slice(0, 200));
    const nope = await call(P, "POST", "/api/settings/keys/linear_api_key/validate", { body: { teamKey: "NOPE" } });
    check("int linear validate unknown team -> ok false",
      nope.status === 200 && nope.body?.check?.ok === false && /not visible/.test(nope.body?.check?.reason || ""));
    const gh = await call(P, "PUT", "/api/settings/keys/github_token", { body: { value: GOOD_GH } });
    check("int github PUT ok", gh.status === 200 && gh.body?.check?.ok === true, gh.raw.slice(0, 200));
    check("int github PUT no canary in response", !gh.raw.includes(GOOD_GH));
  }

  // provider: GET, invalid, builtin save
  {
    const g = await call(P, "GET", "/api/settings/provider");
    const or = (g.body?.providers || []).find((p) => p.name === "openrouter");
    check("int provider GET shape", g.status === 200 && g.body?.source === "default"
      && or?.baseUrl === "https://openrouter.ai/api" && or?.keyName === "OPENROUTER_API_KEY", g.raw.slice(0, 300));
    const bad = await call(P, "PUT", "/api/settings/provider", { body: { active: "nosuch" } });
    check("int provider PUT unknown -> 400 invalid", bad.status === 400 && bad.body?.error === "invalid");
    const ok = await call(P, "PUT", "/api/settings/provider", { body: { active: "openrouter" } });
    check("int provider PUT openrouter -> 200 with check",
      ok.status === 200 && ok.body?.check?.ok === true, ok.raw.slice(0, 300));
  }

  // routing: rows from the real models.json + supervisor, priced from the
  // openrouter scope; overlay round-trip
  {
    const g = await call(P, "GET", "/api/settings/routing");
    check("int routing GET -> 200 openrouter", g.status === 200 && g.body?.provider === "openrouter", g.raw.slice(0, 300));
    const squads = (g.body?.rows || []).map((row) => row.squad);
    check("int routing rows include every squad + supervisor",
      ["supervisor", "dev", "plan", "review", "test", "cadence"].every((s) => squads.includes(s)), JSON.stringify(squads));
    const dev = g.body?.rows?.find((row) => row.squad === "dev");
    check("int routing dev row from models.json",
      dev?.lead === "z-ai/glm-5.3-flash" && dev?.source === "models.json"
      && dev?.price?.input === 0.075 && dev?.price?.output === 0.25 && dev?.unpriced === false
      && Number.isFinite(dev?.benchmark), JSON.stringify(dev));
    const sup = g.body?.rows?.find((row) => row.squad === "supervisor");
    check("int routing supervisor row = provider default, not models.json routing",
      sup?.lead === "xiaomi/mimo-v2.6-pro" && sup?.source === "provider-default"
      && sup?.price?.input === 0.435 && sup?.unpriced === false, JSON.stringify(sup));
    check("int routing models from the openrouter scope",
      (g.body?.models || []).some((mm) => mm.id === "z-ai/glm-5.3-flash" && mm.price?.input === 0.075 && Number.isFinite(mm.benchmark)));

    const put = await call(P, "PUT", "/api/settings/routing", { body: { squad: "dev", lead: "z-ai/glm-5.2" } });
    const devPut = put.body?.rows?.find((row) => row.squad === "dev");
    check("int routing PUT -> settings source + price",
      put.status === 200 && devPut?.lead === "z-ai/glm-5.2" && devPut?.source === "settings"
      && devPut?.price?.input === 1.4, JSON.stringify(devPut));
    check("int routing PUT persisted in the overlay",
      JSON.parse(readText(join(dir, "config", "settings.json")))?.routing?.dev?.lead === "z-ai/glm-5.2");
    const back = await call(P, "PUT", "/api/settings/routing", { body: { squad: "dev", lead: null } });
    const devBack = back.body?.rows?.find((row) => row.squad === "dev");
    check("int routing PUT null -> back to models.json",
      back.status === 200 && devBack?.source === "models.json" && devBack?.lead === "z-ai/glm-5.3-flash");
    const bad = await call(P, "PUT", "/api/settings/routing", { body: { squad: "nosuch", lead: "m" } });
    check("int routing PUT unknown squad -> 400", bad.status === 400);
  }

  // provider: custom switch needs a stored key; the failing check leaves
  // settings untouched; then the real switch
  {
    const noKey = await call(P, "PUT", "/api/settings/provider", { body: {
      active: "custom",
      custom: { baseUrl: CHECKS_URL, authStyle: "token", keyName: "PROVIDER_API_KEY",
        tiers: { smallFast: "prov/m-tiny" }, defaultModel: "prov/m-tiny" },
    } });
    check("int provider PUT custom without key -> 400 provider-check-failed",
      noKey.status === 400 && noKey.body?.error === "provider-check-failed", noKey.raw.slice(0, 200));
    check("int provider PUT custom without key left settings untouched",
      !exists(join(dir, "config", "settings.json"))
      || JSON.parse(readText(join(dir, "config", "settings.json")))?.provider?.active !== "custom");

    // The optional key candidate: rejected leaves settings + secrets
    // untouched; the accepted one sets the provider up fresh — no prior
    // PUT /keys needed.
    const customBody = {
      active: "custom",
      custom: { baseUrl: CHECKS_URL, authStyle: "token", keyName: "PROVIDER_API_KEY",
        tiers: { smallFast: "prov/m-tiny" }, defaultModel: "prov/m-tiny" },
    };
    const settingsBefore = readText(join(dir, "config", "settings.json"));
    const candBad = await call(P, "PUT", "/api/settings/provider", { body: { ...customBody, key: { value: BAD_PROV } } });
    check("int provider PUT candidate bad -> 400 provider-check-failed",
      candBad.status === 400 && candBad.body?.error === "provider-check-failed", candBad.raw.slice(0, 200));
    check("int provider PUT candidate bad left settings untouched",
      readText(join(dir, "config", "settings.json")) === settingsBefore);
    check("int provider PUT candidate bad wrote no key file", !exists(join(secrets, "provider_api_key")));
    check("int provider PUT candidate bad: no canary in response", !candBad.raw.includes(BAD_PROV));

    const candGood = await call(P, "PUT", "/api/settings/provider", { body: { ...customBody, key: { value: GOOD_PROV } } });
    check("int provider PUT candidate good -> 200 custom",
      candGood.status === 200 && candGood.body?.active === "custom" && candGood.body?.check?.ok === true,
      candGood.raw.slice(0, 300));
    check("int provider PUT candidate good file content", readText(join(secrets, "provider_api_key")) === GOOD_PROV);
    check("int provider PUT candidate good: no canary in response", !candGood.raw.includes(GOOD_PROV));
    const storedCand = JSON.parse(readText(join(dir, "config", "settings.json")));
    check("int provider PUT candidate persisted", storedCand?.provider?.active === "custom");

    const rejected = await call(P, "PUT", "/api/settings/keys/provider_api_key", { body: { value: BAD_PROV } });
    check("int provider key bad -> 400", rejected.status === 400 && rejected.body?.error === "key-rejected");
    const saved = await call(P, "PUT", "/api/settings/keys/provider_api_key", { body: { value: GOOD_PROV } });
    check("int provider key good -> 200", saved.status === 200 && saved.body?.saved === true, saved.raw.slice(0, 200));
    check("int provider key file content", readText(join(secrets, "provider_api_key")) === GOOD_PROV);

    const switched = await call(P, "PUT", "/api/settings/provider", { body: {
      active: "custom",
      custom: { baseUrl: CHECKS_URL, authStyle: "token", keyName: "PROVIDER_API_KEY",
        tiers: { smallFast: "prov/m-tiny" }, defaultModel: "prov/m-tiny" },
    } });
    check("int provider PUT custom -> 200", switched.status === 200 && switched.body?.active === "custom"
      && switched.body?.custom?.baseUrl === CHECKS_URL, switched.raw.slice(0, 300));
    const stored = JSON.parse(readText(join(dir, "config", "settings.json")));
    check("int provider switch persisted", stored?.provider?.active === "custom"
      && stored?.provider?.custom?.keyName === "PROVIDER_API_KEY");
    const g2 = await call(P, "GET", "/api/settings/provider");
    check("int provider GET reflects the overlay", g2.body?.active === "custom" && g2.body?.source === "settings");

    const test = await call(P, "POST", "/api/settings/provider/test", { body: { active: "openrouter" } });
    check("int provider/test ok", test.status === 200 && test.body?.check?.ok === true, test.raw.slice(0, 200));
  }

  // repos: local bare clone, polling, mapping, unmap
  {
    const refused = await call(P, "POST", "/api/settings/repos", { body: { url: "http://example.com/x/y" } });
    check("int repos POST bad URL -> 400", refused.status === 400 && typeof refused.body?.error === "string");

    const started = await call(P, "POST", "/api/settings/repos", { body: { url: BARE_URL, project: "FEN" } });
    check("int repos POST -> 202 jobId", started.status === 202 && typeof started.body?.jobId === "string",
      started.raw.slice(0, 200));
    const jobPath = `/api/settings/repos/jobs/${started.body.jobId}`;
    const done = await pollUntil(P, jobPath, (j) => j.status === "done" || j.status === "error");
    check("int clone job done", done.body?.status === "done", JSON.stringify(done.body));
    const missing = await call(P, "GET", "/api/settings/repos/jobs/no-such-job");
    check("int clone job unknown -> 404", missing.status === 404);

    const listing = await call(P, "GET", "/api/settings/repos");
    check("int repos GET shape", listing.status === 200 && typeof listing.body?.root === "string"
      && Array.isArray(listing.body?.repos) && Array.isArray(listing.body?.jobs), listing.raw.slice(0, 200));
    const row = (listing.body?.repos || []).find((r) => r.name === "seedrepo");
    check("int repos GET clone row", row && row.project === "FEN" && typeof row.branch === "string"
      && row.index === "missing" && row.worktrees === 0, JSON.stringify(row));

    check("int first mapped clone creates the missing user projects file", exists(join(dir, "projects.json")) && JSON.parse(readText(join(dir, "projects.json"))).projects.some(p => p.repo?.endsWith("/seedrepo")));
    check("int first mapped clone does not write curated config", readFileSync(new URL("../config/projects.json", import.meta.url), "utf8") === curatedMapBefore);
    const unmapped = await call(P, "DELETE", "/api/settings/repos/seedrepo/mapping");
    check("int repos DELETE mapping -> removed", unmapped.status === 200
      && JSON.stringify(unmapped.body?.removed) === JSON.stringify(["FEN"]), unmapped.raw.slice(0, 200));
    const listing2 = await call(P, "GET", "/api/settings/repos");
    const row2 = (listing2.body?.repos || []).find((r) => r.name === "seedrepo");
    check("int repos GET after unmap", row2?.project === null, JSON.stringify(row2));
  }

  // retention
  {
    const r = await call(P, "GET", "/api/settings/retention");
    check("int retention GET -> 200 shape", r.status === 200 && typeof r.body?.policy === "string"
      && r.body?.managedBy === "FOC-780" && typeof r.body?.computedAt === "string"
      && typeof r.body?.usage?.transcriptsBytes === "number"
      && typeof r.body?.usage?.telemetryBytes === "number"
      && typeof r.body?.usage?.workspacesBytes === "number"
      && typeof r.body?.usage?.stateBytes === "number"
      && Array.isArray(r.body?.partial), r.raw.slice(0, 300));
  }

  // agent-tools: read-only GET over the effective root (FOC-906)
  {
    const r = await call(P, "GET", "/api/settings/agent-tools");
    check("int agent-tools GET -> 200 with the effective root",
      r.status === 200 && r.body?.root === join(dir, "agents"), r.raw.slice(0, 200));
    const a = (r.body?.agents || []).find((x) => x.agent === "agent-a");
    check("int agent-tools GET healthy row",
      a?.permissions?.allow?.includes("Read") && a?.permissions?.deny?.includes("Bash(git push:*)")
      && Array.isArray(a?.mcp) && Array.isArray(a?.skills) && typeof a?.settingsPath === "string",
      JSON.stringify(a).slice(0, 200));
    const broken = (r.body?.agents || []).find((x) => x.agent === "agent-broken");
    check("int agent-tools GET broken row -> error, still 200",
      r.status === 200 && typeof broken?.error === "string" && broken?.permissions === undefined,
      JSON.stringify(broken));
    check("int agent-tools GET check summary", typeof r.body?.check?.summary?.errors === "number"
      && Array.isArray(r.body?.check?.findings));
    const wrong = await call(P, "PUT", "/api/settings/agent-tools");
    check("int agent-tools PUT -> 405", wrong.status === 405);
  }

  {
    const nope = await call(P, "GET", "/api/settings/definitely-not");
    check("int unmatched settings path -> 404", nope.status === 404);
  }

  // LEAK CHECK: the canaries must be absent from the server's captured
  // stdout and stderr.
  for (const c of ALL_CANARIES) {
    check(`int leak grep stdout ${c.slice(0, 12)}…`, !child.stdoutBuf.includes(c));
    check(`int leak grep stderr ${c.slice(0, 12)}…`, !child.stderrBuf.includes(c));
  }
} catch (err) {
  failed++;
  failures.push(`integration crashed — ${err?.stack || err}`);
} finally {
  if (child) { try { child.kill(); } catch {} }
  fakeChecks.close();
}

// ── report ───────────────────────────────────────────────────────────────────

try {
  rmSync(unitDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
} catch { /* Windows file locks — the tmp dirs are disposable */ }

console.log(`\nsettings-routes: ${passed} passed, ${failed} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);

process.exit(failed ? 1 : 0);

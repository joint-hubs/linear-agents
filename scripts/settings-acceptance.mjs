#!/usr/bin/env node
/**
 * scripts/settings-acceptance.mjs — deterministic acceptance harness for the
 * Settings package (FOC-773/778/786; plan: docs/plans/fenix-settings-keys.md,
 * "Verification"). One runnable script, zero npm deps, no test-lane entry.
 *
 * WHAT IT PROVES (canary keys only — every value is a dummy canary, never a
 * real credential, and the mock provider NEVER serves a real model):
 *   1. a rejected key is refused with a reason and NOTHING is written;
 *   2. an accepted key is written IN PLACE (content replaced, inode kept,
 *      mode 0600 on POSIX) and `present` flips in GET /api/settings/keys;
 *   3. the provider switches to a custom Anthropic-compatible endpoint (the
 *      local mock) with no code or launcher edit, plus the routing setting
 *      round-trip (settings source, null -> back to models.json);
 *   4. the repositories API honors its URL validation and clones a LOCAL
 *      bare fixture (file:// + FENIX_REPOS_ALLOW_LOCAL=1), then unmaps;
 *   5. GET /api/settings/retention answers the documented shape;
 *   6. leak surfaces: no canary in any HTTP response, in the API server's
 *      stdout/stderr (local mode) or any --scan-dir tree. The full Docker
 *      surfaces (docker inspect / compose logs / in-container grep) are a
 *      printed MANUAL step for scripts/key-leak-check.mjs.
 *
 * MODES
 *   node scripts/settings-acceptance.mjs local [--keep] [--project FEN]
 *       Fully self-contained: spawns the REAL telemetry-server.mjs as a child
 *       with isolated env seams under one tmp dir (secrets, settings overlay,
 *       data home, sqlite db), starts the mock, creates a local bare git
 *       fixture, runs every check, kills the child, cleans up.
 *
 *   node scripts/settings-acceptance.mjs run --base-url http://127.0.0.1:7331 \
 *        [--checks-url URL] [--no-mock] [--mock-host H] [--secrets-dir PATH]
 *        [--settings-file PATH] [--repos-fixture-url URL] [--scan-dir PATH]...
 *        [--project FEN]
 *       Runs against an ALREADY RUNNING Fenix API (the isolated Docker stack
 *       the caller prepared). File-level assertions run only when the HOST
 *       path of a bind mount is passed (--secrets-dir, --settings-file).
 *
 *   node scripts/settings-acceptance.mjs mock [--host H] [--port P]
 *       Only the mock provider/Linear/GitHub server, foreground — for a
 *       caller that starts the stack itself. Prints the bound URL, blocks.
 *
 * ISOLATION CONTRACT (run mode) — the caller MUST start the API process with
 * the mock seams, otherwise the harness REFUSES to touch keys (preflight P3):
 *   LA_PROVIDER_BASEURL_OPENROUTER = <mock URL>      (redirects provider checks)
 *   LA_LINEAR_CHECK_URL            = <mock URL>/linear
 *   LA_GITHUB_CHECK_URL            = <mock URL>/gh
 *   FENIX_REPOS_ALLOW_LOCAL        = 1               (file:// clone fixture)
 *   LA_SECRETS_DIR                 = /fenix-secrets  (rw mount, per Compose)
 *   LA_SETTINGS_FILE               = /fenix-config/settings.json (rw mount)
 * and for the clone check a mount visible INSIDE the container, passed as
 * --repos-fixture-url file://<path-inside-container>.
 *
 * SAFETY: the preflight reads GET /api/settings/provider and aborts every
 * key/provider check unless the openrouter entry's baseUrl points at a local
 * mock host (127.0.0.1 / localhost / host.docker.internal, same host as
 * --checks-url). Canaries are dummy values, so even a misrouted call cannot
 * spend money — but the gate keeps the run honest, and K2/V5 prove the seams
 * were actually redirected (the mock must have seen the requests).
 * HTTP writes send no Origin header (non-browser clients are allowed by the
 * same-origin guard; from a host into the published container port the
 * remoteAddress is the container gateway, which isLocalOrigin trusts).
 *
 * Exit: 0 all PASS/SKIP, 1 any FAIL, 2 usage.
 */

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { scrubSecret } from "./key-check.mjs";
import { scanDirForCanaries } from "./key-leak-check.mjs";

const POSIX = process.platform !== "win32";

// ---------------------------------------------------------------------------
// Canaries — dummy values ONLY. The mock rejects any credential whose value
// contains "BAD"; everything else is accepted with the minimal shape the
// checks parse.
// ---------------------------------------------------------------------------

const GOOD_OR = "sk-or-v1-CANARYGOOD-accept-0001";
const BAD_OR = "sk-or-v1-CANARYBAD-reject-0002";
const GOOD_PROV = "sk-ant-CANARYGOOD-prov-0003";
const BAD_PROV = "sk-ant-CANARYBAD-prov-0004";
const GOOD_LIN = "lin_api_CANARY-accept-0005";
const GOOD_GH = "ghp_CANARYGOODaccept0006";
const ALL_CANARIES = [GOOD_OR, BAD_OR, GOOD_PROV, BAD_PROV, GOOD_LIN, GOOD_GH];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);

/** Scrub every canary (and any key-shaped token) out of a message — the
 *  harness itself must never print a canary value either. */
function scrubAll(text) {
  let out = String(text ?? "");
  for (const c of ALL_CANARIES) out = scrubSecret(out, c);
  return out.split("\n").join(" ").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { flags._.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (flags[name] === undefined) flags[name] = next;
      else if (Array.isArray(flags[name])) flags[name].push(next);
      else flags[name] = [flags[name], next];
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function readText(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function exists(p) {
  try { statSync(p); return true; } catch { return false; }
}

/** Free localhost port (bound and released before the real listener takes it). */
function freePort() {
  return new Promise((res) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
}

// ---------------------------------------------------------------------------
// The mock provider/Linear/GitHub server — the ONLY endpoint the stack's live
// checks may reach. Records every request so the harness can prove a seam was
// actually redirected. Prints nothing (no canary can reach a log line).
// ---------------------------------------------------------------------------

function startMock({ host = "127.0.0.1", port } = {}) {
  const state = { requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const auth = String(req.headers.authorization || req.headers["x-api-key"] || "");
    const bad = auth.includes("BAD");
    state.requests.push({ method: req.method, url: req.url, bad });
    const deny = () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "denied by mock" } }));
    };
    if (req.method === "POST" && req.url === "/v1/messages") {
      if (bad) return deny();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_mock", type: "message", role: "assistant",
        content: [{ type: "text", text: "mock" }],
        model: "mock/small", stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/v1/key")) {
      if (bad) return deny();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { label: "canary", limit: 100, usage: 0 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/linear") {
      if (bad) return deny();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: {
          viewer: { id: "v1", name: "Canary" },
          teams: { nodes: [{ key: "FEN", name: "Fenix" }] },
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/gh") {
      if (bad) return deny();
      res.writeHead(200, { "content-type": "application/json", "x-oauth-scopes": "repo" });
      res.end(JSON.stringify({ login: "canary-user" }));
      return;
    }
    // Control surface: the request log, so a harness run in another process
    // can prove the API's check seams point HERE. No canary values — the log
    // records URLs and whether the credential looked rejected, never values.
    if (req.method === "GET" && req.url === "/_log") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requests: state.requests }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((res) => {
    server.listen(port ?? 0, host, () => {
      const bound = server.address().port;
      res({
        server, port: bound, url: `http://127.0.0.1:${bound}`, state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP client — records every raw response for the canary leak scan. No
// Origin header: the same-origin guard allows non-browser clients.
// ---------------------------------------------------------------------------

function makeClient(baseUrl) {
  const raws = [];
  async function call(method, path, { body, timeoutMs = 20000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      const raw = json === null ? text : JSON.stringify(json);
      raws.push(raw);
      return { status: res.status, body: json, raw };
    } finally {
      clearTimeout(timer);
    }
  }
  return { call, raws };
}

async function pollUntil(call, path, predicate, { ms = 30000, step = 250 } = {}) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await call("GET", path);
    if (last.status === 200 && last.body && predicate(last.body)) return last;
    await sleepMs(step);
  }
  throw new Error(`poll timeout on ${path}: ${scrubAll(JSON.stringify(last?.body))}`);
}

// ---------------------------------------------------------------------------
// Check ledger — a check body either returns a note (PASS), throws an Error
// with .skip (SKIP) or throws plain (FAIL). All detail text is scrubbed.
// ---------------------------------------------------------------------------

const results = [];
function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail: scrubAll(detail) });
}
const canaryFree = (text) => ALL_CANARIES.every((c) => !text.includes(c));

async function step(id, name, fn) {
  try {
    const note = await fn();
    record(id, name, "PASS", typeof note === "string" ? note : "");
    return true;
  } catch (err) {
    if (err?.skip) { record(id, name, "SKIP", String(err.message)); return true; }
    record(id, name, "FAIL", String(err?.message || err));
    return false;
  }
}

/** Return (throw) from a check body to record a SKIP with a reason. */
function skipNote(reason) {
  const err = new Error(reason);
  err.skip = true;
  throw err;
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// The check sequence — shared by both modes. `io` carries the seams:
//   call / raws     HTTP client against the API under test (+ leak surface)
//   secretsDir      HOST path of the secrets mount (null -> file checks SKIP)
//   settingsFile    HOST path of the overlay mount (null -> API-level only)
//   checksUrl       the mock URL AS THE API PROCESS SEES IT
//   fixtureUrl/Name local bare-repo URL as the API process sees it (null -> SKIP)
//   project         Linear project key used for the clone mapping
//   scanDirs        extra host dirs scanned for canaries (must be clean)
//   child           spawned server (local mode) -> stdout/stderr leak grep
//   mockLog         async () -> mock request log ([] entries {url,bad}), or
//                   null when no log exists (weak gate only)
// ---------------------------------------------------------------------------

async function runChecks(io) {
  const { call, raws } = io;
  const orFile = io.secretsDir ? join(io.secretsDir, "openrouter_api_key") : null;

  // ── P: preflight ──────────────────────────────────────────────────────────
  let initialProvider = null;

  await step("P1", "health endpoint answers", async () => {
    const r = await call("GET", "/api/telemetry/health");
    expect(r.status === 200, `expected 200, got ${r.status}`);
    return "status 200";
  });

  await step("P2", "GET /api/settings/keys shape + writable", async () => {
    const r = await call("GET", "/api/settings/keys");
    expect(r.status === 200, `expected 200, got ${r.status}`);
    expect(Array.isArray(r.body?.keys), "keys is not an array");
    const names = r.body.keys.map((k) => k.name).sort();
    expect(
      JSON.stringify(names) === JSON.stringify(["github_token", "linear_api_key", "openrouter_api_key", "provider_api_key"]),
      `unexpected allow-list: ${names.join(", ")}`,
    );
    expect(typeof r.body?.note === "string" && r.body.note.includes("Supervisor"), "note missing");
    expect(canaryFree(r.raw), "canary in the keys response");
    io.writable = r.body?.writable === true;
    if (!io.writable) {
      skipNote("secrets NOT writable — every key-write check will SKIP until the stack mounts .fenix/secrets rw into fenix-api");
    }
    return `${r.body.keys.length} keys, writable`;
  });
  const needWritable = () => {
    if (!io.writable) skipNote("secrets not writable (P2) — key-write checks skipped");
  };

  await step("P3", "safety probe: a refused canary proves the provider seam is redirected", async () => {
    io.seamsProven = false; // guilty until proven redirected
    const r0 = await call("GET", "/api/settings/provider");
    expect(r0.status === 200, `expected 200, got ${r0.status}`);
    initialProvider = r0.body;
    const or = (r0.body?.providers || []).find((p) => p.name === "openrouter");
    let checksHost;
    try { checksHost = new URL(io.checksUrl).hostname; } catch { checksHost = "(unparsable)"; }
    expect(
      LOCAL_HOSTS.has(checksHost),
      `--checks-url host ${checksHost} is not 127.0.0.1/localhost/host.docker.internal — ` +
      "the overlay refuses http to any other host, so the provider switch could not be tested either.",
    );
    io.seamsProven = false;
    const mockLog = io.mockLog ? await io.mockLog() : null;
    if (!mockLog) {
      // No request log to prove the redirect behaviorally. NOTE: the provider
      // PAYLOAD shows the config baseUrl — the LA_PROVIDER_BASEURL_* override
      // is applied at check time, not in the payload — so this payload check
      // is only a weak gate; the caller took that responsibility with
      // --no-mock (or a mock without /_log). Canaries are dummy values anyway.
      expect(or?.baseUrl, "openrouter entry has no baseUrl");
      let host;
      try { host = new URL(or.baseUrl).hostname; } catch { host = "(unparsable)"; }
      expect(
        LOCAL_HOSTS.has(host),
        `openrouter baseUrl ${or.baseUrl} is not a mock host and no mock log (/_log) proves the redirect — refusing key/provider checks (run 'mock' mode and pass --checks-url)`,
      );
      io.seamsProven = true;
      return "WEAK gate: payload URL is a mock host, redirect not proven (canaries are dummies)";
    }
    // The refusal path writes nothing, so a refused canary is safe to send
    // FIRST. The mock MUST have seen it — otherwise the check reached a real
    // endpoint and the isolation contract is broken: refuse everything after.
    const before = await call("GET", "/api/settings/keys");
    const initialPresent = before.body?.keys?.find((k) => k.name === "openrouter_api_key")?.present ?? null;
    const r = await call("PUT", "/api/settings/keys/openrouter_api_key", { body: { value: BAD_OR } });
    expect(r.status === 400 && r.body?.error === "key-rejected",
      `probe: expected 400 key-rejected, got ${r.status}: ${r.raw.slice(0, 200)}`);
    // Re-fetch AFTER the probe — the pre-gate snapshot above predates it.
    const postLog = (await io.mockLog()) || [];
    const hits = postLog.filter((q) => q.url === "/v1/messages");
    expect(hits.length > 0,
      "the provider check did NOT reach this mock — the API process's seam (LA_PROVIDER_BASEURL_OPENROUTER) does not point here; refusing key/provider checks");
    expect(hits.some((q) => q.bad), "the mock never saw the BAD canary");
    if (orFile && exists(orFile)) {
      expect(readText(orFile) !== BAD_OR, "rejected key reached the secrets file");
    }
    const after = await call("GET", "/api/settings/keys");
    const present = after.body?.keys?.find((k) => k.name === "openrouter_api_key")?.present;
    expect(present === initialPresent, `present changed on refusal (${initialPresent} -> ${present})`);
    io.seamsProven = true;
    return "refused canary + mock hit → seams proven, state unchanged";
  });
  const needSeams = () => {
    if (io.seamsProven === false) skipNote("isolation not proven (P3) — refusing to send candidate keys anywhere");
  };

  // ── K: keys ───────────────────────────────────────────────────────────────

  await step("K1", "accepted key -> 200 saved", async () => {
    needWritable();
    needSeams();
    if (orFile && !exists(orFile)) writeFileSync(orFile, "seed-placeholder", "utf8");
    io.orInodeBefore = orFile ? statSync(orFile).ino : null;
    const r = await call("PUT", "/api/settings/keys/openrouter_api_key", { body: { value: GOOD_OR } });
    expect(r.status === 200, `expected 200, got ${r.status}: ${r.raw.slice(0, 200)}`);
    expect(r.body?.saved === true, "saved is not true");
    expect(canaryFree(r.raw), "canary in the save response");
    return "200 saved";
  });

  await step("K2", "secret file written IN PLACE (content, inode, mode)", async () => {
    if (!io.writable) skipNote("K1 skipped — nothing was written");
    needSeams();
    if (!orFile) skipNote("--secrets-dir not given — file-level assertions are not possible from outside the container");
    expect(readText(orFile) === GOOD_OR, "file content is not the accepted canary");
    const st = statSync(orFile);
    if (POSIX) {
      expect((st.mode & 0o777) === 0o600, `mode is ${(st.mode & 0o777).toString(8)}, expected 600`);
      expect(st.ino === io.orInodeBefore, `inode changed (${io.orInodeBefore} -> ${st.ino}) — the write was not in place`);
      return "content + inode preserved + mode 0600";
    }
    if (io.orInodeBefore && st.ino) {
      expect(st.ino === io.orInodeBefore, `file index changed (${io.orInodeBefore} -> ${st.ino})`);
      return "content + file index preserved";
    }
    skipNote("inode not comparable on this filesystem");
  });

  await step("K3", "GET keys reflects the saved key (present, lastCheck, no value)", async () => {
    needSeams();
    const r = await call("GET", "/api/settings/keys");
    const or = r.body?.keys?.find((k) => k.name === "openrouter_api_key");
    expect(or?.present === true, "present is not true after save");
    expect(or?.lastCheck?.ok === true, `lastCheck not ok: ${JSON.stringify(or?.lastCheck)}`);
    expect(canaryFree(r.raw), "canary in the keys response after save");
    return "present=true, lastCheck ok, no value in the payload";
  });

  await step("K4", "Linear key saved + validate honors the team filter", async () => {
    needWritable();
    needSeams();
    const put = await call("PUT", "/api/settings/keys/linear_api_key", { body: { value: GOOD_LIN } });
    expect(put.status === 200, `PUT linear expected 200, got ${put.status}: ${put.raw.slice(0, 200)}`);
    const linLog = io.mockLog ? await io.mockLog() : null;
    if (linLog) {
      expect(linLog.some((q) => q.url === "/linear"),
        "no /linear request reached the mock — LA_LINEAR_CHECK_URL is missing on the API process");
    }
    const ok = await call("POST", "/api/settings/keys/linear_api_key/validate", { body: { teamKey: "FEN" } });
    expect(ok.status === 200 && ok.body?.check?.ok === true, `team FEN should pass: ${ok.raw.slice(0, 200)}`);
    const nope = await call("POST", "/api/settings/keys/linear_api_key/validate", { body: { teamKey: "NOPE" } });
    expect(nope.status === 200 && nope.body?.check?.ok === false, "an unknown team must not pass");
    expect(/not visible/.test(nope.body?.check?.reason || ""), `reason not actionable: ${nope.body?.check?.reason}`);
    expect(canaryFree(put.raw + ok.raw + nope.raw), "canary in a Linear response");
    return "validate ok for FEN, refused for NOPE";
  });

  await step("K5", "GitHub token saved via the mock /gh surface", async () => {
    needWritable();
    needSeams();
    const put = await call("PUT", "/api/settings/keys/github_token", { body: { value: GOOD_GH } });
    expect(put.status === 200, `expected 200, got ${put.status}: ${put.raw.slice(0, 200)}`);
    const ghLog = io.mockLog ? await io.mockLog() : null;
    if (ghLog) {
      expect(ghLog.some((q) => q.url === "/gh"),
        "no /gh request reached the mock — LA_GITHUB_CHECK_URL is missing on the API process");
    }
    expect(canaryFree(put.raw), "canary in the GitHub response");
    return "token accepted via the mock";
  });

  // ── V: provider ───────────────────────────────────────────────────────────

  await step("V1", "GET provider shape (providers, custom, effectiveOn)", async () => {
    const r = await call("GET", "/api/settings/provider");
    expect(r.status === 200, `expected 200, got ${r.status}`);
    expect(Array.isArray(r.body?.providers) && r.body.providers.length > 0, "providers list empty");
    expect(typeof r.body?.active === "string", "active missing");
    expect(typeof r.body?.effectiveOn === "string" && r.body.effectiveOn.includes("child"), "effectiveOn note missing");
    expect(canaryFree(r.raw), "canary in the provider response");
    return `active=${r.body.active} source=${r.body.source}`;
  });

  await step("V2", "PUT provider unknown name -> 400 invalid", async () => {
    const r = await call("PUT", "/api/settings/provider", { body: { active: "no_such_provider" } });
    expect(r.status === 400 && r.body?.error === "invalid", `expected 400 invalid, got ${r.raw.slice(0, 200)}`);
    return "refused";
  });

  const customBlock = () => ({
    baseUrl: io.checksUrl,
    authStyle: "token",
    keyName: "PROVIDER_API_KEY",
    tiers: { smallFast: "mock/small" },
    defaultModel: "mock/small",
  });

  await step("V3", "PUT custom WITHOUT a stored key -> 400 provider-check-failed, overlay untouched", async () => {
    needSeams();
    const keys = await call("GET", "/api/settings/keys");
    const present = keys.body?.keys?.find((k) => k.name === "provider_api_key")?.present;
    if (present) skipNote("provider key already stored (re-run?) — the no-key refusal path is not reachable");
    const r = await call("PUT", "/api/settings/provider", { body: { active: "custom", custom: customBlock() } });
    expect(r.status === 400, `expected 400, got ${r.status}`);
    expect(r.body?.error === "provider-check-failed", `error=${r.body?.error}`);
    expect(/no key stored/.test(r.body?.check?.reason || ""), `reason: ${r.body?.check?.reason}`);
    if (io.settingsFile && exists(io.settingsFile)) {
      const overlay = JSON.parse(readText(io.settingsFile));
      expect(overlay?.provider?.active !== "custom", "overlay switched despite the failed check");
    }
    return "switch refused before any write";
  });

  await step("K6", "provider_api_key: bad refused, good saved", async () => {
    needWritable();
    needSeams();
    const bad = await call("PUT", "/api/settings/keys/provider_api_key", { body: { value: BAD_PROV } });
    expect(bad.status === 400 && bad.body?.error === "key-rejected", `bad provider key: ${bad.raw.slice(0, 200)}`);
    const good = await call("PUT", "/api/settings/keys/provider_api_key", { body: { value: GOOD_PROV } });
    expect(good.status === 200 && good.body?.saved === true, `good provider key: ${good.raw.slice(0, 200)}`);
    if (io.secretsDir) {
      expect(readText(join(io.secretsDir, "provider_api_key")) === GOOD_PROV, "provider secret file content mismatch");
    }
    expect(canaryFree(bad.raw + good.raw), "canary in a provider-key response");
    return "bad refused, good saved";
  });

  await step("V4", "PUT provider custom -> 200; GET reflects the switch (settings source)", async () => {
    needSeams();
    const r = await call("PUT", "/api/settings/provider", { body: { active: "custom", custom: customBlock() } });
    expect(r.status === 200, `expected 200, got ${r.status}: ${r.raw.slice(0, 250)}`);
    expect(r.body?.active === "custom" && r.body?.check?.ok === true, `body: ${r.raw.slice(0, 250)}`);
    const g = await call("GET", "/api/settings/provider");
    expect(g.body?.active === "custom" && g.body?.source === "settings", `GET: ${g.raw.slice(0, 250)}`);
    expect(g.body?.custom?.baseUrl === io.checksUrl, "custom baseUrl not stored");
    if (io.settingsFile && exists(io.settingsFile)) {
      const overlay = JSON.parse(readText(io.settingsFile));
      expect(overlay?.provider?.active === "custom" && overlay?.provider?.custom?.keyName === "PROVIDER_API_KEY",
        "overlay not persisted");
    }
    return "provider switched to the mock endpoint with no code or launcher edit";
  });

  await step("V5", "POST /api/settings/provider/test with the stored openrouter key", async () => {
    needSeams();
    const r = await call("POST", "/api/settings/provider/test", { body: { active: "openrouter" } });
    expect(r.status === 200 && typeof r.body?.check?.ok === "boolean", `unexpected: ${r.raw.slice(0, 200)}`);
    expect(r.body?.check?.ok === true, `check failed: ${r.body?.check?.reason}`);
    return "test ok via the mock";
  });

  // ── R: routing ────────────────────────────────────────────────────────────

  let routingSquad = null;
  let routingOriginal = null;

  await step("R1", "GET routing shape (rows, models, provider=custom)", async () => {
    if (io.seamsProven === false) skipNote("the provider switch did not run (P3) — cascade");
    const r = await call("GET", "/api/settings/routing");
    expect(r.status === 200, `expected 200, got ${r.status}`);
    expect(r.body?.provider === "custom", `provider=${r.body?.provider} (the custom switch should be active)`);
    expect(Array.isArray(r.body?.rows) && r.body.rows.length > 0, "rows empty");
    expect(r.body.rows.every((row) => typeof row.squad === "string"
      && (row.source === null || typeof row.source === "string")
      && typeof row.unpriced === "boolean"), "row shape broken");
    expect(Array.isArray(r.body?.models), "models not an array");
    routingSquad = (r.body.rows.find((row) => row.squad === "dev")
      || r.body.rows.find((row) => row.squad !== "supervisor"))?.squad;
    routingOriginal = r.body.rows.find((row) => row.squad === routingSquad) || null;
    expect(routingSquad, "no routable squad found");
    expect(canaryFree(r.raw), "canary in the routing response");
    return `provider=custom, ${r.body.rows.length} rows, squad under test: ${routingSquad}`;
  });

  await step("R2", "PUT routing lead (unpriced model) -> source settings", async () => {
    if (!routingSquad) skipNote("routing GET failed — cascade");
    const r = await call("PUT", "/api/settings/routing", { body: { squad: routingSquad, lead: "mock/unrouted-canary" } });
    expect(r.status === 200, `expected 200, got ${r.status}: ${r.raw.slice(0, 250)}`);
    const row = r.body?.rows?.find((x) => x.squad === routingSquad);
    expect(row?.lead === "mock/unrouted-canary" && row?.source === "settings", `row: ${JSON.stringify(row)}`);
    expect(row?.unpriced === true && row?.price === null, "an unknown model must be allowed but labelled unpriced");
    if (io.settingsFile && exists(io.settingsFile)) {
      const overlay = JSON.parse(readText(io.settingsFile));
      expect(overlay?.routing?.[routingSquad]?.lead === "mock/unrouted-canary", "routing not persisted in the overlay");
    }
    return "routing change persisted";
  });

  await step("R3", "PUT routing unknown squad -> 400", async () => {
    if (!routingSquad) skipNote("routing GET failed — cascade");
    const r = await call("PUT", "/api/settings/routing", { body: { squad: "no_such_squad", lead: "m" } });
    expect(r.status === 400 && r.body?.error === "unknown squad", `got ${r.raw.slice(0, 150)}`);
    return "refused";
  });

  await step("R4", "routing restored to its pre-run source", async () => {
    if (!routingSquad || !routingOriginal) skipNote("routing GET failed — cascade");
    const wasSettings = routingOriginal.source === "settings";
    const body = wasSettings
      ? { squad: routingSquad, lead: routingOriginal.lead }
      : { squad: routingSquad, lead: null };
    const r = await call("PUT", "/api/settings/routing", { body });
    expect(r.status === 200, `restore failed: ${r.raw.slice(0, 200)}`);
    const row = r.body?.rows?.find((x) => x.squad === routingSquad);
    expect(row?.lead === routingOriginal.lead, `lead ${row?.lead} != original ${routingOriginal.lead}`);
    return wasSettings ? "original settings lead restored" : "overlay entry removed (models.json again)";
  });

  // ── C: repositories ───────────────────────────────────────────────────────

  await step("C1", "POST repos bad URL -> 400 (API validation honored)", async () => {
    const r = await call("POST", "/api/settings/repos", { body: { url: "http://example.com/x/y" } });
    expect(r.status === 400 && typeof r.body?.error === "string", `got ${r.status}: ${r.raw.slice(0, 150)}`);
    return "non-github/non-local URL refused";
  });

  await step("C2", "clone from the local bare fixture -> job done -> listed -> unmapped", async () => {
    if (!io.fixtureUrl) {
      skipNote("no --repos-fixture-url (and not local mode) — a bare fixture the API process can read is required");
    }
    const started = await call("POST", "/api/settings/repos", { body: { url: io.fixtureUrl, project: io.project } });
    expect(started.status === 202,
      `fixture clone refused (${started.status}: ${started.raw.slice(0, 200)}) — is FENIX_REPOS_ALLOW_LOCAL=1 set on the API process?`);
    const jobPath = `/api/settings/repos/jobs/${started.body?.jobId}`;
    const done = await pollUntil(call, jobPath, (j) => j.status === "done" || j.status === "error");
    expect(done.body?.status === "done", `clone job failed: ${scrubAll(JSON.stringify(done.body)).slice(0, 300)}`);
    const listing = await call("GET", "/api/settings/repos");
    expect(listing.status === 200 && Array.isArray(listing.body?.repos), "repos listing broken");
    const row = listing.body.repos.find((r) => r.name === io.fixtureName);
    expect(row, `cloned repo ${io.fixtureName} not listed`);
    expect(row?.project === io.project, `mapping: ${JSON.stringify(row)}`);
    const unmapped = await call("DELETE", `/api/settings/repos/${encodeURIComponent(io.fixtureName)}/mapping`);
    expect(unmapped.status === 200 && JSON.stringify(unmapped.body?.removed) === JSON.stringify([io.project]),
      `unmap: ${unmapped.raw.slice(0, 200)}`);
    const after = await call("GET", "/api/settings/repos");
    const row2 = after.body?.repos?.find((r) => r.name === io.fixtureName);
    expect(row2?.project === null, "mapping survived the unmap");
    return `cloned ${io.fixtureName} from a bare fixture, mapped ${io.project}, unmapped`;
  });

  // ── T: retention ──────────────────────────────────────────────────────────

  await step("T1", "GET retention shape", async () => {
    const r = await call("GET", "/api/settings/retention");
    expect(r.status === 200, `expected 200, got ${r.status}`);
    expect(typeof r.body?.policy === "string", "policy missing");
    expect(r.body?.managedBy === "FOC-780", `managedBy=${r.body?.managedBy}`);
    expect(typeof r.body?.computedAt === "string", "computedAt missing");
    for (const field of ["transcriptsBytes", "telemetryBytes", "workspacesBytes", "stateBytes"]) {
      expect(typeof r.body?.usage?.[field] === "number", `usage.${field} missing`);
    }
    expect(Array.isArray(r.body?.partial), "partial not an array");
    return `policy=${r.body.policy}`;
  });

  // ── V6: provider restore ──────────────────────────────────────────────────

  await step("V6", "provider restored to its pre-run state", async () => {
    needSeams();
    if (!initialProvider) skipNote("no preflight snapshot");
    if (initialProvider.source === "env") {
      skipNote(`active came from LA_PROVIDER=${initialProvider.active} — the overlay stays switched; rebuild the stack instead`);
    }
    const body = initialProvider.source === "settings" && initialProvider.active === "custom" && initialProvider.custom
      ? { active: "custom", custom: initialProvider.custom }
      : { active: initialProvider.active || "openrouter" };
    const r = await call("PUT", "/api/settings/provider", { body });
    expect(r.status === 200, `restore PUT failed: ${r.raw.slice(0, 200)}`);
    const g = await call("GET", "/api/settings/provider");
    expect(g.body?.active === body.active, `restored active ${g.body?.active}`);
    return `active=${body.active}`;
  });

  // ── L: leak surfaces ──────────────────────────────────────────────────────

  await step("L1", "no canary in ANY HTTP response of this run", async () => {
    const hits = raws.filter((raw) => !canaryFree(raw));
    expect(hits.length === 0, `${hits.length} response(s) carried a canary`);
    return `${raws.length} responses scanned`;
  });

  if (io.child) {
    await step("L2", "no canary in the API server's stdout/stderr", async () => {
      const out = io.child.stdoutBuf + io.child.stderrBuf;
      expect(canaryFree(out), "canary in the server's own output");
      return `${out.length} bytes of server output scanned`;
    });
  }

  for (const dir of io.scanDirs) {
    await step(`L3:${dir}`, `host scan clean: ${dir}`, async () => {
      const found = scanDirForCanaries(dir, ALL_CANARIES);
      expect(found.length === 0,
        `${found.length} file(s) contain a canary: ${found.slice(0, 3).map((f) => f.slice(dir.length + 1)).join(", ")}`);
      return "clean";
    });
  }
}

// ---------------------------------------------------------------------------
// Canary files — one value per file, written OUTSIDE the tracked source (tmp),
// for the manual key-leak-check run. The values are dummies.
// ---------------------------------------------------------------------------

let canaryFilesDir = null;
function writeCanaryFiles() {
  if (canaryFilesDir) return canaryFilesDir;
  canaryFilesDir = mkdtempSync(join(tmpdir(), "settings-canaries-"));
  ALL_CANARIES.forEach((c, i) => {
    writeFileSync(join(canaryFilesDir, `canary-${i}.txt`), `${c}\n`, "utf8");
  });
  return canaryFilesDir;
}

// ---------------------------------------------------------------------------
// Local mode — spawn the REAL server with isolated seams under one tmp dir
// (the shape of the settings-routes.test.mjs integration block, as a
// standalone acceptance run).
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function gitRun(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createBareFixture(dir) {
  const seed = join(dir, "seed-src");
  const bare = join(dir, "seedrepo");
  gitRun(dir, "init", seed);
  gitRun(seed, "config", "user.email", "acceptance@example.com");
  gitRun(seed, "config", "user.name", "acceptance");
  writeFileSync(join(seed, "README.md"), "# acceptance seed\n", "utf8");
  gitRun(seed, "add", ".");
  gitRun(seed, "commit", "-m", "seed");
  gitRun(dir, "clone", "--bare", seed, bare);
  return { url: pathToFileURL(bare).href, name: "seedrepo" };
}

async function spawnIsolatedServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(SCRIPTS_DIR, "telemetry-server.mjs")], {
    env: { ...env, TELEMETRY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdoutBuf = "";
  child.stderrBuf = "";
  child.stdout.on("data", (c) => { child.stdoutBuf += c; });
  child.stderr.on("data", (c) => { child.stderrBuf += c; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`telemetry-server exited early (${child.exitCode}):\n${child.stderrBuf.slice(-800)}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
      if (r.ok) return { child, port };
    } catch { /* not up yet */ }
    await sleepMs(150);
  }
  throw new Error("telemetry-server not ready in 20s");
}

async function modeLocal(flags) {
  const dir = mkdtempSync(join(tmpdir(), "settings-acceptance-"));
  const secrets = join(dir, "secrets");
  mkdirSync(secrets, { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "workspaces"), { recursive: true });

  // The central sqlite store is a hard server requirement — create the schema
  // up front, exactly like the route test does.
  const dbPath = join(dir, "telemetry.sqlite");
  const { openTelemetryDb } = await import("./telemetry-store.mjs");
  const { ensureViews } = await import("./telemetry-canonical.mjs");
  const db = openTelemetryDb(dbPath);
  ensureViews(db);
  db.close();

  const mock = await startMock({ host: "127.0.0.1" });
  const fixture = createBareFixture(dir);
  const settingsFile = join(dir, "config", "settings.json");

  const childEnv = {
    ...process.env,
    NODE_ENV: "test",
    LA_SECRETS_DIR: secrets,
    LA_SETTINGS_FILE: settingsFile,
    LA_DATA_HOME: join(dir, "data"),
    LA_PROJECTS_FILE: join(dir, "projects.json"),
    LA_GITHUB_ROOT: join(dir, "workspaces"),
    LA_SQUAD_HOME: join(dir, "agents"),
    LA_SUPERVISOR_STATE_HOME: join(dir, "sup-state"),
    LA_STATE_ROOT: join(dir, "state-root"),
    LA_TELEMETRY_DB: dbPath,
    LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
    // Hermetic provider resolution: no real .env, no LA_PROVIDER — but the
    // openrouter base URL moves to the mock, so a live check can never leave
    // this machine.
    LA_PROVIDER: "",
    LA_PROVIDER_ENV_FILE: join(dir, "missing.env"),
    LA_PROVIDER_BASEURL_OPENROUTER: mock.url,
    LA_LINEAR_CHECK_URL: `${mock.url}/linear`,
    LA_GITHUB_CHECK_URL: `${mock.url}/gh`,
    OPENROUTER_API_KEY: "",
    PROVIDER_API_KEY: "",
    LINEAR_API_KEY: GOOD_LIN,
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    FENIX_REPOS_ALLOW_LOCAL: "1",
  };

  let child = null;
  try {
    const spawned = await spawnIsolatedServer(childEnv);
    child = spawned.child;
    const client = makeClient(`http://127.0.0.1:${spawned.port}`);
    await runChecks({
      call: client.call,
      raws: client.raws,
      secretsDir: secrets,
      settingsFile,
      checksUrl: mock.url,
      fixtureUrl: fixture.url,
      fixtureName: fixture.name,
      project: String(flags.project || "FEN"),
      scanDirs: [].concat(flags["scan-dir"] || []),
      child,
      mockLog: async () => mock.state.requests,
    });
  } finally {
    if (child) { try { child.kill(); } catch { /* already gone */ } }
    await sleepMs(300); // let the child release the sqlite file (Windows)
    await mock.close();
    if (flags.keep === true) {
      console.log(`[keep] artifacts left at ${dir}`);
    } else {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows locks — disposable */ }
    }
  }
}

// ---------------------------------------------------------------------------
// run mode — against an already running (isolated) API
// ---------------------------------------------------------------------------

function repoNameOf(url) {
  const clean = String(url).replace(/\.git\/?$/, "").replace(/\/+$/, "");
  return clean.split(/[\\/]/).pop() || "fixture";
}

async function modeRun(flags) {
  const baseUrl = String(flags["base-url"] || "");
  if (!baseUrl) { usage(); process.exit(2); }

  let mock = null;
  let checksUrl = flags["checks-url"] ? String(flags["checks-url"]) : null;
  if (!flags["no-mock"] && !checksUrl) {
    mock = await startMock({ host: String(flags["mock-host"] || "127.0.0.1") });
    checksUrl = mock.url;
  }
  if (!checksUrl) {
    console.error("run mode needs --checks-url (the mock URL as the API process sees it) or the built-in mock");
    process.exit(2);
  }

  const fixtureUrl = flags["repos-fixture-url"] ? String(flags["repos-fixture-url"]) : null;

  const client = makeClient(baseUrl);
  try {
    await runChecks({
      call: client.call,
      raws: client.raws,
      secretsDir: flags["secrets-dir"] ? resolvePath(String(flags["secrets-dir"])) : null,
      settingsFile: flags["settings-file"] ? resolvePath(String(flags["settings-file"])) : null,
      checksUrl,
      fixtureUrl,
      fixtureName: fixtureUrl ? repoNameOf(fixtureUrl) : null,
      project: String(flags.project || "FEN"),
      scanDirs: [].concat(flags["scan-dir"] || []),
      child: null,
      mockLog: mock
        ? async () => mock.state.requests
        : async () => {
            // The external mock exposes GET /_log (mock mode does); anything
            // else falls back to the weak payload gate.
            try {
              const r = await fetch(new URL("/_log", flags["mock-control-url"] || checksUrl), { signal: AbortSignal.timeout(3000) });
              if (!r.ok) return null;
              const body = await r.json();
              return Array.isArray(body?.requests) ? body.requests : null;
            } catch { return null; }
          },
    });
  } finally {
    if (mock) await mock.close();
  }
}

// ---------------------------------------------------------------------------
// mock mode — serve only, foreground; the caller starts the stack itself
// ---------------------------------------------------------------------------

async function modeMock(flags) {
  const host = String(flags.host || "127.0.0.1");
  const mock = await startMock({ host, port: flags.port ? Number(flags.port) : undefined });
  console.log(`mock provider/Linear/GitHub server on ${host}:${mock.port}`);
  console.log("As the API process sees it (Docker):");
  console.log(`  LA_PROVIDER_BASEURL_OPENROUTER=http://host.docker.internal:${mock.port}`);
  console.log(`  LA_LINEAR_CHECK_URL=http://host.docker.internal:${mock.port}/linear`);
  console.log(`  LA_GITHUB_CHECK_URL=http://host.docker.internal:${mock.port}/gh`);
  console.log('Endpoints: POST /v1/messages | GET /api/v1/key | POST /linear | GET /gh.');
  console.log('GET /_log serves the request log (the harness uses it to prove the seams).');
  console.log('Credentials containing "BAD" get 401, everything else 200. Ctrl-C stops.');
  const stop = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // foreground
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  const self = "node scripts/settings-acceptance.mjs";
  console.error("Deterministic acceptance harness for the Settings package (canary keys ONLY).");
  console.error("");
  console.error("Modes:");
  console.error(`  ${self} local [--keep] [--project FEN] [--scan-dir PATH]...`);
  console.error("        Self-contained: real telemetry-server + isolated seams + mock +");
  console.error("        local bare git fixture; every check; cleans up afterwards.");
  console.error(`  ${self} run --base-url URL [--checks-url URL] [--no-mock] [--mock-host H]`);
  console.error("        [--secrets-dir PATH] [--settings-file PATH] [--repos-fixture-url URL]");
  console.error("        [--mock-control-url URL] (host-accessible /_log URL when checks-url is container-only)");
  console.error("        [--scan-dir PATH]... [--project FEN]");
  console.error("        Against an already running isolated Fenix API (Docker). File-level");
  console.error("        assertions need the HOST paths of the bind mounts.");
  console.error(`  ${self} mock [--host H] [--port P]`);
  console.error("        Only the mock server, foreground — for a caller that starts the stack.");
  console.error("");
  console.error("The API process (run mode, Docker) MUST be started with the mock seams,");
  console.error("otherwise the preflight gate refuses every key/provider check:");
  console.error("  LA_PROVIDER_BASEURL_OPENROUTER=http://host.docker.internal:<mockPort>");
  console.error("  LA_LINEAR_CHECK_URL=http://host.docker.internal:<mockPort>/linear");
  console.error("  LA_GITHUB_CHECK_URL=http://host.docker.internal:<mockPort>/gh");
  console.error("  FENIX_REPOS_ALLOW_LOCAL=1");
  console.error("  LA_SECRETS_DIR=/fenix-secrets (rw) | LA_SETTINGS_FILE=/fenix-config/settings.json (rw)");
  console.error("");
  console.error("Exit: 0 all PASS/SKIP | 1 any FAIL | 2 usage.");
}

const flags = parseFlags(process.argv.slice(2));
const mode = flags._[0] || "local";

if (mode === "local") {
  writeCanaryFiles();
  await modeLocal(flags).catch((err) => {
    console.error(`harness error: ${scrubAll(err?.stack || err)}`);
    process.exitCode = 1;
  });
} else if (mode === "run") {
  writeCanaryFiles();
  await modeRun(flags).catch((err) => {
    console.error(`harness error: ${scrubAll(err?.stack || err)}`);
    process.exitCode = 1;
  });
} else if (mode === "mock") {
  await modeMock(flags);
} else {
  usage();
  process.exit(2);
}

// ── report ───────────────────────────────────────────────────────────────────

if (mode !== "mock") {
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");

  console.log("\n=== Settings acceptance ===");
  for (const r of results) {
    const mark = r.status === "PASS" ? "PASS" : r.status === "SKIP" ? "SKIP" : "FAIL";
    console.log(`  [${mark}] ${r.id} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

  if (skipped.length) {
    console.log("\nNOT COVERED HERE (honest skips):");
    for (const s of skipped) console.log(`  - ${s.id} ${s.name}: ${s.detail}`);
  }

  console.log("\nMANUAL NEXT STEPS (out of the harness's reach by design):");
  console.log("  1. key-leak-check over the FULL Docker surfaces (docker inspect, compose");
  console.log("     logs, in-container grep of /data in both containers) with the canary");
  console.log("     files written outside the tracked source:");
  for (let i = 0; i < ALL_CANARIES.length; i++) {
    console.log(`        node scripts/key-leak-check.mjs --canary-file ${join(canaryFilesDir || "(run the harness first)", `canary-${i}.txt`)} \\`);
  }
  console.log("        ...plus --project/--compose-file/--project-directory/--data-dir as needed.");
  console.log("  2. The NEXT CHILD SPAWN must resolve the switched provider/model");
  console.log("     (FOC-786 AC1) and the Supervisor picks the rotated key up on its next");
  console.log("     fresh session — spawn once and check the child's resolved env.");
  console.log("  3. Browser pass over every Settings section (no console errors).");

  process.exit(process.exitCode || (failed.length ? 1 : 0));
}

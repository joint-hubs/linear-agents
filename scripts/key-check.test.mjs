#!/usr/bin/env node
/**
 * scripts/key-check.test.mjs — tests for scripts/key-check.mjs (FOC-778 slice B).
 *
 * NO REAL KEYS: every test uses a local fake HTTP server (node:http on
 * 127.0.0.1:0) and canary strings. Each check receives its key only through
 * parameters, every remote endpoint is overridden (baseUrl / endpoints), and
 * after every call we assert the canary appears in neither the returned
 * object, any error text a fetch misbehavior produces, nor captured console
 * output.
 *
 * Run: node --test scripts/key-check.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scrubSecret,
  checkProviderKey,
  checkLinearKey,
  checkGithubToken,
} from "./key-check.mjs";

// ---------------------------------------------------------------------------
// Canaries — fake, never real. The sk-ant/ghp/github_pat shapes double as
// shape-scrub canaries; the Linear canary has no known shape, so only the
// exact-match scrub can catch it leaking.
// ---------------------------------------------------------------------------

const CANARY = "sk-ant-CANARY-0123456789abcdef-CANARY";
const CANARY_LINEAR = "lin_api_CANARY_0123456789abcdefghij";
const CANARY_GITHUB = "ghp_CANARY0123456789abcdefghijklmnop";
const CANARY_PAT = "github_pat_CANARY_finegrained_token_0123456789";

/** Assert a result object never contains the canary key. */
function assertNoCanary(result, canary) {
  assert.ok(
    !JSON.stringify(result).includes(canary),
    `result leaks the key: ${JSON.stringify(result)}`,
  );
}

// ---------------------------------------------------------------------------
// Fake server helpers (node:http on 127.0.0.1:0)
// ---------------------------------------------------------------------------

/** Start a fake HTTP server; handler(req, res, { body, url, headers }). */
async function startFakeServer(handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      try {
        handler(req, res, { body, url: req.url, headers: req.headers });
      } catch {
        res.destroy();
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

function respondJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** A fetch-Response-shaped stub for tests that inject fetchImpl directly. */
function stubResponse(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (name) => (headers[name.toLowerCase()] ?? null) },
  };
}

/** fetchImpl that fails the connection deterministically (no real socket). */
function refusedFetch() {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:59999");
  err.cause = { code: "ECONNREFUSED" };
  return async () => {
    throw err;
  };
}

// ---------------------------------------------------------------------------
// scrubSecret
// ---------------------------------------------------------------------------

test("scrubSecret: exact-match replacement", () => {
  assert.equal(scrubSecret("failed auth for lin_api_XYZ here", "lin_api_XYZ"), "failed auth for [redacted] here");
});

test("scrubSecret: key shapes replaced even without the exact secret", () => {
  assert.equal(
    scrubSecret("bad token sk-ant-abc123def456ghi in message", undefined),
    "bad token [redacted] in message",
  );
  assert.equal(
    scrubSecret("leaked ghp_ABCDEFGHIJKLMNOPQRSTUV in logs", undefined),
    "leaked [redacted] in logs",
  );
  assert.equal(
    scrubSecret("pat github_pat_ABCDEFGHIJKLMNOPQRSTUVWX echoed", undefined),
    "pat [redacted] echoed",
  );
});

test("scrubSecret: regex metacharacters in the secret are literal", () => {
  assert.equal(scrubSecret("a.b(c) BADKEY", "a.b(c)"), "[redacted] BADKEY");
});

// ---------------------------------------------------------------------------
// checkProviderKey — status branches, auth header per style, base URL
// ---------------------------------------------------------------------------

test("provider: 200 with authStyle token sends Authorization Bearer and the ping body", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 200, { id: "msg_1" }));
  try {
    const result = await checkProviderKey({
      baseUrl: `${srv.url}/`,
      authStyle: "token",
      key: CANARY,
      model: "test-model",
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "key accepted (HTTP 200)");
    assert.equal(result.details.model, "test-model");
    const req = srv.requests[0];
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["authorization"], `Bearer ${CANARY}`);
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.headers["content-type"], "application/json");
    const sent = JSON.parse(req.body);
    assert.deepEqual(sent, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: 200 with authStyle apikey sends x-api-key and no Authorization", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 200, { id: "msg_1" }));
  try {
    const result = await checkProviderKey({
      baseUrl: srv.url,
      authStyle: "apikey",
      key: CANARY,
      model: "test-model",
    });
    assert.equal(result.ok, true);
    const req = srv.requests[0];
    assert.equal(req.headers["x-api-key"], CANARY);
    assert.equal(req.headers["authorization"], undefined);
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: 401 and 403 reject the key", async () => {
  for (const status of [401, 403]) {
    const srv = await startFakeServer((req, res) => respondJson(res, status, { error: { message: `nope ${CANARY}` } }));
    try {
      const result = await checkProviderKey({ baseUrl: srv.url, key: CANARY, model: "m" });
      assert.equal(result.ok, false);
      assert.equal(result.reason, `key rejected (HTTP ${status})`);
      assertNoCanary(result, CANARY);
    } finally {
      await srv.close();
    }
  }
});

test("provider: 404 suggests the base URL and model", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 404, { error: { type: "not_found_error" } }));
  try {
    const result = await checkProviderKey({ baseUrl: srv.url, key: CANARY, model: "m" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "endpoint or model not found (HTTP 404) — check the base URL and model");
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: 400 error body echoing the key gets scrubbed", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 400, { error: { message: `invalid model for key ${CANARY}` } }),
  );
  try {
    const result = await checkProviderKey({ baseUrl: srv.url, key: CANARY, model: "m" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid request (HTTP 400): invalid model for key [redacted]");
    assert.ok(result.reason.includes("[redacted]"));
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: 400 without a parseable error body falls back to HTTP 400", async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(400, { "content-type": "text/html" });
    res.end("<html>bad</html>");
  });
  try {
    const result = await checkProviderKey({ baseUrl: srv.url, key: CANARY, model: "m" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "HTTP 400");
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: 402 insufficient credit, 429 rate limited, other codes generic", async () => {
  const expectations = [
    [402, "insufficient credit (HTTP 402)"],
    [429, "rate limited (HTTP 429) — the key is probably valid"],
    [500, "HTTP 500"],
    [503, "HTTP 503"],
  ];
  for (const [status, reason] of expectations) {
    const srv = await startFakeServer((req, res) => respondJson(res, status, { error: { message: "x" } }));
    try {
      const result = await checkProviderKey({ baseUrl: srv.url, key: CANARY, model: "m" });
      assert.equal(result.ok, false);
      assert.equal(result.reason, reason);
      assertNoCanary(result, CANARY);
    } finally {
      await srv.close();
    }
  }
});

test("provider: network failure names the host only, never headers or URL", async () => {
  const result = await checkProviderKey({
    baseUrl: "http://127.0.0.1:59999",
    key: CANARY,
    model: "m",
    fetchImpl: refusedFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cannot reach 127.0.0.1:59999: ECONNREFUSED");
  assert.ok(!result.reason.includes("http://"));
  assert.ok(!result.reason.includes("Bearer"));
  assertNoCanary(result, CANARY);
});

test("provider: a misbehaving fetch that throws a key-containing error leaks nothing", async () => {
  const evilFetch = async () => {
    throw new Error(`connection failed for ${CANARY}`);
  };
  const result = await checkProviderKey({
    baseUrl: "http://127.0.0.1:59999",
    key: CANARY,
    model: "m",
    fetchImpl: evilFetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^cannot reach 127\.0\.0\.1:59999: ERROR$/);
  assertNoCanary(result, CANARY);
});

test("provider: timeout path reports TIMEOUT against a hanging server", async () => {
  const srv = await startFakeServer(() => {
    /* never respond */
  });
  try {
    const result = await checkProviderKey({
      baseUrl: srv.url,
      key: CANARY,
      model: "m",
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^cannot reach 127\.0\.0\.1:\d+: TIMEOUT$/);
    assert.ok(!result.reason.includes("http://"));
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("provider: missing key and invalid base URL refuse locally", async () => {
  const noKey = await checkProviderKey({ baseUrl: "http://127.0.0.1:59999", key: "" });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.reason, "no key provided");

  const noHost = await checkProviderKey({ baseUrl: "not a url", key: CANARY });
  assert.equal(noHost.ok, false);
  assert.equal(noHost.reason, "invalid base URL");
  assertNoCanary(noHost, CANARY);
});

// ---------------------------------------------------------------------------
// checkProviderKey — OpenRouter key metadata (GET /api/v1/key first)
// ---------------------------------------------------------------------------

test("openrouter: key endpoint answers first; no model skips the messages call", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { data: { label: "wizard-key", limit: 10.5, usage: 2.5, extra: "dropped" } }),
  );
  try {
    const result = await checkProviderKey({
      baseUrl: "https://openrouter.ai/api/v1",
      key: CANARY,
      endpoints: { openrouterKey: `${srv.url}/api/v1/key` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "key accepted (HTTP 200)");
    assert.deepEqual(result.details, { label: "wizard-key", limit: 10.5, usage: 2.5 });
    assert.ok(Object.keys(result.details).every((k) => ["label", "limit", "usage"].includes(k)));
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].method, "GET");
    assert.equal(srv.requests[0].headers["authorization"], `Bearer ${CANARY}`);
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("openrouter: key endpoint non-200 rejects without touching messages", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 401, { error: "invalid" }));
  try {
    const result = await checkProviderKey({
      baseUrl: "https://openrouter.ai/api/v1",
      key: CANARY,
      endpoints: { openrouterKey: `${srv.url}/api/v1/key` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "key rejected (HTTP 401)");
    assert.equal(srv.requests.length, 1);
    assertNoCanary(result, CANARY);
  } finally {
    await srv.close();
  }
});

test("openrouter: with a model the messages call follows the key call", async () => {
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers, body: opts.body });
    if (String(url).includes("/api/v1/key")) {
      return stubResponse(200, { data: { label: "wiz", limit: 10, usage: 2 } });
    }
    return stubResponse(200, { id: "msg_1" });
  };
  const result = await checkProviderKey({
    baseUrl: "https://openrouter.ai/api",
    authStyle: "token",
    key: CANARY,
    model: "test-model",
    fetchImpl: fetchStub,
  });
  assert.equal(result.ok, true);
  assert.equal(result.details.model, "test-model");
  assert.equal(result.details.label, "wiz");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[0].headers.Authorization, `Bearer ${CANARY}`);
  assert.equal(calls[1].url, "https://openrouter.ai/api/v1/messages");
  assert.equal(calls[1].headers.Authorization, `Bearer ${CANARY}`);
  const sent = JSON.parse(calls[1].body);
  assert.equal(sent.max_tokens, 1);
  assert.equal(sent.model, "test-model");
  assertNoCanary(result, CANARY);
});

test("openrouter: key endpoint network failure names its host", async () => {
  const result = await checkProviderKey({
    baseUrl: "https://openrouter.ai/api/v1",
    key: CANARY,
    endpoints: { openrouterKey: "http://127.0.0.1:59999/api/v1/key" },
    fetchImpl: refusedFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cannot reach 127.0.0.1:59999: ECONNREFUSED");
  assertNoCanary(result, CANARY);
});

// ---------------------------------------------------------------------------
// checkLinearKey — GraphQL, raw Authorization (matches linear-client.mjs)
// ---------------------------------------------------------------------------

const LINEAR_OK_BODY = {
  data: {
    viewer: { id: "u1", name: "Mateusz" },
    teams: { nodes: [{ key: "FEN", name: "Fenix" }, { key: "GEN", name: "General" }] },
  },
};

function linearSrv() {
  return startFakeServer((req, res) => respondJson(res, 200, LINEAR_OK_BODY));
}

test("linear: ok without teamKey — viewer name, team keys, team null", async () => {
  const srv = await linearSrv();
  try {
    const result = await checkLinearKey({
      key: CANARY_LINEAR,
      endpoints: { linear: `${srv.url}/graphql` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "key accepted");
    assert.deepEqual(result.details, { viewer: "Mateusz", teams: ["FEN", "GEN"], team: null });
    const req = srv.requests[0];
    assert.equal(req.url, "/graphql");
    assert.equal(req.headers["authorization"], CANARY_LINEAR);
    assert.ok(req.body.includes("viewer"));
    assert.ok(req.body.includes("teams"));
    assertNoCanary(result, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
});

test("linear: ok with teamKey — case-insensitive match, raw Authorization (no Bearer)", async () => {
  const srv = await linearSrv();
  try {
    const result = await checkLinearKey({
      key: CANARY_LINEAR,
      teamKey: "gen",
      endpoints: { linear: `${srv.url}/graphql` },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.details, { viewer: "Mateusz", teams: ["FEN", "GEN"], team: "gen" });
    assert.ok(!srv.requests[0].headers["authorization"].startsWith("Bearer"));
    assertNoCanary(result, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
});

test("linear: team not visible lists the visible teams", async () => {
  const srv = await linearSrv();
  try {
    const result = await checkLinearKey({
      key: CANARY_LINEAR,
      teamKey: "nope",
      endpoints: { linear: `${srv.url}/graphql` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "team nope not visible to this key (visible: FEN, GEN)");
    assertNoCanary(result, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
});

test("linear: team not visible with zero teams says (visible: none)", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { data: { viewer: { id: "u1", name: "Mateusz" }, teams: { nodes: [] } } }),
  );
  try {
    const result = await checkLinearKey({
      key: CANARY_LINEAR,
      teamKey: "nope",
      endpoints: { linear: `${srv.url}/graphql` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "team nope not visible to this key (visible: none)");
    assertNoCanary(result, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
});

test("linear: 401 rejects the key; other HTTP codes generic", async () => {
  const srv401 = await startFakeServer((req, res) => respondJson(res, 401, { error: "invalid api key" }));
  try {
    const r = await checkLinearKey({ key: CANARY_LINEAR, endpoints: { linear: `${srv401.url}/graphql` } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "key rejected (HTTP 401)");
    assertNoCanary(r, CANARY_LINEAR);
  } finally {
    await srv401.close();
  }
  const srv500 = await startFakeServer((req, res) => respondJson(res, 500, { error: "boom" }));
  try {
    const r = await checkLinearKey({ key: CANARY_LINEAR, endpoints: { linear: `${srv500.url}/graphql` } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "HTTP 500");
    assertNoCanary(r, CANARY_LINEAR);
  } finally {
    await srv500.close();
  }
});

test("linear: GraphQL errors are scrubbed when they echo the key", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { errors: [{ message: `invalid api key: ${CANARY_LINEAR}` }] }),
  );
  try {
    const result = await checkLinearKey({
      key: CANARY_LINEAR,
      endpoints: { linear: `${srv.url}/graphql` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "GraphQL error: invalid api key: [redacted]");
    assertNoCanary(result, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
});

test("linear: missing viewer rejects; network failure names the host", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { data: { teams: { nodes: [] } } }),
  );
  try {
    const r = await checkLinearKey({ key: CANARY_LINEAR, endpoints: { linear: `${srv.url}/graphql` } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "key rejected (no viewer in response)");
    assertNoCanary(r, CANARY_LINEAR);
  } finally {
    await srv.close();
  }
  const noServer = await checkLinearKey({ key: CANARY_LINEAR, fetchImpl: refusedFetch() });
  assert.equal(noServer.ok, false);
  assert.equal(noServer.reason, "cannot reach api.linear.app: ECONNREFUSED");
  assertNoCanary(noServer, CANARY_LINEAR);
});

// ---------------------------------------------------------------------------
// checkGithubToken — /user, scopes classification
// ---------------------------------------------------------------------------

test("github: classic token with repo scope — login, scopes, no warning", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { login: "octocat" }, { "x-oauth-scopes": "repo, read:org" }),
  );
  try {
    const result = await checkGithubToken({
      token: CANARY_GITHUB,
      endpoints: { github: `${srv.url}/user` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "token accepted");
    assert.equal(result.warning, undefined);
    assert.deepEqual(result.details, { login: "octocat", tokenType: "classic", scopes: ["repo", "read:org"] });
    const req = srv.requests[0];
    assert.equal(req.url, "/user");
    assert.equal(req.headers["authorization"], `Bearer ${CANARY_GITHUB}`);
    assert.equal(req.headers["user-agent"], "fenix");
    assertNoCanary(result, CANARY_GITHUB);
  } finally {
    await srv.close();
  }
});

test("github: classic token without repo accepted with a warning", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { login: "octocat" }, { "x-oauth-scopes": "read:org, workflow" }),
  );
  try {
    const result = await checkGithubToken({
      token: CANARY_GITHUB,
      endpoints: { github: `${srv.url}/user` },
    });
    assert.equal(result.ok, true);
    assert.equal(result.warning, "token lacks the repo scope — pushes will fail");
    assert.equal(result.details.tokenType, "classic");
    assert.deepEqual(result.details.scopes, ["read:org", "workflow"]);
    assertNoCanary(result, CANARY_GITHUB);
  } finally {
    await srv.close();
  }
});

test("github: fine-grained via expiration header and via github_pat_ prefix", async () => {
  const srv = await startFakeServer((req, res) =>
    respondJson(res, 200, { login: "octocat" }, { "github-authentication-token-expiration": "2027-01-01" }),
  );
  try {
    const viaHeader = await checkGithubToken({
      token: CANARY_GITHUB,
      endpoints: { github: `${srv.url}/user` },
    });
    assert.equal(viaHeader.ok, true);
    assert.equal(viaHeader.details.tokenType, "fine-grained");
    assert.deepEqual(viaHeader.details.scopes, []);
    assert.equal(viaHeader.warning, undefined);
    assertNoCanary(viaHeader, CANARY_GITHUB);
  } finally {
    await srv.close();
  }

  const srv2 = await startFakeServer((req, res) => respondJson(res, 200, { login: "octocat" }));
  try {
    const viaPrefix = await checkGithubToken({
      token: CANARY_PAT,
      endpoints: { github: `${srv2.url}/user` },
    });
    assert.equal(viaPrefix.ok, true);
    assert.equal(viaPrefix.details.tokenType, "fine-grained");
    assertNoCanary(viaPrefix, CANARY_PAT);
  } finally {
    await srv2.close();
  }
});

test("github: 401 rejects; unknown token type when headers absent", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 401, { message: "Bad credentials" }));
  try {
    const r = await checkGithubToken({ token: CANARY_GITHUB, endpoints: { github: `${srv.url}/user` } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "token rejected (HTTP 401)");
    assertNoCanary(r, CANARY_GITHUB);
  } finally {
    await srv.close();
  }
  const srv2 = await startFakeServer((req, res) => respondJson(res, 200, { login: "octocat" }));
  try {
    const unknown = await checkGithubToken({ token: CANARY_LINEAR, endpoints: { github: `${srv2.url}/user` } });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.details.tokenType, "unknown");
    assertNoCanary(unknown, CANARY_LINEAR);
  } finally {
    await srv2.close();
  }
});

test("github: network failure names the host only", async () => {
  const result = await checkGithubToken({ token: CANARY_GITHUB, fetchImpl: refusedFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cannot reach api.github.com: ECONNREFUSED");
  assert.ok(!result.reason.includes("Bearer"));
  assertNoCanary(result, CANARY_GITHUB);
});

// ---------------------------------------------------------------------------
// Console capture sweep — nothing is ever logged with the key
// ---------------------------------------------------------------------------

test("no canary in captured console output while checks run", async () => {
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const push = (...args) => captured.push(args.join(" "));
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    const echo400 = await checkProviderKey({
      baseUrl: "http://127.0.0.1:59999",
      key: CANARY,
      model: "m",
      fetchImpl: async () => stubResponse(400, { error: { message: `bad key ${CANARY}` } }),
    });
    assertNoCanary(echo400, CANARY);
    const linErr = await checkLinearKey({
      key: CANARY_LINEAR,
      fetchImpl: async () => stubResponse(200, { errors: [{ message: `denied ${CANARY_LINEAR}` }] }),
    });
    assertNoCanary(linErr, CANARY_LINEAR);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  assert.ok(!captured.join("\n").includes(CANARY), "console captured the key");
  assert.ok(!captured.join("\n").includes(CANARY_LINEAR), "console captured the key");
});

// ---------------------------------------------------------------------------
// CLI — key from stdin (never argv), JSON result on stdout
// ---------------------------------------------------------------------------

test("CLI: provider check reads the key from stdin and prints clean JSON", () => {
  return (async () => {
    const srv = await startFakeServer((req, res) => respondJson(res, 200, { id: "msg_1" }));
    try {
      const script = fileURLToPath(new URL("./key-check.mjs", import.meta.url));
      // Async spawn: spawnSync would block this process's event loop, so the
      // in-process fake server could never answer and the CLI timed out.
      const child = spawn(
        process.execPath,
        [script, "provider", "--base-url", srv.url, "--auth-style", "apikey", "--model", "test-model"],
      );
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (c) => stdout.push(c));
      child.stderr.on("data", (c) => stderr.push(c));
      child.stdin.write(`${CANARY}\n`);
      child.stdin.end();
      const [status, stdoutStr, stderrStr] = await Promise.all([
        new Promise((resolve) => child.on("close", (code) => resolve(code))),
        new Promise((resolve) => child.stdout.on("end", () => resolve(Buffer.concat(stdout).toString("utf8")))),
        new Promise((resolve) => child.stderr.on("end", () => resolve(Buffer.concat(stderr).toString("utf8")))),
      ]);
      assert.equal(status, 0, `CLI failed: ${stderrStr}`);
      const parsed = JSON.parse(stdoutStr);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.reason, "key accepted (HTTP 200)");
      assert.ok(`${stdoutStr}\n${stderrStr}`.indexOf(CANARY) === -1, "CLI output echoes the key");
      assert.equal(srv.requests[0].headers["x-api-key"], CANARY);
    } finally {
      await srv.close();
    }
  })();
});

test("CLI: unknown command prints usage and exits 2 without touching the network", () => {
  const script = fileURLToPath(new URL("./key-check.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "bogus"], { input: CANARY, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("Usage"));
  assert.ok(`${r.stdout}\n${r.stderr}`.indexOf(CANARY) === -1);
});

// --- CLI: provider resolution (--provider) -----------------------------------

/** Run the CLI async and collect status/stdout/stderr (fake servers need a
 *  live event loop — spawnSync would block it, see the note above). */
async function runCli(args, { input, env } = {}) {
  const script = fileURLToPath(new URL("./key-check.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (c) => stdout.push(c));
  child.stderr.on("data", (c) => stderr.push(c));
  if (input !== undefined) {
    child.stdin.write(`${input}\n`);
  }
  child.stdin.end();
  const [status, stdoutStr, stderrStr] = await Promise.all([
    new Promise((resolve) => child.on("close", (code) => resolve(code))),
    new Promise((resolve) => child.stdout.on("end", () => resolve(Buffer.concat(stdout).toString("utf8")))),
    new Promise((resolve) => child.stderr.on("end", () => resolve(Buffer.concat(stderr).toString("utf8")))),
  ]);
  return { status, stdout: stdoutStr, stderr: stderrStr };
}

function tempDir2() {
  return mkdtempSync(join(tmpdir(), "foc-778-"));
}

test("CLI --provider: resolves the provider config and picks the cheapest tier model", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 200, { id: "msg_1" }));
  const dir = tempDir2();
  try {
    const configPath = join(dir, "models.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          fakeprov: {
            baseUrl: srv.url,
            authEnv: "FAKE_KEY",
            authStyle: "token",
            defaultModel: "fallback-model",
            tiers: { haiku: "cheapest-model", smallFast: "also-cheap" },
          },
        },
      }),
      "utf8",
    );
    const { status, stdout, stderr } = await runCli(["provider", "--provider", "fakeprov"], {
      input: CANARY,
      env: { LA_PROVIDER_CONFIG: configPath },
    });
    assert.equal(status, 0, `CLI failed: ${stderr}`);
    // Exactly ONE JSON line on stdout.
    assert.equal(stdout.slice(0, -1).includes("\n"), false, `multi-line stdout: ${stdout}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reason, "key accepted (HTTP 200)");
    assert.equal(parsed.details.model, "cheapest-model");
    const req = srv.requests[0];
    assert.equal(req.headers["authorization"], `Bearer ${CANARY}`);
    assert.equal(JSON.parse(req.body).model, "cheapest-model");
    assert.ok(`${stdout}\n${stderr}`.indexOf(CANARY) === -1, "CLI output echoes the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("CLI --provider custom: resolves baseUrl/authStyle/defaultModel from the settings overlay", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 200, { id: "msg_1" }));
  try {
    const dir = tempDir2();
    const settingsPath = join(dir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        provider: {
          active: "custom",
          custom: {
            baseUrl: srv.url,
            authStyle: "apikey",
            keyName: "PROVIDER_API_KEY",
            tiers: {},
            defaultModel: "custom-model",
          },
        },
      }),
      "utf8",
    );
    const { status, stdout, stderr } = await runCli(["provider", "--provider", "custom"], {
      input: CANARY,
      env: { LA_SETTINGS_FILE: settingsPath },
    });
    assert.equal(status, 0, `CLI failed: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.details.model, "custom-model");
    const req = srv.requests[0];
    assert.equal(req.headers["x-api-key"], CANARY);
    assert.equal(req.headers["authorization"], undefined);
    assert.ok(`${stdout}\n${stderr}`.indexOf(CANARY) === -1, "CLI output echoes the key");
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await srv.close();
  }
});

test("CLI: rejected key → exit 1, one JSON line, no key in the output", async () => {
  const srv = await startFakeServer((req, res) => respondJson(res, 401, { error: { message: "nope" } }));
  try {
    const { status, stdout, stderr } = await runCli(["provider", "--base-url", srv.url, "--model", "m"], {
      input: CANARY,
    });
    assert.equal(status, 1);
    assert.equal(stdout.slice(0, -1).includes("\n"), false, `multi-line stdout: ${stdout}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "key rejected (HTTP 401)");
    assert.ok(`${stdout}\n${stderr}`.indexOf(CANARY) === -1, "CLI output echoes the key");
  } finally {
    await srv.close();
  }
});

test("CLI provider: no --provider and no --base-url → usage, exit 2", () => {
  const script = fileURLToPath(new URL("./key-check.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script, "provider"], { input: CANARY, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("Usage"));
});

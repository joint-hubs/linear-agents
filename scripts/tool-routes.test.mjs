// scripts/tool-routes.test.mjs — the /api/tool-profiles routes (P2 backend
// slice). Unit tests over the flat dispatcher with a FAKE ctx (the same
// guard/json/body-capturing shapes telemetry-server passes in) and an
// INJECTED probe — no server spawn, no ports, no python, no network.
//
// Run: node --test scripts/tool-routes.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleToolRoute, setToolRoutesDeps, probeThoughtmap } from "./tool-routes.mjs";
import { readToolProfiles } from "./tool-profiles.mjs";

// ── fake harness ─────────────────────────────────────────────────────────────

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tool-routes-"));
}

/**
 * A fake ctx mirroring telemetry-server's: json/log/isLocalOrigin/
 * isAllowedOrigin/readJsonBody/respondBodyError. `body` is what the injected
 * readJsonBody resolves with; `bodyError` (e.g. a tooLarge marker) rejects.
 */
function makeCtx({ body = {}, bodyError = null, allowedOrigin = true } = {}) {
  const calls = [];
  const ctx = {
    json: (_res, status, data) => calls.push({ status, data }),
    log: () => {},
    isLocalOrigin: () => true,
    isAllowedOrigin: () => allowedOrigin,
    readJsonBody: async () => {
      if (bodyError) throw bodyError;
      return body;
    },
    respondBodyError: (res, err) => {
      const status = err?.tooLarge ? 413 : 400;
      ctx.json(res, status, { error: err?.tooLarge ? err.message : "invalid JSON body: " + err.message });
      return status;
    },
  };
  return { ctx, calls };
}

const fakeReq = (method, extra = {}) => ({
  method,
  headers: {},
  socket: { remoteAddress: "127.0.0.1" },
  ...extra,
});

const fakeUrl = (path) => new URL(path, "http://127.0.0.1");

/** Points the registry's default path at a temp file for the whole test. */
function useTempRegistry() {
  const dir = tempDir();
  const prev = process.env.LA_TOOL_PROFILES_FILE;
  process.env.LA_TOOL_PROFILES_FILE = join(dir, "tool-profiles.json");
  return {
    dir,
    registryPath: process.env.LA_TOOL_PROFILES_FILE,
    restore() {
      if (prev === undefined) delete process.env.LA_TOOL_PROFILES_FILE;
      else process.env.LA_TOOL_PROFILES_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── dispatch boundary ────────────────────────────────────────────────────────

test("handleToolRoute: a foreign path is not ours (returns false, nothing written)", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx } = makeCtx();
    const handled = await handleToolRoute(fakeReq("GET"), {}, fakeUrl("/api/other"), ctx);
    assert.equal(handled, false);
  } finally {
    reg.restore();
  }
});

// ── GET /api/tool-profiles ───────────────────────────────────────────────────

test("GET /api/tool-profiles: the validated config, defaults included", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx();
    const handled = await handleToolRoute(fakeReq("GET"), {}, fakeUrl("/api/tool-profiles"), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0].status, 200);
    assert.equal(calls[0].data.config.mcp.thoughtmap.enabled, false);
    assert.equal(calls[0].data.config.mcp.thoughtmap.baseUrl, "http://thoughtmap-app:8585");
  } finally {
    reg.restore();
  }
});

// ── GET /api/tool-profiles/catalog ───────────────────────────────────────────

test("GET /api/tool-profiles/catalog: the merged catalog with the five MCP tools", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx();
    const handled = await handleToolRoute(fakeReq("GET"), {}, fakeUrl("/api/tool-profiles/catalog"), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0].status, 200);
    const catalog = calls[0].data;
    for (const name of [
      "mcp__thoughtmap__search_thoughts",
      "mcp__thoughtmap__list_clusters",
      "mcp__thoughtmap__get_cluster",
      "mcp__thoughtmap__cluster_distances",
      "mcp__thoughtmap__text_distance",
    ]) {
      assert.equal(catalog.tools[name].readOnly, true);
    }
    assert.equal(catalog.tools.Read.risk, "safe");
    assert.equal(catalog.servers.thoughtmap.readOnly, true);
  } finally {
    reg.restore();
  }
});

// ── PUT /api/tool-profiles ───────────────────────────────────────────────────

test("PUT /api/tool-profiles: a foreign origin is refused before the body is read", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx({ allowedOrigin: false, body: { patch: {} } });
    const handled = await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0].status, 403);
  } finally {
    reg.restore();
  }
});

test("PUT /api/tool-profiles: dryRun applies nothing; a real PUT persists", async () => {
  const reg = useTempRegistry();
  try {
    {
      const { ctx, calls } = makeCtx({
        body: { patch: { mcp: { thoughtmap: { enabled: true } } }, dryRun: true },
      });
      await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
      assert.equal(calls[0].status, 200);
      assert.equal(calls[0].data.dryRun, true);
      assert.equal(calls[0].data.config.mcp.thoughtmap.enabled, true);
      assert.equal(readToolProfiles().mcp.thoughtmap.enabled, false); // unchanged
    }
    {
      const { ctx, calls } = makeCtx({ body: { patch: { mcp: { thoughtmap: { enabled: true } } } } });
      await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
      assert.equal(calls[0].status, 200);
      assert.equal(readToolProfiles().mcp.thoughtmap.enabled, true);
    }
  } finally {
    reg.restore();
  }
});

test("PUT /api/tool-profiles: a stale expectedRevision is a 400 conflict, nothing written", async () => {
  const reg = useTempRegistry();
  try {
    {
      const { ctx } = makeCtx({ body: { patch: { leadTools: { dev: ["Read"] } } } });
      await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
    }
    const before = readFileSync(reg.registryPath, "utf8");
    const { ctx, calls } = makeCtx({
      body: { patch: { leadTools: { dev: ["Grep"] } }, expectedRevision: 0 },
    });
    await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
    assert.equal(calls[0].status, 400);
    assert.match(calls[0].data.error, /revision conflict/);
    assert.equal(readFileSync(reg.registryPath, "utf8"), before);
  } finally {
    reg.restore();
  }
});

test("PUT /api/tool-profiles: an invalid patch is a 400 with the schema errors", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx({ body: { patch: { leadTools: { dev: "Read" } } } });
    await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
    assert.equal(calls[0].status, 400);
    assert.match(calls[0].data.error, /array of tool names or null/);
  } finally {
    reg.restore();
  }
});

test("PUT /api/tool-profiles: a missing patch is a 400; an over-cap body is a 413", async () => {
  const reg = useTempRegistry();
  try {
    {
      const { ctx, calls } = makeCtx({ body: {} });
      await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
      assert.equal(calls[0].status, 400);
      assert.match(calls[0].data.error, /patch \(object\) is required/);
    }
    {
      const tooLarge = new Error("body too large (>8KB)");
      tooLarge.tooLarge = true;
      const { ctx, calls } = makeCtx({ bodyError: tooLarge });
      await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
      assert.equal(calls[0].status, 413);
    }
  } finally {
    reg.restore();
  }
});

// ── POST /api/tool-profiles/test ─────────────────────────────────────────────

test("POST /api/tool-profiles/test: the injected probe decides verified; response carries no found content", async () => {
  const reg = useTempRegistry();
  try {
    const probedWith = [];
    setToolRoutesDeps({
      probe: async (cfg) => {
        probedWith.push({ ...cfg });
        return { ok: true, stages: { initialize: true, toolsList: true, searchRoundtrip: true }, tools: ["mcp__thoughtmap__search_thoughts"], ms: 12 };
      },
    });
    try {
      const { ctx, calls } = makeCtx({
        body: { baseUrl: "http://thoughtmap-app:8585", ollamaBaseUrl: "http://thoughtmap-ollama:11434" },
      });
      await handleToolRoute(fakeReq("POST"), {}, fakeUrl("/api/tool-profiles/test"), ctx);
      assert.equal(calls[0].status, 200);
      assert.equal(calls[0].data.configured.baseUrl, "http://thoughtmap-app:8585");
      assert.equal(calls[0].data.configured.enabled, false); // testing ≠ enabling
      assert.equal(calls[0].data.check.ok, true);
      assert.deepEqual(Object.keys(calls[0].data.check), ["ok", "stages", "tools", "ms"]);
      // The candidate reached the probe (configured vs verified is explicit).
      assert.equal(probedWith[0].baseUrl, "http://thoughtmap-app:8585");
      // No result bodies, no query echo, no notes payload in the response.
      assert.equal(JSON.stringify(calls[0].data).includes("content"), false);
    } finally {
      setToolRoutesDeps({ probe: probeThoughtmap }); // restore the real probe
    }
  } finally {
    reg.restore();
  }
});

test("POST /api/tool-profiles/test: a missing python is a structured unavailable, not a fake green", async () => {
  const reg = useTempRegistry();
  try {
    setToolRoutesDeps({
      probe: async () => ({
        ok: false,
        stages: { initialize: false, toolsList: false, searchRoundtrip: false },
        tools: [],
        code: "python-unavailable",
        hint: "pip install 'mcp' requests",
      }),
    });
    try {
      const { ctx, calls } = makeCtx({ body: {} });
      await handleToolRoute(fakeReq("POST"), {}, fakeUrl("/api/tool-profiles/test"), ctx);
      assert.equal(calls[0].status, 200);
      assert.equal(calls[0].data.check.ok, false);
      assert.equal(calls[0].data.check.code, "python-unavailable");
      assert.ok(calls[0].data.check.hint.includes("mcp"));
    } finally {
      setToolRoutesDeps({ probe: probeThoughtmap });
    }
  } finally {
    reg.restore();
  }
});

test("POST /api/tool-profiles/test: candidate validation rejects localhost and secrets", async () => {
  const reg = useTempRegistry();
  try {
    {
      const { ctx, calls } = makeCtx({ body: { baseUrl: "http://localhost:8585" } });
      await handleToolRoute(fakeReq("POST"), {}, fakeUrl("/api/tool-profiles/test"), ctx);
      assert.equal(calls[0].status, 400);
      assert.match(calls[0].data.errors.join(" "), /must not point at localhost/);
    }
    {
      const { ctx, calls } = makeCtx({ body: { embeddingModel: "sk-ant-api03-0123456789abcdef" } });
      await handleToolRoute(fakeReq("POST"), {}, fakeUrl("/api/tool-profiles/test"), ctx);
      assert.equal(calls[0].status, 400);
      assert.match(calls[0].data.errors.join(" "), /must not contain secrets/);
    }
  } finally {
    reg.restore();
  }
});

// ── fall-through ─────────────────────────────────────────────────────────────

test("an unknown /api/tool-profiles/* path is a 404 inside the namespace", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx();
    const handled = await handleToolRoute(fakeReq("GET"), {}, fakeUrl("/api/tool-profiles/nope"), ctx);
    assert.equal(handled, true);
    assert.equal(calls[0].status, 404);
  } finally {
    reg.restore();
  }
});

test("write routes require loopback too (isLocalOrigin false → 403)", async () => {
  const reg = useTempRegistry();
  try {
    const { ctx, calls } = makeCtx({ body: { patch: {} } });
    ctx.isLocalOrigin = () => false;
    await handleToolRoute(fakeReq("PUT"), {}, fakeUrl("/api/tool-profiles"), ctx);
    assert.equal(calls[0].status, 403);
  } finally {
    reg.restore();
  }
});

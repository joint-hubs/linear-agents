// scripts/tool-routes.mjs — the /api/tool-profiles routes (P2 backend slice),
// dispatched by telemetry-server.mjs beside the settings routes.
//
// Transport only. The registry logic lives in tool-profiles.mjs; this module
// adds exactly one thing of its own: the Thoughtmap connection probe. The
// probe is NOT a REST health claim — it initializes the real adapter over
// stdio (JSON-RPC: initialize → tools/list) and performs one read-only
// search roundtrip with a synthetic query, so "verified" means the MCP server
// actually started and answered. Found content never leaves the probe: the
// response carries stages/names/timing only, never result bodies (the store
// holds personal notes — they must not reach the API response or the server
// log).
//
// No arbitrary command/script injection: the probed adapter is the fixed
// builtin script (scripts/mcp/server-thoughtmap.py); a request can only tune
// the validated config fields (URLs / model / clusters path).
//
// Test seams: setToolRoutesDeps() swaps the probe for a stub, so route tests
// never spawn Python and never touch the network.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeGuards } from "./cockpit-routes.mjs";
import {
  readToolProfiles,
  writeToolProfiles,
  getToolCatalog,
  validateToolProfiles,
  emptyToolProfiles,
} from "./tool-profiles.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, "..");
const ADAPTER_SCRIPT = join(REPO_ROOT, "scripts", "mcp", "server-thoughtmap.py");

// Config payloads are control data, not documents — the same 8 KB the server
// defaults readJsonBody to.
const BODY_CAP = 8192;

// The probe's whole conversation must fit in this budget; the adapter's own
// tool timeouts stay far below it.
const PROBE_TIMEOUT_MS = 20_000;
// Line-framing guards: a runaway adapter cannot grow the probe buffer forever.
const PROBE_MAX_LINES = 200;
const PROBE_MAX_BUFFER = 1024 * 1024;

// ---------------------------------------------------------------------------
// Injectable dependency (tests)
// ---------------------------------------------------------------------------

const deps = { probe: probeThoughtmap };

/** Swap dependencies for tests — e.g. { probe: async () => ({ ok: true, ... }) }. */
export function setToolRoutesDeps(overrides = {}) {
  Object.assign(deps, overrides);
}

// ---------------------------------------------------------------------------
// The Thoughtmap probe — a minimal MCP stdio client
// ---------------------------------------------------------------------------

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function rpcNotify(method, params) {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

/**
 * Initialize the real adapter over stdio and prove it answers:
 *   1. initialize  → the server must respond with its capabilities
 *   2. tools/list  → the registered tool names come back
 *   3. tools/call search_thoughts with a synthetic query → one read-only
 *      roundtrip (the result CONTENT is discarded — counted, never surfaced)
 *
 * Never throws. Every outcome is a structured result; a missing interpreter
 * or dependency is `python-unavailable` with an actionable hint, so the UI
 * can show "configured but unverifiable" instead of a fake green light.
 */
export function probeThoughtmap(cfg, { timeoutMs = PROBE_TIMEOUT_MS, pythonPath, scriptPath = ADAPTER_SCRIPT } = {}) {
  const python = pythonPath || process.env.FENIX_TOOL_PROBE_PYTHON || "python";
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stages = { initialize: false, toolsList: false, searchRoundtrip: false };
    let tools = [];
    let settled = false;
    let child = null;
    let watchdog = null;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (child) {
        try {
          child.kill();
        } catch {}
      }
      const ok = stages.initialize && stages.toolsList && stages.searchRoundtrip;
      resolve({ ok, stages, tools, ms: Date.now() - startedAt, ...extra });
    };

    const unavailable = (err) => ({
      ok: false,
      stages,
      tools: [],
      ms: Date.now() - startedAt,
      code: "python-unavailable",
      hint:
        "the probe needs a python interpreter with the 'mcp' and 'requests' packages " +
        "(pip install 'mcp' requests); set FENIX_TOOL_PROBE_PYTHON when the interpreter is not on PATH",
      error: err?.code === "ENOENT" ? `python not found: ${python}` : String(err?.message ?? err),
    });

    try {
      child = spawn(python, [scriptPath], {
        env: {
          ...process.env,
          THOUGHTMAP_API_URL: cfg.baseUrl,
          THOUGHTMAP_CLUSTERS: cfg.clustersPath,
          OLLAMA_BASE_URL: cfg.ollamaBaseUrl,
          OLLAMA_EMBEDDING_MODEL: cfg.embeddingModel,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish(unavailable(err));
      return;
    }

    // One request is in flight at a time; each answered stage sends the next.
    let nextId = 1;
    const sendNext = () => {
      if (settled) return;
      if (!stages.initialize) {
        child.stdin.write(rpc(nextId, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "fenix-tool-profiles", version: "1" },
        }));
        nextId++;
        return;
      }
      if (!stages.toolsList) {
        child.stdin.write(rpcNotify("notifications/initialized"));
        child.stdin.write(rpc(nextId, "tools/list", {}));
        nextId++;
        return;
      }
      if (!stages.searchRoundtrip) {
        child.stdin.write(rpc(nextId, "tools/call", {
          name: "search_thoughts",
          arguments: { query: "fenix tool-profile probe", n_results: 1 },
        }));
        nextId++;
        return;
      }
      finish();
    };

    let buffer = "";
    let lineCount = 0;

    child.on("error", (err) => finish(unavailable(err)));

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > PROBE_MAX_BUFFER) {
        finish({ ok: false, code: "protocol", error: "probe buffer overrun" });
        return;
      }
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0 && !settled) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (++lineCount > PROBE_MAX_LINES) {
          finish({ ok: false, code: "protocol", error: "too many protocol lines" });
          return;
        }
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC frame (banner noise) — ignored
        }
        if (msg.error) {
          finish({
            ok: false,
            code: "mcp-error",
            error: `MCP error on id ${msg.id}: ${msg.error.message ?? "unknown"}`,
          });
          return;
        }
        if (msg.id === 1) {
          stages.initialize = true;
          sendNext();
        } else if (msg.id === 2) {
          stages.toolsList = true;
          tools = Array.isArray(msg.result?.tools)
            ? msg.result.tools.map((t) => (typeof t?.name === "string" ? t.name : null)).filter(Boolean)
            : [];
          sendNext();
        } else if (msg.id === 3) {
          // The roundtrip answered — the content itself is discarded on purpose.
          stages.searchRoundtrip = true;
          sendNext();
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      // Kept out of the response by default (finish() does not forward it);
      // surfaced only in the unavailable branch below, tail-trimmed.
      if (!settled) child.__stderrTail = ((child.__stderrTail || "") + chunk.toString("utf8")).slice(-800);
    });

    child.on("exit", (code) => {
      if (!settled) {
        const tail = child.__stderrTail ? String(child.__stderrTail).slice(-400) : undefined;
        finish({ ok: false, code: "exit", error: `adapter exited early (code ${code})`, stderrTail: tail });
      }
    });

    watchdog = setTimeout(() => {
      finish({ ok: false, code: "timeout", error: `no completed MCP handshake within ${timeoutMs} ms` });
    }, timeoutMs);

    sendNext();
  });
}

// ---------------------------------------------------------------------------
// Route handlers (settings-routes style flat dispatcher)
// ---------------------------------------------------------------------------

export async function handleToolRoute(req, res, url, ctx) {
  const { readJsonBody, respondBodyError, json, log } = ctx;
  const method = req.method;
  const path = url.pathname;
  if (!path.startsWith("/api/tool-profiles")) return false;

  const isWrite = method === "POST" || method === "PUT";
  if (isWrite && !writeGuards(req, res, path, ctx)) return true;

  try {
    // --- GET/PUT /api/tool-profiles -----------------------------------------
    if (path === "/api/tool-profiles") {
      if (method === "GET") {
        const config = readToolProfiles();
        json(res, 200, { config });
        log(method, path, 200);
        return true;
      }
      if (method !== "PUT") return methodMismatch(res, method, path, ctx);
      let body;
      try {
        body = await readJsonBody(req, BODY_CAP);
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      const patch = body?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        json(res, 400, { error: "patch (object) is required" });
        log(method, path, 400);
        return true;
      }
      const dryRun = Boolean(body?.dryRun);
      const expectedRevision = Number.isInteger(body?.expectedRevision) ? body.expectedRevision : undefined;
      try {
        const { config, changes } = writeToolProfiles(patch, { dryRun, expectedRevision });
        json(res, 200, { config, changes, dryRun });
        log(method, path, 200);
      } catch (err) {
        // Validation, CAS conflicts and schema refusals are caller errors.
        json(res, 400, { error: String(err?.message || err).split("\n").join(" | ") });
        log(method, path, 400);
      }
      return true;
    }

    // --- GET /api/tool-profiles/catalog --------------------------------------
    if (path === "/api/tool-profiles/catalog") {
      if (method !== "GET") return methodMismatch(res, method, path, ctx);
      json(res, 200, getToolCatalog());
      log(method, path, 200);
      return true;
    }

    // --- POST /api/tool-profiles/test ----------------------------------------
    if (path === "/api/tool-profiles/test") {
      if (method !== "POST") return methodMismatch(res, method, path, ctx);
      let body;
      try {
        body = await readJsonBody(req, BODY_CAP);
      } catch (err) {
        log(method, path, respondBodyError(res, err));
        return true;
      }
      // Candidate config: the stored thoughtmap block with ONLY the four
      // validated fields overridable. The probed script is fixed — a request
      // can never name a command, a script or a server.
      const candidate = candidateThoughtmap(body);
      const { ok, errors } = validateToolProfiles(candidate);
      if (!ok) {
        json(res, 400, { error: "invalid", errors });
        log(method, path, 400);
        return true;
      }
      const block = candidate.mcp.thoughtmap;
      const check = await deps.probe(block);
      json(res, 200, {
        configured: {
          enabled: block.enabled,
          baseUrl: block.baseUrl,
          ollamaBaseUrl: block.ollamaBaseUrl,
          embeddingModel: block.embeddingModel,
          clustersPath: block.clustersPath,
        },
        // ok:true ONLY when the adapter initialized, listed its tools AND
        // answered one read-only search — never a REST health claim.
        check,
      });
      log(method, path, 200);
      return true;
    }

    // A /api/tool-profiles/* path with no route — answered here so the log
    // lines stay whole (the server's fall-through 404 would answer anyway).
    json(res, 404, { error: "not found" });
    log(method, path, 404);
    return true;
  } catch (err) {
    json(res, 500, { error: String(err?.message || err).split("\n")[0] });
    log(method, path, 500);
    return true;
  }
}

/**
 * The stored thoughtmap block (defaults when unreadable) with the request's
 * overrides applied. `enabled` is deliberately NOT overridable here — testing
 * connectivity is independent of the registry's enabled flag.
 */
function candidateThoughtmap(body) {
  let stored = null;
  try {
    stored = readToolProfiles().mcp?.thoughtmap ?? null;
  } catch {
    stored = null; // an unreadable registry falls back to defaults for the probe
  }
  const block = { ...(stored ?? emptyToolProfiles().mcp.thoughtmap) };
  for (const field of ["baseUrl", "ollamaBaseUrl", "embeddingModel", "clustersPath"]) {
    if (typeof body?.[field] === "string" && body[field].trim() !== "") block[field] = body[field];
  }
  return { version: 1, revision: 0, mcp: { thoughtmap: block }, leadTools: {} };
}

function methodMismatch(res, method, path, ctx) {
  ctx.json(res, 405, { error: "method not allowed" });
  ctx.log(method, path, 405);
  return true;
}

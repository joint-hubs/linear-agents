// scripts/mcp/shadow-run.mjs — end-to-end shadow run for the FOC-401 decision
// servers (docs/mcp-decision-steps-catalog.md §Shadow run evidence).
//
// Invokes BOTH servers through their real MCP message path (initialize →
// tools/list → tools/call) on realistic dictated fixtures and records the
// result to a JSON evidence file. NOT wired into any supervisor flow — this
// is evidence collection, not routing.
//
//   node scripts/mcp/shadow-run.mjs [--mode auto|live|offline] [--out <path>] [--no-write]
//
//   auto (default)  live when OPENROUTER_API_KEY is set, offline otherwise
//   live            tier-1 Jev via OpenRouter /api/alpha/decisions — refused
//                   without a key; a live call failure is recorded as the
//                   typed error it is, never re-labeled or retried as offline
//   offline         the deterministic path (no model call, confidence null)
//
// The evidence record states the path explicitly on every level — never fake
// a live call, never present an offline sample as a model answer.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJSON } from "../utils.mjs";
import { createExtractionServer, SERVER_INFO as EXTRACTION_INFO, TOOL as EXTRACTION_TOOL } from "./server-extraction.mjs";
import { createPromptRefinementServer, SERVER_INFO as REFINEMENT_INFO, TOOL as REFINEMENT_TOOL } from "./server-prompt-refinement.mjs";
import { createOfflineProvider } from "./provider-offline.mjs";
import { createJevProvider } from "./provider-jev.mjs";
import { EXTRACTION_STEP, PROMPT_REFINEMENT_STEP } from "./steps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT = join(__dirname, "..", "..", "docs", "mcp-decision-steps-shadow-run.json");
const AUTH_ENV = "OPENROUTER_API_KEY";

// Realistic dictated inputs: an English stream-of-words sample and a Polish
// dictation sample ("kif i czeryf" is corrupted dictation for "feature").
// Content is synthetic — nothing from a real issue or a real conversation.
const EXTRACTION_FIXTURES = [
  {
    name: "dictated-en",
    text: "gantt snapshot export thingy. um also the export should include hidden rows I think, plus a date range picker for the toolbar",
  },
  {
    name: "dictated-pl-kif-czeryf",
    text: "kif i czeryf. No i jeszcze retry w webhookach oraz wykres kosztów w raporcie miesięcznym",
  },
];

// A realistic drafted squad prompt (the DEV implementer brief shape) with the
// features extraction would have produced.
const REFINEMENT_FIXTURES = [
  {
    name: "squad-prompt-medium",
    prompt:
      "Task(implementer): snapshot export for the Gantt view. Context: render() owns the canvas; " +
      "export module is a stub. Expected: PNG data-URL for a populated schedule, date-range bound; " +
      "empty schedule must not crash the caller. Verify with the repo lint and the existing test runner.",
    features: [
      { name: "snapshot export", size: "small" },
      { name: "date range picker", size: "small" },
      { name: "webhook retry", size: "small" },
    ],
  },
];

/**
 * Run both servers end to end and return the evidence object.
 * Injectable ({ fetchImpl }) keeps this hermetic for tests: they force
 * offline or inject a stub provider — tests never touch the network.
 */
export async function runShadowRun({
  mode = "auto",
  apiKey,
  fetchImpl,
  write = true,
  outPath = DEFAULT_OUT,
  now = () => new Date().toISOString(),
} = {}) {
  const envKey = apiKey !== undefined ? apiKey : process.env[AUTH_ENV];
  const path = mode === "auto" ? (envKey ? "live" : "offline") : mode;

  if (path !== "live" && path !== "offline") {
    throw new Error(`unknown shadow-run mode "${mode}" — expected auto | live | offline`);
  }
  if (path === "live" && !envKey) {
    throw new Error(`mode live requires ${AUTH_ENV} in the environment — refusing to fake a live call`);
  }

  const providerFor = (step) => (path === "live"
    ? createJevProvider({ apiKey: envKey, fetchImpl })
    : createOfflineProvider(step));

  const servers = [
    {
      key: "extraction",
      serverInfo: EXTRACTION_INFO,
      tool: EXTRACTION_TOOL.name,
      step: EXTRACTION_STEP,
      fixtures: EXTRACTION_FIXTURES,
      factory: createExtractionServer,
    },
    {
      key: "promptRefinement",
      serverInfo: REFINEMENT_INFO,
      tool: REFINEMENT_TOOL.name,
      step: PROMPT_REFINEMENT_STEP,
      fixtures: REFINEMENT_FIXTURES,
      factory: createPromptRefinementServer,
    },
  ];

  const evidence = {
    _doc:
      "Shadow-run evidence for the FOC-401 decision servers (docs/mcp-decision-steps-catalog.md). " +
      "Every call carries `path`: \"live\" (tier-1 Jev via OpenRouter /api/alpha/decisions, " +
      "measured confidence) or \"offline\" (deterministic, no model call, confidence null per " +
      "ADR-0012 D3.6). An offline record is never presented as a live result, and a failed live " +
      "call is recorded as the typed error it is.",
    runAt: now(),
    path,
    key: `${AUTH_ENV}: ${envKey ? "present" : "absent"}`,
    servers: [],
  };

  for (const entry of servers) {
    const provider = providerFor(entry.step);
    const server = entry.factory({ provider });

    // Handshake through the real handler — proves the protocol surface, not
    // just the decision function.
    const initResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shadow-run", version: "0.1.0" } },
    });
    const listResponse = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const calls = [];
    for (const fixture of entry.fixtures) {
      const response = await server.handleMessage({
        jsonrpc: "2.0",
        id: calls.length + 10,
        method: "tools/call",
        params: { name: entry.tool, arguments: fixtureArguments(fixture) },
      });
      calls.push({
        fixture: fixture.name,
        path,
        envelope: parseToolResult(response),
      });
    }

    evidence.servers.push({
      server: entry.serverInfo.name,
      tool: entry.tool,
      handshake: {
        initialize: initResponse?.result?.protocolVersion === "2025-06-18" ? "ok" : "failed",
        toolsList: Array.isArray(listResponse?.result?.tools) && listResponse.result.tools.length === 1 ? "ok" : "failed",
      },
      calls,
    });
  }

  if (write) atomicWriteJSON(outPath, evidence);
  return evidence;
}

// Extraction fixtures carry `text`; refinement fixtures carry prompt+features.
// One arguments object per server keeps the tools/call surface honest.
function fixtureArguments(fixture) {
  if (typeof fixture.text === "string") return { text: fixture.text };
  return { prompt: fixture.prompt, features: fixture.features };
}

// tools/call result → the decision envelope. A protocol-level failure (an
// unknown tool, invalid params) is recorded as the JSON-RPC error it is.
function parseToolResult(response) {
  if (response?.error) {
    return { ok: false, protocolError: { code: response.error.code, message: response.error.message, data: response.error.data ?? null } };
  }
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    return { ok: false, protocolError: { code: -32603, message: "tools/call returned no content" } };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, protocolError: { code: -32603, message: "tools/call content is not valid JSON" } };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function usage(stream) {
  stream("Usage: node scripts/mcp/shadow-run.mjs [--mode auto|live|offline] [--out <path>] [--no-write]");
  stream(`Default --out: ${DEFAULT_OUT}`);
}

if (process.argv[1] && process.argv[1].endsWith("shadow-run.mjs")) {
  const args = process.argv.slice(2);
  let mode = "auto";
  let outPath = DEFAULT_OUT;
  let write = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      usage(console.log);
      process.exit(0);
    } else if (args[i] === "--mode") {
      mode = args[++i];
      if (!mode) {
        console.error("shadow-run: --mode requires one of auto | live | offline");
        usage(console.error);
        process.exit(2);
      }
    } else if (args[i] === "--out") {
      outPath = args[++i];
      if (!outPath) {
        console.error("shadow-run: --out requires a path");
        usage(console.error);
        process.exit(2);
      }
    } else if (args[i] === "--no-write") {
      write = false;
    } else {
      console.error(`shadow-run: unknown argument '${args[i]}'`);
      usage(console.error);
      process.exit(2);
    }
  }

  if (mode !== "auto" && mode !== "live" && mode !== "offline") {
    console.error(`shadow-run: unknown --mode '${mode}' — expected auto | live | offline`);
    usage(console.error);
    process.exit(2);
  }

  try {
    const evidence = await runShadowRun({ mode, write, outPath });
    const calls = evidence.servers.flatMap((s) => s.calls);
    const ok = calls.filter((c) => c.envelope?.ok === true).length;
    console.log(`shadow-run: path=${evidence.path} — ${ok}/${calls.length} call(s) ok across ${evidence.servers.length} server(s)`);
    for (const server of evidence.servers) {
      for (const call of server.calls) {
        const status = call.envelope?.ok === true ? "ok" : `error: ${call.envelope?.error?.code ?? call.envelope?.protocolError?.code}`;
        console.log(`  ${server.tool} [${call.fixture}] → ${status}`);
      }
    }
    if (write) console.log(`evidence: ${outPath}`);
  } catch (err) {
    console.error(`shadow-run: ${err.message}`);
    process.exit(1);
  }
}

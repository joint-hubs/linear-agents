// scripts/mcp/server-extraction.mjs — MCP host for the extraction decision
// step (FOC-401, ADR-0012 D5). Dictated free text in, a short typed JSON of
// expected features out. Stdio transport for real callers; the handler is
// exported so tests and the shadow run exercise the real message path
// without spawning a process.

import { runDecision } from "./envelope.mjs";
import { EXTRACTION_STEP } from "./steps.mjs";
import { createOfflineProvider } from "./provider-offline.mjs";
import { createJevProvider } from "./provider-jev.mjs";
import { createMcpHandler, serveStdio } from "./jsonrpc.mjs";

export const SERVER_INFO = { name: "fenix-decision-extraction", version: "0.1.0" };

export const TOOL = {
  name: "extract_features",
  description:
    "Extract the user's expected features from dictated free text into a short typed JSON. " +
    "Fail-closed: schema-validated output or a typed error, never partial data (ADR-0012 D5).",
  inputSchema: EXTRACTION_STEP.inputSchema,
};

// The programmatic factory defaults to the offline provider so tests stay
// hermetic by construction; the stdio entry below resolves live-if-key.
export function createExtractionServer({ provider } = {}) {
  const chosen = provider || createOfflineProvider(EXTRACTION_STEP);
  const handler = createMcpHandler({
    serverInfo: SERVER_INFO,
    tools: [TOOL],
    callTool: async (_name, args) => runDecision(EXTRACTION_STEP, args, { provider: chosen }),
  });
  return { ...handler, serverInfo: SERVER_INFO, tools: [TOOL] };
}

// ── stdio entry ──────────────────────────────────────────────────────────────
// OPENROUTER_API_KEY present → tier-1 Jev (live); absent → the deterministic
// offline path. FENIX_MCP_PROVIDER=offline forces offline even with a key
// present. Mode is announced on stderr — stdout is protocol, never log.

if (process.argv[1] && process.argv[1].endsWith("server-extraction.mjs")) {
  const forceOffline = process.env.FENIX_MCP_PROVIDER === "offline";
  const apiKey = process.env.OPENROUTER_API_KEY;
  const provider = !forceOffline && apiKey
    ? createJevProvider({ apiKey })
    : createOfflineProvider(EXTRACTION_STEP);
  const server = createExtractionServer({ provider });
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — mode: ${provider.mode}`);
  await serveStdio(server.handleLine);
}

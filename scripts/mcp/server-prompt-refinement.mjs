// scripts/mcp/server-prompt-refinement.mjs — MCP host for the prompt
// refinement decision step (FOC-401, ADR-0012 D5). Squad prompt + features
// in, the ADR-0009 amendment size (small/medium/large) with the derived squad
// engagement plus per-feature relations out. Stdio transport for real
// callers; the handler is exported so tests and the shadow run exercise the
// real message path without spawning a process.

import { runDecision } from "./envelope.mjs";
import { PROMPT_REFINEMENT_STEP } from "./steps.mjs";
import { createOfflineProvider } from "./provider-offline.mjs";
import { createJevProvider } from "./provider-jev.mjs";
import { createMcpHandler, serveStdio } from "./jsonrpc.mjs";

export const SERVER_INFO = { name: "fenix-decision-prompt-refinement", version: "0.1.0" };

export const TOOL = {
  name: "refine_prompt",
  description:
    "Classify a drafted squad prompt: overall task size (small/medium/large per the ADR-0009 " +
    "amendment, with the squad engagement derived in code) and per-feature relations. " +
    "Fail-closed: schema-validated output or a typed error, never partial data (ADR-0012 D5).",
  inputSchema: PROMPT_REFINEMENT_STEP.inputSchema,
};

// The programmatic factory defaults to the offline provider so tests stay
// hermetic by construction; the stdio entry below resolves live-if-key.
export function createPromptRefinementServer({ provider } = {}) {
  const chosen = provider || createOfflineProvider(PROMPT_REFINEMENT_STEP);
  const handler = createMcpHandler({
    serverInfo: SERVER_INFO,
    tools: [TOOL],
    callTool: async (_name, args) => runDecision(PROMPT_REFINEMENT_STEP, args, { provider: chosen }),
  });
  return { ...handler, serverInfo: SERVER_INFO, tools: [TOOL] };
}

// ── stdio entry ──────────────────────────────────────────────────────────────
// OPENROUTER_API_KEY present → tier-1 Jev (live); absent → the deterministic
// offline path. FENIX_MCP_PROVIDER=offline forces offline even with a key
// present. Mode is announced on stderr — stdout is protocol, never log.

if (process.argv[1] && process.argv[1].endsWith("server-prompt-refinement.mjs")) {
  const forceOffline = process.env.FENIX_MCP_PROVIDER === "offline";
  const apiKey = process.env.OPENROUTER_API_KEY;
  const provider = !forceOffline && apiKey
    ? createJevProvider({ apiKey })
    : createOfflineProvider(PROMPT_REFINEMENT_STEP);
  const server = createPromptRefinementServer({ provider });
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — mode: ${provider.mode}`);
  await serveStdio(server.handleLine);
}

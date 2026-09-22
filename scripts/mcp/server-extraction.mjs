// scripts/mcp/server-extraction.mjs — MCP host for the extraction decision
// step (FOC-401, ADR-0012 D5). Dictated free text in, a short typed JSON of
// expected features out. Stdio transport for real callers; the handler is
// exported so tests and the shadow run exercise the real message path
// without spawning a process.
//
// Wiring gate (FOC-397, option a): the live path used to POST the Jev endpoint
// directly (createJevProvider). It now routes through the decision-call seam
// (scripts/decision-call.mjs) — same fail-closed envelope discipline, retries,
// metering and shadow records as every other registry-served call. The step's
// registry-owned question set is still built by the step's own toJev; the call
// stays on the seam's INLINE channel (no decisionId — resolveEntryQuestions
// refuses template entries by design), so answers stay operative and the
// serving posture in config/decisions.json reads
// { via: "seam (inline)", actsOnAnswers: true, a0Enforced: false, gate: "FOC-387" }.

import { createDecisionCaller } from "../decision-call.mjs";
import { runDecision, TypedError } from "./envelope.mjs";
import { EXTRACTION_STEP } from "./steps.mjs";
import { createOfflineProvider } from "./provider-offline.mjs";
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

// The live provider behind the seam: the step maps its registry-owned
// question set (toJev), the seam call carries them inline, and the envelope's
// answers feed the step's own fromJev mapping. A failed envelope throws the
// typed error the MCP envelope layer already maps — never partial data.
export function createSeamProvider({ caller }) {
  return {
    tier: 1,
    mode: "live",
    async decide({ step, input }) {
      const mapped = step.toJev(input);
      const envelope = await caller({ state: mapped.state, questions: mapped.questions });
      if (!envelope.ok) throw new TypedError(envelope.error.code, envelope.error.message);
      return {
        tier: 1,
        model: envelope.model,
        mode: "live",
        ...step.fromJev({ answers: envelope.decision.answers }, mapped),
      };
    },
  };
}

// ── stdio entry ──────────────────────────────────────────────────────────────
// OPENROUTER_API_KEY present → the seam caller (live); absent → the
// deterministic offline path. FENIX_MCP_PROVIDER=offline forces offline even
// with a key present. Mode is announced on stderr — stdout is protocol, never
// log.

if (process.argv[1] && process.argv[1].endsWith("server-extraction.mjs")) {
  const forceOffline = process.env.FENIX_MCP_PROVIDER === "offline";
  const apiKey = process.env.OPENROUTER_API_KEY;
  const provider = !forceOffline && apiKey
    ? createSeamProvider({ caller: createDecisionCaller({ apiKey }) })
    : createOfflineProvider(EXTRACTION_STEP);
  const server = createExtractionServer({ provider });
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — mode: ${provider.mode}`);
  await serveStdio(server.handleLine);
}
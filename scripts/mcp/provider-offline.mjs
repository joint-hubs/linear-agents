// scripts/mcp/provider-offline.mjs — the deterministic path, no model call.
//
// Used by the shadow run without credentials, by tests (hermetic — no
// network, no key), and as the stdio server fallback when OPENROUTER_API_KEY
// is absent. It is NOT a fake live result: mode is always "offline", tier and
// model are always null, confidence is always null (ADR-0012 D3.6 — measured
// sources only), and the sample still passes the step's output schema, so the
// fail-closed contract is exercised end-to-end without a network.

export function createOfflineProvider(step) {
  return {
    tier: null,
    model: null,
    mode: "offline",
    async decide({ input }) {
      return { tier: null, model: null, mode: "offline", ...step.offlineDecide(input) };
    },
  };
}

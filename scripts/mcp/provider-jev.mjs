// scripts/mcp/provider-jev.mjs — tier-1 decision provider (ADR-0012 D2).
//
// OpenRouter Decisions API (alpha): POST /api/alpha/decisions with
// {model, state, questions}. Measured contract (live probes, 2026-09-19):
//   · questions is a RECORD keyed by question id — {q0: {type, instructions,
//     criteria}, ...}; an array is rejected with 400 "expected record";
//   · criteria is a RECORD of label → description; a noul question's labels
//     are exactly "true" / "false";
//   · answers is a RECORD keyed by the same ids — a noul answer is
//     {type:"noul", noul: <probability>}; a choice answer is
//     {type:"choice", choice, probabilities: {...}, confidence};
//   · the response carries the resolved model build (typesafe/jev-1.13-<date>),
//     usage.cost, and the provider name.
// (GAPS §2.3 = docs/plans/fenix-architecture-gaps-2026-09-19.md recorded an
// earlier array-shaped contract on the morning of the same day; the endpoint
// changed shape in between — the exact alpha risk ADR-0012 D4/Q7c names as
// the Path B trigger. Latency/cost measured there still holds: ~0.3–0.5 s,
// ~$0.02 per 1,000 decisions.)
//
// ADR-0012 D3 constraints honored here:
//   · the model is pinned to typesafe/jev-1.13 — the ~latest alias has no
//     endpoint and chat/completions returns 400 for decisions models (D3.4,
//     D3.5);
//   · confidence is taken ONLY from the response's native probabilities /
//     confidence fields (D3.6) — anything unmeasured stays null;
//   · the alpha endpoint may change shape — any mismatch is a typed
//     unparseable_output error, never a guess (that shape change is the
//     Path B trigger, D4/Q7c).
//
// The endpoint is third-party surface (TypeSafe) — the request carries step
// state by design (accepted trade-off, ADR-0012 Risks), and this provider
// never echoes response bodies into error messages, so content cannot leak
// through the typed error path. The one provider message that is echoed — a
// transport/fetch error — is scrubbed and capped first (FOC-417).

import { TypedError } from "./envelope.mjs";
import { scrub } from "./scrub.mjs";

const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
// Pinned — never a ~latest alias (ADR-0012 D3.5).
const JEV_MODEL = "typesafe/jev-1.13";
// config/models.json providers.openrouter.authEnv.
const AUTH_ENV = "OPENROUTER_API_KEY";

export { JEV_ENDPOINT, JEV_MODEL, AUTH_ENV };

/**
 * Tier-1 provider. `apiKey` comes from the env by the caller (server mains,
 * the shadow run); `fetchImpl` is injectable so tests exercise the live path
 * without a network.
 */
export function createJevProvider({ apiKey, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  return {
    tier: 1,
    model: JEV_MODEL,
    mode: "live",
    async decide({ step, input }) {
      if (!apiKey) {
        throw new TypedError("auth_missing", `${AUTH_ENV} is not set — tier-1 Jev needs it (config/models.json providers.openrouter.authEnv)`);
      }

      // The step owns the mapping; the provider owns the transport. The state
      // carries the step's input by design — it is what the tier is for
      // (ADR-0012 Risks: content sensitivity accepted at this tier).
      const mapped = step.toJev(input);

      let response;
      try {
        response = await fetchImpl(JEV_ENDPOINT, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: JEV_MODEL, state: mapped.state, questions: mapped.questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A fetch/transport error is third-party text: it can quote the URL
        // (and whatever the runtime put in it), so it is scrubbed before it
        // becomes the typed reason (FOC-417).
        const reason = err?.name === "TimeoutError" || err?.name === "AbortError"
          ? `timed out after ${timeoutMs}ms`
          : scrub(err?.message || "network error");
        throw new TypedError("provider_error", `decisions call failed: ${reason}`);
      }

      if (!response.ok) {
        // Status only — never the body, which may echo step content.
        throw new TypedError("provider_error", `decisions endpoint returned HTTP ${response.status}`);
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new TypedError("unparseable_output", "decisions response is not valid JSON");
      }

      // fromJev returns { decision, confidence }; the provider adds its own
      // tier/model/mode so the envelope states who served the call. The
      // response's resolved build (typesafe/jev-1.13-<date>) is the more
      // precise decision-record fact when the endpoint reports it.
      const resolvedModel = typeof body?.model === "string" && body.model ? body.model : JEV_MODEL;
      return { tier: 1, model: resolvedModel, mode: "live", ...step.fromJev(body, mapped) };
    },
  };
}

// ── strict, typed parsers for the documented answer shapes ──────────────────

/**
 * noul answer → native probability of "true", or null. Measured live shape:
 * {type:"noul", noul: <number>}. A response without a numeric probability in
 * [0,1] is unparseable by contract — the caller (step.fromJev) turns null
 * into a typed error instead of guessing.
 */
export function probabilityOf(answer) {
  const p = answer?.noul;
  return typeof p === "number" && p >= 0 && p <= 1 ? p : null;
}

/**
 * choice answer → the chosen label from `allowed`, or null. Measured live
 * shape: {type:"choice", choice, probabilities: {...}, confidence}. The
 * explicit label field is preferred; falling back to the argmax of the native
 * probabilities distribution is still a measured reading, not a fabrication.
 */
export function choiceOf(answer, allowed) {
  const label = answer?.choice ?? answer?.label ?? answer?.answer;
  if (typeof label === "string" && allowed.includes(label)) return label;
  const probs = answer?.probabilities;
  if (probs && typeof probs === "object" && !Array.isArray(probs)) {
    let best = null;
    let bestP = -1;
    for (const [key, value] of Object.entries(probs)) {
      if (allowed.includes(key) && typeof value === "number" && value > bestP) {
        best = key;
        bestP = value;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * choice answer → native confidence, or null (absent/unmeasured stays null —
 * D3.6: measured only, never estimated).
 */
export function confidenceOf(answer) {
  const c = answer?.confidence;
  return typeof c === "number" && c >= 0 && c <= 1 ? c : null;
}

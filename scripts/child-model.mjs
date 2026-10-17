// scripts/child-model.mjs — which model a spawned squad child runs on
// (FOC-762/FOC-773). Pure decision over injected inputs: no process.env reads
// here, so the Supervisor's own ANTHROPIC_MODEL can never leak into the answer
// by accident — that inheritance was exactly the bug this replaces (run a93f
// put dev/test children on the Supervisor's model while the registry said
// `model: null`).
//
// Precedence (first hit wins):
//   1. explicit --model                         → source "--model"
//   2. settings overlay routing.<squad>.lead    → source "settings:routing.<squad>"
//   3. models.json routing for the squad's lead role, resolved through the
//      `ids` aliases (a per-provider alias map picks the active provider's id)
//                                                  → source "routing:<squad>"
//   4. providerEntry.defaultModel               → source "provider-default"
//   5. nothing configured                       → { model: null, source: null }
//
// childProviderEnv() builds the FRESH provider environment every child gets
// (FOC-773): a provider change in the settings overlay must be effective on the
// next spawn, so the child env is re-resolved at spawn time rather than
// inherited from the Supervisor's shell.
//
// FOC-607 adds the per-spawn model policy (assertModelPolicy). A named DEV
// role may not be --model'ed at all: a dev child's report is only as
// trustworthy as its model, and three recorded incidents started with a weaker
// --model slipping past the routing table — so the table (models.json
// routing.dev, or the settings overlay's routing.dev.lead) is the DEV model's
// ONLY source. The overlay stays allowed: routing.dev.lead is configuration
// reviewed in Settings, not a per-spawn flag slipped past the policy. Other
// squads may pass --model, but only for a model with a pricing row in
// config/models.json — an unpriced id costs UNKNOWN and silently diverges the
// record from the run. Routed ids (table or overlay) are deliberately NOT
// price-checked here: local/ollama providers route models that legitimately
// have no pricing row, and they keep surfacing in unpricedModels as before.

import { resolveProvider, formatSetLines } from "./provider-resolve.mjs";

// provider-resolve prints cmd-style `set "VAR=value"` lines for _lib.bat; the
// spawn path consumes the same lines so the two surfaces cannot drift. The
// value is greedy to the last quote — values with `=` inside survive.
const SET_LINE_RE = /^set "([A-Za-z_][A-Za-z0-9_]*)=(.*)"$/;

const isModelId = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Pick the model a squad child runs on.
 *
 * @param {object} params
 * @param {string} params.squad - squad name ("plan" | "dev" | "review" | "test")
 * @param {string|null} [params.explicitModel] - the --model flag value, if given
 * @param {object|null} [params.settings] - the settings overlay (fenix-settings)
 * @param {object|null} [params.modelsConfig] - parsed config/models.json
 * @param {string|null} [params.provider] - the active provider name (per-provider
 *   alias maps and the custom-provider fallback resolve against it)
 * @param {object|null} [params.providerEntry] - the active provider's entry
 *   (models.json `providers` map, or the overlay's `provider.custom`)
 * @returns {{ model: string|null, source: string|null }}
 */
export function childModelFor({ squad, explicitModel, settings, modelsConfig, provider, providerEntry }) {
  if (isModelId(explicitModel)) return { model: explicitModel.trim(), source: "--model" };

  const lead = settings?.routing?.[squad]?.lead;
  if (isModelId(lead)) return { model: lead.trim(), source: `settings:routing.${squad}` };

  // models.json routes ROLES to alias keys; the role supervisor-spawn launches
  // is the squad's worker, and the supervisor squad itself is routed via
  // "default". A "lead" key is accepted too, mirroring the overlay's shape.
  const entry = modelsConfig?.routing?.[squad];
  if (entry && typeof entry === "object") {
    let alias = entry.lead ?? entry.default ?? entry.worker;
    if (alias !== null && typeof alias === "object") alias = alias[provider] ?? null;
    if (isModelId(alias)) {
      // Alias → full model id through `ids`; a key already holding a full id
      // passes through unchanged (gen-model-map.mjs's resolve() semantics).
      const mapped = modelsConfig?.ids?.[alias] ?? alias;
      if (isModelId(mapped)) return { model: mapped.trim(), source: `routing:${squad}` };
      if (mapped !== null && typeof mapped === "object") {
        const perProvider = mapped[provider];
        if (isModelId(perProvider)) return { model: perProvider.trim(), source: `routing:${squad}` };
      }
    }
  }

  const defaultModel = providerEntry?.defaultModel;
  if (isModelId(defaultModel)) return { model: defaultModel.trim(), source: "provider-default" };

  return { model: null, source: null };
}

/**
 * The per-spawn model policy (FOC-607). Judges ONLY the explicit `--model`
 * request — routed ids (table or overlay) and a missing request pass untouched.
 * Pure over injected inputs: `hasPriceRow` is the supervisor-lib check of the
 * same name, injected so callers (and tests) need no models file on disk; it
 * returns `{ priced: boolean }` like the real one.
 *
 * @param {object} params
 * @param {string} params.squad - squad name ("plan" | "dev" | "review" | "test")
 * @param {string|null} params.requestedModel - the --model flag value, if given
 * @param {Function} params.hasPriceRow - (modelId) => { priced: boolean }
 * @returns {{ error: string, message: string }|null} a typed refusal, or null
 *   when the request is allowed
 */
export function assertModelPolicy({ squad, requestedModel, hasPriceRow }) {
  // Trimmed so `--model " z-ai/glm-5.3-flash"` is priced on the trimmed id,
  // consistent with childModelFor (which trims before returning). A
  // whitespace-only value counts as no request.
  const wanted = isModelId(requestedModel) ? requestedModel.trim() : null;
  if (wanted) {
    if (squad === "dev") {
      return {
        error: "model-override-banned",
        message:
          "named DEV roles take their model from the routing table " +
          "(config/models.json routing.dev, or the settings overlay routing.dev.lead) — " +
          "drop --model; FOC-607",
      };
    }
    if (hasPriceRow(wanted)?.priced !== true) {
      return {
        error: "model-unpriced",
        message:
          `--model ${wanted} has no pricing row in config/models.json — ` +
          "add the row or use a routed model; FOC-607",
      };
    }
  }
  return null;
}

/**
 * The provider environment a child is launched with — a FRESH resolution at
 * spawn time (FOC-773), not the Supervisor's inherited values, so a provider
 * switch in the settings overlay is effective on the next spawn. Built by
 * parsing the same set lines provider-resolve prints for the launcher, so the
 * CLI surface and this one stay one contract.
 *
 * @param {object} [options]
 * @param {string|null} [options.provider] - explicit provider name, passed to
 *   resolveProvider as its positional arg — which beats LA_PROVIDER env and the
 *   settings overlay. The spawn path records the name it resolved and the
 *   follow-up path replays it, so a resumed turn pins the SAME provider the
 *   first turn ran on even after a switch in the settings overlay.
 * @param {Function} [options.resolve] - injectable resolution (tests); defaults
 *   to resolveProvider (explicit arg > LA_PROVIDER env > overlay > openrouter)
 * @returns {object} env map on success, or `{ error }` when resolution failed —
 *   the caller refuses the spawn (fail closed: no child on a half-resolved provider)
 */
export function childProviderEnv({ provider, resolve = resolveProvider } = {}) {
  let resolved;
  try {
    resolved = provider ? resolve(provider) : resolve();
  } catch (err) {
    return { error: String(err?.message ?? err).split("\n")[0] };
  }
  if (!resolved.present || !resolved.authValue) {
    return { error: "Provider credential is missing; configure it in Settings before starting a child" };
  }
  // Clear inherited defaults when the new provider omits a tier/model.
  const env = {
    LA_PROVIDER_DEFAULT_MODEL: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
    ANTHROPIC_SMALL_FAST_MODEL: "",
  };
  for (const line of formatSetLines(resolved)) {
    const match = SET_LINE_RE.exec(line);
    if (match) env[match[1]] = match[2];
  }
  // Tolerant to either surface: a resolver that reports the default model but a
  // formatter that does not print it yet still yields the variable.
  if (env.LA_PROVIDER_DEFAULT_MODEL === undefined && isModelId(resolved.defaultModel)) {
    env.LA_PROVIDER_DEFAULT_MODEL = resolved.defaultModel;
  }
  return env;
}

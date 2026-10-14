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

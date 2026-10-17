// scripts/child-model.test.mjs — FOC-762/FOC-773 slice C: the child's model
// decision and the per-child provider environment.
//
// Pins: the full precedence chain (--model > overlay routing.<squad>.lead >
// models.json routing through the ids aliases > provider defaultModel >
// nothing), the Supervisor's ANTHROPIC_MODEL being ignored outright, alias
// resolution including per-provider alias maps, and childProviderEnv parsing
// the same set lines provider-resolve prints (plus its error contract).
//
// Run: node --test scripts/child-model.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertModelPolicy, childModelFor, childProviderEnv } from "./child-model.mjs";

const MODELS = {
  providers: {
    openrouter: { baseUrl: "https://openrouter.ai/api", authEnv: "OPENROUTER_API_KEY", defaultModel: "xiaomi/mimo-v2.6-pro" },
    nebul: { baseUrl: "https://api.inference.nebul.io", authEnv: "NEBUL_API_KEY" },
  },
  ids: {
    glm: "z-ai/glm-5.2",
    glm53flash: "z-ai/glm-5.3-flash",
    minimax: "minimax/minimax-m3",
  },
  routing: {
    dev: { recon: "glm53flash", implement: "glm53flash", worker: "glm53flash", flash: "glm53flash" },
    supervisor: { default: "glm", worker: "minimax" },
  },
};

test("an explicit --model wins over everything", () => {
  const pick = childModelFor({
    squad: "dev",
    explicitModel: "some/explicit-model",
    settings: { routing: { dev: { lead: "overlay/lead" } } },
    modelsConfig: MODELS,
    provider: "openrouter",
    providerEntry: MODELS.providers.openrouter,
  });
  assert.deepEqual(pick, { model: "some/explicit-model", source: "--model" });
});

test("the overlay's routing.<squad>.lead wins over models.json routing", () => {
  const pick = childModelFor({
    squad: "dev",
    explicitModel: null,
    settings: { routing: { dev: { lead: "overlay/lead-model" } } },
    modelsConfig: MODELS,
    provider: "openrouter",
    providerEntry: MODELS.providers.openrouter,
  });
  assert.deepEqual(pick, { model: "overlay/lead-model", source: "settings:routing.dev" });
});

test("models.json routing for the squad resolves through the ids aliases", () => {
  const pick = childModelFor({
    squad: "dev",
    explicitModel: null,
    settings: {},
    modelsConfig: MODELS,
    provider: "openrouter",
    providerEntry: MODELS.providers.openrouter,
  });
  assert.deepEqual(pick, { model: "z-ai/glm-5.3-flash", source: "routing:dev" });
});

test("the supervisor squad's lead role is routing.default, resolved through ids", () => {
  const pick = childModelFor({
    squad: "supervisor",
    explicitModel: null,
    settings: {},
    modelsConfig: MODELS,
    provider: "openrouter",
    providerEntry: MODELS.providers.openrouter,
  });
  assert.deepEqual(pick, { model: "z-ai/glm-5.2", source: "routing:supervisor" });
});

test("a routing alias that maps per provider picks the active provider's id", () => {
  const config = {
    ...MODELS,
    ids: { ...MODELS.ids, glm: { openrouter: "z-ai/glm-5.2", nebul: "zai-org/GLM-5.2-FP8" } },
    routing: { dev: { worker: "glm" } },
  };
  assert.deepEqual(
    childModelFor({ squad: "dev", settings: {}, modelsConfig: config, provider: "nebul" }),
    { model: "zai-org/GLM-5.2-FP8", source: "routing:dev" },
  );
  assert.deepEqual(
    childModelFor({ squad: "dev", settings: {}, modelsConfig: config, provider: "openrouter" }),
    { model: "z-ai/glm-5.2", source: "routing:dev" },
  );
});

test("an alias not in ids passes through as a full model id", () => {
  const config = { ...MODELS, routing: { dev: { worker: "vendor/full-model-id" } } };
  assert.deepEqual(
    childModelFor({ squad: "dev", settings: {}, modelsConfig: config, provider: "openrouter" }),
    { model: "vendor/full-model-id", source: "routing:dev" },
  );
});

test("the provider's defaultModel wins when nothing is routed", () => {
  const pick = childModelFor({
    squad: "review",
    explicitModel: null,
    settings: {},
    modelsConfig: MODELS,
    provider: "openrouter",
    providerEntry: MODELS.providers.openrouter,
  });
  assert.deepEqual(pick, { model: "xiaomi/mimo-v2.6-pro", source: "provider-default" });
});

test("a custom provider's defaultModel comes from its entry", () => {
  const pick = childModelFor({
    squad: "test",
    explicitModel: null,
    settings: { provider: { custom: { defaultModel: "custom/local-model" } } },
    modelsConfig: MODELS,
    provider: "custom",
    providerEntry: { defaultModel: "custom/local-model" },
  });
  assert.deepEqual(pick, { model: "custom/local-model", source: "provider-default" });
});

test("nothing configured yields { model: null, source: null }", () => {
  assert.deepEqual(childModelFor({ squad: "test", settings: {}, modelsConfig: MODELS, provider: "nebul", providerEntry: MODELS.providers.nebul }), {
    model: null,
    source: null,
  });
  assert.deepEqual(childModelFor({}), { model: null, source: null });
});

test("the Supervisor's ANTHROPIC_MODEL is never the answer", () => {
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = "supervisor/own-model";
  try {
    const pick = childModelFor({
      squad: "test", // no routing row, no provider defaultModel
      explicitModel: null,
      settings: {},
      modelsConfig: MODELS,
      provider: "nebul",
      providerEntry: MODELS.providers.nebul,
    });
    assert.equal(pick.model, null);
    assert.equal(pick.source, null);
  } finally {
    // Restore, never delete: the suite runs in the caller's process.
    if (prev === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = prev;
  }
});

// ── assertModelPolicy (FOC-607): the per-spawn --model policy ────────────────

test("assertModelPolicy refuses an explicit --model on a dev squad", () => {
  const refusal = assertModelPolicy({
    squad: "dev",
    requestedModel: "z-ai/glm-5.3",
    hasPriceRow: () => ({ priced: true }),
  });
  assert.equal(refusal.error, "model-override-banned");
  assert.match(refusal.message, /routing table/);
  assert.match(refusal.message, /drop --model/);
});

test("assertModelPolicy refuses an unpriced --model on a non-dev squad", () => {
  const refusal = assertModelPolicy({
    squad: "plan",
    requestedModel: "totally/unpriced-id",
    hasPriceRow: () => ({ priced: false }),
  });
  assert.equal(refusal.error, "model-unpriced");
  assert.match(refusal.message, /totally\/unpriced-id/);
  assert.match(refusal.message, /config\/models\.json/);
});

test("assertModelPolicy allows a priced --model on a non-dev squad", () => {
  const seen = [];
  const refusal = assertModelPolicy({
    squad: "plan",
    requestedModel: "z-ai/glm-5.3-flash",
    hasPriceRow: (id) => {
      seen.push(id);
      return { priced: true };
    },
  });
  assert.equal(refusal, null);
  assert.deepEqual(seen, ["z-ai/glm-5.3-flash"], "hasPriceRow runs against the requested id");
});

test("assertModelPolicy allows a dev squad without --model", () => {
  const refusal = assertModelPolicy({
    squad: "dev",
    requestedModel: null,
    hasPriceRow: () => {
      throw new Error("hasPriceRow must not be consulted without a requestedModel");
    },
  });
  assert.equal(refusal, null);
});

test("assertModelPolicy allows a non-dev squad without --model; hasPriceRow is never called", () => {
  let calls = 0;
  const refusal = assertModelPolicy({
    squad: "plan",
    requestedModel: null,
    hasPriceRow: () => {
      calls++;
      return { priced: true };
    },
  });
  assert.equal(refusal, null);
  assert.equal(calls, 0);
});

test("childProviderEnv parses the set lines provider-resolve prints", () => {
  const env = childProviderEnv({
    resolve: () => ({
      provider: "nebul",
      baseUrl: "https://api.inference.nebul.io",
      baseUrlSource: "config",
      authVar: "ANTHROPIC_AUTH_TOKEN",
      authEnv: "NEBUL_API_KEY",
      authStyle: "token",
      authValue: "nebul-key",
      present: true,
      tiers: { opus: "zai-org/GLM-5.2-FP8", sonnet: "zai-org/GLM-5.2-FP8" },
      defaultModel: "zai-org/GLM-5.2-FP8",
    }),
  });
  assert.equal(env.error, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.inference.nebul.io");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "nebul-key");
  // The inactive auth var is cleared, not left inherited.
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.LA_PROVIDER, "nebul");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "zai-org/GLM-5.2-FP8");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "zai-org/GLM-5.2-FP8");
  assert.equal(env.LA_PROVIDER_DEFAULT_MODEL, "zai-org/GLM-5.2-FP8");
  // Omitted tiers are cleared so the previous provider cannot leak through.
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "");
});

test("childProviderEnv passes an explicit provider to the resolver (beats env/overlay)", () => {
  const seen = [];
  const env = childProviderEnv({
    provider: "nebul",
    resolve: (name) => {
      seen.push(name);
      return {
        provider: "nebul",
        baseUrl: "https://api.inference.nebul.io",
        authVar: "ANTHROPIC_AUTH_TOKEN",
        authEnv: "NEBUL_API_KEY",
        authValue: "nebul-key",
        present: true,
        tiers: null,
      };
    },
  });
  assert.deepEqual(seen, ["nebul"], "the explicit name must reach resolveProvider as its positional arg");
  assert.equal(env.LA_PROVIDER, "nebul");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.inference.nebul.io");
});

test("childProviderEnv without a provider calls the resolver with no args", () => {
  const seen = [];
  childProviderEnv({
    resolve: (...a) => {
      seen.push(a.length);
      return { provider: "openrouter", baseUrl: "https://openrouter.ai/api", authVar: "ANTHROPIC_AUTH_TOKEN", authValue: "k", present: true, tiers: null };
    },
  });
  assert.deepEqual(seen, [0], "legacy resume path resolves the currently active provider");
});

test("childProviderEnv passes an explicit provider to the resolver (the follow-up's pin)", () => {
  const seen = [];
  const env = childProviderEnv({
    provider: "nebul",
    resolve: (name) => {
      seen.push(name);
      return {
        provider: "nebul",
        baseUrl: "https://api.inference.nebul.io",
        authVar: "ANTHROPIC_AUTH_TOKEN",
        authEnv: "NEBUL_API_KEY",
        authStyle: "token",
        authValue: "nebul-key",
        present: true,
        tiers: null,
      };
    },
  });
  // The explicit name is passed through as the resolver's first argument —
  // resolveProvider treats it as beating LA_PROVIDER env and the overlay.
  assert.deepEqual(seen, ["nebul"]);
  assert.equal(env.error, undefined);
  assert.equal(env.LA_PROVIDER, "nebul");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.inference.nebul.io");
});

test("childProviderEnv without a provider calls the resolver with no args", () => {
  const seen = [];
  childProviderEnv({
    resolve: (name) => {
      seen.push(name);
      return {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api",
        authVar: "ANTHROPIC_AUTH_TOKEN",
        authEnv: "OPENROUTER_API_KEY",
        authStyle: "token",
        authValue: null,
        present: false,
        tiers: null,
      };
    },
  });
  assert.deepEqual(seen, [undefined]); // today's active provider, not a pinned name
});

test("childProviderEnv returns { error } on a resolution failure", () => {
  const env = childProviderEnv({ resolve: () => { throw new Error('Unknown provider "nope" (valid: openrouter)'); } });
  assert.match(env.error, /Unknown provider "nope"/);
});

test("childProviderEnv refuses a missing credential before launching a child", () => {
  const env = childProviderEnv({
    resolve: () => ({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      authVar: "ANTHROPIC_AUTH_TOKEN",
      authEnv: "OPENROUTER_API_KEY",
      authStyle: "token",
      authValue: null,
      present: false,
      tiers: null,
    }),
  });
  assert.match(env.error, /credential is missing/);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

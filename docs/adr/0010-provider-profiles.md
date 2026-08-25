# ADR-0010 — Provider profiles in `config/models.json`

- **Status:** Accepted (2026-08-25)
- **Implements:** ADR-0001 roadmap item "Provider per squad"; PRD: `docs/ui/provider-config.md`
- **Supersedes:** the "OpenRouter only" scope of `docs/ui/dashboard-launcher-and-squad-config.md` (F2)

## Context

`bin/_lib.bat` hard-codes a single provider: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
`ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%` (plus the `NATIVE=1` override used by plan.bat).
`config/models.json::providers` (name → URL) exists but is read by nothing. ADR-0001's
constraint stands: **one Claude Code session = one provider** (one `ANTHROPIC_BASE_URL` per
process; subagent frontmatter `model:` selects a model, never a provider — ADR-0002).

Mateusz has access to other Anthropic-Messages-protocol APIs with different model catalogues
and prices and wants to point squads at them.

## Decision

1. **Provider profiles** live in `config/models.json::providers`:
   `name → {baseUrl, authEnv, authStyle?, models?}`. `baseUrl` is the exact
   `ANTHROPIC_BASE_URL` value; `authEnv` is the **name** of the env var holding the key
   (`token` style → `ANTHROPIC_AUTH_TOKEN`, `apikey` style → `ANTHROPIC_API_KEY`).
2. **Granularity = per squad.** A squad `.bat` carries `set "LA_PROVIDER=<name>"`;
   absence means `openrouter` (backward compatible). Unknown name or missing key env var →
   hard error at launch.
3. **Pricing is scoped per provider** (`pricing.<provider>.<modelId>`), keyed by the model ID
   exactly as telemetry records it — same model may be priced differently per provider.
4. **Secrets never enter `models.json`** (git-tracked) or the UI — only env-var names; key
   values stay in `.env`.
5. `NATIVE=1` behaviour is untouched; per-role providers and fallback chains stay deferred
   (would require supervisor-mode per-role processes, ADR-0009).

## Consequences

**Positive:** squads can use any Anthropic-protocol API (cost/catalogue freedom) with UI
editing; migration is backward compatible (no `LA_PROVIDER` line = today's behaviour);
telemetry costs stay truthful per provider.

**Negative / costs:** one-time `models.json` migration (flat pricing → per-provider nesting)
touching every pricing consumer (telemetry-store, squad-config, sync-model-prices,
cost-report, drift tests); model-ID validation must be provider-aware (OpenRouter slug vs
bare IDs); price auto-sync and OpenRouter Activity reconciliation remain OpenRouter-only;
mixing vendors within one squad still requires OpenRouter (it remains the default).

# PRD — Provider Configuration (squad-config)

- **Status:** Draft → implementation (MVP approved by Mateusz 2026-08-25; rev 2 incorporates
  architect review — flat-pricing consumer list completed, `setlocal`/`endlocal` export trap,
  `LA_PROVIDER` line position, `runs`/`model_prices` schema migrations, POST body cap)
- **Extends:** `docs/ui/dashboard-launcher-and-squad-config.md` (F2 — squad-config); supersedes its "provider is always OpenRouter" scope
- **Decision record:** `docs/adr/0010-provider-profiles.md`
- **Implements (partially):** ADR-0001 roadmap item "Provider per squad" (per-role provider and fallback stay deferred)

## 1. Problem

All squads launch through one hard-coded provider (OpenRouter): `bin/_lib.bat` sets
`ANTHROPIC_BASE_URL=https://openrouter.ai/api` and `ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%`
unconditionally (the only escape hatch is `NATIVE=1`). Mateusz has access to other
Anthropic-Messages-protocol APIs with **different model catalogues and different prices**.
Today there is no way to point a squad at such an API; `/squad-config` help text even states
"Provider to zawsze OpenRouter".

`config/models.json` already carries a `providers` map (`name → base URL`), but no code reads
it — it is a placeholder for exactly this feature (and its OpenRouter URL is stale:
`/api/v1` instead of the `/api` the SDK actually needs — see ADR-0002).

## 2. Scope

**In (MVP):**
- Provider profiles in `config/models.json`: OpenRouter + user-defined custom providers
  (any base URL speaking the Anthropic Messages API).
- **Per-squad** provider assignment, edited in `/squad-config`, persisted as a line in
  `bin/<squad>.bat` (+ `-dry` twin). Default when the line is absent: `openrouter`.
- **Model pickers pair with the provider** (explicit requirement): when a squad's provider is X,
  lead/agent model fields validate against X's model-ID format and take suggestions from X's
  model list — they are no longer assumed to be OpenRouter slugs.
- **Pricing scoped per provider** (same model may cost differently per provider). Manual entry
  in the UI for non-OpenRouter providers; auto-sync stays OpenRouter-only.
- Telemetry: provider recorded per run, displayed in the dashboard; cost math resolves prices
  per (provider, model).
- One-time migration of the existing flat config; every existing test/invariant keeps passing.

**Out (deferred):**
- Provider per role — needs one process per role (supervisor mode, ADR-0009). ADR-0001's
  "one session = one provider" stands.
- Fallback chains (`models.json::fallback`, ADR-0001 W5) — still unread by code.
- OpenAI-protocol providers without an Anthropic-compatible endpoint (custom entry must speak
  Anthropic Messages API; OpenAI-only APIs need an external gateway — not built here).
- Auto price sync for non-OpenRouter providers. `sync-model-prices.mjs` keeps operating on the
  OpenRouter scope only, but **must be migrated** to read/write `pricing.openrouter` (see §5).
- OpenRouter Activity reconciliation in `cost-report.mjs` (OpenRouter-only; local token-based
  cost math already covers every provider).
- Changing `NATIVE=1` semantics (plan.bat native branch stays exactly as today).
- `bin/agent.bat` / `bin/orchestrate*.bat` provider plumbing (standalone/legacy paths).

## 3. Config schema (normative)

`config/models.json` after migration (values illustrative; migration moves real data verbatim):

```json
{
  "_doc": "…",
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api",
      "authEnv": "OPENROUTER_API_KEY",
      "authStyle": "token"
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "authEnv": "ANTHROPIC_API_KEY",
      "authStyle": "apikey"
    },
    "zai_anthropic": {
      "baseUrl": "https://api.z.ai/api/anthropic",
      "authEnv": "ZAI_API_KEY",
      "authStyle": "token",
      "models": ["glm-5.2", "glm-5.3"]
    }
  },
  "ids":      "… unchanged (reference aliases) …",
  "routing":  "… unchanged (reference only, not consumed by launch) …",
  "pricing": {
    "openrouter": {
      "z-ai/glm-5.2": { "input": 0.6, "output": 2.2, "cacheRead": 0.04, "cacheWrite": 1.2 }
    },
    "zai_anthropic": {
      "glm-5.2": { "input": 0.5, "output": 2.0, "cacheRead": 0.05 }
    }
  },
  "fallback": "… unchanged, deferred …"
}
```

### Field rules

| Field | Rule |
|---|---|
| provider `name` | `^[a-z][a-z0-9_-]*$` — must be `.bat`-safe (lands in `set "LA_PROVIDER=…"`) |
| `baseUrl` | http(s) URL; **exact value** set as `ANTHROPIC_BASE_URL` (no `/v1` appending assumptions — ADR-0002) |
| `authEnv` | `^[A-Z][A-Z0-9_]*$` — **name of the env var** holding the key. Secrets NEVER in `models.json` (git-tracked) or the UI — only in `.env` |
| `authStyle` | `token` (default; `ANTHROPIC_AUTH_TOKEN`, Bearer — current OpenRouter path) or `apikey` (`ANTHROPIC_API_KEY`, x-api-key) |
| `models` | optional; list of model IDs as sent to that provider's API; drives UI suggestions |
| pricing key per provider | the model ID **exactly** as configured in `.bat`/frontmatter (that is what telemetry records) |
| pricing row | `{input, output, cacheRead?, cacheWrite?}` USD/1M tokens; numeric; `cacheRead ≤ input` (existing invariant; `0` allowed when price unknown) |

### Migration (one-time)

1. `providers`: `name → URL` string becomes `name → {baseUrl, authEnv, authStyle}` for all
   three existing entries (openrouter / anthropic / zai_anthropic). OpenRouter's `baseUrl` is
   corrected to `https://openrouter.ai/api` (the old `/api/v1` string was never consumed and is
   wrong for the SDK — ADR-0002).
2. `pricing`: all existing flat rows move under `pricing.openrouter` verbatim (count preserved).
3. No `LA_PROVIDER` lines are added to any `.bat` — absence = `openrouter` = byte-identical
   behaviour to today.

## 4. Behaviour spec

### 4.1 Launch (`bin/_lib.bat` + squad `.bat`)

- Squad `.bat` (main + `-dry` twin) carries `set "LA_PROVIDER=<name>"` **immediately before the
  `call "%~dp0_lib.bat"` line** — it must be set *before* `_lib.bat` runs. (Note: the
  `ANTHROPIC_MODEL` line sits *after* the call, so this needs a **dedicated writer function** in
  squad-config, not the lead-model rewrite mechanics.)
- `_lib.bat` resolves `LA_PROVIDER` (default `openrouter` when unset) and sets
  `ANTHROPIC_BASE_URL=<baseUrl>` plus the auth var per `authStyle`. Everything else it does
  today stays — in particular `CLAUDE_CODE_SUBAGENT_MODEL` remains cleared (ADR-0002).
- **setlocal trap:** `.env` is loaded inside `_lib.bat`'s `setlocal` block and only a fixed
  variable list survives the `endlocal &` export chain — a custom provider's key (e.g.
  `ZAI_API_KEY`) would be silently dropped. Resolution: a small **node resolver helper**
  (single source of truth) reads `models.json` + `.env`, and emits `set "VAR=…"` lines that
  `_lib.bat` consumes after `endlocal` (uniform for every provider; secret values are never
  echoed to the console — only set). The same helper doubles as the resolution check below.
- Unknown provider name at launch → **hard error** listing valid provider names (no silent
  fallback; config rot must be visible).
- Provider's `authEnv` unset in the environment → hard error naming provider + env var
  (same fail-fast shape as today's `OPENROUTER_API_KEY` check).
- `NATIVE=1` keeps precedence and its current clearing behaviour, unchanged.
- A demonstrable **resolution check** must exist (the resolver helper's dry mode): prints the
  resolved `ANTHROPIC_BASE_URL` + auth-var *presence* (not value) for a given `LA_PROVIDER`
  **without launching claude** — used by tests and manual verification. Build and validate this
  BEFORE rewriting `_lib.bat` (it is the risk-reduction step for the `.bat` mechanics).

### 4.2 UI (`/squad-config`)

- **Providers card** (new, above squads): list of providers (name, baseUrl, authEnv, authStyle,
  models count) + add/edit/remove. `openrouter` cannot be deleted (it is the default). Deleting
  a provider referenced by any squad → blocked with a clear message; deleting a provider also
  removes its pricing scope.
- **Squad cards**: provider `<select>` per squad (persisted through the existing POST path).
- **Model fields pair with provider**: lead + agent-role inputs validate per the squad's
  provider — `openrouter` keeps the existing `vendor/model` slug regex; custom providers accept
  `^[A-Za-z0-9._:/-]+$` (`.bat`/frontmatter-safe, no spaces/quotes/`%`). Suggestions (datalist)
  come from the provider's `models` list ∪ its pricing keys.
- **Pricing editor**: scoped per provider (provider selector/tabs); add/edit/remove rows;
  validation per §3.
- Switching a squad's provider shows a non-blocking warning listing role models that have no
  pricing row under the new provider (models are NOT auto-rewritten — Mateusz decides).
- Help panel rewritten: no more "Provider to zawsze OpenRouter"; explains authEnv → `.env`.

### 4.3 API (`telemetry-server.mjs`)

- `GET /api/squad-config` → adds `providers` and per-squad `provider`; `pricing` now nested per
  provider.
- `POST /api/squad-config` body gains `providers?` and `squads[].provider?`; validation per §3
  (provider exists, URL shape, env-var name shape, model-ID shape per provider). Rejection of a
  provider deletion referenced by a squad → 4xx with message. Existing localhost/same-origin
  guards unchanged.
- Slug validation must become **provider-aware**: `validateSlug` (OpenRouter `vendor/model`
  regex) is today called unconditionally for every lead/agent model — for a squad on a custom
  provider it must use the loose `^[A-Za-z0-9._:/-]+$` rule instead.
- The POST body cap for this endpoint is raised (e.g. 64 KB) so provider definitions with model
  lists plus per-provider pricing fit; the UI sends only changed sections where practical.
- `dryRun: true` behaves as today (validate + report, write nothing).

### 4.4 Telemetry & cost

- Run manifest records `provider` (string; from `LA_PROVIDER`, default `"openrouter"`;
  `NATIVE` runs keep the existing native flag/label path). This needs: a `provider` column on
  the `runs` table (`ALTER TABLE` migration, legacy rows default `'openrouter'`), the field in
  `run-manifest.mjs` `cmdStart()`, and `LA_PROVIDER` exported past `_lib.bat`'s `endlocal`
  chain. RunDetail shows the provider badge.
- Cost resolution order per event: exact `pricing[provider][model]` → fuzzy within that
  provider's scope → for legacy runs with no provider field: `pricing.openrouter` →
  cross-provider fuzzy (today's `resolvePrice` behaviour preserved for old data).
- **Price-set storage must survive the migration:** `pricingSnapshot()`/`ensurePriceSet()` in
  `telemetry-store.mjs` currently iterate the flat pricing map — fed the nested shape they would
  snapshot an *empty* price set and every cost becomes null. The `model_prices` table gains a
  `provider` column (legacy rows backfilled `'openrouter'`) and, while there, a
  `cache_write_price` column so `cacheWrite` stops being billed at the input rate.
- `sync-model-prices.mjs` operates on `pricing.openrouter` only (its compare + point-edit
  regex must target the nested scope); `cost-report.mjs` `loadPricing()` reads the
  `pricing.openrouter` scope; OpenRouter Activity reconciliation unchanged (documented
  limitation: direct providers reconcile via local telemetry only).

### 4.5 Invariants (`check.mjs`, `config-drift.test.mjs`)

- Every provider entry: valid `baseUrl` + `authEnv` (+ `authStyle` ∈ {token, apikey}).
- Every model in active use (squad lead `.bat` line, agent frontmatter) has a pricing row under
  **that squad's provider**.
- Round-trip test: POST→GET preserves `providers`/`ids`/`routing`/`fallback` (existing
  preservation tests extended to the new shape).

## 5. Acceptance criteria

1. Migrated `models.json`: all existing pricing rows present under `pricing.openrouter`
   (count preserved), three provider entries valid; `check.mjs` + full script test suite green.
   **Every flat-pricing consumer is migrated in the same slice** (leaving any one of them red
   blocks the whole change): `telemetry-store.mjs` (`pricingSnapshot`/`ensurePriceSet`/
   `resolvePrice`/`calculateCost` + `model_prices` schema per §4.4), `squad-config.mjs`
   (`readPricing`/`writePricing` provider-aware), `ledger.mjs` (`getPricing`), `sync-model-prices.mjs`
   (compare + point-edit target `pricing.openrouter`), `cost-report.mjs` (`loadPricing`),
   `config-drift.test.mjs` (three tests iterate flat pricing keys), and
   `squad-config-write.test.mjs` (fixture + assertions updated to the new provider object shape:
   `baseUrl`/`authEnv`/`authStyle` asserted after round-trip).
2. With no `LA_PROVIDER` anywhere, launch env resolution is byte-identical to today
   (OpenRouter) — demonstrated via the resolution check from §4.1.
3. Resolution check proves: custom provider → correct `ANTHROPIC_BASE_URL` + auth var per
   `authStyle`; missing auth env → named error; unknown provider → named error.
4. API round-trip: create a custom provider, assign a squad to it, add its pricing rows via
   POST → GET reflects all three; `.bat` (main + dry) carries the `LA_PROVIDER` line; invalid
   payloads rejected with clear messages.
5. UI builds and shows: Providers card, per-squad provider select, provider-scoped model
   suggestions, provider-scoped pricing editor, updated help text.
6. Telemetry: a run under a custom provider records it; RunDetail badge correct; cost computed
   from that provider's pricing; legacy runs (no provider field) compute costs unchanged.
7. No secret values anywhere in `models.json`, API responses, or logs — env-var **names** only.

## 6. Verification plan

- Repo test suite (`scripts/*.test.mjs`) + `scripts/check.mjs` green.
- `ui` build passes; boot `telemetry-server` and exercise GET/POST `/api/squad-config`
  (curl) including a provider switch.
- Manual (Mateusz): switch one squad to a custom provider in the UI, run its `-dry` bat, see
  the resolved provider in the resolution check / run detail.

## 7. Future work (explicitly deferred)

Provider per role (supervisor mode), fallback chains, multi-provider price auto-sync,
OpenAI-protocol gateway support, per-provider spend dashboards.

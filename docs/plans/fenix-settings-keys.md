# FOC-773 + FOC-778 + FOC-786 (+ FOC-762) — pluggable provider, key wizard, Settings

Date: 2026-10-13. Lane O after FOC-785 (Mateusz: several tasks per PR). Spec: `docs/ui/dashboard-v2-spec.md` §2, §3, §4.6,
§4.7, §6; `docs/ui/provider-config.md`. FOC-762 (lane B) is pulled in: without "a child's model comes from the routing
table" a routing change in Settings is not effective on the next spawn (FOC-786 AC1).

## Decisions (Mateusz, 2026-10-13)

* **Keys are written from the dashboard** — a security-boundary change Mateusz chose explicitly. Scope of the change:
  the host's `.fenix/secrets` is mounted **read-write into `fenix-api` only** (`/fenix-secrets`); `fenix-supervisor`
  keeps the read-only Compose secrets. Every write is validated live first; the value never appears in a response, a
  log line, telemetry or the UI after submit.
* **Provider and routing settings live in an overlay** `.fenix/config/settings.json` (`/fenix-config/settings.json` in
  Docker, `<repo>/.fenix/config/settings.json` natively), which survives `fenix update`; `config/models.json` stays the
  shipped baseline.
* **Repositories**: list + add (background clone with progress) + unmap (files stay).
* **Retention**: read-only in Settings (current policy + disk usage); FOC-780 stays in lane B.

## FOC-773 — provider = config

* `scripts/fenix-settings.mjs` (new): `settingsPath()`, `readSettings()`, `writeSettings(patch)` (atomic, schema
  validated, unknown keys refused) — `{ provider: { active, custom: { baseUrl, authStyle, keyName, tiers, defaultModel } },
  routing: { <squad>: { lead } } }`.
* `provider-resolve.mjs`: active provider = `LA_PROVIDER` env > overlay `provider.active` > `"openrouter"`; provider
  `custom` comes from the overlay (base URL, auth style, tiers, default model); a provider entry may declare
  `defaultModel` (the Supervisor's model when nothing else is set) — the entrypoint's hard-coded `xiaomi/mimo-v2.6-pro`
  default becomes the resolved default model.
* Keys for any provider: a generic Compose secret `provider_api_key` mapped at start to the active provider's `authEnv`
  (`openrouter_api_key` stays for OpenRouter; empty placeholder files are created by `fenix` so Compose never fails).
* Unpriced models stay `null` (pricing scope = the active provider's; a custom provider is unpriced unless priced).
* **FOC-762**: `supervisor-spawn` picks the child model as `--model` > overlay `routing.<squad>.lead` > `models.json`
  routing for the squad on the active provider > provider `defaultModel`; never inherited from the Supervisor; the child
  env gets a fresh provider resolution (base URL, auth, tiers) so a provider change is effective on the next spawn.
  `modelSource` records which rule won.

## FOC-778 — key wizard and validation

* `scripts/key-check.mjs` (new, injectable `fetch`): `checkProviderKey({ baseUrl, authStyle, key, model })` — one
  `POST /v1/messages` with `max_tokens: 1` on the cheapest tier (any Anthropic-compatible endpoint; OpenRouter also
  `GET /api/v1/key`); `checkLinearKey(key, { teamKey })` — `viewer` + the team; `checkGithubToken(token)` — `/user`,
  `X-OAuth-Scopes` (needs `repo` for classic tokens; fine-grained tokens reported as such). Results
  `{ ok, reason, details }` — never the key; network errors name the endpoint, not the header.
* `fenix keys` (bash): provider choice (configured providers + custom endpoint), the same checks via curl (team and
  scopes added), writes the secret files (0600) and the overlay; `fenix keys <name>` rotates one key.
* Leak check `scripts/key-leak-check.mjs`: given canary values, greps `docker inspect`, container logs, the telemetry
  store and spool, run tees and records, and the registry; prints only "found / not found" per surface.

## FOC-786 — Settings (`/settings/:section`)

Routes `scripts/settings-routes.mjs` (`handleSettingsRoute`, same guards as the Cockpit writes; bodies ≤ 8 KB):

* **Keys** — `GET /api/settings/keys` → `[{ name, label, present, lastCheck: { at, ok, reason } }]` (no values, no
  lengths); `POST /api/settings/keys/:name/validate` (checks the stored key); `PUT /api/settings/keys/:name` `{ value }` →
  live check → on success write `/fenix-secrets/<name>` **in place** (O_TRUNC, mode 0600 — keeps the inode the Compose
  bind mounts see) and update this process's env; refused key → 400 with the reason, nothing written. Last-check state
  kept in memory + `/data/settings/key-checks.json` (no values).
* **Provider & routing** — `GET/PUT /api/settings/provider` (active + custom), `POST /api/settings/provider/test` (live
  check with the stored key), `GET/PUT /api/settings/routing` (lead model per squad with price from the active provider's
  scope and the v1 benchmark data; unknown model → "unpriced", allowed but labelled). The v1 SquadConfig screen stays
  as "Advanced routing" (subagent roles, tools, pricing editor).
* **Repositories** — `GET /api/settings/repos` (name, origin, HEAD, branch, CodeGraph index state, worktree count,
  mapped Linear project); `POST /api/settings/repos` `{ url, project? }` → background `git clone --progress` job
  (`GET /api/settings/repos/jobs/:id`); `DELETE /api/settings/repos/:name/mapping` → removes the project mapping only.
* **Squads & prompts** — the v1 Prompts screen (edits land on the `/data/agents` volume, next spawn).
* **Retention** — `GET /api/settings/retention` → `cleanupPeriodDays` in force, transcript / telemetry / workspace disk
  usage and free disk; "managed by FOC-780" note.

UI: `ui/src/settingsModel.js` (pure) + `screens/Settings.jsx` + `components/settings/*`; key inputs are
`type="password"`, `autocomplete="off"`, cleared after submit, never kept in state after the request; the nav's Settings
area becomes `/settings/keys|provider|repos|squads|retention` with v1 SquadConfig / Prompts as sub-tabs.

## Slices (Flash workers)

* Wave 1: A overlay + provider resolution + secrets mapping · B `key-check.mjs` · D `fenix-repos.mjs` (+ fenix-projects
  `remove`) · E retention/disk-usage library.
* Wave 2: C FOC-762 spawn model + per-child provider env · F `fenix keys` · G `settings-routes.mjs` + compose mount +
  server registration · H Settings UI + nav.
* Wave 3: `key-leak-check.mjs`, docs (ACCESS, QUICKSTART, provider-config), registration, Flash review, integration.

## Verification

Unit + route + UI model tests; Windows `test-all` + Linux lane; `vite build`. Acceptance stack (fake API, canary dummy
keys): wrong key refused with the reason, right key (mock-accepted) written in place and seen by the Supervisor's next
spawn; provider switched to a custom Anthropic-compatible endpoint (the mock on another port) with no code or launcher
edit — next child uses it; routing change → next child's model; repo added via the UI (local bare repo URL) and
unmapped; retention numbers; **leak check: canaries absent from docker inspect, logs, telemetry, tees and records**;
browser pass over every section (no console errors).

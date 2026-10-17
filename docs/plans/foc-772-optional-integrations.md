# FOC-772 — optional integrations off by default: Atlas, Nebul, pisi workspace, personal memory

Owner: delivery owner (orchestrator), 2026-10-16. Branch `foc-772-integrations`, cut from `main` at #71. Parent FOC-768 (M8). Atlas, Nebul, the second Linear workspace and the personal memory are Mateusz's local setup; a developer installing Fenix 1.0.0 has none of them.

## Facts (recon 2026-10-15)

- **Atlas**: `config/atlas-mcp.json.template` is rendered by `bin/_lib.bat:38-45` on every launcher start from `ATLAS_VENV_PYTHON`/`ATLAS_ROOT`; with empty vars the placeholders stay literal and `bin/orchestrate-openrouter.bat:78` still passes `--mcp-config config\atlas-mcp.json`, so Claude Code reports a failed server (the session starts). Atlas is not in `.mcp.json`; children never see it. `agents/orchestrator/CLAUDE.md:30-36` tells the orchestrator to use `mcp__atlas__*`. No knob exists.
- **Nebul**: already opt-in — `provider-resolve.mjs:119-166` resolves the active provider as arg > `LA_PROVIDER` > `settings.provider.active` > `openrouter`; `child-model.mjs:148-156` fails closed on a missing credential. Pricing rows in `config/models.json` must stay (historical telemetry). The key wizard still lists nebul.
- **pisi**: `linear-client.mjs:59-97` picks `LINEAR_API_KEY_PISI` for workspace `pisi` and throws when it is missing; `work-board.mjs:529-583` treats that as a graceful stop, `telemetry-server.mjs:770-774` and the queue routes do not (error rows for pisi ids); `publish-linear-comment.mjs:175-188` writes to pisi when `LINEAR_WORKSPACE=pisi`; `config/projects.json:40-41` maps PISI; the wizard never asks for the key.
- **Personal memory**: repo-local `agents/orchestrator/memory/*` (shipped), referenced by `agents/orchestrator/CLAUDE.md:42-50` and the `memory-nav` skill; `fenix-seed-agents.mjs:57-66` copies every squad's `memory/` to the volume. Nothing reads `~/.claude/memory`; no hook reads a memory dir — absence is cosmetic today.
- Overlay whitelist (`fenix-settings.mjs`): `provider`, `routing` (+ `ownership`, `retention` on other open branches). Doctor requires only the three core keys. `docker/entrypoint.sh:12-29` already skips missing secrets silently — the pattern to copy.

## Design

1. **One switch per integration** — overlay key `integrations: { atlas: boolean, pisi: boolean, memory: boolean }`, every flag defaults to `false`; unknown sub-keys rejected. Nebul keeps its existing switch (`provider.active`), documented here, no new flag. `scripts/fenix-integrations.mjs`: `readIntegrations({ settings })` → `{ atlas, pisi, memory, nebul, source }` (`nebul` derived from the active provider), `integrationEnabled(name, { settings })`, CLI `show [--json]` and `enabled <name>` (exit 0 when on, 1 when off, 2 usage) so launchers can ask without parsing JSON.
2. **Atlas off** = absent: `bin/_lib.bat` renders `config/atlas-mcp.json` only when `enabled atlas` says so and removes a stale rendered file when off; `bin/orchestrate-openrouter.bat` passes `--mcp-config config\atlas-mcp.json` only when the file exists; `agents/orchestrator/CLAUDE.md` makes the Atlas delegation section conditional ("when `integrations.atlas` is on; otherwise plan and implement without the bridge"). `config/tool-norm.json` stays (inert).
3. **pisi off** = jointhubs only: `linear-client.mjs` exports `workspaceEnabled("pisi")`; `chooseApiKey` for pisi with the flag off returns a typed refusal `{ code: "integration-off" }` instead of throwing a missing-key error; the cross-workspace fallbacks in `telemetry-server.mjs`, `work-routes.mjs`/`work-board.mjs` and `publish-linear-comment.mjs` skip pisi when off (no error rows, no prompt); with the flag on and the key missing the current error stays (a misconfiguration, not an absence).
4. **memory off**: `fenix-seed-agents.mjs` skips `memory/` directories when `integrations.memory` is off (a clean volume carries no personal notes); `agents/orchestrator/CLAUDE.md` says the memory index is optional and absent by default. The committed `agents/orchestrator/memory/*` files stay in the repo for now — moving them out is Mateusz's call (they are his working notes), recorded as a follow-up.
5. **Doctor + launcher**: `fenix-doctor.mjs` adds one check `integrations`: for every enabled integration whose prerequisite is missing (`atlas`: `ATLAS_ROOT`/`ATLAS_VENV_PYTHON`; `pisi`: `LINEAR_API_KEY_PISI`) → WARN with the fix; all off → OK "none enabled". `fenix integrations [show|enable <name>|disable <name>]` forwards to the node CLI / `fenix-settings set`. The key wizard stops listing nebul unless `provider.active` is nebul already (out of scope beyond that).
6. **Docs**: this plan; `docs/QUICKSTART.md` one bullet (integrations are off; how to enable); `README.md` Atlas paragraph gets the flag; `docs/ACCESS.md` one line (Mateusz's overlay sets the three flags on).

## Acceptance (ticket)

1. Clean config (OpenRouter + Linear + GitHub only, no overlay key): `readIntegrations` → all off; `_lib.bat` renders nothing (unit test on the `enabled` CLI exit code); the Linear client, the board, the queue and the comment publisher treat pisi as absent without error rows — tests; the seed skips memory — test; doctor OK.
2. Enabling each flag restores today's paths — tests with the flag on (atlas render, pisi key selection, memory seeded).
3. Full Windows suite and the Linux lane green beyond the #75 reds.

## Rollout

After merge: Mateusz's overlay gets `integrations: { atlas: true, pisi: true, memory: true }` (`fenix-settings set integrations …`) before the next launcher start, so his setup keeps behaving as today.

## Out of scope

Moving the personal memory files out of the repo, the jointhubs.os / knowledge-base add-on, UI labels for the PISI workspace (cosmetic), removing nebul pricing rows.

# FOC-607 — spawn model policy: no `--model` on DEV roles, fail closed on unpriced ids, record requested vs served

Owner: delivery owner (orchestrator), 2026-10-15. Branch `foc-607-model-policy`, cut from `main` at #71. Parent FOC-466 (M1).

## Problem

`supervisor-spawn.mjs --model` accepts any id for any squad. A bad id does not fail closed: the turn starts on whatever the provider serves, the registry records the requested id, and the record and the run diverge silently. Three times on record a named DEV role came back on a weaker model and wrote a report nobody could trust. FOC-762 made the routing table the source of a child's model; this ticket makes the per-spawn override policy explicit and records what actually ran.

## Facts (recon 2026-10-15)

- `scripts/child-model.mjs:45-74` `childModelFor`: precedence `--model` > overlay `routing.<squad>.lead` > `config/models.json` `routing[squad]` (`lead ?? default ?? worker`, aliases via `ids`) > provider `defaultModel`. No squad refuses `--model`; a missing `--model` only warns (`supervisor-spawn.mjs:822-827`). No pricing check at spawn.
- Pricing rows: `config/models.json` `pricing.<provider>[id]`; `hasPriceRow(model)` in `scripts/supervisor-lib.mjs:742-759`; an unpriced id costs `null` (UNKNOWN) and lands in `unpricedModels` (`costFromResult :800-862`). The only hard pricing gate today is on hold options (`supervisor-gate.mjs:360-366`).
- Registry entry at spawn carries `model`, `modelSource`, `provider` (`supervisor-spawn.mjs:844-850`). The served model arrives in the child's `system/init` event and is read in `supervisor-watch.mjs:343-350` into a local `initModel`, used for pricing only — never persisted. The turn record gets only `endedAt`/`exitCode` (`:410`). `supervisor-status.mjs` prints no model field (`:224-248`). `supervisor-followup.mjs` passes `entry.model` back on resume (`:436`, `:456`).
- Provider env resolution is already fail-closed before any write (`supervisor-spawn.mjs:775-780`).

## Design

1. **Policy in `child-model.mjs`** — `childModelFor` (or a sibling `assertModelPolicy({ squad, requestedModel, resolved, hasPriceRow })`) returns a typed refusal instead of a model:
   - `squad === "dev"` and an explicit `--model` → `{ error: "model-override-banned", message }`: named DEV roles take their model from the routing table only (overlay `routing.dev.lead` is configuration, not a per-spawn flag, and stays allowed).
   - any other squad with an explicit `--model` whose id has no pricing row (`hasPriceRow`, injected) → `{ error: "model-unpriced", message }` naming the id and `config/models.json`.
   - routed ids (table or overlay) keep today's behaviour — they are curated with pricing; an unpriced routed id still shows up as `unpricedModels`, unchanged.
2. **Gate in `supervisor-spawn.mjs`** right where the model is resolved (`:812-819`), before any side effect (no worktree, no registry write, no child): a refusal → `failJson` with `error` = the policy code and a message that names the policy and the fix (drop `--model`, or add a pricing row). Follow-up turns are untouched (`supervisor-followup.mjs` reuses the pin).
3. **Record what ran** — `supervisor-watch.mjs` persists onto the current turn record, at turn end next to `endedAt`/`exitCode`: `requestedModel` (the `--model` the watcher received, i.e. the registry pin) and `initModel` (from `system/init`, `null` when the event never came). On `system/init` it may also patch `initModel` early so a crashed turn still shows what started.
4. **Surface it** — `supervisor-status.mjs` per-child snapshot gains `model`, `modelSource`, `initModel` (latest turn) and `modelDrift: true` when both are present and differ; the human/briefing output prints one line per drifted child: `model drift: requested <a>, served <b>`.
5. **Contract** — `agents/supervisor/CLAUDE.md`: one line — never pass `--model` to a DEV role; the routing table decides; an unpriced id is refused at spawn. `docs/supervisor-e2e-checklist.md`: one proof item (`node scripts/test-run.mjs child-model supervisor-spawn supervisor-watch supervisor-status`).

## Acceptance (ticket)

1. `supervisor-spawn.mjs --squad dev --model <anything>` → exit 1, `error: "model-override-banned"`, no child, no worktree, no registry entry — test.
2. `--squad dev` without `--model` → routing pin, `modelSource: routing:dev` visible in the entry — existing test stays green.
3. `--model <unpriced id>` on a squad that accepts `--model` → exit 1, `error: "model-unpriced"` — test; a priced explicit id still spawns.
4. Turn record carries `requestedModel` and `initModel`; `supervisor-status.mjs` surfaces both and `modelDrift` — tests with a mock child that emits `system/init` with a different model.
5. Full Windows suite and the Linux lane green beyond the #75 reds; lint 0 violations.

## Out of scope

The ladder rungs and routing table contents, `supervisor-followup.mjs` pin reuse, pricing rows, refusing unpriced routed ids (would break local/ollama providers without pricing).

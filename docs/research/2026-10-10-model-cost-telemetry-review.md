# Model and cost telemetry review — 2026-10-10

**Question (Mateusz):** do we track models correctly in telemetry? Children seem to inherit the
model class — is that how it should be? Plus: can the squads use CodeGraph and draw.io better?

**Method.** Read-only. Sources: every Supervisor run registry (`.state/supervisor/*/children.json`,
403 children, 2026-09-02 → 2026-10-10), the children's tee streams, their Claude Code transcripts
(lead + `subagents/`), and the live telemetry store opened `readOnly`. **Ground truth** = every
assistant message in the child's transcripts, deduplicated by `message.id`, priced with the runtime
price snapshot (`pricingSnapshot()` + `calculateCost()`, the same code the watcher and ingest use).
37 children have no transcript left on disk (30-day retention), so ground-truth totals cover 366.
The analysis scripts are in the session scratchpad, not in the repo (see T2/T3 for the repo check).

## Summary

| # | Finding | Severity |
|---|---|---|
| F1 | The **served** model is recorded correctly — every child's lead model in telemetry equals the model in its registry entry. | ok |
| F2 | Children **inherit the Supervisor's model** unless the Supervisor passes `--model`: 228 of 403 (57 %). 101 children ran on `xiaomi/mimo-v2.6-pro` while `config/models.json` routes every squad to `z-ai/glm-5.3-flash`. | medium |
| F3 | Subagents resolve a **model class (tier)** inherited from the Supervisor's environment. The `sonnet` tier is `google/gemini-2.5-flash-lite` (chosen for the permission classifier), so `general-purpose` / `Explore` and any `Task(model: "sonnet")` silently run on it. | medium |
| F4 | **Registry `costUsd` is 5.05× ground truth** ($781.85 vs $154.70) — the watcher sums `result` events whose `modelUsage` is cumulative for the session. | **high** |
| F5 | **Telemetry drops resumed turns**: exact for single-turn children (1.00 × ground truth), 0.25 × for multi-turn children, 0.42 × overall. | **high** |
| F6 | **FOC-477 arm-B baseline is 3.82× ground truth** (sum $7.51 vs $1.97) — it was taken from registry `costUsd`. Arm A is priced from OpenRouter `usage.cost`, so the comparison is biased toward arm A. | **high (campaign)** |
| F7 | **CodeGraph is barely used**: 0.1–3 % of search actions for subagents, 0.4–17 % for leads, 1.4 % for the Supervisor. | medium |
| F8 | draw.io: two credible options — the official `jgraph/drawio-mcp` plugin and `Agents365-ai/drawio-skill`. | decision |

## F1 — the served model is recorded correctly

`usage_facts.model` is `message.model` from the transcript line (`telemetry-ingest.mjs:277`), i.e.
what the provider reported as served. For all 397 children with telemetry rows, the lead's recorded
model equals `children.json → model`. Nothing to fix in the per-message model attribution.

Side note: the same model appears under dated and undated ids (`z-ai/glm-5.2` vs
`z-ai/glm-5.2-20260616`, `anthropic/claude-haiku-4.5` vs `anthropic/claude-4.5-haiku-20251001`).
Pricing resolves both; per-model grouping in reports does not. Low priority.

## F2 — children inherit the Supervisor's model

`supervisor-spawn.mjs:672-680`: without `--model`, the child takes `ANTHROPIC_MODEL` from the
Supervisor's process. The FOC-171-era fix records it truthfully (`modelSource:
"inherited:ANTHROPIC_MODEL"`) and prints a warning, but nothing resolves the squad's configured model.

| modelSource | children | lead model |
|---|---:|---|
| `inherited:ANTHROPIC_MODEL` | 228 | mimo-v2.6-pro 101 · glm-5.3-flash 121 · glm-5.3 6 |
| `--model` | 140 | glm-5.3-flash 121 · others 19 |
| none (pre-fix, 2026-09-02..05) | 35 | glm-5.3-flash |

So the squad's model is whatever the Supervisor happens to run on. `config/models.json` says
`routing.{plan,dev,review,test}.* = glm53flash`, and `routing.supervisor.default = glm`
(`z-ai/glm-5.2`), while `bin/supervisor.bat:25` defaults the Supervisor to `xiaomi/mimo-v2.6-pro` and
the dashboard edits the `.bat` (`squad-config.mjs`). Two sources of truth, and neither is read by
`supervisor-spawn`.

**Should it be like this? No.** A child's model must be a declared decision: routing config by
default, `--model` as an explicit override with a reason. If REVIEW should run on mimo, that belongs in
`routing.review`, not in the Supervisor's environment.

## F3 — subagents get a model *class* from the inherited tier environment

Children inherit `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` from
the Supervisor (provider `openrouter` tiers: opus/haiku/smallFast = glm-5.3-flash, **sonnet =
gemini-2.5-flash-lite**). Squad subagent definitions pin `model: z-ai/glm-5.3-flash` (all 23
code-touching ones), but:

- built-in agents (`general-purpose` inherits the caller's model, `Explore` uses a tier) and
- any `Task(..., model: "sonnet" | "opus" | "haiku")` call, which overrides the definition,

resolve through the tier. Observed since 2026-09-15 (subagent messages not on glm-5.3-flash):

| squad / agent | model | msgs | window |
|---|---|---:|---|
| supervisor / general-purpose | deepseek-v4.1-flash | 2 373 | 09-17..18 |
| dev / implementer | deepseek-v4.1-flash | 1 066 | 09-19..21 |
| supervisor / general-purpose | mimo-v2.6-pro (inherit) | 777 | 09-25..10-08 |
| dev / implementer | **gemini-2.5-flash-lite** | 399 | 09-20..28 |
| supervisor / general-purpose | **gemini-2.5-flash-lite** | 107 | 10-01..**10-10** |
| supervisor / Explore | **gemini-2.5-flash-lite** | 71 | 10-01 |
| dev / debugger, recon; review / worker | **gemini-2.5-flash-lite** | 133 | 09-15..30 |

October squad subagents are clean (100 % glm-5.3-flash); the Supervisor's own built-ins are not.
`gemini-2.5-flash-lite` is a classifier-grade model: work routed there by a class name is a silent
quality drop, and nothing in the record says "requested sonnet, got flash-lite".

## F4 — registry `costUsd` overstates cost 5×

`supervisor-watch.mjs` adds `costFromResult(event)` for **every** `result` event of a turn and adds the
turn total to the registry. Claude Code's `result.modelUsage` is **cumulative for the session**:

1. **Within one process** — every background-task wake-up ends in another `result` carrying the same
   cumulative usage. FOC-236 arm B (`plan-4`): 5 result events, each $0.139 → recorded $0.695.
2. **Across resumed turns** — the resumed turn's `result` again carries the whole session. Verified on
   `26c7/review-39`: turn-2 and turn-3 deltas of `modelUsage` equal the transcript's per-turn usage to
   the token (mimo input 38 302 / cache-read 737 536 for turn 2).

| children | registry | ground truth | ratio |
|---|---:|---:|---:|
| single-turn (237) | $67.62 | $34.83 | 1.94× |
| multi-turn (129) | $714.23 | $119.87 | 5.96× |
| **all (366)** | **$781.85** | **$154.70** | **5.05×** |

Worst: `0151/dev-3` (FOC-403, 15 turns) $295.37 recorded vs $33.73 true.

**Blast radius:** every "wycenione" number the Supervisor reports, the per-child cost in the run
registry and anything reading it (status/briefing, cost cap — overcount trips it early, which is the
safe direction), and the FOC-477 arm-B baseline (F6). `costFromResult` itself prices correctly; the
defect is summing cumulative snapshots.

## F5 — telemetry drops resumed turns

Per-message ingest is right: single-turn children match ground truth exactly (1.00). Multi-turn
children: telemetry holds $29.92 of $119.87 (0.25); 109 of 188 multi-turn children have their later
turns completely absent.

Root cause (traced in code): `supervisor-followup.mjs` reuses the child's `telemetryRunId`, and the
watcher ends the run again via `run-manifest end`. That second `run.ended` event has the same identity
as the first — `(run_id, source_kind="manifest", source_path=<manifest>, source_offset=1,
event_type="run.ended")` — so `eventAlreadyApplied` (`telemetry-store.mjs:1158-1173`) drops it.
`runs.ended_at` stays at the end of turn 1; five minutes later `settledRun`
(`telemetry-ingest.mjs:966`) treats the run as settled, and the transcript lines the resumed turns
append are never parsed. No data-quality issue is raised.

## F6 — FOC-477 arm-B baseline is inflated

`docs/research/foc-477-runs.json` records arm-B cost as registry `costUsd` ("priced/wycenione").
Against transcript ground truth:

| issue | turns | recorded | ground truth | × |
|---|---:|---:|---:|---:|
| FOC-236 | 1 | 0.6952 | 0.1390 | 5.00 |
| FOC-436 | 1 | 0.0489 | 0.0489 | 1.00 |
| FOC-240 | 1 | 0.1084 | 0.1084 | 1.00 |
| FOC-239 | 2 | 0.3462 | 0.0803 | 4.31 |
| FOC-132 | 2 | 0.7336 | 0.1168 | 6.28 |
| FOC-136 | 2 | 1.6236 | 0.1386 | 11.71 |
| FOC-403 | 1 | 0.1396 | 0.0698 | 2.00 |
| FOC-550 | 2 | 0.4820 | 0.2326 | 2.07 |
| FOC-688 | 5 | 3.3333 | 1.0305 | 3.23 |
| FOC-198 | 3 | 0.0749 | — transcript deleted | — |
| **sum (9)** | | **7.5108** | **1.9650** | **3.82** |

Arm A is priced from OpenRouter's per-call `usage.cost`, so a GO on the cost axis
(`A < B × 0.85`) would rest on a baseline overstated 1–12× per issue. This is baseline data, not the
graph-runner instrument; correcting it does not move the instrument boundary. FOC-198's baseline is
unrecoverable from transcripts. Its tee holds the result events: three cumulative values
0.023 → 0.045 → 0.009, non-monotone, so no safe reconstruction. It needs a conservative rule in the
protocol.

## F7 — CodeGraph is barely used

Share of CodeGraph calls among code-search actions (CodeGraph + Grep/Glob + shell grep/rg/find/cat),
telemetry since 2026-09-26 (resumed turns missing, see F5 — shares, not totals):

| squad | lead | subagents |
|---|---:|---:|
| supervisor | 1.4 % (49 vs 3 518) | 0.0 % |
| plan | 2.0 % | 0.8 % |
| dev | 17.0 % | 3.2 % |
| review | 0.4 % | 0.1 % |
| test | 8.3 % | 0.4 % |

Causes:

1. **No MCP tools outside linear-agents.** The guarded server is declared in this repo's `.mcp.json`;
   `jawnosc-wynagrodzen`, `post-fraud-model` and `wskm-skrypty-energetyka` have no `.mcp.json`, and
   `supervisor-spawn` passes no `--mcp-config`. Children there have no `mcp__codegraph__*` tools at
   all. Most of the 26c7 run's work was in `jawnosc-wynagrodzen`, where all 17 worktrees have an index.
2. **The fallback is buried.** Each squad `CLAUDE.md` has one ~900-character line that mentions the
   CLI (`node $LA_ROOT/scripts/code-intel.mjs … --project-root <worktree>`) in the middle of freshness
   caveats. Subagent definitions list the MCP tools but not the CLI.
3. **The Supervisor's contract has zero mentions** of CodeGraph or draw.io.

## F8 — draw.io options (GitHub, 2026-10-10)

| | `jgraph/drawio-mcp` (official) | `Agents365-ai/drawio-skill` |
|---|---|---|
| maintainer | draw.io makers (JGraph) | community |
| stars / license / last push | 5.6k / Apache-2.0 / 2026-10-10 | 10.1k / MIT / 2026-10-02 |
| what it is | Claude Code plugin (skill) writing native `.drawio`; optional PNG/SVG/PDF via draw.io Desktop CLI; MCP app/tool servers; ELK / libavoid layout passes | skill + `diagramctl` CLI: prompt → `.drawio`, 16 extractors (Python/JS/Go/Rust imports, Terraform/K8s, SQL DDL, OpenAPI…), incremental sync preserving manual layout, `drawiodiff` drift, Diagram-as-Test rules |
| surface | small | large (many Python scripts, optional MCP server) |
| fit | ad-hoc diagrams by agents | ideas for the release dossier (architecture delta between releases, layout-preserving sync) |

Both export through the draw.io Desktop CLI. Smart App Control already blocks `semgrep.exe`
intermittently; `drawio.exe` may hit the same wall, and the Docker image (`jgraph/drawio-mcp`) is the
fallback. Third-party skills run code, so read the code before installing.

## Proposed tasks

| id | task | priority | notes |
|---|---|---|---|
| T1 | Recompute the FOC-477 arm-B baseline from transcripts; add a conservative rule for FOC-198; record the method in the protocol | **High, before any counted arm-A run** | data correction, no instrument change |
| T2 | Watcher: child cost = priced transcript messages (dedup `message.id`, lead + subagents), **set** not add; keep `costUsdReported`; one-time recompute of `children.json` costs | High | acceptance: reconciliation check ≤ 1 % vs ground truth on all children with transcripts |
| T3 | Telemetry: a resumed turn must re-open the run (or end it with a per-turn event identity); one-time re-ingest of runs whose transcript grew past the parsed size | High | acceptance: multi-turn telemetry / ground truth ≥ 0.99 |
| T4 | `supervisor-spawn` resolves the squad model from `config/models.json` routing when `--model` is absent (`modelSource: "routing:<squad>"`); one source of truth for the Supervisor's own model | Medium | removes F2 |
| T5 | Children get tier variables = their squad model at spawn (they run `bypassPermissions`, no classifier); contract line "never pass `model` to Task"; record requested vs served model per delegation | Medium | removes F3 |
| T6 | CodeGraph for every child: `--mcp-config` with the guarded server at spawn (no edit to a foreign `.mcp.json`; spike first), a short "Code navigation" block at the top of each squad `CLAUDE.md`, code-touching subagent and Supervisor contract, a `code-intel:` line in the PINNED STATE prologue, a share-per-squad metric | Medium | baseline numbers in F7 |
| T7 | draw.io: install the official plugin for agent diagrams (after reading it); spike `drawiodiff` / sync from Agents365 for the release-dossier delta; check `drawio.exe` under Smart App Control | Low | ties to `docs/prd/release-dossier-prd.md` |

Linear (created 2026-10-10): T1 = FOC-759 (child of FOC-477, M2) · T2 = FOC-760 and T3 = FOC-761
(FOC-466, M1) · T4 = FOC-762, T5 = FOC-763, T6 = FOC-764 (FOC-470, M5) · T7 = FOC-765 (FOC-714, M7;
plugin review posted as a comment). Squads run on the models in `config/models.json` (Mateusz,
2026-10-10).

Ordering: T1 now (it gates FOC-477's cost axis). T2 + T3 together, because one reconciliation
script is the acceptance check for both. Then T4/T5, then T6. Instruction edits (T5/T6) to
`agents/plan/**` wait until the FOC-477 campaign ends — `plan.spec` runs as a PLAN child in arm A,
so changing its contract mid-campaign moves the instrument.

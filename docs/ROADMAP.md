---
type: roadmap
status: active
audience: Mateusz (decision) → Supervisor (execution order)
created: 2026-07-03
updated: 2026-10-08
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need.
---

# linear-agents — roadmap

<!-- roadmap:current:start — hand-written 2026-10-08; FOC-718 replaces this block with a render from Linear -->

## Current roadmap (2026-10-08)

Source of truth: Linear project **FENIX** (team Focus). One epic per milestone; order inside an epic = the
epic's order. Two lanes: **A** = critical path that needs Mateusz at gates, **B** = the Supervisor's
autonomous queue (one live child at a time).

| Milestone | Epic | Linear progress | State | What is left |
|---|---|---|---|---|
| M1 Foundations | FOC-466 | 67 % | in progress | FOC-598 (core landed, AC1b decision), FOC-511, FOC-512, FOC-607, FOC-616, FOC-626 (campaign) |
| M2 Graph engine + PLAN graph | FOC-467 | 88 % | closing | **FOC-477** (10 PLAN-graph runs with Mateusz at gates → go/no-go for M4), FOC-712 |
| M3 Jev at the gates | FOC-468 | 28 % | in progress | FOC-391, FOC-387, FOC-410, FOC-384, FOC-392 |
| M4 Delivery loop as a graph | FOC-469 | 0 % | waits for FOC-477 go | FOC-478, FOC-382, FOC-390, FOC-617, FOC-622, FOC-456, FOC-393, FOC-453, FOC-619, FOC-618, FOC-117 |
| M5 Slim DEV and Supervisor | FOC-470 | 14 % | in progress | **FOC-727–731 agent working state** (early, lane B), FOC-621 rest, FOC-623, FOC-610, FOC-611, FOC-647, FOC-455, FOC-479, FOC-457, FOC-388, FOC-389, FOC-395, FOC-454, FOC-394, FOC-458, FOC-635, FOC-691 |
| M6 Optimization and learning | FOC-471 | 27 % | data first | FOC-625, FOC-398, FOC-459, FOC-399, FOC-273, FOC-110, FOC-222, FOC-223, FOC-224 |
| M7 Release discipline and living docs | FOC-714 | 0 % | new 2026-10-08 | FOC-715–724 (planning templates, hygiene, CodeGraph → DrawIO dossier, Fenix 1.1) |
| Maintenance (standing) | FOC-472 | — | idle-lane only | FOC-726 (High), FOC-667 (High), FOC-602, FOC-642, FOC-604, FOC-606, FOC-615, FOC-725, FOC-461 + nits |

PRDs for the 2026-10-08 additions: `docs/prd/release-dossier-prd.md` (M7),
`docs/prd/agent-working-state-prd.md` (M5, FOC-727–731).

### Task sequence

**Lane A — critical path (needs Mateusz):**

1. FOC-477 — 10 PLAN-graph runs (arm A) on the frozen corpus, one at a time, Mateusz answers `plan.gate1`
   and `draft-approval` → report `docs/research/foc-477-plan-graph-vs-squad.md` → M2 Done → go/no-go for M4.

**Lane B — Supervisor queue (in this order):**

1. FOC-726 — supervisor-merge builds the combined tree across merge commits (every PR landing depends on it).
2. Land `dd96ad8` (event-loop test budget, FOC-461 nit 4) — already on `foc-477-q3-dev`.
3. FOC-667 — blocked scanner = one honest UNKNOWN state, not 13 reds (ends the known-red ritual).
4. FOC-512 — egress screen on PR bodies (PR landing flow is live since 2026-10-06).
5. FOC-716 — `create-child` inherits project + milestone (+ FOC-606 priority verb, same file).
6. FOC-727 → FOC-728 → FOC-729 — agent working state: store, base keys, re-injection after compaction.
7. FOC-715 — planning templates; milestone and epic descriptions rewritten.
8. FOC-717 — Linear hygiene report.
9. FOC-511 — SUPERVISOR_DENY gaps.
10. FOC-730 + FOC-621 remainder — one batch, needs Mateusz's OK for editing `agents/**`.
11. FOC-598 (after the AC1b decision) and FOC-607.
12. FOC-718 — ROADMAP render + STATE.md compaction.
13. FOC-719 → FOC-720 → FOC-721 — converter port, Fenix views, architecture delta.
14. FOC-722 → FOC-723 — release scope graph, release audit.
15. FOC-724 — Fenix 1.1 (M1 + M2) dossier, after FOC-477; FOC-712 and FOC-691 are scoped in or deferred there.
16. By the FOC-477 verdict: M4 (FOC-478 → FOC-382 → FOC-390 → FOC-617 → FOC-622 → FOC-456 → FOC-393 →
    FOC-453) or M3 (FOC-391 → FOC-387 → FOC-410 → FOC-384 → FOC-392).

**Idle-lane fillers:** FOC-602, FOC-642, FOC-604, FOC-615, FOC-616 (budgeted), FOC-626 (cost gate),
FOC-647 (research), FOC-635 and FOC-731 (after 10 real tasks).

### Decisions (2026-10-08)

Taken by Mateusz:

1. **FOC-477 runs start now** — right after the `dd96ad8` fix lands. The Supervisor is the frontman (that is
   the measured setup); Mateusz answers the gates. `config/graph.json`, `config/decisions.json` and
   `config/models.json` are frozen until the 10th run is recorded.
2. **Editing `agents/**` is allowed** (FOC-621 remainder + FOC-730).
3. **No cost gates for now** — priced cost is still recorded and reported; nothing waits on a cost gate
   (FOC-626 campaign may run as an idle-lane filler).
4. **FOC-691 (`plan.intent` model/tier policy) needs a deeper analysis first** — no model or tier change
   until then.

Still open:

5. FOC-598 AC1b — recommended (b): close on the landed core, file the key redesign separately.
6. Push of local `main` (ahead of `origin/main`).

<!-- roadmap:current:end -->

---

## Historical (2026-07-03 → 2026-09-12) — superseded by the section above

State then: 5 squads proven end-to-end (PISI-98, JOI-51 wave), observability dashboard live
(Live/Timeline/Runs/Costs/Tasks/Flow + /api/launch), telemetry accurate after repair wave
(kickoff inference, reconcile, delegation policy, cold-start discovery). Dashboard UI redesigned
to design-system v2 (sidebar shell, Flow log drawer). Costs measured live in dashboard. Known
hazards being closed under Fenix v2.

---

## Plan index (consolidated — single source of truth)

Fenix v2 epic = **JOI-73**. This table maps every workstream to its defining doc and Linear tasks.
Docs live under `docs/`; each task's description also names its doc path.

| Workstream | Linear | Doc (source of truth) | Status |
|---|---|---|---|
| Worktree-per-dev-run | ~~JOI-75~~ → **FOC-119** | `docs/plans/brainstorm-graph-engineering.md` (D) | **superseded 2026-08-25** — worktree is assigned by the Supervisor at spawn, not by `dev-branch.mjs` |
| Run lifecycle closed at source | JOI-76 | this file §NOW.2 | planned |
| plan.bat NATIVE-by-default | JOI-77 | `docs/adr/0001-provider-routing-and-fallback.md` | planned |
| OpenRouter mgmt key → reconcile | JOI-78 | `docs/decisions/cost-optimization.md` | needs:access |
| GLM cacheRead price | JOI-79 | `docs/decisions/cost-optimization.md` | planned |
| Delegation watch ≥40% | JOI-80 | `docs/decisions/cost-optimization.md` | planned |
| UI debt (lead label, headers, tooltip) | JOI-81 | — | **done via UI redesign v2 (2026-07)** |
| GCP VM agent-runner | JOI-82 | `docs/ops/remote-agent-execution.md` | needs:decision (VM) |
| PILOT office/asystent urzędnika | JOI-83 | this file §NEXT.5 | blocked by JOI-75 |
| L2/L3 remote + terminal | JOI-84 | `docs/ui/control-plane-plan.md` | blocked by JOI-82 |
| HITL inbox in dashboard | JOI-85 | `docs/ui/control-plane-plan.md` §3.3 + `docs/ui/ux-design-v3.md` §7 | planned |
| CADENCE weekly on pilot | JOI-86 | this file §NEXT.8 | planned |
| Flow log drawer Phase 2 | JOI-92 | `docs/ui/ux-design-v3.md` (Flow) | planned |
| **Graphify + ThoughtMap context maps** | **JOI-167** | `docs/plans/brainstorm-graphify-thoughtmap-integration.md` (C) | approved, planned |
| Learning miner S1 (specialization) | JOI-91 | `docs/plans/brainstorm-specialization-learning.md` (B) | approved, planned |
| Autonomous dispatcher | *(not yet decomposed)* | `docs/plans/brainstorm-autonomous-dispatch.md` (A) | brainstorm draft |
| **Graph engineering — Supervisor as graph runtime** | **FOC-116 · FOC-159** | `docs/plans/brainstorm-graph-engineering.md` (D) | approved, decomposed 2026-08-25 |

Brainstorm docs A/B/C/D are the **Fenix v3 direction** (autonomy · learning · context maps · graph
engineering). A and B are drafts; **C is approved and decomposed under JOI-73** (foundational, feeds
the pilot); **D is approved and decomposed under FOC-116 / FOC-159** in the Focus team. Cost
analysis: `docs/decisions/cost-optimization.md`. Delegation policy lives in each `agents/*/CLAUDE.md`.

> **Status of this file (2026-08-25):** the active Fenix line moved to team **Focus**, project
> **FENIX**, epic **FOC-102 "[ FENIX ] 1.0.0"**. JOI-73 "Fenix v2" was, in Mateusz's words, "in a
> sense only a brainstorm" — it still holds 16 open tickets that need reviewing one by one, not
> closing wholesale: some are genuinely dead (JOI-81 landed via UI redesign v2; JOI-85 HITL inbox is
> partly absorbed by the Supervisor gate relay), some are alive and unrelated to the Supervisor
> (JOI-167 context maps, JOI-210 quality signal, JOI-78/79 cost work). Until that review happens,
> treat the NOW/NEXT/LATER sections below as historical.

---

## NOW (1–2 tyg.) — reliability for real workloads

1. **Worktree-per-dev-run** (top priority). Shared working tree = agents commit each other's
   changes and switch branches under a live run (observed twice). `dev-branch.mjs start` should
   create `git worktree add ../la-wt/<branch>` and the run works there; cleanup is `supervisor-cleanup.mjs`, behind TEST-pass + Mateusz's yes (FOC-167 — not on handoff, which the return edges still need).
   AC: two dev runs in parallel produce two clean, disjoint commits.
2. **Run lifecycle closed at source.** Launcher wrapper runs claude via `start /wait` + always
   calls `run-manifest end` (kills the zombie class); `reconcile-runs.mjs` wired into
   telemetry-server startup as safety net. Live/Timeline switch to `lastActivityAt`.
3. **Cost levers armed:** plan.bat NATIVE-by-default (subscription Opus; `OR=1` escape);
   OpenRouter management key in `.env` → `cost-report.mjs` reconcile vs ledger; real GLM
   `cacheRead` price in models.json. Watch delegation ≥40% on new runs; if leads still grind,
   tighten kickoffs (worker/flash-first).
4. Small UI debt: `_lead`→"lead" label, Runs header layout, ambiguous badge tooltip.

## NEXT (2–6 tyg.) — production pilot + control plane

5. **PILOT: office / "asystent urzędnika" through the squads.** 5–10 real Linear tasks
   end-to-end, launched from the Tasks tab. Measure per task: cycle time, $, review rounds,
   HITL waits. This IS the product test. Every friction → a JOI task (pull-based).
6. **L2 remote sessions** (blocked on GCP VM decision): spawn-agent.yml interactive-tmux,
   attach from dashboard run card. **L3**: read-only terminal tail + `##NEEDS-INPUT` alert.
7. **HITL inbox in dashboard (P4):** list `needs:*` tasks + answer/approve write-back via
   linear-ops — cuts the longest dead time (agent waiting for Mateusz).
8. Weekly CADENCE run against the pilot (digest: throughput, $/task, drift) — the roadmap's
   feedback loop.

## LATER (kwartał) — scale and meta

9. **Meta-agent (L4):** watches tmux sessions, answers routine prompts per policy file, audit
   log, Discord escalation. Prereq: L2+L3 + NEEDS-INPUT protocol proven.
10. PR-driven review loop (Copilot) + release versioning / QA sessions / dual sign-off
    (docs/backlog/pr-review-loop-release-versioning.md) — only if pilot shows review squad
    insufficient.
11. Multi-project scale-out: more repos/workspaces on one dashboard (dimensions already exist).
12. Productization (setup script, docs for a second operator) — only if wanted.

## Anti-goals (explicitly not now)
- No new squads until the 5 existing ones run the pilot cleanly.
- No SSE/websockets while 5 s poll suffices. No UI framework changes.
- No meta-agent before terminal visibility (L3) proves the data it would act on.

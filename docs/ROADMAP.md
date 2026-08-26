---
type: roadmap
status: proposal
audience: Mateusz (decision) → PLAN squad (decompose under JOI-51 / new epics)
created: 2026-07-03
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need.
---

# linear-agents — roadmap (Now / Next / Later)

State today: 5 squads proven end-to-end (PISI-98, JOI-51 wave), observability dashboard live
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

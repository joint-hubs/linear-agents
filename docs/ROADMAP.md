---
type: roadmap
status: proposal
audience: Mateusz (decision) → PLAN squad (decompose under JOI-51 / new epics)
created: 2026-07-03
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need.
---

# linear-agents — roadmap (Now / Next / Later)

State today: 5 squads proven end-to-end (PISI-98, JOI-51 wave), observability dashboard live
(Live/Timeline/Runs/Costs/Tasks + /api/launch), telemetry accurate after repair wave
(kickoff inference, reconcile, delegation policy). Costs: $181 to date, lead-heavy (fix shipped,
measuring). Known hazards: shared working tree, zombie manifests at source, subscription unused
for plan.

## NOW (1–2 tyg.) — reliability for real workloads

1. **Worktree-per-dev-run** (top priority). Shared working tree = agents commit each other's
   changes and switch branches under a live run (observed twice). `dev-branch.mjs start` should
   create `git worktree add ../la-wt/<branch>` and the run works there; cleanup on handoff.
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

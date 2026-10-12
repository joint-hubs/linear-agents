---
type: roadmap
status: active
audience: Mateusz (decision) → Supervisor (execution order)
created: 2026-07-03
updated: 2026-10-12
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need.
---

# linear-agents — roadmap

<!-- roadmap:current:start — hand-written 2026-10-12; FOC-718 replaces this block with a render from Linear -->

## Current roadmap (2026-10-12, evening revision — 1.0.0 first)

Source of truth: Linear project **FENIX** (team Focus). Order = `blocked by` relations; every scheduled task
carries a due date. Three lanes run at once; each lane is a chain, cross-lane links are named below.

**Priority: Fenix 1.0.0** (Mateusz, 2026-10-12). M7 comes after the release: the 1.0.0 dossier is written by hand
in FOC-790, and the M7 tooling cuts the next release (1.1, FOC-724) with 1.0.0 as its baseline.

| Milestone | Epic | Target | What decides it |
|---|---|---|---|
| M1 Foundations | FOC-466 | 2026-11-15 | cost truth (FOC-760/761, lane O), egress PR path (FOC-512), deny gaps (FOC-511), model overrides (FOC-607) — all by 10-21 |
| M2 Graph engine + PLAN graph | FOC-467 | 2026-11-13 | FOC-801 fix → FOC-477 (10 arm-A runs, report, go/no-go) → FOC-712 |
| M3 Jev at the gates | FOC-468 | 2027-01-16 | starts after FOC-724, by the FOC-477 verdict |
| M4 Delivery loop as a graph | FOC-469 | 2027-03-31 | starts after FOC-724, by the FOC-477 verdict |
| M5 Slim DEV and Supervisor | FOC-470 | 2027-05-31 | agent working state FOC-727–730 in lane B before the tag |
| M6 Optimization and learning | FOC-471 | 2027-10-31 | data first; no scheduled work |
| M7 Release discipline and living docs | FOC-714 | 2026-12-15 | after the tag: FOC-715 → … → FOC-723 → FOC-724 (the 1.1 dossier) |
| **M8 Fenix 1.0.0 — portable release** | FOC-768 | **2026-11-19** | lane O + lane B's 1.0 slice (FOC-762/779/780) → FOC-789 → FOC-790 (tag) |

### Lane O — Fenix 1.0.0 build (orchestrator session with Mateusz)

| Due | Task |
|---|---|
| 10-13 | FOC-807 Docker Supervisor run id (waker, guard, briefing) |
| 10-14 | FOC-803 Linux hosts with uid ≠ 1000 |
| 10-16 | FOC-784 Work board |
| 10-19 → 10-21 | FOC-760 registry cost from transcripts → FOC-761 resumed turns in telemetry (+ FOC-759 arm-B baseline) → FOC-769 Supervisor focus ticket |
| 10-23 | FOC-785 Costs & quality |
| 10-26 → 10-30 | FOC-773 pluggable provider → FOC-778 key wizard → FOC-786 Settings → FOC-788 human push / PR |
| 11-02 → 11-04 | FOC-771 Node entry points → FOC-772 optional integrations → FOC-808 VM hygiene |
| 11-06 → 11-10 | FOC-802 child isolation → FOC-791 Team → FOC-787 Insights |
| 11-11 | FOC-809 sizing on a dev-squad run |
| 11-12 → 11-13 | FOC-775 image on GHCR (release candidate) → FOC-777 `update` pulls the pinned image |
| 11-16 → 11-17 | FOC-789 fresh-machine acceptance on the published image → FOC-781 docs |
| 11-18 | buffer for acceptance snags |
| 11-19 | FOC-790 release notes, hand-written dossier, tag `v1.0.0` |

### Lane A — FOC-477 measurement (Supervisor as frontman, Mateusz at the gates)

FOC-801 (10-14; it killed arm-A attempt 5, the first counted run) → 10 arm-A runs, one at a time → FOC-759
baseline (10-20, needs FOC-760) → FOC-477 report + go/no-go (10-30) → FOC-712 (11-06) → M2 done.

### Lane B — Supervisor queue (one live child at a time)

1. **Before the tag, 1.0 first:** FOC-512 (10-15) → FOC-511 (10-19) → FOC-607 (10-21) → FOC-762 (10-23) →
   FOC-779 (10-27) → FOC-780 (10-29; blocks FOC-789). FOC-762/779/780 moved here from lane O: self-contained,
   no dashboard work, and they shorten lane O by three days. If lane B is more than a week late on them, lane O
   takes them back.
2. **Then M5 agent working state:** FOC-727 (11-02) → FOC-728 (11-04) → FOC-729 (11-06) → FOC-730 + FOC-621
   rest (11-10).
3. **After the tag, M7:** FOC-715 (11-23) → FOC-717 (11-25) → FOC-718 (11-27) → FOC-719 (12-01) →
   FOC-720 (12-03) → FOC-721 (12-07) → FOC-722 (12-09) → FOC-723 (12-11) → FOC-724 1.1 dossier (12-15).
   Then by the FOC-477 verdict: M4 (FOC-478 → 382 → 390 → 617 → 622 → 456 → 393 → 453) or M3
   (FOC-391 → 387 → 410 → 384 → 392); both chains are in Linear without dates.

**Idle-lane fillers (no dates; 11-10 → 11-23 in lane B):** FOC-602, FOC-642, FOC-604, FOC-615, FOC-616,
FOC-626, FOC-647, FOC-635, FOC-731.

### Changes on 2026-10-12

* Landed but still open in Linear, closed with their commit: FOC-726 (`659ad72`), FOC-667 (`367ac52`),
  FOC-733 (`4bc5bc2`), FOC-758 (`d9f6cc2`), FOC-716 + FOC-606 (`0023a25`); FOC-794 (pi recon delivered);
  FOC-804 (PR #63, `a5db96d`).
* 16 tasks of other products moved out of FENIX to their parents' projects (TRADING, BIZNES, NEO); FOC-442 and
  FOC-460 (n8n deploy, parent FOC-157 "[NEO] deploy na V&V") to NEO.
* New from the GCP VM run: FOC-802, FOC-803, FOC-807, FOC-808, FOC-809.
* Evening revision (Mateusz: M7 later, 1.0 first): FOC-790 no longer waits for FOC-724; FOC-724 is back to
  being the 1.1 dossier; lane B takes FOC-762/779/780 before M5 and M7; M8 2026-12-01 → **2026-11-19**,
  M7 2026-11-27 → 2026-12-15.
* Fixed a dependency cycle: FOC-775 ← FOC-789 ← FOC-777 ← FOC-775. The image goes to GHCR first and the
  acceptance run uses the published image.
* Dates assume one task per working day in lane O and two per task in lane B; lane B shares the Supervisor
  with product work (jawnosc-wynagrodzen), so its dates move when the Supervisor works elsewhere.

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

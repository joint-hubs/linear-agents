---
type: roadmap
status: active
audience: Mateusz (decision) → delivery owner (orchestrator session, since 2026-10-15); the Supervisor is the frontman for other products only
created: 2026-07-03
updated: 2026-10-15
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need.
---

# linear-agents — roadmap

<!-- roadmap:current:start — hand-written 2026-10-15; FOC-718 replaces this block with a render from Linear -->

## Current roadmap (2026-10-15 revision — one owner, task workspaces in 1.0, tag 2026-12-03)

Source of truth: Linear project **FENIX** (team Focus). Order = `blocked by` relations; every scheduled task
carries a due date. **One delivery owner** since 2026-10-15 (Mateusz: "chcę żebyś Ty był odpowiedzialny za
delivery"): the orchestrator session plans, delegates to Flash workers, opens PRs and keeps Linear and this file in
sync; Mateusz merges and answers gates. The Supervisor is the frontman for other products (jawnosc-wynagrodzen,
WSKM) and takes **no Fenix task** from this point; lane B is folded into lane O.

**Priority: Fenix 1.0.0 with task workspaces as a pillar** (Mateusz, 2026-10-15, option b). PR #71 delivered the
task-workspace stream (FOC-816: one Supervisor per task, task cockpits, tool profiles, statistics, semantic map)
outside the 2026-10-12 plan; it stays in 1.0, the fresh-machine acceptance covers both modes (legacy single
Supervisor and two task sessions side by side), and the tag moves from 11-19 to **12-03**. M7 comes after the tag.

| Milestone | Epic | Target | What decides it |
|---|---|---|---|
| M1 Foundations | FOC-466 | 2026-11-15 | cost truth done (FOC-760/761/769); egress PR path (FOC-512), deny gaps (FOC-511), model overrides (FOC-607) — lane O, by 10-21 |
| M2 Graph engine + PLAN graph | FOC-467 | 2026-11-20 | FOC-801 landed (PR #72) → arm-A attempt 7 on boundary `e0f8b40` → 10 counted runs (Mateusz at the gates) → FOC-759 → FOC-477 report + go/no-go → FOC-712 |
| M3 Jev at the gates | FOC-468 | 2027-01-16 | after FOC-724, by the FOC-477 verdict |
| M4 Delivery loop as a graph | FOC-469 | 2027-03-31 | after FOC-724, by the FOC-477 verdict |
| M5 Slim DEV and Supervisor | FOC-470 | 2027-05-31 | FOC-762 done; agent working state FOC-727–730 after the tag |
| M6 Optimization and learning | FOC-471 | 2027-10-31 | data first; no scheduled work |
| M7 Release discipline and living docs | FOC-714 | 2027-01-15 | after the tag: FOC-715 → … → FOC-723 → FOC-724 (the 1.1 dossier); dates re-planned in December |
| **M8 Fenix 1.0.0 — portable release** | FOC-768 | **2026-12-03** | lane O → FOC-789 (both modes) → FOC-781 → FOC-790 (tag) |

### Lane O — Fenix 1.0.0 build (delivery owner; Flash workers; Mateusz merges)

| Due | Task |
|---|---|
| 10-16 | PR #72 FOC-801 landing merged; `main` green again (gate-answer regression from #71, pinned-state test, claims flake); push from the dashboard hardened (`actor: ai` opt-in + token, child deny list) |
| 10-19 → 10-20 | FOC-512 egress PR path (Urgent) → FOC-511 deny-list gaps (Urgent) |
| 10-21 | FOC-607 `--model` overrides fail closed |
| 10-22 → 10-23 | FOC-779 generated artifacts → FOC-780 retention |
| 10-26 | FOC-772 optional integrations off by default |
| 10-27 → 10-28 | FOC-771 Node entry points replace the .bat launchers |
| 10-29 → 10-30 | FOC-802 child isolation in the container |
| 11-02 → 11-04 | FOC-791 Team → FOC-787 Insights |
| 11-05 → 11-06 | FOC-808 VM resource hygiene |
| 11-09 → 11-10 | FOC-839 task workspaces 1.0 hardening (legacy single-session compatibility suite, migration, QUICKSTART for task cockpits, FOC-816 residue) |
| 11-12 | FOC-809 sizing on a dev-squad run (needs the VM and Mateusz's consent for the sampler) |
| 11-13 → 11-16 | FOC-775 image on GHCR (release candidate) → FOC-777 `update` pulls the pinned image |
| 11-17 → 11-27 | FOC-789 fresh-machine acceptance on the published image, both modes (snags become tasks) |
| 11-30 → 12-01 | FOC-781 docs; buffer for acceptance snags |
| 12-03 | FOC-790 release notes, hand-written dossier, tag `v1.0.0` |

### Lane A — FOC-477 measurement (delivery owner runs the harness, Mateusz at the gates)

Attempts 1–6 excluded (registry `docs/research/foc-477-runs.json`; 5 = before the FOC-801 boundary, 6 = harness
error at the gate emitter). **Attempt 7** starts only when Mateusz can sit at `plan.gate1` (~2 min to the gate,
~$0.007); every step, including a resume after a resolution, goes through `scripts/foc-477-armA-launch.mjs`. Then
one run per sitting until 10 counted runs → FOC-759 baseline from transcripts (FOC-760 is in) → FOC-477 report +
go/no-go (target 11-20) → FOC-712 → M2 done.

### After the tag

1. **M5 agent working state:** FOC-727 → FOC-728 → FOC-729 → FOC-730 + FOC-621 rest.
2. **M7:** FOC-715 → FOC-717 → FOC-718 → FOC-719 → FOC-720 → FOC-721 → FOC-722 → FOC-723 → FOC-724 (1.1 dossier).
   Then by the FOC-477 verdict: M4 (FOC-478 → 382 → 390 → 617 → 622 → 456 → 393 → 453) or M3
   (FOC-391 → 387 → 410 → 384 → 392); both chains are in Linear without dates.

**Fillers (no dates):** FOC-602, FOC-642, FOC-604, FOC-615, FOC-616, FOC-626, FOC-647, FOC-635, FOC-731.

### Changes on 2026-10-15

* **Owner change.** The orchestrator session owns delivery (Linear, this file, PRs). The Supervisor's lane B
  dissolves into lane O; it keeps serving jawnosc-wynagrodzen and WSKM and must not take Fenix tickets.
* **PR #71** (25 commits, 164 files, +41k lines) landed the Settings stream (FOC-762/773/778/786), FOC-788,
  FOC-815 and the unplanned task-workspace stream, recorded after the fact as **FOC-816**. Decision (b): it is a 1.0
  pillar; M8 2026-11-19 → **2026-12-03**, FOC-789 11-16 → 11-27, FOC-781 → 12-01, FOC-790 → 12-03; M7 12-15 →
  2027-01-15. New **FOC-839** for the 1.0 hardening of that stream.
* **`main` was red after #71** (171/174 on Windows and Linux): a real regression — the legacy single-session
  dashboard's gate answer returned 500 from the managed-session id validation (would have hit the VM at the next
  `fenix update`) — plus a stale pinned-state test and a flaky claims lock test. Fixed in the next PR.
* **Security:** the dashboard publish route accepted `actor: "ai"` behind guards that let a host process through;
  now opt-in (`publish.aiActor`) and token-bound, with the dashboard's write routes on the child deny list.
* **FOC-801 landed** (PR #72, boundary `e0f8b40`); arm-A attempts 5 and 6 excluded; attempt 7 waits for Mateusz.
* Linear hygiene: FOC-762/773/778/786 closed with #71; FOC-801 Done; the three acceptance stacks and seven stale
  images removed from the Windows host.

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
* Cockpit feedback from the VM (Mateusz: clunky, chat ↔ terminal, questions not in Needs-you, Supervisor
  never woke up): FOC-807 → Urgent with a visible "something waits" state; new FOC-810 right after it; FOC-772 and
  FOC-808 moved to lane B so the tag stays on 11-19.
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

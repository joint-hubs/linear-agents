---
type: roadmap
status: active
audience: Mateusz (decision) → delivery owner (orchestrator session, since 2026-10-15); the Supervisor is the frontman for other products and runs Fenix tickets headless under the delivery owner
created: 2026-07-03
updated: 2026-11-03
principle: pull-based — the platform is good enough to WORK WITH; every next feature must be justified by friction observed while running real tasks, not invented ahead of need. After 1.0: measure → cheapen → harden → learn.
---

# linear-agents — roadmap

<!-- roadmap:current:start — hand-written 2026-11-03 (FOC-1050); FOC-718 replaces this block with a render from Linear -->

## Current roadmap (2026-11-03 revision — close 1.0, then measure before learning)

Source of truth: Linear project **FENIX** (team Focus); dates are the Gantt written to Linear on 2026-10-29
(`docs/roadmap/fenix-gantt.html`, also the due dates in Linear). Capability map: `docs/roadmap/taxonomy.json`.
Phase order accepted 2026-10-26 (`docs/roadmap/2026-10-26-next-steps-proposal.md`). Decisions of record for the
six contradictions the recon found: **ADR-0015** (`docs/adr/0015-roadmap-decisions-of-record-2026-11-03.md`).

**Roles.** One delivery owner since 2026-10-15 (Mateusz: "chcę żebyś Ty był odpowiedzialny za delivery"): it plans,
drives the headless Supervisor ticket by ticket, reads every diff, opens the PRs and **merges to `main`** (Mateusz,
2026-10-17: "masz zgodę na mergowanie"; ADR-0015 §1), keeps Linear and this file in sync. Mateusz answers gates and
approves tag pushes. The Supervisor (glm-5.3-flash since 2026-11-02, REVIEW lead MiMo v2.6 Pro since the FOC-1171
overlay; ADR-0015 §3) runs DEV → REVIEW → TEST children in worktrees and never pushes, merges or answers its own
cleanup gates.

| Milestone | Epic | Target | What decides it |
|---|---|---|---|
| **M8 Fenix 1.0.0 — portable release** | FOC-768 | **2026-12-03** | rc.10 (11-06) → FOC-789 day 6 (11-09 → 11-24) → FOC-781 (11-25 → 11-30) → FOC-790 dossier + tag (12-01 → 12-03) |
| M2 Graph engine + PLAN graph | FOC-467 | 2026-12-23 | FOC-477 moved behind the tag: 10 counted arm-A runs 12-07 → 12-23 (Mateusz at the gates) → go/no-go = the M2 verdict → FOC-712 (2027-01-04 → 01-08) |
| Phase 1 — measure before learning | FOC-1070 | 2027-01-22 | targets on the board, cost truth of the loop, 3 sessions on two repos; see below |
| M7 Release discipline and living docs | FOC-714 | 2027-02-26 | FOC-715 (01-18) → 717 → 718 → 719 → 720 → 721 → 722 → 723 → FOC-724 Fenix 1.1 (02-19 → 02-26); the 1.1 dossier generator, not 1.0's (ADR-0015 §2) |
| Phase 2 — cheaper Supervisor (72 % of cost) | — | 2027-03-05 | FOC-967 → FOC-965 model campaign, FOC-960 on-demand VM, FOC-457 tier per node |
| Phase 3 — delivery quality (68 % of fixes) | — | 2027-03-22 | FOC-382 → 387 → 456 → 390 → 393; FOC-387 is the prerequisite for M3 |
| Phase 4 — self-improvement v1 | FOC-944 | 2027-04-09 | Harness² FOC-945 → FOC-946; FOC-947 after data |
| M3 Jev at the gates | FOC-468 | no date | after the M2 verdict and FOC-387: FOC-391, 384, 410, 392 |
| M4 Delivery loop as a graph | FOC-469 | no date | after the M2 verdict: FOC-478, 617, 622, 453, 117, 618, 619 (the Phase 3 tickets are its quality core) |
| M5 Slim DEV and Supervisor | FOC-470 | no date | FOC-727–730 merged 2026-10-17; FOC-731 (5/5, measurement), 479, 455, 454, 458, 394, 395, 388, 389, 610, 611, 763, 764 |
| M6 Optimization and learning | FOC-471 | no date | data first: GEPA FOC-398, open weights, fine-tuning FOC-273/281/282/625, FOC-222/223/224, FOC-947 |
| M1 Foundations | FOC-466 | done | cost truth (FOC-760/761/769), egress PR path (FOC-512), deny gaps (FOC-511), model overrides (FOC-607) — merged 2026-10-17 |

### Phase 0 — close 1.0 (M8, the only dated lane until the tag)

State on 2026-11-03: `v1.0.0-rc.9` is the current image; FOC-789 part 1 ran 2026-10-21/22/25, part 2 on 10-26,
day 5 on 10-27; the FOC-1055 fix (PR #168) and the FOC-1080/1089 snags are in; the snag backlog is FOC-1051
(S1–S36, one ticket each). The delivery session of 2026-11-01 → 11-03 landed 40 PRs (#163 → #206) through the
headless Supervisor: isolation and snag fixes, the verdict/delivery provenance chain (FOC-1155, 1194, 1210), the
journal and cleanup fixes (FOC-1207, 1211), the flake fixes (FOC-1220, 1221).

| Dates | Task |
|---|---|
| 10-30 → 11-06 | 1.0 isolation and snags before rc.10: FOC-1088 own worktree per small-task session, FOC-1090 egress branch-name false positive, FOC-1111 chat queue, FOC-1066 "Teach auto mode" popup, FOC-1062 `verdict record` vs the classifier (part 2 = FOC-1142) |
| 11-02 → 11-06 | 1.0 CLI: FOC-1107 `fenix settings set`, FOC-1065 `fenix restart <service>`, then FOC-777 CLI close-out (its AC1 = the acceptance run) |
| **11-06** | **rc.10** |
| 11-09 → 11-13 | FOC-1050 this rewrite + the six contradictions (ADR-0015) — done 11-03, ahead of plan |
| 11-09 → 11-24 | FOC-789 acceptance day 6 on rc.10 → two task sessions side by side + push from the dashboard → final; FOC-1109 "Provide the values" hold with a text field and FOC-1110 Work card → session cockpit land inside it (11-10 → 11-12) |
| 11-16 → 11-19 | FOC-1056 fresh install without the first-run hold; FOC-1075 attach-link in linear-ops and MCP |
| 11-20 | rc.11 candidate |
| 11-25 → 11-30 | FOC-781 Quickstart walked by someone other than Mateusz (In Review until then) |
| 12-01 → 12-03 | FOC-790 release notes, the hand-written dossier `docs/releases/1.0.0/README.md`, tag `v1.0.0` (Mateusz pushes the tag) |
| **12-03** | **v1.0.0** |

Running alongside, undated, from the delivery queue: FOC-1222 (DEV must finish on a commit; REVIEW/TEST only on a
sha), FOC-1224 (STATE.md index drift, journals closed at merge), FOC-1225 (scanner noise), FOC-1227 (cleanup
archive on nested fixture repos). Fillers: FOC-642, 604, 615, 616, 626, 647, 635, 731, 913.

### Phase 1 — measure before learning (FOC-1070, 2026-12-07 → 2027-01-22)

| Dates | Task |
|---|---|
| 12-07 → 12-09 | FOC-1074 `test-run --affected` + parallelism |
| 12-07 → 12-14 | FOC-1071 targets on the board: first-time-right, $/ticket by size, interventions, wall time |
| 12-10 → 12-16 | FOC-878 per-run child identity in the container |
| 12-15 → 12-21 | FOC-1072 Bash output cap (11.7 % of the bill) — with FOC-419 cache-read cost measured |
| 01-04 → 01-08 | FOC-1076 acceptance of 3 concurrent task sessions on two repositories (bigger VM); pulls FOC-878 and FOC-920 forward |
| 01-11 → 01-15 | FOC-1073 code hygiene: ESLint + shared CLI helpers |
| 01-11 → 01-22 | FOC-1051 remaining snags S1–S36, triaged in bulk |

Also in the phase, undated: FOC-920 unattended policy (deny-after mode not yet exercised on the VM), FOC-283
handoff compressor (measured here, built in Phase 2 if the numbers say so).

### Phase 2 — cheaper Supervisor (2027-01-25 → 03-05)

FOC-967 model experiments in Settings (per-slot arm list, sticky per-ticket assignment; 01-25 → 02-05) → FOC-965
the campaign on real tickets (02-08 → 03-05; arm list fixed in ADR-0015 §5) · FOC-960 on-demand VM: Cloud Run
gateway + autostop (02-01 → 02-10; remote control phase D) · FOC-457 model tier per node (02-15 → 02-24) ·
FOC-283 handoff compressor if Phase 1 shows the handoff share. FOC-966 provider/quantisation policy undated.

### Phase 3 — delivery quality (2027-02-22 → 03-22)

FOC-382 typed DEV turn exit record (02-22 → 02-26) → FOC-387 decision calibration on recorded labels (03-01 →
03-08) → FOC-456 REVIEW gate: AC coverage (03-01 → 03-08) → FOC-390 finding verifier (03-09 → 03-16) → FOC-393
repeat-round classifier (03-17 → 03-22). Measured against the Phase 1 targets; FOC-387 opens M3.

### Phase 4 — self-improvement v1 (2027-03-15 → 04-09)

Harness² (epic FOC-944): FOC-945 harness fingerprint on every run + trajectory renderer (03-15 → 03-24) → FOC-946
reflector → per-domain library → kickoff injection, promotion through a gate (03-25 → 04-09). First slice prompt
and skill edits only, second routing proposals, third tool gaps. FOC-947 after data (M6).

### Other tracks (undated)

- **Remote control** FOC-957: phases A/B done (fenix-control MCP, PR #139); C and E (FOC-959, FOC-961) undated; D is
  FOC-960 in Phase 2.
- **Precedent index** ADR-0014: F0 spike done (recall OK, cost prediction failed); go/no-go T0.8 pending since
  2026-09-29, no tickets, code uncommitted.
- **Maintenance** FOC-472: a standing epic, never blocks the plan.
- **JW first client** 2027-01-11 (milestone on the Gantt; jawnosc-wynagrodzen work is outside this file).

### Decisions of record (ADR-0015, 2026-11-03)

1. The delivery owner merges to `main`; Mateusz answers gates and approves tag pushes.
2. FOC-790's hand-written dossier ships with 1.0; FOC-724 is the 1.1 generator.
3. Supervisor lead `z-ai/glm-5.3-flash` (since 11-02); REVIEW lead `xiaomi/mimo-v2.6-pro` (FOC-1171 overlay).
4. Squad models = routing v2 (`config/models.json`, FOC-964); PRD tables are dated snapshots.
5. FOC-965 arms: glm-5.3-flash (baseline), mimo-v2.6-pro, claude-haiku-5.5, gemini-4-argon, muse-spark-1.3, claude-sonnet-5.5.
6. Autonomous pickup off by default, opt-in per owner scope (FOC-902); not part of the 1.0 acceptance.

### Changes on 2026-11-04

- **Phase 1 pulled forward** (Mateusz, 2026-11-04: "Faza 1 naprzód"). The rc.10 lane is done except FOC-777, FOC-789 day 6 and
  the tag wait for Mateusz, and the Fenix delivery queue after FOC-1227 is empty — so the delivery owner starts the
  Phase 1 tickets now instead of 2026-12-07, in this order: FOC-1074 (`test-run --affected`, jobs, longest-first,
  spawn-test split, prove-isolation in CI) → FOC-1071 (targets on the board) → FOC-1072 (Bash output cap) → FOC-878
  (per-run child identity). The Gantt dates stay as the latest-finish line; `updated` above is not bumped for this.
- Delivery 2026-11-03 → 11-04: PRs #207 → #217 (FOC-1222, 1224, 1231, 1232, 1159, 1236, 1237, 1235, 1238, 1245)
  through the headless Supervisor — verdict provenance and idempotent recording, scratch isolation, the container
  gate on the host-archived HEAD, two CI flakes fixed on measured causes, the dry-run probe. FOC-1227 in flight.

### Changes on 2026-11-03

- Rewrite from the 2026-10-26 proposal and the 2026-10-29 Gantt (FOC-1050). The JOI-era NOW/NEXT/LATER tail and
  plan index (2026-07-03 → 2026-09-12) are removed; read them at `git show 1fa8546:docs/ROADMAP.md`.
- Dates that were stale here (FOC-789 "11-17 → 11-27", FOC-781 "11-30", FOC-791/787/839 as future work, M2 "11-20",
  M7 "2027-01-15") replaced by the Gantt's; FOC-957, FOC-965/967 and Harness² FOC-944–947 added.
- Six contradictions resolved in ADR-0015; HANDOFF §5/§8, the 1.0 PRD (§8 P4, D2), the remote-control PRD §7, the
  release README, the five squad PRDs with their `docs/agents/` mirrors, the model-experiments PRD and the FOC-902
  plan now say the same thing.

### Changes on 2026-10-17

- **Merge round:** Mateusz authorised the delivery owner to merge ("masz zgodę na mergowanie, trzeba to ustabilizować");
  PRs #72–#97 (26) landed on `main` in dependency order, each after `origin/main` was merged into its branch with the
  affected tests green; then #98 (the `test-run.test.mjs` sandbox list, red on `main` after FOC-905) and #99 (the
  operator checkout's `modelSettings` for `agents/supervisor/settings.json`). Final gate: full Windows suite 193/195
  (the two reds = #98 and FOC-913), the Linux lane (CI) green on the #98 tree.
- **Lane O ahead of plan:** everything scheduled 10-16 → 10-30 was on `main` on 10-17, plus the FOC-898 epic
  (multi-Supervisor isolation: shared skills, `fenix agent-tools`, scoped-only autonomy, ticket lease, scratch under
  run dirs, per-task journals, run ownership, Settings → Agent tools) and M5 FOC-727–730.
- **Operations:** the native Supervisor was stopped and restarted on the new code at Mateusz's request; the operator
  checkout is on `main`; the FOC-903 scratch migration and fixture sweep were applied on its state home.
- **Linear:** FOC-848, 511, 512, 607, 780, 779, 772, 771, 802, 840, 903 (+602), 727–730, 899–906 and the epic
  FOC-898 Done with merge notes; FOC-913 (watch-cost flake under suite load) filed under FOC-472.

### Changes on 2026-10-15

* **Owner change.** The orchestrator session owns delivery (Linear, this file, PRs). The Supervisor's lane B
  dissolved into lane O; it keeps serving jawnosc-wynagrodzen and WSKM.
* **PR #71** (25 commits, 164 files, +41k lines) landed the Settings stream (FOC-762/773/778/786), FOC-788,
  FOC-815 and the unplanned task-workspace stream, recorded after the fact as **FOC-816**. Decision (b): it is a 1.0
  pillar; M8 2026-11-19 → **2026-12-03**; new **FOC-839** for the 1.0 hardening of that stream (done 10-19 → #102).
* **`main` was red after #71** (171/174 on Windows and Linux): a real regression — the legacy single-session
  dashboard's gate answer returned 500 from the managed-session id validation — plus a stale pinned-state test and
  a flaky claims lock test. Fixed in the next PR.
* **Security:** the dashboard publish route accepted `actor: "ai"` behind guards that let a host process through;
  now opt-in (`publish.aiActor`) and token-bound, with the dashboard's write routes on the child deny list.
* **FOC-801 landed** (PR #72, boundary `e0f8b40`); arm-A attempts 5 and 6 excluded; attempt 7 moved behind the tag.

### Changes on 2026-10-12

* Landed but still open in Linear, closed with their commit: FOC-726 (`659ad72`), FOC-667 (`367ac52`),
  FOC-733 (`4bc5bc2`), FOC-758 (`d9f6cc2`), FOC-716 + FOC-606 (`0023a25`); FOC-794 (pi recon delivered);
  FOC-804 (PR #63, `a5db96d`).
* 16 tasks of other products moved out of FENIX to their parents' projects (TRADING, BIZNES, NEO).
* New from the GCP VM run: FOC-802, FOC-803, FOC-807, FOC-808, FOC-809.
* Evening revision (Mateusz: M7 later, 1.0 first): FOC-790 no longer waits for FOC-724; FOC-724 is the 1.1 dossier.
* Fixed a dependency cycle: FOC-775 ← FOC-789 ← FOC-777 ← FOC-775. The image goes to GHCR first and the
  acceptance run uses the published image.

<!-- roadmap:current:end -->

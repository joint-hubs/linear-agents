---
type: prd
status: accepted (planning answers 2026-10-08 — recommended defaults)
milestone: M7 Release discipline and living docs
epic: FOC-714
created: 2026-10-08
---

# PRD — Release discipline and the release dossier (CodeGraph → DrawIO + audit)

## 1. Problem

Three gaps showed up in the 2026-10-08 review:

1. **Planning objects lie.** 44 Fenix children created by `linear-ops create-child` had no project and no
   milestone, so Linear showed M3 at 0 % with 2 of 7 children Done and M1 at 77 % over 13 of 17 children.
   FOC-621 and FOC-598 sat in "Todo" while their code was on `main`; epics with Done children sat in
   "Backlog". Milestones have one-line descriptions, no exit criteria, no out-of-scope list.
2. **Releases are not a thing.** The only release scoping ever done was the one-off Fenix 1.0 scope record
   (`docs/plans/fenix-1.0-release-scope.md`, FOC-102). Since then landings are continuous (PR #39–#49) and
   nothing groups them, says what was deliberately left out, or turns that into backlog.
3. **Architecture documentation does not exist as a release artefact.** `docs/diagrams/*.puml` are hand-drawn
   and stale; `docs/ROADMAP.md` was stale from 2026-09-12 to 2026-10-08; `docs/STATE.md` is 3,183 lines.

## 2. Goal

Every release is **scoped in small blocks with an explicit out-of-scope list whose every item is a backlog
task**, and ships a **release dossier**: architecture pages generated deterministically from CodeGraph into
editable DrawIO, the architecture delta against the previous release, and an audit + verification record
that never claims more than was checked.

## 3. Definitions (the planning model)

| Object | What it is | Must contain |
|---|---|---|
| **Milestone** (M1–M7) | A capability goal | Goal (one sentence), measurable exit criteria, epic, out of scope, target date or "by exit criteria" |
| **Epic** (one per milestone) | The work container | Problem, outcome, exit criteria, ordered children, out of scope — every bullet a FOC id or "not tracked — reason" |
| **Release** (e.g. Fenix 1.1) | A cut of landed work | Version, theme, 2–4 blocks (each ≤ ~8 points, independently landable, own exit criterion), out of scope with FOC ids, risks, dossier link |
| **Residual** | What a partial landing leaves | Its own task; the parent closes Done only together with it |

Rules: landed code ⇒ the task is at least In Progress. A child inherits project and milestone from its parent
chain. Out-of-scope items of a milestone go to a later milestone or to the maintenance epic (FOC-472), never
into the same milestone.

## 4. User journey (Mateusz)

1. "Zróbmy release 1.1" → the Supervisor runs the **release scope graph**: it collects Done/In Progress work
   of M1 + M2 and the hygiene findings, proposes 2–4 blocks and an out-of-scope list with reasons.
2. Mateusz answers one `release-approval` gate (same grammar as `draft-approval`: `ok`, `B nie, …`, free text).
3. `release.push` labels in-scope issues `release:1.1`, creates backlog tasks for every untracked out-of-scope
   item (parent, project, milestone, label `deferred`), writes `docs/releases/1.1/scope.md`.
4. The blocks land as usual (branch → PR → merge).
5. `release-audit` regenerates the architecture pages from a fresh index, computes the delta, runs the checks,
   asks Jev (advisory) whether each diagram claim is supported by its quoted evidence, files findings as tasks,
   and writes `docs/releases/1.1/README.md`.
6. Mateusz opens `architecture.drawio` in draw.io, reads the README, and says the word for the tag.

## 5. Scope

### In

- Planning templates and the residual rule (FOC-715); `create-child` inheritance (FOC-716); Linear hygiene
  report (FOC-717); `ROADMAP.md` rendered from Linear + `STATE.md` compaction (FOC-718).
- Node port of the pilot converter with parity tests (FOC-719); Fenix views + stale-view checks (FOC-720);
  architecture delta (FOC-721).
- Release scope graph (FOC-722); release audit + dossier generator (FOC-723); Fenix 1.1 as the acceptance run
  (FOC-724).

### Out (each tracked)

- Linear native Releases — no release pipeline exists in the workspace; needs UI setup. Until then: label
  `release:<version>` + milestone + dossier. Not tracked yet — revisit after 1.1.
- Committing the full graph export (7 MB in the pilot) — local artefact, hash in the manifest.
- Adopting the Fenix converter in post-fraud-model — FOC-725 (maintenance epic).
- Browser/runtime journeys in the audit — named under "limits" in every dossier; not tracked yet.
- New layout algorithms for DrawIO — only if pages turn out unreadable; not tracked yet.

## 6. The pilot (post-fraud-model, 2026-10-08) — what we keep and what we change

Source: `post-fraud-model/docs/audit/2026-10-08-codegraph/` (README, plan, verification, 9 pages, converter
`scripts/codegraph_to_drawio.py` 1,207 lines + 31 tests; untracked in that repo on 2026-10-08).

**Keep:**

- Two arrow kinds: **G** = aggregated native CodeGraph dependency (import/call/instantiation/reference — not
  execution order), **M** = manual source-backed flow (HTTP, SSE, child processes, files) with evidence.
- Determinism: native DB and JSON export give byte-identical DrawIO; repeated runs identical.
- Validation that fails closed: invalid ids, dangling edges, count drift, path traversal, overlapping groups,
  colliding positions, overwriting inputs.
- Manifest as a provenance ledger: resolved node ids, dropped/internal edges, coverage (pilot: 2,013 of 9,618
  nodes represented = 20.93 %), input sha256.
- Verification honesty: targeted vs full suite stated separately, every failure listed, limits section.
- Bounded pages (≤ 9 boxes, ≤ 12 arrows) — readable in draw.io.

**Change:**

| Pilot | Fenix |
|---|---|
| Python stdlib script in the target repo | Node `scripts/codegraph-drawio.mjs` (zero deps, `node:sqlite`), `--project-root` for any target repo |
| Freshness checked by hand (`codegraph sync`, pending 0) | Export refuses unless `code-intel.mjs status` proves fresh; UNKNOWN = exit 3 |
| Views hand-written (36 KB JSON) | [G] may draft from the graph; the committed views file is human-approved; stale selector = fail |
| M evidence as `file:line` (drifts) | Quote + path; the check finds the quote wherever the line moved |
| One snapshot | Delta against the previous release's manifest |
| Audit = one manual session | Deterministic checks + [J] advisory claim verifier + findings → backlog |
| 7 MB export next to the diagram | Not committed; hash in the manifest |

## 7. Architecture

```text
Linear (milestones, epics, issues) ──► release.inputs [D] ──► release.scope [G] ──► release-approval [H]
                                                                                    │
                    docs/releases/<v>/scope.md  ◄── release.push [D] (labels, deferred tasks, egress screen)

fresh CodeGraph index ──► codegraph-drawio.mjs ──► architecture.drawio + manifest.json (+ PNG via draw.io CLI)
         ▲                     ▲ docs/architecture/views.json (approved)          │
   code-intel status           │                                                  ▼
   (freshness guard)     --check-views (stale selectors, quotes)        delta --from <prev manifest>
                                                                                  │
release-audit.mjs: checks [D] + claim verifier [J] + findings → backlog ──► docs/releases/<v>/README.md
```

Dossier layout: `docs/releases/<version>/{scope.md, architecture.drawio, pages/*.png, manifest.json,
delta.md, delta.json, README.md}`.

## 8. Phases and tasks

| Phase | Tasks | Lane | Notes |
|---|---|---|---|
| 1 — planning discipline | FOC-715 → FOC-716 → FOC-717 → FOC-718 | B, now | FOC-716 stops new orphans; do it first in practice |
| 2 — architecture docs | FOC-719 → FOC-720, FOC-721 | B | FOC-719 is the only L |
| 3 — release flow | FOC-722 → FOC-723 → FOC-724 | B, then A | FOC-724 needs FOC-477 Done (M2 closed) |

## 9. Acceptance criteria (milestone exit)

1. New children always carry project + milestone; `linear-hygiene.mjs` on FENIX exits 0.
2. `roadmap-render.mjs --check` passes on `main`.
3. Fenix architecture pages regenerate byte-identically from the same graph; stale views and drifted quotes fail.
4. `docs/releases/1.1/` is complete: scope with blocks and tracked out-of-scope, pages, delta ("first release,
   no baseline"), audit with every check PASS / named UNKNOWN / known red with proof, findings as FOC ids.

## 10. Decisions (2026-10-08, recommended defaults accepted)

1. Fenix capability for any target repo; dogfood on linear-agents first.
2. Port the converter to Node; parity with the Python pilot.
3. Label + milestone + dossier now; Linear native Releases later.
4. Do not commit the full graph export.
5. New milestone M7; Phase 1 starts now in lane B, parallel to FOC-477.
6. Release blocks: 2–4 per release, ≤ ~8 points each, independently landable, own exit criterion.
7. Backfill of the 44 orphan children and the status fixes (FOC-621, FOC-598, FOC-626, epics M3/M5/M6) done
   on 2026-10-08.

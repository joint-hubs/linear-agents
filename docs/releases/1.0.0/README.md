# Fenix 1.0.0 — release dossier

Status: **skeleton (FOC-790)** — hand-written dossier, filled against `main` as of 2026-10-20.
Structure follows FOC-790: scope (M8 children and their PRs), the FOC-789 acceptance record, the
sizing (FOC-809), known limits and every open snag as a FOC id. No PRD prescribes a different
structure (`docs/prd/fenix-1.0.0-release-prd.md` scopes the release; `docs/prd/release-dossier-prd.md`
defines the release flow, not this file's sections).

## 1. Summary

Fenix 1.0.0 is the first tagged release a developer can run on their own machine with one command:
a Docker-only quick start (`./fenix up` — image, Compose stack, key wizard, no host dependencies
besides Docker), dashboard v2 (Cockpit / Work / Team / Costs & quality / Insights / Settings), one
cost truth (per-ticket cost reconciled against transcript ground truth, Supervisor share included)
and task workspaces with concurrent Supervisors on one repository.

- Image: `ghcr.io/joint-hubs/fenix:1.0.0` (published by FOC-775).
- `rc.1` tagged 2026-10-20; `v1.0.0` is pushed by Mateusz after the acceptance run (FOC-789).

## 2. Scope — M8 children (epic FOC-768) and their PRs

PR numbers resolved from git history on `origin/main` (merge-commit subjects and bodies);
Linear statuses as of 2026-10-20. "—" = no merge commit found in git history.

### Done (37)

| Issue | Title | PR |
|---|---|---|
| FOC-769 | Supervisor declares its active ticket; telemetry charges Supervisor turns to it | #69 |
| FOC-770 | One paths module — store and squad dirs resolved through it | #57 |
| FOC-771 | Node entry points replace the `.bat` launchers | #82 |
| FOC-772 | Optional integrations off by default (Atlas, pisi, personal memory) | #81 |
| FOC-773 | Pluggable provider | #71 |
| FOC-774 | Suite green on Linux in the Fenix image | #55 |
| FOC-775 | Docker image; published to GHCR on tag `v*` | #54, #116 |
| FOC-776 | Supervisor at home in the container — repos, volume-backed config, session resume | #58 |
| FOC-778 | Key wizard with live validation + Compose secrets | #71 |
| FOC-779 | Generated artifacts — digest registry, refresh on start / server tick | #80 |
| FOC-780 | Retention — keep everything by default, one configurable limit, prune on demand | #79 |
| FOC-782 | Dashboard v2 UX spec — six areas | #52 |
| FOC-783 | Cockpit — Supervisor chat + web terminal, needs-you inbox, honest child status | #62 |
| FOC-784 | Work board | #70 |
| FOC-785 | Costs & quality | #70 |
| FOC-786 | Settings — provider, key vault, repos, retention, routing screens | #71 |
| FOC-787 | Insights — Tickets, Money and Outliers panels | #104 |
| FOC-788 | Push / Open PR button from the dashboard (human confirms) | #71 |
| FOC-791 | Dashboard v2 Team — line-ups per lead, `GET /api/team` | #103 |
| FOC-799 | Docker follow-ups — orphaned children marked `crashed`, CodeGraph approvals on the volume | #59 |
| FOC-800 | Dashboard writes work in Docker (container gateway counts as local) | #60 |
| FOC-802 | Child isolation in the container (`fenix-child` uid, spawn helper, proof) | #83 |
| FOC-803 | Run data on the volume; uid stanzas out of the Dockerfile | #68 |
| FOC-804 | Dashboard v2 navigation — six areas, v1 screens under them | #63 |
| FOC-807 | Supervisor gets its run id — waker, guard, briefing, wake banner | #67 |
| FOC-808 | VM hygiene follow-ups | #105, #107 |
| FOC-809 | VM sizing sampler + report (p20 / p50 / p80 + peak per phase) | #108, #109, #113 |
| FOC-810 | Cockpit answers the Supervisor's dialogs | #68 |
| FOC-811 | Run manifests and per-run decision logs follow `LA_STATE_ROOT` | #68 |
| FOC-816 | Task workspaces and concurrent Supervisors (P1–P4) | #71 |
| FOC-839 | Task workspaces 1.0 hardening — legacy suite, migration, QUICKSTART cockpits | #102 |
| FOC-848 | Task ownership — a Supervisor acts only on tickets its installation owns | #76 |
| FOC-914 | Team group filters from the Linear state | #114 |
| FOC-915 | Insights task table precomputed in the analysis cache | #112 |
| FOC-917 | Resumed turns get the child teardown identity (mark + TMPDIR) | #110 |
| FOC-918 | Unattended Supervisor prompts — recognised, aged, visible in doctor | #115 |
| FOC-921 | Supervisor prompt hygiene — scratch in `mktemp -d`, Done only after the merge | #118 |

### In progress / review

| Issue | Title | Status | PR |
|---|---|---|---|
| FOC-777 | `fenix up` / `update` pull the pinned image; `--source` builds from the clone | Merged (#117) — AC1 pending FOC-789 | #117 |
| FOC-781 | Quickstart docs | In Review — needs a README run by someone other than Mateusz | — |
| FOC-943 | Supervisor writes to Linear/GitHub through Fenix MCP servers; declared permission mode | Merged (#124) | #124 |

### Open

| Issue | What it is | PR |
|---|---|---|
| FOC-789 | Fresh-machine acceptance run on a real Linear issue (release AC1) | — |
| FOC-790 | Release notes + dossier (this file) + tag `v1.0.0` | — |
| FOC-878 | Per-run child identity — residual of FOC-802 | — |
| FOC-920 | Parked-prompt policy (what happens to a Supervisor parked > 10 min) | — |

## 3. Acceptance run (FOC-789)

**To be filled after the run.**

| Metric | Value |
|---|---|
| Machine profile | — |
| Time to dashboard (`./fenix up` → Cockpit open) | — |
| Time to landed branch (one real Linear issue, plan → landed) | — |
| Cost per ticket (transcript ground truth, Supervisor share included) | — |
| Manual steps the run needed | — |
| Snags | → FOC ids |

## 4. Sizing (FOC-809)

Measured on `fenix-vm` (GCP), four real tickets, 296 samples over 5 h 7 min — full table in
[docs/QUICKSTART.md](../../QUICKSTART.md), section **Fenix on a VM (GCP)**, "Sizing" paragraph.
Quoted verbatim:

> **Minimum** (evidence 2026-10-19): 2 vCPU, 8 GB RAM, 50 GB disk — a dev child sits at p80 load
> 1.4 of 2 cores and its memory peak (5.9 GB, a test/build spike) needs the 8 GB; 4 GB is not
> enough. The heaviest phase was not the child but the Supervisor working a ticket itself (running
> test lanes and `npm ci` in its clone): p80 CPU 158 % of one core, load1 peak 13.3 — both cores
> saturated for minutes at a time, and the runs still completed.
>
> **Recommended**: `e2-standard-2` for one worker at a time (Fenix's default); `e2-standard-4` when
> a child and the Supervisor's own test runs (or an image build) overlap, or when the no-cache
> build time (4 min on 2 vCPU) matters.

## 5. Known limits

- The v1 SquadConfig screen edits repo files inside the image, which do not survive
  `fenix update`; provider, routing and keys live in the Settings overlay instead (FOC-786,
  see QUICKSTART "Status").
- Child isolation covers the `fenix-child` user boundary, but per-run child identity is a
  residual: children of one run are not individually attributable across restarts (FOC-878).
- The Quickstart docs (FOC-781) have not been walked through by anyone other than Mateusz yet.
- A Supervisor hitting a `Do you want to proceed?` prompt stops until a human answers —
  visibility exists (FOC-918), the parked-prompt policy does not (FOC-920).
- The acceptance run (FOC-789) has not happened: the §3 record and the release metrics are
  placeholders, and `v1.0.0` is not tagged.

## 6. Upgrade from earlier builds

[docs/QUICKSTART.md — "Upgrade"](../../QUICKSTART.md): `./fenix update` pulls the pinned image and
restarts the stack (keys and the data volume untouched); `--source` rebuilds from the clone.
Includes the FOC-783 Cockpit-hooks merge note.

## 7. Decisions

- Provider: OpenRouter as the shipped default, pluggable (FOC-773).
- Image published publicly on GHCR (FOC-775, 2026-10-19).
- Supervisor model: `xiaomi/mimo-v2.6-pro` (grok-4.7 tried 2026-10-20, ~12× the cost at equal AA intelligence; A/B candidates FOC-965).
- Permission mode `auto` declared at the Supervisor launch (FOC-943).
- Task workspaces as a 1.0 pillar (2026-10-15, FOC-839 hardening).

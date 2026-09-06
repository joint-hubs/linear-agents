---
type: spec
status: implemented
audience: Mateusz (approval) → GLM (build)
tags: [type/spec, area/ui, topic/rewards]
created: 2026-09-06
issue: FOC-225
plan: agents/supervisor/plans/greedy-popping-wilkes.md
manager-ui: fenix-manager.md
---

# Fenix Manager — rewards and manager ratings (build spec)

This document specifies the reward system delivered in slice 3 of the Fenix Manager plan:
attribution, evidence, the rating rubric, and persistence. **Delivered in slice 3** — the
implementation confirmation at the end of §5 records what shipped; no zeroed placeholder
records anywhere.

**Framing rule: XP records verified experience. It does not claim that model weights improved,
that a squad is "good", or that a rating measures quality.** Nothing here is RL, fine-tuning, or
training — the word "progression" describes a bookkeeping view, nothing more.

## 0. What already exists (do not rebuild)

| Asset | Where | Role in rewards |
|---|---|---|
| TEST squad verdicts (independent acceptance) | supervisor run records | the ONLY source of automatic XP evidence |
| Run/task identifiers, started/cost fields | telemetry store | evidence references, never reward inputs themselves |
| Application-data directory conventions | repo root `.state/`, `docs/ACCESS.md` | the ledger lives beside them (location confirmed: `rewards.sqlite` under the rewards home, see §5) |
| Manager profiles UI | `ui/src/screens/Manager.jsx` + inspector | display only; the browser never computes or submits XP |

## 1. Attribution model

- **Evidence subject** = a specific task revision on a specific repo, verified by TEST.
  Identity: `repo + taskId + revision (or explicit unknown)`.
- **Credit subject** = squad-level by default. A role earns individual credit ONLY when evidence
  links that role (run ↔ role attribution from the slice 2 adapter). Unattributed evidence cannot
  earn individual credit and is never redistributed as proof of each role's quality.
- Attribution fields recorded with every entry: evidence ID, task/repo, subject (squad and, when
  linked, role), run ID, actual model used, prompt/config revision — each field is either the real
  value or an explicit `unknown`. Silence is not zero and not a guess.

## 2. Evidence — what can generate XP

1. **Only ingestion of validated acceptance evidence generates automatic XP.** The accepted
   verdict must come from the TEST stage's own recorded output, referenced by evidence ID —
   never from interpreting success-shaped log text, exit codes, or a supervisor's prose.
2. If the acceptance artefacts cannot prove the task-revision relation, the UI shows
   `awaiting verified evidence`. There is no backfill pass, ever.
3. The **browser cannot submit XP or claim TEST passed.** Reward writes happen in one place: a
   server-side ingestion path that validates the evidence reference before any insert.
4. Duplicate protection: a stable dedup key `evidence + task-revision + rule-version` is enforced
   transactionally; replayed evidence produces no second award (tested by replay).

## 3. XP rules (PRODUCT RULES, not measurements)

> The constants below are product decisions chosen for legibility. They are not derived from
> measured performance, they do not estimate capability, and changing them changes display
> arithmetic only. Every constant is versioned and rendered with its version in the UI.

| Constant | Value | Version |
|---|---|---|
| XP per independently TEST-accepted task revision | **100 squad XP** | `xp-rules v1` |
| Level curve | **500 XP per level** (linear) | `xp-rules v1` |

- Repeated polls, retries, REVIEW passes and extra runs **never multiply** an award: one accepted
  revision = one award, regardless of how many runs it took.
- Profiles show **participation in accepted work** (evidence linked to the role), not a derived
  per-role score.
- Initial badges, both evidence-backed: `first verified delivery` (1st accepted revision for the
  subject), `five distinct verified deliveries` (5 distinct task-revisions).
- **No bonus exists for**: token spend, tool-call counts, raw speed, zero escalations, or avoiding
  questions. Metrics that would reward the wrong behavior are excluded by design, not missing by
  oversight.

## 4. Manager rating (subjective) — separated from acceptance (verified)

Two independent axes, rendered apart in the UI and stored apart in the ledger:

| Axis | Source | Values | Can it make a task pass? |
|---|---|---|---|
| Independent acceptance | TEST verdict via evidence | `accepted / not accepted / unverified` | it IS the pass/fail record |
| Manager rating | a human, optionally per task/run | `1–5` + explanatory note + optional distinction | **never** |

Rating rubric (rendered next to the control so the scale is self-documenting):

- **5** — notably above the bar: caught something the verification path would have missed, or
  exceptional clarity of hand-off/evidence.
- **4** — solid delivery; no rework beyond normal review friction.
- **3** — acceptable; meaningful friction (extra rounds, unclear evidence) but delivered.
- **2** — delivered with significant rework or supervision cost.
- **1** — delivered but the process was actively harmful (unsafe changes, misleading evidence).

Rules:

- A rating is tied to a specific task/run and subject. It is subjective by definition; the UI
  labels it "manager rating (subjective)" next to the verified verdict, and the two are never
  averaged or combined into one score.
- Rating unsuccessful work is allowed and must not flip its acceptance state (a 1★ note on a
  rejected task stays a rejected task).
- **No rating means unknown, not zero** — displayed as "not rated", never 0/5.
- Rating edits supersede the prior entry (audit trail kept, latest wins for display); editing a
  rating never regenerates XP.

## 5. Persistence design

- A **dedicated local durable reward ledger** — not `localStorage`, not edits to raw telemetry.
  Preferred: a separate SQLite module/database under the existing application-data directory,
  overridable path for tests; the exact location is confirmed against storage conventions and
  documented (in this doc + `docs/ACCESS.md` if user-visible) before implementation.
- Record fields: evidence ID, task/repo, subject squad (and optional role), run, actual model,
  prompt/config revision (or explicit unknown), rule version, timestamp, points, provenance
  (which rule/vote produced it), and record kind (`award | correction | revocation | rating`).
- **Corrections and revocations are history, not deletes.** Reopening a task or invalidating an
  acceptance updates *active* XP while the audit trail keeps every prior entry.
- Transactional dedup on the stable key (§2.4); concurrent insertion is safe (tested).
- Server restart preserves the ledger (tested by restart persistence check).
- Cross-repo task-ID collisions are handled by the full `repo + taskId` identity (tested).
- The ratings endpoint accepts only a bounded schema with valid referenced entities, and follows
  the server's existing protections: loopback-only, origin checks, JSON body limits. User notes
  are rendered as text (no HTML injection path). No secrets and no whole prompts are stored in
  reward records.

**Implementation confirmation (slice 3):**

- Ledger: `scripts/reward-ledger.mjs` — a dedicated `node:sqlite` database `rewards.sqlite` under
  `%LOCALAPPDATA%\linear-agents\rewards\` (env overrides `LA_REWARDS_DB` / `LA_REWARDS_HOME`),
  never `telemetry.sqlite`; append-only rows with an `active` flag; path overridable for tests;
  survives restart (tested).
- Record kinds shipped: `award | revocation | rating`. `correction` is realized as supersession
  rather than a fourth kind — every save (rating amendment included) inserts a new record; the
  newest per subject wins for display and the audit trail keeps priors.
- Revocation is **verdict-driven only** (a supervisor fail verdict referencing the award's
  evidence revokes it; a Linear reopen without a new verdict round does not). A revocation is
  recorded as its own audit row (`active=0`, negative points) and the award row is marked
  inactive — so active XP returns to its pre-award value while the history stays intact.
- Ingest runs **on read**: `GET /api/manager/rewards` wraps only the evidence ingest in a 30 s
  single-flight TTL cache; squads/ratings/held are read fresh per payload build.
- Provenance caveat: the acceptance-verdict → award join carries a documented `PROVENANCE_CAVEAT`
  verbatim in each record's provenance field (supervisor-resolved decision, PROCEED-WITH-CAVEAT).
- Repo identity (review round 5): the dedup key's repo component is the recording run's **logical
  repo** — its git common dir, read spawn-free from the run's recorded workspace observation; with
  no observation, the normalized launch cwd stands in. The raw checkout path is kept in the record's
  provenance whenever the common dir supplied the identity. Two worktrees of one repo therefore
  share one identity: the same accepted revision re-reviewed from another checkout yields one award,
  not two (spec §3).
- Held awards (review round 5): a pass verdict whose credit subject cannot be resolved is written
  in one transaction at subject `unknown`, `active=0`, under a **held-scoped dedup key** (`held|`
  prefix) — replays of the same unresolved evidence collapse to one held row (the ~30 s Manager
  polls cannot grow the ledger), and a hold never blocks the real award once the producing run
  links.

## 6. UI rendering (Manager integration)

- Squad header / profile Achievements tab: level + XP from `xp-rules v1`, with the version label
  visible ("rules v1 · 100 XP per accepted revision · 500 XP per level").
- `awaiting verified evidence` is a first-class state wherever an award would appear.
- Manager rating control appears only where a human is the author — landed in the inspector
  **History rows** (ended runs with a task), the only post-task human-authoring surface on
  `/manager`; the board and profiles do not render ratings — rating display lives in the
  inspector History rows.
- There is deliberately no XP submitter: `ui/src/api.js` exposes a GET-only rewards helper plus
  the one ratings POST, and nothing else.

## 7. Acceptance criteria (slice 3, for the record now)

- [ ] Ledger is a separate durable store (not localStorage, not telemetry edits), path overridable for tests, survives restart.
- [ ] Automatic XP originates only from validated acceptance-evidence ingestion; browser XP submission is impossible.
- [ ] Replay/concurrent insertion of the same evidence yields exactly one award.
- [ ] Reopened task / revoked acceptance adjusts active XP and preserves the audit trail.
- [ ] Rating amendment supersedes without regenerating XP; unrated renders as unknown, never 0.
- [ ] Cross-repo task-ID collision, changed model/prompt, missing evidence and invalid role are all handled (each has a test).
- [ ] XP constants render with their rule version and are labelled as product rules.
- [ ] No XP-driven unlock of tools, autonomy, spend or promotion exists anywhere in the codebase.

## 8. Out of scope

Leaderboards claiming causal quality, rating-driven autonomous selection, model marketplaces,
historic backfill before the ledger exists, and any training/RL interpretation of XP.

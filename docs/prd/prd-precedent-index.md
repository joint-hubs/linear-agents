# Precedent Index — PRD

**Status:** plan accepted by Mateusz 2026-09-29 · **F0 done (results 2026-09-29), go/no-go decision pending** · F1+ gated on that decision
**Date:** 2026-09-29
**Owner:** Mateusz
**Rationale, options and evidence:** [brainstorm-precedent-search.md](../plans/brainstorm-precedent-search.md) (Polish; this PRD holds the normative requirements only)
**ADR:** [0014](../adr/0014-precedent-index-two-layer.md) (Proposed)
**Supersedes:** the "experience packets" layer of [flowdb-learning-loop.md](../plans/flowdb-learning-loop.md)
**Feeds:** [brainstorm B](../plans/brainstorm-specialization-learning.md) (playbooks consume clusters and lessons)
**Backlog refs:** none created yet — drafts in §9 (not pushed to Linear)

## 1. Problem

Every task in Fenix starts from zero. PLAN does not know what similar tasks cost or how many review rounds they took; DEV rediscovers the same pitfalls; REVIEW sends work back for the same defects. The knowledge exists but is scattered: Linear (description, AC, hand-offs), git (commits), `.state/supervisor/` (gates, verdicts), telemetry (cost, time) and transcripts (thoughts and actions; ~65% of the files still exist, the rest were pruned). Earlier attempts are dormant (`flow.db`, 45 tasks, last data 2026-08-02; the FlowDB layer-3 spec was never built).

## 2. Goal and non-goals

**Goal.** For a new problem (ticket, symptom, plan sketch, set of files) return, within a token budget:

1. similar **closed cases** and how they were solved (commits, files, functions, the chain of steps);
2. which of them were solved **most efficiently** (fewest turns first, then cost and time) at acceptable quality;
3. known **pitfalls** (review findings on those files, dead ends in past chains);
4. **calibration**: what such tasks usually cost (input to estimates and budgets).

**Non-goals.** A vector database service; LLM fine-tuning; indexing FEN/PISI/pseudo-tasks (`SUP:*`); applying precedents automatically without a human and measurement; code search (CodeGraph does that); a dashboard rebuild (a small panel only, F6).

## 3. Decisions (Mateusz, 2026-09-29 — binding)

| # | Decision |
|---|---|
| D1 | Success (A2) = TEST pass + human approval + task moved to Done |
| D2 | **Two layers.** L1 = deterministic and automatic. L2 = L1 analysed by the CADENCE squad. **L2 has higher priority** (lane, veto, dedupe) |
| D3 | Embeddings: state of the art **via the OpenRouter API**, maximum precision; the model is chosen by a bake-off on our own data |
| D4 | Use a **clustering algorithm** on the embeddings and a **Jev- or Laya-type classifier** in the workflow |
| D5 | Corpus: **FOC and JOI only** |
| D6 | Reasoning/thoughts are indexed too, as **sequences / chains / relations** |
| D7 | This is a Fenix implementation (Node scripts, MCP server, graph step, CADENCE role), not a notebook analysis |
| D8 | V2 = TEST pass + `cleanup-approval` or `push-approval` answered "tak"; the standalone era (before 2026-08-25) reaches V1 at most |
| D9 | "Fastest" = **fewest turns first**, other metrics weighted lower. "Turn" has two meanings in Fenix, so the family covers both: **LLM turns** (assistant messages = model calls; every task with telemetry), **child turns** (`children.json → turns[]`: each spawn or resume of a supervisor child, including gate-answer and review-loop resumptions; supervisor era only) and **review rounds** (verdict records). Default weights (config, tuned in F0): LLM turns 0.35, child turns 0.15, review rounds 0.10 (family total 0.60), loaded cost 0.20, active time 0.20; an unavailable metric's weight is renormalised over the available ones |
| D10 | JOI content and transcripts may be sent to the embeddings API after the egress screen (fail-closed; no tool results) |
| D11 | CADENCE `curator` role approved; Mateusz edits `agents/cadence/CLAUDE.md`; weekly schedule plus on-demand |
| D12 | Jev first; Laya later (student / Path B once labels exist) — not in F0 |
| D13 | A Python sidecar is allowed (clustering, evaluation); the core stays pure JS + `node:sqlite` |
| D14 | Go/no-go thresholds accepted: Recall@5 ≥ 0.35, cost-prediction MAPE ≥ 15% better than the per-type median, ≥ 60% of clusters coherent |

## 4. Users and journey

| Persona | Need |
|---|---|
| **Mateusz** (owner, async HITL) | trust a suggestion at a glance; digest and dashboard over raw logs; edit or veto lessons in git |
| **PLAN** | calibration for estimates; earlier AC / decompositions of similar tickets |
| **DEV** | pitfalls and "how it was fixed" for the files about to be touched |
| **REVIEW** | earlier findings on the same files |
| **Supervisor** | task-size estimate and budget |
| **CADENCE / curator** | the L1 material to curate |

**Journey.** (1) A ticket arrives; intake shows "3 similar closed tasks (L2: 1 lesson + 2 cases), median loaded cost $X, usually Y rounds; golden path: …". (2) DEV starts recon on files A, B and gets pitfalls from earlier work (advisory, with "differences to check"). (3) After Done and a "tak" on cleanup, L1 ingests the task automatically. (4) Weekly, CADENCE adds new lessons, flagged cases and the fastest solutions per cluster to the digest; Mateusz edits or vetoes lessons in a PR.

## 5. Requirements

Normative. Detail and reasoning: brainstorm section in parentheses.

| ID | Requirement |
|---|---|
| **Corpus and quality** | |
| R1 | Only tickets matching `^(FOC\|JOI)-\d+$` in allowlisted repos are indexed; `SUP:*`, FEN, PISI are excluded (§13) |
| R2 | Quality levels: V0 = Done in Linear; V1 = V0 + TEST verdict pass; V2 = V1 + ≥ 1 human approval. "Fastest" rankings use V2 only; also "settled", AC map covers declared ACs, not `excluded` by L2 (§8) |
| R3 | Every record carries provenance: sources, snapshot time, extractor version, layer, method |
| **L1 ingest** | |
| R4 | L1 is deterministic: same sources + same pinned embedding model ⇒ same index. No generative output in L1 except Jev `choice` labels, tagged with provenance (§6) |
| R5 | Ingest is idempotent (content hash), incremental and resumable; a re-run on unchanged sources changes nothing and costs $0 |
| R6 | All text leaving the machine passes the egress screen on raw leaves; a hit skips the item and increments a counter, never sends silently; raw tool results are neither stored nor sent (§13) |
| R7 | The embedding model is pinned in `config/models.json` with a price row; model id and dimensions are stored with every vector; a model change is an explicit re-embed job |
| R8 | Every embedding / Jev call emits a telemetry event with `usage.cost`; hard cap `LA_PRECEDENT_MAX_COST_USD` |
| R9 | Chain data derived from transcripts is indexed early (before retention deletes the files) and backed up like the telemetry store (§6) |
| **Retrieval** | |
| R10 | Query modes: `problem`, `symptom`, `plan`, `files`, `fastest`, `chain` (§8) |
| R11 | Hybrid retrieval: FTS5 BM25 + dense vectors + structural (shared files/functions), fused with RRF (k = 60); weights tuned in F0 |
| R12 | L2 lane first at a lower similarity threshold (θ_L2 = θ_L1 − δ); `exclude` removes, `caution` warns, `superseded` substitutes; L2-cited cases move under their lesson (§7) |
| R13 | Jev `noul` rerank of the top-N is an A0 annotation, never the sole criterion until calibrated (§8) |
| R14 | Below threshold the answer is "no precedent"; abstentions are logged |
| R15 | Result cards fit a hard token budget (2–4k), carry provenance, confidence and "differences to check", are advisory in tone, and are delimited as data |
| R16 | Query latency < 1 s on the full corpus (brute-force cosine in JS) |
| **Efficiency** | |
| R17 | Efficiency = −Σ w_m · log(actual_m / expected_m); expected_m comes from earlier V2 neighbours (k = 5–10, similarity-weighted); fewer than 5 neighbours ⇒ "n/a"; always show n and a bootstrap interval; weights in `config/precedent.json` (D9) |
| R18 | Chain shortness (steps from the first exploration to the first successful verification) is reported separately from cost |
| **Chains** | |
| R19 | Model: case ▸ chain ▸ episode ▸ step (thought → action → observation) with typed relations `next`, `retry_of`, `responds_to_error`, `resolves`, `touches_file`, `touches_function`, `returned_by`, `blocked_by`, `related_to`, `duplicate_of`, `similar_to`, `member_of`, and L2-only `supersedes`, `annotates` (§5, §11) |
| R20 | Thought text is stored truncated and screened (head + tail) with its full length and a transcript pointer; native Claude redacts thoughts, so those steps keep actions and observations only |
| R21 | Segmentation is deterministic; loops are collapsed by similarity (`retry_of`) (§11) |
| **Clusters and classifier** | |
| R22 | Cluster cases, episodes and sequence signatures; cluster identity belongs to L2; online assignment to pinned centroids; the Python sidecar is batch, file-based, optional and fail-soft (D13) (§9) |
| R23 | Classifier decisions are registered in `config/decisions.json` at autonomy A0 and go through the existing decision-call seam: `precedent.relevance`, `.problem_type`, `.area`, `.step_kind`, `.resolved`, `.duplicate`. Jev first (D12) (§10) |
| **L2 (CADENCE curator)** | |
| R24 | Curator outputs: annotations (`endorsed`/`caution`/`exclude`/`superseded`), lessons as `docs/lessons/*.md` in git, cluster names, golden paths and anti-patterns, stale-check via CodeGraph, dedupe (§7) |
| R25 | Extractive guarantee: every L2 statement cites existing artifact ids and metrics; a deterministic checker verifies that ids exist and quotes appear verbatim in the source; a lesson without evidence is rejected (lesson FOC-359) |
| R26 | L2 lives in separate tables keyed by the stable case id; an L1 rebuild never overwrites L2 |
| R27 | Contract changes recorded: `agents/cadence/CLAUDE.md` (Mateusz), the `cadence` node in `config/graph.json`, ADR-0014, a weekly schedule |
| **Integration** | |
| R28 | CLI `scripts/precedent.mjs` (JSON on stdout, logs on stderr; registered in `docs/tools/README.md`); read-only MCP `scripts/mcp/server-precedent.mjs` with a freshness guard that returns a typed UNKNOWN when freshness cannot be proven |
| R29 | Graph step `plan.precedents [D]` after `plan.dor`; `intake.task_size` gets `state.neighbors`; a DEV recon prologue block only after A0 evidence; REVIEW gets earlier findings on the changed files; marker `##PRECEDENT <id>` |
| R30 | Every query, result and use is logged (telemetry) for online evaluation |
| **Security and privacy** | |
| R31 | The index is local and git-ignored; `precedent purge --task`; lessons (in git) contain no secrets (checker + screen) |
| R32 | Retrieved text is data, not instructions; agents ignore commands inside precedents |
| R33 | Scope = ticket regex + repo allowlist (from `config/projects.json`) + path denylist; F0 measures overlap with non-Fenix paths before anything is embedded (T0.1) |
| **Gate** | |
| R34 | Go/no-go after F0 (D14). Not met ⇒ stop, or narrow to a structural "file → cases" index without vectors |

## 6. UX

Consumers are mostly agents; Mateusz reads digests and cards. Tone is always **advisory, with evidence** — provenance, confidence and "what to check before copying"; never an order.

Card schema (illustrative, not data):

```
{ id, layer: "L1"|"L2", similarity: {dense, bm25, structural},
  why: [shared files, terms],
  outcome: {quality: "V2", turns, rounds, loaded_cost_usd, active_min, efficiency: "-42% vs neighbours", n},
  solution: {commits, files, functions, approach, pitfalls},
  chain: {steps, golden: true},
  caveats: [differences to check, stale?],
  provenance: {sources, curated_by} }
```

CLI: `precedent search "<text>" [--mode problem|symptom|plan|files|fastest|chain] [--k 5] [--json]`, `precedent show <case>`, `precedent chain <case|episode>`, `precedent files <paths…>`, `precedent fastest --like <case>`, `precedent ingest [--task FOC-xxx]`, `precedent status`, `precedent verify`, `precedent eval`, `precedent purge --task`.

## 7. Architecture (summary)

One derived SQLite file `precedents.sqlite` beside `telemetry.sqlite`, outside git: tables for `case`, `artifact`, `chain`, `episode`, `step`, `vec` (object, facet, model, dims, float32 BLOB, text hash), `edge` (src, rel, dst, weight, provenance), FTS5 indexes, and separate L2 tables (`annotation`, `lesson`, `cluster`). L1 pipeline: extract → screen → normalize → segment → embed (OpenRouter) → link → score → store. Retrieval: candidates (BM25 + dense + structural) → RRF → L2 lane → Jev rerank → cards. Full diagram and rationale: brainstorm §4–§11.

New pieces: `scripts/precedent.mjs`, `scripts/lib/precedent-*.mjs`, `scripts/mcp/server-precedent.mjs`, `config/precedent.json`, embeddings section in `config/models.json`, decision entries in `config/decisions.json`, step `plan.precedents` in `config/graph.json`, curator role in `agents/cadence/`, `docs/lessons/`, an optional Python sidecar under `tools/precedent-sidecar/`.

## 8. Phases and tasks

Each task has an owner squad in the drafts (§9). Tick as work lands.

### F0 — Evidence spike (offline, no infrastructure; 2–4 days) — **results in 2026-09-29, decision pending**

Code in `tools/precedent-spike/` (proposed for commit, not committed), data in `.spike-precedent/` (git-ignored by the existing `.spike-*/` rule), report in [docs/benchmark/precedent-index-spike.md](../benchmark/precedent-index-spike.md). Read-only against telemetry, Linear and git. Leakage rule: a signal is never evaluated against a label derived from itself; evaluation uses a **time split** (a query sees only earlier cases).

- [x] **T0.1** Corpus snapshot: 1 036 cases → 626 in scope; V0 368 / V1 126 / **V2 64**; 1 289 tagged commits in 11 repos; transcripts 79% reachable with the retention archive
- [x] **T0.2** Bake-off of 12 models (+ dimension and prefix variants): code-oriented models lead; top group not separable; dimension truncation is nearly free; ≈ $0.60 total
- [x] **T0.3** Time-split retrieval with BM25 / recency / random baselines and paired intervals: hybrid > BM25 in every setting, gain largest cross-epic and cross-project
- [x] **T0.4** Neighbour prediction (**does not beat simple baselines**) and ranking stability (**stable to weights, not to the meaning of "turn"**)
- [x] **T0.5** Clustering: HDBSCAN best (45 clusters, ARI 0.86, 45% unassigned); Louvain only a coarse fallback
- [x] **T0.6** Jev pilot (196 decisions, $0.006): relevance rerank plausible but not significant; `problem_type` accuracy 0.63. Laya out of F0 (D12)
- [x] **T0.7** Chains: 1 789 transcripts → 67 400 steps → 11 128 episodes in 9 s; 46.5% of error signatures recur, 27% of recurring ones have an earlier resolved episode
- [ ] **T0.8** Report written; **go/no-go decision (Mateusz) — pending** (§10 of the report)

**F0 verdict vs D14:** Recall@5 met, cost-prediction MAPE **not met**, cluster coherence provisionally met. Recommendation: **go, narrowed** — drop the predictive cost claim (R17), keep hybrid retrieval, clusters and chains. Requirement changes proposed by the evidence (R2, R6, R7, R11, R15, R17, R22, R29, R33) are tabulated in the report §8 and are applied to this PRD when the decision is recorded.

**F0 done when** the report contains, per test, the metric, the baseline, the threshold from D14 and a verdict (done), and Mateusz has recorded go / narrow / stop (pending).

### F1 — L1: indexer, store, CLI (2–3 weeks)

Schema, connectors (Linear, git, `.state`, telemetry, transcripts), screen, embeddings client with meter and `config/models.json` entry, idempotent ingest, `precedent search/show/status/ingest`, tests (`*.test.mjs`, lane in `test-lanes.json`, lint), freshness guard, supervisor hook after Done. **AC:** ingest of the whole FOC/JOI corpus < 15 min and < $5; a repeat ingest changes nothing and costs $0; a query < 1 s; fail-closed paths covered by tests.

### F2 — Chains and relations

Segmentation, edges, `precedent chain`, `step_kind` tagging (Jev), error-signature search. **AC:** on a 50-episode sample, ≥ 70% agreement with a manual judgement of kind/outcome for `recover` episodes.

### F3 — MCP and A0 integration

`server-precedent.mjs`, step `plan.precedents`, `state.neighbors` in `intake.task_size`, triage annotation, REVIEW "findings on these files", `##PRECEDENT` marker, telemetry events. **AC:** queries and uses visible in telemetry; no change in agent behaviour beyond the annotation.

### F4 — L2: CADENCE curator

ADR-0014 accepted, `agents/cadence/CLAUDE.md` change (Mateusz), curator role, citation checker, lessons in `docs/lessons/`, lane and veto in search, weekly schedule. **AC:** a weekly run produces annotations and ≥ 1 lesson whose evidence the checker verifies; a lesson without evidence is rejected; L2 beats L1 per the rules.

### F5 — Clusters, efficiency, playbooks

Production clustering with pinned ids, `fastest` ranking with neighbours and gates, best-of-cluster → playbook drafts (brainstorm B). **AC:** stable cluster ids across runs (ARI ≥ agreed threshold); rankings show n and an interval.

### F6 — Dashboard, monitoring, Laya, retention

"Similar tasks" panel; coverage / hit-rate / drift / cost metrics; the Laya decision (student / Path B, ADR-0012 amendment); backup of the chain layer.

## 9. Linear drafts (not created in Linear)

Decomposition granularity follows the repo rule "smallest independent slice". F0 and F1 are decomposed; F2–F6 stay epics until the go/no-go, because a "narrow" or "stop" outcome would change them. Squad names refer to the Fenix squads (DEV builds, TEST verifies). **PI-0.1–PI-0.8 were executed directly on 2026-09-29 (see §8 and the F0 report); do not create them in Linear except, if wanted, as closed items for traceability.** The PI-1.x rows below are pre-evidence drafts and will be adjusted by the report's §8 (hybrid retrieval, no predictive cost claim, mask-and-rescreen, real repo allowlist, archive as transcript source).

| Draft | Title | Squad | Size | Depends on | Acceptance |
|---|---|---|---|---|---|
| **E-PI** | Epic: Precedent Index (L1 + L2) | PLAN | — | — | F0 verdict recorded; F1–F6 tracked as children |
| PI-0.1 | F0: corpus snapshot with V-levels and scope test | DEV | M | — | `corpus.jsonl` + report; counts by workspace and V-level; transcript overlap with non-Fenix paths reported |
| PI-0.2 | F0: embedding bake-off harness | DEV | M | 0.1 | ≥ 5 models embedded (facet `problem`); cost and latency table; vectors cached |
| PI-0.3 | F0: retrieval eval (time split, baselines) | DEV | M | 0.2 | Recall@k / MRR / nDCG for each model and baseline with confidence intervals |
| PI-0.4 | F0: neighbour prediction and ranking stability | DEV | S | 0.2 | MAPE vs per-type median; ranking stability under weight perturbation |
| PI-0.5 | F0: clustering comparison | DEV | S | 0.2 | cohesion, ARI stability, label agreement; a review sheet for manual coherence |
| PI-0.6 | F0: Jev pilot (200 items) | DEV | S | 0.1 | accuracy vs reference labels, latency, cost; labels exported |
| PI-0.7 | F0: chain feasibility (50 transcripts) | DEV | M | 0.1 | segmentation sanity report; error-signature hit@k |
| PI-0.8 | F0: report and go/no-go | PLAN | S | 0.3–0.7 | `docs/benchmark/precedent-index-spike.md`; the decision recorded by Mateusz |
| PI-1.1 | Store schema and migrations | DEV | M | 0.8 go | tables + tests; L1/L2 separation enforced |
| PI-1.2 | `config/precedent.json` and embeddings entry in `config/models.json` | DEV | S | 0.8 go | validators and config-drift tests pass |
| PI-1.3 | Embeddings client (batch, retry, cache, meter, cap) | DEV | M | 1.2 | mocked tests; fail-closed on screen hit |
| PI-1.4 | Linear connector | DEV | M | 1.1 | fixtures; snapshot idempotent |
| PI-1.5 | Git connector (commits, files, functions) | DEV | M | 1.1 | commits matched by subject and by child registry |
| PI-1.6 | `.state/supervisor` connector (gates, verdicts) | DEV | S | 1.1 | V-level and `returned_by` computed |
| PI-1.7 | Telemetry connector (turns, cost, time, rounds) | DEV | M | 1.1 | canonical views only; parity with the analysis numbers |
| PI-1.8 | Ingest command and supervisor hook | DEV | M | 1.3–1.7 | < 15 min, < $5, repeat = no change |
| PI-1.9 | Search v1 and CLI | DEV | M | 1.8 | < 1 s; RRF; abstention; `status`, `verify` |
| PI-1.10 | Docs and tool registry | DEV | S | 1.9 | `docs/tools/` entry; TELEMETRY-EXPLAINED note |

## 10. Risks and open items

Risk table: brainstorm §16. Open: (a) the exact meaning of "turns" — LLM turns vs supervisor child turns vs review rounds; **F0 shows the ranking depends on it** (child-turn and round rankings are nearly unrelated to the LLM-turn ranking, report §4), so it must be decided before F1 ships `fastest` (D9); (a2) default scope exclusions applied in F0 (personal projects, personal-finance/tax/hobby workdirs, automated intake alerts; −410 cases) — confirm or widen; (a3) who reviews the cluster sheet for D14 criterion 3; (b) when Mateusz edits `agents/cadence/CLAUDE.md` and turns on the schedule (F4); (c) whether ADR-0012 changes for Path B (F6).

## 11. Status and resume point

- 2026-09-29: plan accepted; brainstorm updated to approved-v2; this PRD and ADR-0014 written; **F0 executed (T0.1–T0.7), report written; T0.8 decision pending**.
- Resume: read [the F0 report](../benchmark/precedent-index-spike.md) (§0 verdict, §8 design changes, §10 decision block), then this section. On "go" apply the §8 changes to R-rows and ADR-0014, then decompose F1 in Linear from §9 (drafts PI-1.x). Pre-existing uncommitted changes in the repo (`docs/STATE.md`, `scripts/linear-ops.mjs`) are not part of this work.
- Nothing from this work is committed; the proposed commit batches are listed in the session summary.

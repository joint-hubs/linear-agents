# FOC-272 — Architecture review: does the Fenix topology match how work actually flows?

**Type:** consolidated review, answering children FOC-274…FOC-280 in one document.
**Status:** findings produced; fix-or-defer disposition **pending a gate** (scope record §3.4 / Q2 — findings never auto-extend 1.0 scope).
**Reviewer:** REVIEW child `review-3`, supervisor run `2026-09-11T06-21-51-460-supervisor-58da`.
**Base:** `674f8f4` (worktree `foc-272-review`, branch from `chore/foc-102-baseline`), clean at start; analysis-only — no `config/`, `agents/*/settings*` or prompt edits (issue AC 4).
**Deliverable form:** written recommendation (`docs/reviews/`), not an ADR — no single decision is proposed here; the gate disposes first, and any ADR belongs to the wave that implements what it approves.
**Mandate:** `docs/plans/fenix-1.0-release-scope.md` §3.4 (pure review, runs first, fix-or-defer gate). The issue packet's note that "cadence+orchestrator are the non-graph ones" was **corrected against `config/graph.json`**: 7 dirs exist under `agents/` (`cadence, dev, orchestrator, plan, review, supervisor, test`); the graph declares nodes `plan, dev, review, test, cadence` plus the `human` pseudo-node (`config/graph.json:23-135`, `entryNodes` line 8). The non-graph dirs are **orchestrator and supervisor**; cadence is an entry node.

---

## 0. Method and evidence base

**Inputs (all read by this run or its delegated extractions):**
- `docs/research/telemetry-analysis-2026-09.md` (revised 2026-09-10) — primary analysis.
- `report/viz-data.json` (regenerated 2026-09-10T15:50Z, read-only outside this worktree) — every series cited by exact key.
- `.state/research-scratch/A1-cost-latency.md, A2-failure-atlas.md, A3-behavior.md, B1-gates.md, B2-first-turns.md, B3-verdict-findings.md, FT-probe-training-data.md` (read-only outside this worktree) — cited as `(A1 §5)` etc.
- `config/graph.json`, `config/handoff-rules.json`, `scripts/graph-validate.mjs`, `scripts/graph-route.mjs`, `scripts/review-round.mjs`, `scripts/telemetry-server.mjs` (routing surface), `scripts/supervisor-spawn.mjs`, `scripts/supervisor-gate.mjs`, `bin/*.bat`, `config/models.json` (+ `config/models.map`), `agents/{plan,dev,review,test,cadence}/CLAUDE.md` + 29 role files, `docs/adr/0001/0002/0008/0009/0010`, `docs/plans/brainstorm-graph-engineering.md`, `docs/plans/fenix-stabilization-and-learning.md`, `docs/plans/fenix-linear-reconciliation.md`, `docs/TELEMETRY-EXPLAINED.md`.

**Corpus:** 537 runs, 142,997 canonical turns, 70,663 tool calls, 2026-06-25 → 2026-09-10 (`report/viz-data.json → corpus`).

**Method rules applied (from the issue):**
1. **Incident vs pattern** (telemetry report F3a / R13): a per-model or per-role rate is a routing signal only if its calls span several runs; single-run concentrations are reported as incidents, with the run named. §10.1 is the incident register; every incident used is marked `INCIDENT:` inline.
2. **Disputed figures:** conclusions resting on figures FOC-220/FOC-221 actively dispute carry a `disputed-figure` mark naming the task and what changes if its revision lands (§10.2).
3. **Scope sensitivity:** the same metric measured over the full corpus and over the supervisor era (47 runs, 2026-08-27+) differs materially for some series (plan share: 20.1% vs 8.9%). Both variants are given wherever the difference changes the reading, because the `viz-data.json` `budgetShares` series carries **no scope declaration of its own** — a data gap, not a license to pick the convenient number.

**Dollar convention (applies to every `$` below):** all dollar figures come from `canonical_usage` (run-scoped dedup applied, factor 1.83 removed) but still carry the message-line over-count, factor 2.19 — `F7_dataQuality.inflation`: runScoped 1.83×, messageScoped 2.19×, combined 4.01×. The corpus is ≈$1,400 real, not the $3,099.08 canonical sum. **Shares are asserted by the report to be unaffected ("the over-count is proportional across squads, models and roles", F2 note) — that proportionality is itself unverified and is disputed-marked in §10.2.**

---

## 1. Executive verdicts

| Child | Question (short) | Verdict | Key findings |
|---|---|---|---|
| FOC-274 | Five-squad split vs where work is | **Split verdict** — task-flow topology matches reality; cost topology does not describe its two largest actors | F-01, F-02, F-03 |
| FOC-275 | Can the corpus supply the return discriminator? | **Yes for review→dev** (data exists, routing surface missing); **inconclusive for test→dev** (corpus too thin) | F-04, F-05, F-06 |
| FOC-276 | Do the ~30 subagent slots earn their place? | **29 slots; declared slots earn or cost nothing; the real gap is undeclared built-ins at ~39.5% of subagent spend** | F-08, F-10, F-11 |
| FOC-277 | Tool fit | **Declared tool lists fit; one hard rule is structurally unmet** (scanners never provisioned); codegraph-first unmeasured | F-09, F-14 |
| FOC-278 | Pinned state that stops re-derivation | **Defined** (schema in §6); strong multi-run evidence; adoption is a small system change | F-12 |
| FOC-279 | Which rules are measurable / held? | **4 not held or structurally unmet, 1 mode-drifted, 5 verified held, several measurable-but-unverified** (table in §7) | F-02, F-06, F-07, F-08, F-13 |
| FOC-280 | Evidence for any new squad/agent/node? | **No new squad, no new node; three targeted additions/declarations are justified** | F-01, F-04, F-13 |

Disposition summary (the gate decides; details in §9): **fix-now set** F-04, F-06, F-09, F-12, F-13, F-14 (+ supervisor hygiene action F-16); **defer set** F-01, F-02, F-03, F-05, F-07, F-08, F-10, F-11, F-15, F-17.

---

## 2. FOC-274 — Does the five-squad split match where the work actually is?

**(a) Question.** The topology claims five squads (plan → dev → review → test, plus cadence on a timer) partition the work. Does the measured distribution of runs, turns and cost match that claim?

**(b) Series that answer it.**
- `F2_cost.bySquad` (full corpus, $3,098.98 canonical): supervisor **$1,366.38 / 44.1%**, dev $907.59 / 29.3%, plan $328.38 / 10.6%, review $315.07 / 10.2%, orch-ollama $96.78 / 3.1%, test $79.81 / 2.6%, cadence $4.97 / 0.2%. Unpriced rows: 3,299.
- `F2_cost.budgetShares[]` (full corpus): plan 0.2014 vs 0.20 hint (Δ+0.1 pp), dev **0.5565 vs 0.45 (Δ+10.6 pp)**, review 0.1932 vs 0.20 (Δ−0.7), test **0.0489 vs 0.10 (Δ−5.1)**.
- Supervisor-era variant (A1 §5, 47 runs): plan 8.9% (Δ−11), dev 62.1% (Δ+15), review 18.0%, test 10.9% (on target); verification stage 28.9% vs 30%.
- Run counts (A1 §7): dev 188, review 131, test 60, plan 41, supervisor 50, orch-ollama 12; cadence run count not reported (gap, §10.3).
- Funnel evidence (FT §3): 46 dev→review and 42 review→test adjacent session pairs — the handoff edges carry real traffic in order.

**(c) What would change the answer.**
- FOC-221's per-message dedup: if the 2.19× factor is **not** proportional across squads (plausible — thinking-heavy models emit more transcript lines per message), every share above moves; the report's proportionality assertion is unverified. `disputed-figure: FOC-221`.
- Removing first-turn re-derivation (F-12) and the frontman diet (report R2) both target dev/frontman spend; a re-measure after those land is the honest calibration point for shareHints (this is why F-02 proposes recalibration **after** the wave, not now).
- More cadence activity (F-03) would slightly move its 0.2% share — immaterial to the verdict.
- Unpriced rows (3,299, of which supervisor 1,677 — `F7_dataQuality.unpricedModels`, `bySquad.unpriced`) suppress the frontman's true share further; pricing GLM-5.2-FP8 (2,732 rows at $0) can only raise it.

**(d) Verdict.** The **task-flow topology matches reality**: work runs through plan→dev→review→test in the declared order, the funnel counts are monotonic, the verification share the budget policy protects held in the supervisor era (28.9% vs 30%), and no measured child work is homeless — no squad is missing from the five. The **cost topology does not describe where the money goes**, in three ways:
1. The two actors with the largest footprints outside the graph are unmodeled: the supervisor/frontman (44.1% full corpus; 43.5% era = 2.5× all 186 supervised children combined, A1 §5 — the 2.5× figure is era-scoped) and the orch-ollama path (3.1%, 12 sessions W31–W33). ADR-0009 deliberately keeps the frontman inside the cost cap but outside per-stage budgeting ("one number including the Supervisor lead's own cost", 0009:52) — a defensible design choice that was **never written into the graph's budget model**; `graph.json`'s `_budget` note partitions shares as if squads were the whole budget.
2. `shareHints` were promised to be "tuned from usage_facts once real runs exist" (`config/graph.json:14`) and never were — 78 days in, this review is the first calibration. Dev runs +10.6 pp (full corpus) / +15 pp (era) hot; plan and test swing from on-target to −11 pp cold depending on era, which shows the hints need an era-scoped definition, not just new numbers.
3. Cadence declares a weekly timer ("1 digest/week", `agents/cadence/CLAUDE.md:46,138`) but was active in **2 of ~11 weeks** (W26, W32; A1 §3) — the node as declared does not operate.

**(e) Recommendation.**
- **Change the rule (description), not the shape:** declare the frontman and the orchestrator path explicitly out-of-graph in the budget note with their measured shares, instead of adding nodes — the graph models task flow, and the frontman is the runtime that executes it (F-01, defer).
- **Change the rule, later:** recalibrate `shareHints` only after F-12 lands and FOC-221 resolves the disputed factor — recalibrating now would enshrine re-derivation waste and disputed dollars as targets (F-02, defer, blocked by FOC-221).
- **Decide:** wire the cadence timer or demote cadence to a manual on-demand node — its designed enforcement role (delegation-floor retro, bounce limits) is dead letter while it never runs (F-03, decision).

---

## 3. FOC-275 — Can the corpus supply the discriminator the unroutable graph edges need?

**(a) Question.** 6 of 10 edges are `routable:false`, including both returns (`review-to-dev-return`, `test-to-dev-return`), because `In Progress` is also the state of a task dev is actively working on. Does the telemetry corpus already record something that can serve as the "returned, round > 0" discriminator?

**(b) Series / mechanics that answer it.**
- Routing surface: `scripts/graph-route.mjs:30` (`suggestedSquad`) matches **Linear state + labels only**, first-match-wins; `scripts/telemetry-server.mjs:111` reads the 4 emitted rules from `config/handoff-rules.json`. Nothing else reaches the matcher.
- Where rounds live today: verdict records carry `round` per task (`.state/supervisor/<run>/verdicts/*.json`, B3 §1); legacy counter `.state/review-rounds.json` (37 tasks / 64 rounds, FT §2); prose round files `.state/reviews/*.md` (~40, B3 §1); and the Linear comment tag `run:review-round:<ID>:<N>` (review loop step 4) — the round reaches Linear **only inside comment text**, never as a label or state. No telemetry table surfaces round/return (gap).
- Rounds distribution (A2 §4, 47 tasks): 1 round → 25 tasks, 2 → 15, 3 → 3, 4 → 1, 5 → 1, 7 → 1, 9 → 1. `F5_review.findingsByRound`: r1 216, r2 57, r3 29, r4 4, r5 5.
- Near-repeat fingerprints (A2 §4): `fingerprint.combined` equality on consecutive rounds already detected 2 real no-movement repeats — FOC-143 r1→r2→r3 (`75b61bda9d2f4ee3`, run 11df; **INCIDENT:** burned 2 rounds, still failed) and FOC-225 r6→r7 (`7e7c3026fea1858d`, run dd5b; recovered r8+). But `fingerprint.failingTests` is non-empty in **3 of 89** verdicts (F7.4; A2 §4: "near-blind by construction").
- Test→dev returns: 5 test verdicts with ~0 findings exist (B3 §2); root-cause report counts were never analyzed (gap).

**(c) What would change the answer.**
- FOC-163 (fingerprint replaces the round counter — promised in the edge's own `why` note and ADR-0009:7) landing: then the discriminator becomes the fingerprint, and what the corpus must supply is `failingTests` population, not a round label. Either way the **Linear surface** still needs a new label/state — the fingerprint also lives in local records today.
- F-06 (enforce `failingTests` at record time) landing: makes fingerprint-based gating checkable at all; without it, near-repeat detection stays half-blind.
- TEST producing real returns (FOC-165's release-candidate run is the first staged opportunity): the test→dev edge can only be designed against data that does not exist yet.

**(d) Verdict.** **Yes for review→dev — as data, no as surface.** The corpus records everything the discriminator needs: per-task rounds exist in three independent stores, the fingerprint mechanism has already caught both a failure (FOC-143) and a recovery (FOC-225), and the escalation condition ("returned") is exactly what the review loop's own transition does. What does not exist is any of it **on the routing surface**: the matcher sees state+labels, and a returned task is `In Progress` with at most `risk:high` — indistinguishable from work dev already holds. This is a labeling gap, not a data gap, and it is small: the matcher already speaks labels, including stem wildcards (`needs:*`), so an exclusive return label at transition time requires no matcher change.
**Inconclusive for test→dev:** 5 verdicts with no findings is not a corpus to design or validate a discriminator against (F-05). The other four unroutable edges are correctly non-routable by design: the three `escalate` edges would be dead code against the order-1 `needs:*` gate (their own `why` notes say so), and `plan-to-human-gate` stays unroutable because gate records are deliberately not mirrored into Linear (`scripts/supervisor-gate.mjs:9-11`), which should only be revisited if FOC-134 (dispatch-as-code) returns.

**(e) Recommendation. Change the system** (small): emit an exclusive return label (e.g. `returned-by:review` / `returned-by:test`, added on the fail transition, removed on re-handoff) at return time; then flip the two return edges `routable:true` and regenerate `config/handoff-rules.json` via the existing equivalence proof (`graph-validate.test.mjs`). Order-1 `needs:*` precedence keeps escalated tasks routed to human; the `Todo+dor-ok` rule is state-disjoint, so no shadowing is introduced. The dashboard gap this closes is real and was invisible by design ("returns route to null in the dashboard and nobody noticed", `scripts/graph-validate.mjs:5-7`). Prerequisite for the fingerprint path: F-06. **No matcher change, no new state machine.** (F-04 fix-now; F-05 defer until TEST data exists; F-06 fix-now.)

---

## 4. FOC-276 — Role inventory: which of the ~30 subagent slots earn their place?

**(a) Question.** The squads declare ~30 subagent role slots. Measured against the corpus, which earn their place?

**(b) Series that answer it.**
- **Exact inventory (verified, not ~30): 29 slots** — plan 7, dev 6, review 5, test 6, cadence 5 (`agents/<squad>/agents/*.md` frontmatter). 24 of 29 are pinned `z-ai/glm-5.3-flash` (plan/dev/review/test uniform); cadence alone diversifies (minimax-m3, deepseek-v4-pro, deepseek-v4-flash, glm-5.2). ADR-0002's per-role pinning mechanism works as designed — the slugs in the role files are what `config/models.json → routing` maps.
- `F2_cost.leadVsSubagent`: subagents hold **$377.48 / 12.2%** (lead $2,721.49 / 87.8%) across 69,740 subagent turns. `disputed-figure: FOC-221` — if the 2.19× line factor is not proportional between lead and subagent turns (thinking-heavy lead models plausibly emit more lines), this share moves; report asserts proportionality.
- `F2_cost.byRole` (20 rows): the top subagent consumers are **not declared slots**: `general-purpose` $90.81, `Explore` $37.46, `claude` $16.87, `Plan` $3.84 — together **$148.98 ≈ 39.5% of all subagent spend**. Declared slots: implementer $96.17, spec $30.70, refactorer $23.10, deep $19.77, recon $13.89, security $7.28, first-pass $6.53, spec-review $6.37, worker $6.08, decomposer $5.56, runner $4.63, debugger $2.75, flash $1.82, discovery $1.06, deployer $0.42, push $0.32. Missing from `byRole` entirely: **root-cause, scenario-gen (test) and collector, digest, retro (cadence)** — zero labeled spend.
- Quality attribution limit: standalone subagent transcripts are keyed `agent-<hash>`, not by role (A3 §1) — worst repeat rates belong to hashes (`agent-af620b2b0926cbdc1` 91.5% repeat / 48.8% error / 588 calls — **INCIDENT:** this is the review-ec58 flash-lite loop, F3a, single run; `agent-a6e7a15f0f882f6b4` 73.0%, `agent-a1ee0b0c48a8fa160` 59.1%). Re-read pathology (B2 §5): 17 subagent transcripts re-read one file >10×, max **703×** (`test_enrich_news.py`, foc-206-dev — **INCIDENT:** foc-206-dev; the ×115 `companynewspanel.tsx` case is a subagent of the foc-99 review session), across 9 worktrees, all in trading_assist/joint-flows fan-out runs; main sessions are clean (1/183). This is a pattern across runs (9 worktrees) but its per-role attribution is impossible today.

**(c) What would change the answer.**
- Per-run delegation splits (never computed — A3 has corpus only): if some squads meet a meaningful per-run delegation bar, the floor conversation changes from "nobody delegates" to "dev doesn't delegate".
- Attribution carrying role names into subagent session transcripts (F-11) would turn the hash-keyed quality data into per-role data — until then any "role X misbehaves" claim is uncheckable, and this review does not make one.
- FOC-220's waste-labeling revision could re-classify some "repeat" behavior as justified reruns, softening the pathology numbers (`disputed-figure: FOC-220` — affects repeat-rate series, not cost shares).

**(d) Verdict.** The inventory question decomposes into three answers:
1. **Declared slots mostly earn their place, and unused slots cost nothing.** A role slot is a definition file plus a routing key — zero standing cost. The workhorse slots (implementer, recon, refactorer, spec, deep, first-pass, security, runner, worker, flash) all carry measured spend; the cheap end (deployer $0.42, push $0.32, discovery $1.06) ran and returned value at negligible cost. **No removal is justified by this data.**
2. **Zero-usage slots are documentation debt, not waste:** root-cause and scenario-gen (test) never appear in `byRole`; cadence's collector/digest/retro have zero labeled spend because cadence itself barely ran (F-03). These slots describe capability the system has not exercised — keep or cut is a design choice, not an evidence verdict; say so honestly: **inconclusive** on their merit.
3. **The inventory's real hole is what it doesn't declare.** ~39.5% of subagent spend goes to Claude Code built-ins (`general-purpose`, `Explore`, `claude`, `Plan`) that are in no playbook, no routing table, and — since `17fd6ba` (2026-09-04) — inherit the `sonnet` tier, which is the permission-classifier's model (`google/gemini-2.5-flash-lite` via the openrouter tier table), chosen for allow/deny verdicts, not exploration (telemetry F3a/R5a; observed usage since the switch is tiny — Explore 1 turn, general-purpose 4 turns — so this is a structural exposure, not a measured fire). The review squad already mitigates inside its own loop (`agents/review/CLAUDE.md`: generic subagents must be spawned with `model: haiku`); no other squad has that rule.
- Slot-count claim corrected: **29, not ~30**.

**(e) Recommendation.** No role removals. **Change the system (small, deferred):** make built-in subagent usage deliberate everywhere — either give the built-ins their own tier or replicate the review-squad `model: haiku` rule across squads (R5a; batch into the routing/prompts follow-up child, report §6 items 5/8). **Change the system (deferred to FOC-110):** carry role names into subagent attribution so the next version of this question is answerable with quality data, not just cost data (F-11). `disputed-figure: FOC-221` on the 12.2%/39.5% shares (proportionality unverified).

---

## 5. FOC-277 — Tool fit: do roles have the tools they need, and only those?

**(a) Question.** Do the declared tool lists of the 29 roles match what the roles must do, and do the tools the playbooks promise actually exist?

**(b) Series / mechanics that answer it.**
- Declared tools (role frontmatter, verified): every role is `Read/Grep/Glob` plus `Write` for authors (spec, worker, flash, scenario-gen…) and `Bash` for executors (implementer, debugger, recon, deep, first-pass, security, runner, deployer, push, discovery). The partition is coherent: review's finding passes are read+`Bash`-for-git, its report writers have `Write`, no review role can edit product files except via `Bash` (prompt-constrained).
- `F3_behaviour.byTool`: bash 31,905 calls (4.2% err, 1,352 errors — highest absolute), read_file 16,790 (11.2% repeat), grep 4,698, edit_file 6,045 (0.3% repeat — healthy), task_management 4,076, agent_spawn 1,281, glob 1,716. `F3_behaviour.bySquad`: err% dev 1.9, supervisor 3.1, review 3.6, orch-ollama 10.9 (**INCIDENT-class:** 12 sessions, ended W33), plan 3.2, test 2.4, cadence 9.5 (n=296 — small sample). Plan's write_file 35.7% err on n=252 (A3 §3) is a single-squad outlier worth one look, not a verdict.
- **Scanner reality:** `agents/review/agents/security.md:11` promises "(Semgrep/Snyk/Trivy/GitGuardian or equivalents)" and `:14` "Run every available scanner (SAST, SCA, secret-scan) via Bash"; `agents/review/settings.json:18-23` **allows** `semgrep`, `snyk`, `trivy`, `gitleaks`, `eslint`, `ruff`. The repo contains **no scanner configuration, install or CI wiring anywhere** (verified by sweep), and telemetry shows **zero scanner-type tool calls in the whole corpus** — the review squad's toolkit as observed is bash/read_file/grep only (A3 §A; 1,538 grep calls).
- **CodeGraph/code-intel:** all five squad CLAUDE.mds mandate codegraph-first (`agents/plan/CLAUDE.md:68`, dev:99, review:69, test:68, cadence:72); measured: **18 calls corpus-wide** (supervisor 10, orch-ollama 5, dev 3; review, plan, test: zero).
- Routing hygiene: `config/models.map` is missing 5 role keys (plan.worker, dev.flash, review.flash, test.flash, cadence.flash), so `bin/agent.bat` standalone role launches silently fall back to `z-ai/glm-5.2` instead of the frontmatter slug; `models.json → ids.opus` still points at `claude-opus-4.8` while `plan-native.bat` runs opus-5 (`docs/TELEMETRY-EXPLAINED.md` §5 note).
- `mcp__linear__*` is denied everywhere and observed nowhere — squads use the scripts; consistent.

**(c) What would change the answer.**
- Provisioning one scanner and seeing security-pass findings (S-class: 14 findings / 4.5% of all, `F5_review.findingClasses`) cite scanner output would flip F-09 from "structurally unmet" to "held".
- FOC-114's navigation benchmark (scope record §3.5, Q3) is the instrument that decides whether codegraph-first is a good rule — 18 calls in a corpus that mostly predates the MCP wiring is **not evidence of disobedience** (rule introduction date is not in the data; gap), and this review explicitly defers that judgment to FOC-114.
- FOC-220's tool-input truncation fix would make tool-level error rates trustworthy per role (`disputed-figure: FOC-220` — the byTool repeat/error series rest on the truncating, hash-less input recording it disputes).

**(d) Verdict.** The declared tool lists fit the jobs — nothing in the data shows a role starved of a tool it needed or carrying a tool it abused (the pathologies are prompt-level: re-reads, not tool gaps). The tool-fit failures are at the **system** level, not the role level:
1. **The security-by-tools hard rule is structurally unmet** (`agents/review/CLAUDE.md:157`: "Security always by tools (models catch 60–80%) — never a model-only security verdict"). The tools are promised and permission-allowed but never provisioned, so every security pass to date has been exactly the model-only pass the rule forbids. This is the sharpest finding of this question (F-09).
2. **Codegraph-first is not yet practice** (18 / 70,663 calls) — but the corpus largely predates the wiring and the question is already assigned to FOC-114's benchmark; no verdict here.
3. Two small routing drifts make standalone launches lie about their model (F-14).

**(e) Recommendation.** **Change the system:** provision at least a secret scanner and one SAST into the review path (tools are already allow-listed; effort S–M) — or, if that is consciously declined, change the rule to stop promising scanners that do not exist. Given the 1.0 epic is "trustworthy evidence", provisioning is the recommendation (F-09). **Change the system (tiny):** fix `models.map` + `ids.opus` drift (F-14). **Defer:** codegraph-first judgment to FOC-114 (no finding); plan's write_file error outlier is one `Bash` run away from explained — fold into F-06's slice if convenient, otherwise ignore (n=252, single era).

---

## 6. FOC-278 — Context fit: define the pinned state that stops children re-deriving what spawn already knew

**(a) Question.** Children spend their first turns re-deriving state the runtime already holds. Define the pinned state that removes that.

**(b) Series that answer it.**
- `F6_firstTurns.perSquad` (n=183 matched children): median first-15-call context share — dev 33.3%, review 26.7%, test 26.7%, **plan 50.0%**; no productive call in turn 1 — plan **47%**, dev 23%, review 30%, test 11%; first productive call at #5–7 everywhere.
- Re-derivation sources (B2 §3): **37% of sessions re-derive git state** (68/183, within first 3 calls) although spawn pins branch/base-revision; **22% re-query Linear** (41/183; worst: FOC-264 dev, 8 of first 13 calls); reads of files the kickoff itself named: 105/636 context calls (17%). Kickoff length has **zero** effect: `F6_firstTurns.spearman` lenVsCtxPct −0.01, lenVsFirstProd −0.07; quartiles flat (33.3 / 30 / 27.3 / 33.3 across 1.1k–10.5k chars, `F6_firstTurns.quartiles`); explicit ACs change nothing (33.3 vs 32, `acsImpact`).
- Kickoff-visibility gate failures, 5/26 question-gates (B2 §7): FOC-176 wrong-repo spawn; FOC-151 wrong-workspace; FOC-225 kickoff named a file absent from the child tree (gitignored plans dir); FOC-156 broken run structure handed to review; FOC-183 known label-group conflict not propagated.
- What the runtime already holds at spawn: worktree, branch, baseRevision (`scripts/supervisor-spawn.mjs:340-342`, written to the registry `:491-493`), plus `worktreeCreated` — so a reused-worktree dirty list is derivable; the Supervisor holds the issue packet verbatim.
- Estimated effect (report F6): ~30% of first-turn context calls are pure re-derivation. (Dollar-izing that estimate inherits the 2.19× dispute — `disputed-figure: FOC-221` if converted.)

**(c) What would change the answer.** A post-adoption A/B on the same extractor (report §5.3 names B2's harness as the eval): if the context-call share does **not** drop, the cause is not state absence but distrust — children verify because kickoffs have been wrong (5/26 cases above are exactly that). Then the fix is different: spawn-time verification (fail-fast before the child exists) plus a one-call pinned-state confirmation affordance, not more prose. The `spearman` and quartile results already say volume is not the lever; this schema must be **machine-templated**, not hand-written.

**(d) Verdict.** The pinned state is definable today, entirely from what spawn already knows — this is the best-evidenced question of the seven (183 sessions, all four squads, effects uniform across length quartiles: a pattern, not an incident). Definition (the deliverable):

**Pinned-state section — mandatory machine-templated kickoff prologue:**
1. `repo` — absolute repo root + `LA_ROOT`.
2. `worktree` — absolute path (from the registry).
3. `branch` + `baseRevision` (SHA) — from the registry.
4. `clean-at-spawn` — boolean + dirty-path list when a worktree is reused (from `worktreeCreated` + a spawn-time `git status`).
5. `issue` — identifier, title, state, labels **verbatim**; AC list **verbatim** (B3: AC-mapping is not a failure surface — 26/30 declared-AC verdicts map all — so carry ACs for verdict quality, not for context savings).
6. `run` — supervisor run id, child id, `LA_RUN_ID` (so gates/artifacts resolve without rediscovery).
7. `spawn-verified` — proof that every kickoff-named file exists in the child tree (the H2 check; would have prevented 3 of the 5 visibility failures directly).
8. `pre-authorized` — the offline verify commands pre-allowed in this child's settings (P4; kills the deny-list collision class).
9. `known-quirks` — the documented answers from P5's runbook, when they exist.

Plus the delegation-side twin (P7): prompts to subagents inline content or line-ranges, not paths — the 17-transcript re-read pathology (max 703×) is the cost of path-only delegation prompts.

**(e) Recommendation. Change the system** — `supervisor-spawn`/kickoff assembly gains the pinned-state template + spawn-time verification (effort S; report files it as §6 item 3). This is the finding that most directly "reshapes F3/F4 execution mechanics" — the stated reason this review ran first in the wave (F-12, fix-now). **No rule change needed** — nothing in the playbooks contradicts it.

---

## 7. FOC-279 — Which playbook rules are measurable, and which are simply not held?

**(a) Question.** Inventory the written rules of the five playbooks + graph, classify each as measurable or not, and state which measurable rules the corpus shows held vs not held.

**(b) Series / mechanics.** Every row cites its series: `F2_cost.leadVsSubagent`, `F2_cost.budgetShares[]`, `F5_review.*`, `F4_gates.*`, `F3_behaviour.*`, `F7_dataQuality.*`, A1–B3 sections, `config/graph.json`, squad CLAUDE.md line refs.

**(c) What would change the answer.** Any row marked UNVERIFIED becomes measurable with one named query (per-run delegation split; bookkeeping-op counts; escalation-label join for the 7 over-cap tasks). FOC-220/221 land changes several cells at once (repeat/waste rates; cost shares) — `disputed-figure: FOC-220` on repeat-based rows, `disputed-figure: FOC-221` on cost-share rows.

**(d) Verdict — the rule audit table:**

| # | Rule (source) | Measurable? | Status | Evidence |
|---|---|---|---|---|
| 1 | Delegation floor "Target: ≥40% of run cost in subagents" (all 5 squad CLAUDE.mds, e.g. `agents/review/CLAUDE.md:63`; cadence retro threshold `agents/cadence/agents/retro.md:17`) | yes — `leadVsSubagent` | **NOT HELD** — 12.2% corpus; per-run split never computed; the designed enforcer (cadence retro) never ran | F-08; contradicts roadmap L61 ("diagnostic signals, not optimization rewards") |
| 2 | shareHint "tuned from usage_facts once real runs exist" (`config/graph.json:14`) | yes — `budgetShares[]` | **NOT HELD** — never tuned; first calibration is this review; dev Δ+10.6 pp | F-02, `disputed-figure: FOC-221` |
| 3 | "Security always by tools — never a model-only verdict" (`agents/review/CLAUDE.md:157`) | yes — scanner calls in tool facts | **STRUCTURALLY UNMET** — 0 scanner calls corpus-wide; tools never provisioned | F-09 |
| 4 | Near-repeat fingerprint checkable (`failingTests` populated at verdict record) | yes — `F7.4` | **NOT HELD** — 3/89 populated; near-repeat detection "near-blind by construction" (A2 §4) | F-06 |
| 5 | "Max 2 dev↔review rounds — round 3 = escalated" (`agents/review/CLAUDE.md:155`) vs supervised-mode "no round cap; the fingerprint decides" (same file, supervised section) | yes — rounds per task (A2 §4) | **MODE-DRIFTED** — 7 tasks >2 rounds (extremes: r9 FOC-225/run dd5b, r7); at least the extremes are supervised-era, where the cap is deliberately lifted; unsupervised-era compliance unverified (escalation labels not joined — gap) | F-07 |
| 6 | Cadence "1 digest/week" (`agents/cadence/CLAUDE.md:46,138`) | yes — `F2_cost.byWeek` | **NOT HELD** — active in 2 of ~11 weeks (W26, W32) | F-03 |
| 7 | WIP=1 / concurrency 1 (`config/graph.json` `_concurrency`; roadmap L11) | yes | **HELD** — no parallel-child counter-evidence in A2 (186 children, sequential phases) | observed absence |
| 8 | Push consent (roadmap L12; push-approval gates) | yes — `F4_gates.byKind` | **HELD** — 4 push-approval gates, no unconsented push observed | supervised harness denies `git push` at tool level |
| 9 | Verification share protected (budgetPolicy stage split) | yes — stage sums | **HELD in supervisor era** (28.9% vs 30%); cold in full corpus (24.2%) — era-dependent | `budgetShares[]` |
| 10 | Dry runs never close real issues (roadmap L45) | yes — verdict semantics | **HELD** — FOC-218/219 semantics enforced (scope record R7) | no counter-evidence |
| 11 | "2 failed attempts → escalate" (all 5 CLAUDE.mds) | yes in principle | **UNVERIFIED** — no per-task escalation join in any scratch report | gap |
| 12 | "Bookkeeping max 4/run" (all 5 CLAUDE.mds) | yes in principle | **UNVERIFIED** — never measured | gap |
| 13 | Deny-list protocol (pre-P4) | yes — gate taxonomy | **FRICTION CONFIRMED** — 4 collision gates, median 15 min (FOC-143 dev-4-1/4-2, FOC-263, FOC-246; + FOC-156 secondary); one kickoff prohibition directly violated (FOC-143: denied Edit → successful Write on the same file, B3 §3-O) | F-17, P4 filed |
| 14 | Kickoff visibility (pre-H1) | yes — gate taxonomy + B2 | **FRICTION CONFIRMED** — 5/26 question-gates were kickoff-visibility failures; 31% of question-gates already answered by docs | F-12, P5/P6 filed |
| 15 | Gates answered & closed (end-of-run cleanup) | yes — `F4_gates.pending` | **NOT HELD** — 24 pending; 18 stale cleanups aged 44–219 h in abandoned runs (one carries dirty paths — destructive if blindly approved, FOC-244) | F-16, H8 filed |
| 16 | "Unknown never free" (cost honesty) | yes — `unpriced` counts | **HELD with one leak** — every viz series carries `unpriced`; but `stealth/ox-alpha` bills $0.00 over 3,072 turns with `unpriced: 0` (a priced-at-zero row that is neither flagged nor verified) — data-quality observation, not a violation | `byModel` |
| 17 | "3–20× cheaper" / "~90k tokens" inline-cost claims (squad CLAUDE.mds) | yes | **ACCURATE** — frontman median ~89k tok/turn measured (A3 §5); the delegation economics prose matches measurement | praise |

The systemic pattern across the four not-held rows (1, 3, 4, 6): **rules whose enforcement organ was never built or never operated** — the floor's structural form (dispatch-as-code, brainstorm D4) is deferred; the scanners were never provisioned; `failingTests` was never enforced at record time; the retro that polices the floor lives in cadence, which never ran. The playbooks describe the designed system; measurement keeps catching them describing organs that do not exist yet.

**(e) Recommendation.** Split by kind: **change the rule** where the rule is wrong — the delegation floor should be restated as a per-run diagnostic (roadmap L61 already demoted it; the "Target" framing survived in all five playbooks) and the round-cap text should state the mode-conditional truth once (F-08, F-07 — prompt changes, batched into the prompts follow-up child). **Change the system** where the rule is right but unenforced — failingTests population (F-06), scanner provisioning (F-09), stale-gate sweep (F-16), deny-list pre-authorization (F-17, P4). Verification gaps (11, 12) are one named query each — file, don't guess.

---

## 8. FOC-280 — Does the evidence justify any new squad, agent or graph node?

**(a) Question.** Should the topology gain (or lose) any squad, agent role, or node?

**(b) Series that answer it.** `F5_review.findingClasses` (Y 46 / 18.0% substantive — largest class, spread over 22 tasks: a pattern), `F4_gates.byKind/bySquad`, A2 failure taxonomy (`F1_failures.taxonomy`), `F3_behaviour.cacheBySquad` (orch-ollama 0%), FT census (verdict parser 87 pairs; handoff compressor 86+1,143), A1 §9.3 (ollama real cash ~$0).

**(c) What would change the answer.** A wave of test→dev returns with findings would justify designing the test-return discriminator now (F-05). Y-class share falling after a lint gate lands would close F-13's case. Learning-phase data (F5–F8) could justify an FT-servicing node later — out of 1.0 scope by construction.

**(d) Verdict.**
- **No new squad.** No measured work is homeless: dev dominates child spend exactly as a synthesis-heavy flow should; failures are infrastructure-first (22/38 provider-side, `F1_failures.taxonomy`) — the remedy is a retry policy (report §6 item 9), not topology.
- **No new graph node.** The three candidate additions are all **functions, not nodes**: (1) a **lint gate** — Y-class is the largest findings class and a linter's job; wire it into dev's completion contract (`config/graph.json` dev.completion) and DoD, not a supervised node with a budget stage (F-13); (2) a **return label** — makes two already-declared edges honest (F-04); (3) an **accounting declaration** for the frontman/orchestrator (F-01). Nothing here needs autonomy, concurrency or a budget share — node-shaped machinery would be over-modeling.
- **One existing node under question, not a new one:** cadence (F-03). **One out-of-graph consumer needs a disposition, not a node:** orch-ollama — 12 sessions W31–W33, minimax-m3 via local Ollama, **0% cache-hit** (`cacheBySquad`), 314.7M input tokens re-billed every turn, $96.78 list-priced (~$0 real cash, A1 §9.3), 20.6% bash error rate; no design document commits to it (absent from all six topology docs). Either declare it an out-of-graph tool or retire it (F-15).
- **No new agent role.** 29 slots cover the observed work; the gap is undeclared built-ins, which is a policy/tier change (F-10), not new slots.
- **Praise:** the topology-as-artifact decision (brainstorm D1, FOC-158) is what made this review cheap — the equivalence proof holds (`graph-validate.test.mjs`), the validator's reachability check works, and the `why` notes on every edge answered half of FOC-275 before any telemetry was read. A designed topology that can be checked is exactly why the drifts above were findable.

**(e) Recommendation.** No topology-shape change; three targeted system changes ride the gate (F-04, F-13, F-01) and two decisions go to Mateusz (F-03 cadence, F-15 ollama). Everything else is already filed in the telemetry report §6.

---

## 9. Findings register and disposition proposals

| ID | Finding (question) | Class | Disposition proposal | Filed at / rides |
|---|---|---|---|---|
| F-01 | Frontman (44.1%) and orch-ollama (3.1%) sit outside the graph's budget model; $1,399.04 (45%) of spend is unlinked to tasks, mostly frontman runs (A1 §4) | change the rule (declaration) | **DEFER** — add out-of-graph note to `graph.json` `_budget` + dashboard annotation at wave close-out | close-out (§4 step 6) + post-1.0 config child |
| F-02 | shareHints never calibrated against the promise at `graph.json:14`; dev Δ+10.6 pp (full corpus) / +15 pp (era); plan/test deltas swing by era — needs era-scoped definition; `disputed-figure: FOC-221` | change the rule (later) | **DEFER** — recalibrate after F-12 lands and FOC-221 resolves the 2.19× proportionality; re-measure at close-out | blocked by FOC-221; graph-config child |
| F-03 | Cadence declares a weekly timer + "1 digest/week"; active 2 of ~11 weeks; its enforcement role (delegation retro, bounce limits `cadence:114`) is dead letter | decide | **DEFER — decision** | Mateusz; filed against FOC-224 (learning phase) or backlog |
| F-04 | Return discriminator exists in data (verdict `round` fields, review-rounds.json, comment tags) but not on the routing surface (matcher = state+labels, `graph-route.mjs:30`); returns route to null in the dashboard | change the system | **FIX-NOW** — emit exclusive return label on fail transition, flip both return edges `routable:true`, regenerate handoff-rules via equivalence proof | new small child in wave (S–M) |
| F-05 | test→dev return edge has no design corpus: 5 test verdicts, ~0 findings (B3 §2) | n/a (data gap) | **DEFER** — design the label symmetric with review's; validate at the first real test return | FOC-165 release-candidate run |
| F-06 | `fingerprint.failingTests` populated 3/89 — near-repeat detection near-blind; the mechanism already caught 2 real no-movement repeats on `combined` alone | change the system | **FIX-NOW** — enforce population at verdict-record time (H4) | fold into FOC-220 slice or standalone S child |
| F-07 | Round-cap rule text is mode-drifted (max 2 vs supervised no-cap); 7 tasks >2 rounds; escalation-label outcomes unjoined | change the rule (+verify) | **DEFER** — verify escalation labels on the 7 tasks; state the mode-conditional rule once in CLAUDE.md | prompts child + Supervisor verification |
| F-08 | Delegation floor ≥40% vs measured 12.2%; contradicts roadmap L61; structural precondition (D4 dispatch) deferred; `disputed-figure: FOC-221` | change the rule | **DEFER** — restate as per-run diagnostic; batch with P4–P7 | prompts follow-up child (report §6 items 5/8) |
| F-09 | Scanners promised (`security.md:11,14`), allow-listed (`settings.json:18-23`), never provisioned, never called — security-by-tools structurally unmet | change the system | **FIX-NOW** — provision ≥1 secret scanner + 1 SAST into review path (S–M) | new small child in wave |
| F-10 | Built-in subagents = ~39.5% of subagent spend, undeclared, inheriting the permission-classifier model since 17fd6ba; `disputed-figure: FOC-221` | change the system | **DEFER** — R5a tier split / uniform `model: haiku` rule for generics; low urgency (usage since switch tiny) | routing follow-up child (report §6 item 8) |
| F-11 | Subagent quality attribution impossible (agent-\<hash\> keys, A3 §1) — role-level "earns its place" unanswerable on quality | change the system | **DEFER** — carry role names into subagent attribution | FOC-110 (episode provenance, learning phase) |
| F-12 | Pinned state defined (§6); 37% git re-derivation, 22% Linear re-query, plan 50% ctx share; length has zero effect; 5/26 gates kickoff-visibility failures | change the system | **FIX-NOW** — supervisor-spawn pinned-state template + spawn-time verification (S) | new small child in wave; reshapes F3/F4 mechanics |
| F-13 | Y-class style findings 46/18.0% over 22 tasks reach reviewers — a linter's job; lint as dev completion gate, not a node | change the system | **FIX-NOW** — lint in dev completion contract + DoD (S–M) | new small child in wave (report §6 item 7) |
| F-14 | `config/models.map` missing 5 role keys → standalone role launches silently fall back to glm-5.2; `ids.opus` → 4.8 vs plan-native opus-5 | change the system | **FIX-NOW** — tiny config fix | fold into FOC-165's config verification |
| F-15 | orch-ollama: out-of-graph, 12 runs W31–33 (ended), 0% cache, 314.7M re-billed tokens, $96.78 list (~$0 cash), 20.6% bash err; unowned by any design doc | decide | **DEFER — decision** | Mateusz: declare out-of-graph tool or retire |
| F-16 | 18 stale cleanup gates 44–219 h in abandoned runs (one carries dirty paths — destructive if blindly approved); 24 pending total (`F4_gates.pending`) | change the system | **FIX-NOW** — one-off sweep + end-of-run cleanup protocol (H8) | Supervisor hygiene action |
| F-17 | Deny-list collisions: 4 gates (median 15 min) + one directly violated kickoff prohibition (FOC-143 Edit-denied→Write) | change the system | **DEFER** — pre-authorized verify commands in child settings (P4) | prompts/permissions child (report §6 item 5) |

No finding requires editing `config/graph.json`, `config/models.json`, prompts or settings **in this run** — every fix-now row is a filed child executed by DEV after the gate.

---

## 10. Registers

### 10.1 Incident register (single-run concentrations — named, never used as routing signals)

| Incident | What it is | Where |
|---|---|---|
| supervisor-opus era | claude-opus-5 × supervisor = $804.97 in **5 turns / 2 sessions** (26% of corpus, Aug 25–Sep 7); frontman since migrated to glm-5.3 | A1 §2 |
| review-ec58 | flash-lite 91.3% repeats — 588/589 calls of that model; one `general-purpose` loop; also `agent-af620b2b0926cbdc1` | F3a; A3 §1 |
| run dd5b | 31 children, 67.2 h, 13 gates, 4 of 10 worst first-turn sessions, FOC-225 r7 near-repeat | A2 §3/§6; B2 §4 |
| run 7fdd | gate-wait 103% of run wall-clock (31.2 h vs 30.2 h) | A2 §6 |
| FOC-226 | $255.95, 35× median cost; 7 experiment-authorization gates; plausibly = 7fdd (unverified link) | A1; B1 §7 |
| FOC-143 | 3 rounds without diff movement (fingerprint `75b61bda9d2f4ee3`), final fail; also the deny-list-collision and Edit-denied→Write case | A2 §4; B3 §3 |
| foc-206-dev / foc-99-review | 703× and 115× single-file re-reads by subagents (the 17-transcript pathology spans 9 worktrees — the spread is a pattern; the extremes are incidents) | B2 §5 |
| repeat-rate runs ec58/e7b0/aba1/ee09/7196 | 5 single-run outliers; corpus repeat rate is 4.8% | A3 §1 |
| orch-ollama W31–W33 | all 12 sessions of the uncached local path (era-concentrated by nature) | A1 §3 |

### 10.2 Disputed-figure register

| Conclusion affected | Disputed by | What changes if the revision lands |
|---|---|---|
| All dollar figures ($3,099.08 canonical; $1,400 real) | **FOC-221** (per-message dedup, 2.19×; combined 4.01×) | Absolute dollars shrink; rankings/shares hold **only if** the report's proportionality assertion survives — it is unverified |
| Budget-share deltas (dev +10.6 pp; test −5.1 pp; F-02) | **FOC-221** | If multi-line density is squad-skewed (thinking-heavy models emit more lines), the shares move and F-02's calibration numbers change |
| Delegation share 12.2% and built-ins 39.5% (F-08, F-10) | **FOC-221** | Same proportionality caveat, lead-vs-subagent axis |
| Repeat/waste rates (gemini-3.8-flash 45.7%; byTool repeat 11.2% read_file; the 17-transcript re-read counts) | **FOC-220** (justified reruns / Read→Edit→Read wrongly labeled waste; tool_input truncated pre-hash) | Justified-rerun exemption lowers repeat rates; rates used here as shape evidence, not precision |
| Cost-of-re-derivation estimates (~30% of first-turn calls; §6) | **FOC-221** only when dollar-ized | The count-based findings stand; any $ conversion inherits the dispute |

### 10.3 Data gaps (what this review could NOT verify, and the named query that would)

1. Per-run delegation share (A3 computed corpus only) — query: `leadVsSubagent` grouped by run_id. Bounds F-08.
2. Escalation-label outcomes for the 7 over-cap tasks — query: join verdict rounds to Linear labels. Bounds F-07.
3. Linear-side round/return recording (never analyzed) — query: label/comment scan on returned tasks. Bounds F-04's label design.
4. Per-review-pass findings attribution (which of first-pass/security/deep produced which class) — query: findings joined to childId in verdict records. Bounds F-09's S-class reading.
5. orch-ollama run IDs and cadence run counts — absent from all scratch reports. Bounds F-15.
6. test→dev root-cause report counts. Bounds F-05.
7. Codegraph-first rule introduction date vs the corpus window. Bounds the "not yet practice" reading in §5.
8. `viz-data.json` series without scope keys (`budgetShares`) — exporter should stamp scope per series (small, filed with F-02's child).

---

## 11. What the topology got right (recorded, because a review that only lists faults miscalibrates)

1. **Topology-as-artifact (FOC-158/brainstorm D1)** — the equivalence proof, the validator, and the per-edge `why` notes made this review executable at all; the prose topology could not have been audited this way.
2. **Verification share held where it matters** — the supervisor-era verification stage landed at 28.9% vs the 30% the budget policy protects; the one share the policy explicitly guards is the one reality respects.
3. **Per-role model pinning (ADR-0002)** — 29 role files pin explicit slugs, the routing table maps them, and the mechanism works; the observed deviations (built-ins, map drift) are consumers the design never claimed.
4. **WIP=1 discipline** — held across 186 children; the worktree isolation did its job without a single observed collision.
5. **Cost honesty machinery** — unpriced counts ship with every cost series; "unknown is never free" is enforced in the data layer (one priced-at-zero leak noted, §7 row 16).
6. **The `why`-note discipline** — every unroutable edge explains itself; two of this review's answers (escalate-edge dead code, the return-discriminator prerequisite) were pre-stated by the topology itself and merely confirmed by telemetry.

---

*End of review. Per-question closures for FOC-274…FOC-280 and all Linear mutations are the Supervisor's, after the gate. Analysis-only run: one file added, nothing else touched.*
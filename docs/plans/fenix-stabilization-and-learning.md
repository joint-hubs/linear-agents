# Fenix: stabilization and controlled learning

Status: approved execution roadmap, 2026-09-05. Implementation and independent validation are pending unless explicitly recorded below. Supervisor owns delivery; Linear contracts and `docs/STATE.md` record progress.

## Decisions and boundaries

- Stabilize the existing platform before adding learning infrastructure. Logs alone are not verified training examples.
- Preserve all pre-existing changes, logs and worktrees. Use scoped, tested local commits on `chore/fenix-stabilization-learning`; no blanket staging, reset, clean or unapproved deletion.
- PLAN, DEV, REVIEW and TEST leads and roles use exactly `z-ai/glm-5.3-flash`. No silent fallback. Preserve the frontman, CADENCE, orchestrator and unrelated provider tiers.
- No additional budget cap was requested. Existing caps remain enforced; unknown prices remain unknown.
- Execute one issue and one live squad child at a time initially. PLAN → DEV → REVIEW → TEST remain separate stages. Triage confirmation and human gates are not pre-approved by this roadmap.
- The Supervisor alone publishes Linear updates, pushes and creates PRs. Push/PR require their own approval. Cleanup requires both TEST pass and explicit cleanup approval through the cleanup tool.
- A bounded direct bootstrap of prompts and model configuration is authorized before operational squads. It is not independent REVIEW/TEST and is not permission for the frontman to implement the entire roadmap.

## Baseline evidence

- Starting revision: `71a2962`; 13 modified tracked files and 8 untracked files were preserved before bootstrap.
- Local recovery artifacts: `.state/fenix-stabilization/git-before.patch`, `git-before.json`, `untracked-before/`.
- Linear snapshot: `.state/fenix-stabilization/linear-before.json`, 44 issues in project FENIX (`c604a9c8-19bc-4e92-be17-658a5a6d5215`). Legacy Fenix v2 issues require separate reconciliation; title search alone is not membership evidence.
- `node scripts/check.mjs`: FAIL, 24 model-map violations.
- `node scripts/config-drift.test.mjs`: 22 PASS, 1 FAIL; existing frontman pricing lacks `cacheRead`.
- `node scripts/provider-resolve.test.mjs`: 14 PASS.
- Previous focused checks: canonical telemetry 14 PASS; behavioral analytics 15 PASS. Passing these tests does not establish semantic correctness of repeat/outcome metrics.
- No operational child, local delivery commit or Linear migration had been completed at baseline capture.

## Delivery sequence

| Key | Deliverable | Observable acceptance | Dependencies |
| --- | --- | --- | --- |
| F0 | Verify preserved baseline and squad bootstrap | GLM routing/frontmatter/launcher consistency; real model identity checked; existing-issue PLAN without duplicate tickets; human gates preserved; local Node TEST; scoped commits and traceable handoffs | First |
| F1 | Repair legacy outcome parsing | Explicit PASS/FAIL/UNKNOWN; negated blocker text is not a finding; missing RETURN is not PASS; rounds-only and malformed reports remain uncertain; regression tests | F0 |
| F2 | Unify verdict evidence | Structured Supervisor and legacy outcomes with source, round, work fingerprint and artifact; idempotency/conflict handling; REVIEW distinct from final TEST; coverage visible | F1 |
| F3 | Correct behavioral measurements | Hash complete input before preview truncation; output sizes; deterministic ordering; Read→Edit→Read and justified reruns not labeled waste solely by matching arguments | F0 |
| F4 | Qualify canonical usage and task attribution | Shared-session/window-boundary fixtures; no duplicate fleet cost; source lineage retained; uncertain task/price coverage visible; unknown never free | F0 |
| F5 | Reproducible and private episodes | Task/attempt/delegation, effective prompt/config/model/tool versions, code/test revision; privacy/export boundary and provenance; no automatic raw-log publication | F2, F3, F4 |
| F6 | Human feedback and frozen evaluation | Versioned rubric with partial/unknown; disputed cases and random successes; holdout grouped by task; no per-turn leakage; labels linked to evidence | F2, F5 |
| F7 | One-role experience pilot | Verified examples, provenance/expiry/token cap; history treated as untrusted data; held-out baseline comparison on quality, cost and human rework | F5, F6 |
| F8 | CADENCE improvement proposals | One candidate at a time; independent evaluation; human promotion and rollback; immutable safety and evaluation policy | F7 |

F0–F4 are the stabilization wave. F5–F8 are a separately grouped learning phase, not release prerequisites. Routing models, fine-tuning and online RL stay later: first establish sufficient independent labels and compare simple rules/retrieval/current-model baselines.

## Bootstrap contracts

1. Replace duplicated model names with routing-key/purpose tables; align actual launchers and role definitions. Preserve provider-specific internal tier constraints.
2. PLAN enriches an existing atomic issue by default. Decompose only when independently testable slices justify it. Preserve both human gates; dry runs never close real issues.
3. Supervised children consume the supplied issue packet and return artifacts plus requested publication changes. Missing context goes through a question gate, not an alternate permission path.
4. DEV stages only authorized files; briefs specify observable AC, input, scope and verification. REVIEW is read-only, checks the exact candidate and cannot approve an unavailable diff. TEST chooses a real local CLI/server or deployment profile; Docker services still require rebuild/deploy.
5. Handoffs include task/run/session, repo, base/head/diff, files, commands/results, retained artifacts and unresolved questions. Exit code zero alone is not delivery evidence.
6. Update stale Supervisor budget/concurrency explanations without relaxing gates or enabling parallel issue execution.

## Linear reconciliation policy

Use stable `fenix-plan:F*` keys and a persisted migration ledger. Read existing descriptions/comments; prefer enriching useful contracts. Create and verify successors before canceling predecessors. Preserve history; superseded is Canceled, not Done. Infrastructure/UI work is deferred or retained where the current Supervisor does not fulfill it. Verify project, parent, state, labels and dependency relations after mutations. Never publish raw transcripts, credentials or local snapshots.

## Verification and completion

- Focused tests for changed paths, then `node scripts/check.mjs`, `node scripts/config-drift.test.mjs`, provider/headless/gate checks and the applicable `node scripts/test-all.mjs` suite.
- Record every test's result, not only the last command in a compound shell invocation. Separate pre-existing failures from regressions.
- Real GLM canary: explicit repo/base, actual stream model identity, gate relay, handoff continuity, telemetry and local TEST. Configuration strings alone are insufficient evidence.
- Review failures are recorded before returning to the same DEV session. TEST failures never become Done. Reverify combined candidates before integration.
- Primary success measure: cost and human time to an independently verified change without significant corrective work. Delegation percentage, tool-repeat counts and process exit codes are diagnostic signals, not optimization rewards.

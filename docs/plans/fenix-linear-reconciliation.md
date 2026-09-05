# Fenix backlog reconciliation — 2026-09-05

Scope: the FENIX project for `linear-agents`, plus read-only inspection of related legacy Fenix v2/v3 issues. Unrelated title matches were excluded. No issue was deleted or marked Done by this migration.

## Authoritative delivery map

| Roadmap key | Linear | Contract | Parent |
| --- | --- | --- | --- |
| Release | FOC-102 | Stabilize delivery and trustworthy evidence | — |
| F0 | FOC-217 | Preserved baseline and real GLM squad delivery | FOC-102 |
| F1 | FOC-218 | Explicit legacy PASS/FAIL/UNKNOWN parsing | FOC-102 |
| F2 | FOC-219 | Supervisor/legacy verdict evidence and lineage | FOC-102 |
| F3 | FOC-220 | Correct tool behavior measurements | FOC-102 |
| F4 | FOC-221 | Qualified canonical usage/task attribution | FOC-102 |
| Learning | FOC-216 | Evidence, evaluation and controlled improvement | — |
| F5 | FOC-110 (existing) | Reproducible private episode provenance | FOC-216 |
| F6 | FOC-222 | Human feedback and frozen task-grouped evaluation | FOC-216 |
| F7 | FOC-223 | One-role bounded verified experience pilot | FOC-216 |
| F8 | FOC-224 | CADENCE proposals with human promotion | FOC-216 |

Each new contract has a stable `fenix-plan` key, acceptance criteria, scope, verification, handoff requirements and an explicit warning against duplicate PLAN decomposition. No `ai:planned` label, deadline or estimate was invented. New issues are Backlog; unchanged existing workflow states do not imply PLAN validation.

Verified blocking relations:

- FOC-217 → FOC-218, FOC-220, FOC-221.
- FOC-218 → FOC-219.
- FOC-219, FOC-220, FOC-221 → FOC-110.
- FOC-219, FOC-110 → FOC-222.
- FOC-110, FOC-222 → FOC-223.
- FOC-223 → FOC-224.

## Existing backlog decisions

| Issue | Decision | Evidence / successor |
| --- | --- | --- |
| FOC-108 | Canceled, superseded | Manual DEV/REVIEW relay and a top-level orchestrator already have a Supervisor runtime. Remaining end-to-end verification is FOC-217. |
| FOC-107 | Canceled, superseded | Empty cost-panel placeholder; existing dashboard plus concrete cost correctness/attribution contracts FOC-165 and FOC-221. |
| FOC-105 | Canceled, superseded | Empty VM placeholder duplicates the detailed existing JOI-82 agent-runner contract, which remains open. No VM provisioned. |
| FOC-110 | Enriched, identity retained | Original log-model intent becomes F5; moved under FOC-216. |
| FOC-114 | Enriched | Navigation correctness/staleness/fallback and measured effectiveness, not a tool-use quota. |
| FOC-117 | Enriched | Actual interrupted-run recovery; no claim that a manifest backup fixes killed processes, no prohibition of valid review return cycles. Earlier speculative comments remain historical. |
| FOC-134 | Retained, deferred in scope | Status/comment-triggered dispatch is not the same as manual Supervisor; require idempotency, event trust, gates and backpressure. |
| FOC-103 | Retained, deferred in scope | Task/project graph and artifact drill-down are not the existing squad workflow graph. Audit delivered UI before new work. |
| FOC-164 | Retained | Provider base-URL environment override remains a distinct task. |
| FOC-165 | Enriched | Verify existing cap/accounting against AC; include catalogue context-tier pricing and rate-drift evidence, not a premature Done. |

Legacy JOI-73, JOI-89, JOI-91 and JOI-82 were inspected. Their broader backlog was not mass-canceled; implementation evidence and current scope must be checked before further migration. Existing completed/canceled history was preserved.

## Mutation evidence and recovery

Local-only records under `.state/fenix-stabilization/`:

- `linear-before.json`: complete 44-issue project snapshot before mutations.
- `migration-plan.json`, `issue-updates.json`: intended decisions and payloads.
- `create-*.json` / `created-*.json`: prewritten creation UUID and verified result, preventing duplicate creation after uncertain responses.
- `update-*.json` / `updated-*.json`: before-state, intended update and read-back.
- `cancel-*.json` / `canceled-*.json`: verified successor, previous state, cancellation and read-back.
- `relation-*.json`: attempted relation UUID and direction; each relation was read back from its blocking issue.

Linear normalizes Markdown list spacing, bullet markers, trailing whitespace and bare URL links. Strict read-back checks stopped on these changes; each was inspected and reconciled without repeating a mutation. Project, parent, state and substantive content were checked separately. No raw snapshots or transcript excerpts were published to Linear.

## Next gate

FOC-217 is the first operational task. The direct prompt/config bootstrap is not independent REVIEW/TEST. Commit only verified scoped batches, then propose triage through the Supervisor protocol. Plan approval is not an answer to a future triage or child gate.

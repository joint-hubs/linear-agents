# ADR-0011: orch-ollama Withdrawal

**Status:** Accepted

**Date:** 2026-09-14

## Context

This ADR documents the withdrawal of `orch-ollama` from active use, as per the decision made in FOC-272. The decision was based on the following evidence:
- `orch-ollama` appeared exactly 8 times in 4 tracked files: `bin/orchestrate.bat:60,61`; `ui/src/screens/Timeline.jsx:19,23`; `scripts/telemetry-prune.mjs:49-50` (comment only); `docs/research/telemetry-analysis-2026-09.md:18,78,103`. No `orch_ollama` variant was found, nor were there any test, fixture, ADR, diagram, or README mentions of the tag.
- `config/models.json` contained zero `orch-ollama` entries, making the premise of a dedicated pricing row false. Ingest pricing is snapshot-pinned and historical ingest is not broken by removing non-existent pricing rows.
- `bin/orchestrate.bat` is a manual launcher for local Ollama, not programmatically invoked. Its twin, `bin/orchestrate-openrouter.bat`, is separate and out of scope.
- In `ui/src/screens/Timeline.jsx`, the `SQUADS` list drives run filtering. Removing `orch-ollama` would hide 12 historical runs. `SQCOLOR` for `orch-ollama` shares a muted teal with `orch-openrouter`.
- The decision was reached via a gate record: `gate-review-3-2`, run `2026-09-11T06:21:51.460Z`, answered `2026-09-11T07:58:16.542Z` for task `FOC-272`. The gate record is stored locally in `.state/supervisor/<runId>/gates/`.
- A consolidated review document is located at `docs/reviews/foc-272-topology-review.md` on branch `foc-272-review` (commit `527bc64`), which has not been merged.

## Decision

Withdraw `orch-ollama` from active use, following option "(b) Wycofać". This involves deactivating the `bin/orchestrate.bat` entry point and marking it as withdrawn in relevant documentation.

## Consequences

- **Positive:**
    - Reduces cost by removing a component that re-billed tokens on every turn.
    - Aligns with the FOC-272 gate decision.
- **Negative:**
    - The `orch-ollama` entry point is deactivated.
- **Risks:**
    - None identified, as historical telemetry and data are preserved.

## Alternatives Considered

1.  **Declare out-of-graph:** Rejected by the gate decision specifying "(b) Wycofać" (withdrawal) rather than merely declaring it out-of-scope.
2.  **Withdraw from active use:** Chosen approach.

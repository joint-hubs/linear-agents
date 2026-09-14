# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Fenix project.

## Purpose

ADRs document architecturally significant decisions: technology choices, structural changes, protocol designs, and any other decision with lasting impact on the system. They serve as a lightweight, timestamped record of *why* something was done, so future contributors (or the same team six months later) can understand the rationale without reverse-engineering the code.

## Numbering

Each ADR is numbered sequentially: `ADR-NNN` (zero-padded to three digits, e.g. `ADR-001`, `ADR-042`).

File naming convention: `NNNN-descriptive-kebab-case.md` (e.g. `0001-use-openrouter-for-models.md`).

## Records

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-provider-routing-and-fallback.md) | Provider routing — Anthropic subskrypcja-first + OpenRouter fallback | Accepted |
| [0002](0002-subagent-model-mechanism.md) | Subagent model-pinning mechanism (Claude Code + OpenRouter) | Accepted |
| [0003](0003-wow-aging-wip-trend-snapshot.md) | WoW aging-WIP trend snapshot location | Proposed |
| [0004](0004-two-stage-rag-roast-pipeline.md) | Two-stage RAG pipeline for Business Idea Roaster | Proposed |
| [0005](0005-dummy-ui-deploy.md) | Dummy UI deployability proof — stack, transport, healthcheck | Proposed |
| [0006](0006-brain-prompt-canonical-structure-v2.md) | Canonical structure v2 for squad brain prompts (semantic/topological pass — FOC-72 Wave E) | Proposed |
| [0007](0007-trading-assist-architecture.md) | trading_assist architecture — stack reuse, selective migration from stocks-ui, LLM-generated company context, and fundamentals scoring | Proposed |
| [0008](0008-run-scoped-usage-identity.md) | Run-scoped usage identity — composite `(run_id, usage_id)` primary key and `run_id` in all source-location dedup keys | Proposed |
| [0009](0009-supervisor-frontman-runtime.md) | Frontman supervisor runtime — internal bus, headless Claude children, file-based HITL relay | Proposed |
| [0010](0010-provider-profiles.md) | Provider profiles in `config/models.json` | Accepted |
| [0011](0011-orch-ollama-withdrawal.md) | orch-ollama Withdrawal | Accepted |

## Statuses

| Status       | Meaning |
|--------------|---------|
| **Proposed** | Under discussion; not yet accepted. |
| **Accepted** | Agreed upon and currently in effect. |
| **Deprecated** | No longer recommended; kept for historical reference. |
| **Superseded** | Replaced by a newer ADR (which should be linked). |

## Lifecycle

1. **Proposed** — written by the spec or debugger sub-agent, linked in the relevant Linear task.
2. **Accepted** — after review and approval (spec-review gate or lead approval).
3. **Deprecated / Superseded** — when a later decision overturns it; the newer ADR should reference the older one.

## References

- Referenced by [`agents/plan/agents/spec.md`](../../agents/plan/agents/spec.md) — spec sub-agent emits ADRs for non-trivial architectural decisions.
- Referenced by [`agents/dev/agents/debugger.md`](../../agents/dev/agents/debugger.md) — debugger sub-agent emits ADRs for architectural decisions during hard-bug escalation.
- Template: [`adr-template.md`](adr-template.md).

# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Fenix project.

## Purpose

ADRs document architecturally significant decisions: technology choices, structural changes, protocol designs, and any other decision with lasting impact on the system. They serve as a lightweight, timestamped record of *why* something was done, so future contributors (or the same team six months later) can understand the rationale without reverse-engineering the code.

## Numbering

Each ADR is numbered sequentially: `ADR-NNN` (zero-padded to three digits, e.g. `ADR-001`, `ADR-042`).

File naming convention: `NNNN-descriptive-kebab-case.md` (e.g. `0001-use-openrouter-for-models.md`).

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

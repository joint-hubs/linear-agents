## Context

Why is this tech-debt / refactor / infra change needed? What pain or risk does it address? Link
to any prior discussion, ADR, or related issues.

## Current state

What the codebase or infrastructure looks like today. Include relevant metrics (e.g. test
coverage, latency p99, module coupling count).

## Target state

What it should look like after the change. Concrete, measurable.

## Risk

- **Rollback plan**: how to revert if something goes wrong.
- **Migration**: any data migration, zero-downtime requirement, or co-existence period.
- **Observability**: what to monitor during rollout.

## Acceptance Criteria

- **Given** the change is deployed, **When** [scenario], **Then** [technical metric / behaviour].
- **Given** the change is deployed, **When** existing tests run, **Then** no regressions.
- **Given** the change is deployed, **When** [rollback scenario], **Then** system recovers cleanly.

> Note: this issue may not produce user-visible or deployable output. AC are technical.

## DoR (Definition of Ready)

- [ ] Current state is measured / documented.
- [ ] Target state is concrete and testable.
- [ ] Rollback and migration plan exist.
- [ ] Risk is assessed.

## DoD (Definition of Done)

- [ ] All AC pass.
- [ ] Existing test suite passes (no regressions).
- [ ] Metrics confirm target state is reached (or delta is documented).
- [ ] Rollback procedure is verified.
- [ ] `dod-ok` label applied.

## Out of scope

- What this issue explicitly does NOT cover (e.g. UI changes, new features).

## Relations

- **Parent**: [link to epic / initiative]
- **Blocked by**: [issue keys]
- **Blocks**: [issue keys]

## Estimate

T-shirt: `S` / `M` / `L` (delete others). XL → re-split into smaller slices.

## Context

What is the user or business problem? Why does this feature exist? Link to any prior discussion,
ADR, or design doc.

## Jobs to be done

- Outcome the user wants to achieve (not a list of UI fields).
- Measurable signal that the feature is working in production.

## Acceptance Criteria

- **Given** [precondition], **When** [action], **Then** [expected outcome].
- **Given** [precondition], **When** [action], **Then** [expected outcome].
- Edge cases: empty state, error state, loading state.

## DoR (Definition of Ready)

- [ ] Why / outcome is clear.
- [ ] AC are testable and complete (happy + edge paths).
- [ ] Out of scope is documented.
- [ ] Dependencies / blockers identified.
- [ ] Estimate (t-shirt) assigned.

## DoD (Definition of Done)

- [ ] All AC pass (Given/When/Then verified).
- [ ] Unit / integration tests cover new paths.
- [ ] Feature is deployable (migrations, env vars, feature flags ready).
- [ ] Manual smoke test on staging.
- [ ] `dod-ok` label applied.

## Out of scope

- What this issue explicitly does NOT cover (anti-scope).

## Relations

- **Parent**: [link to epic / initiative]
- **Blocked by**: [issue keys]
- **Blocks**: [issue keys]

## Estimate

T-shirt: `S` / `M` / `L` (delete others). XL → re-split into smaller vertical slices.

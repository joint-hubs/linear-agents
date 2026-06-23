## Context

Where was the bug observed (environment, build, commit)? When did it first appear? Link to
related issue or deploy that may have introduced it.

## Repro steps

1. Go to [URL / screen].
2. Perform [action].
3. Observe [unexpected behaviour].

## Expected behaviour

What should have happened instead.

## Impact

- Severity: `crash` / `data-loss` / `blocker` / `cosmetic`.
- Affected users / flows / data.
- Workaround available? (Y/N — describe).

## Root cause

(Filled after debug — leave blank at creation.)

## Acceptance Criteria

- **Given** the bug scenario, **When** the steps above are followed, **Then** the bug no longer
  reproduces.
- **Given** the fix is deployed, **When** existing tests pass, **Then** no regressions are
  introduced.

## DoR (Definition of Ready)

- [ ] Repro steps are clear and reproducible.
- [ ] Environment / build is identified.
- [ ] Impact is assessed.

## DoD (Definition of Done)

- [ ] Bug no longer reproduces on staging.
- [ ] Regression test covers the scenario.
- [ ] Root cause is documented in the issue.
- [ ] `dod-ok` label applied.

## Relations

- **Parent**: [link to epic / release]
- **Blocked by**: [issue keys — e.g. dependency fix]
- **Blocks**: [issue keys]

## Estimate

T-shirt: `S` / `M` / `L` (delete others). XL → re-split.

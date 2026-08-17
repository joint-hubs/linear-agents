# Contributing to Fenix

Thanks for your interest in Fenix! This is an open-source project maintained primarily by a single team, so contributions are welcome but coordinated through GitHub issues to keep work visible and avoid stepping on in-flight changes.

## Quick links

- [Issue tracker](https://github.com/joint-hubs/linear-agents/issues) — bug reports and feature requests
- [Documentation](docs/README.md) — full index of design docs, ADRs, plans
- [Workflow conventions](docs/FENIX_WORKFLOW.md) — Linear statuses, labels, signaling, commit format
- [Polish README](README.md) · [English README](README.en.md)

## How to report a bug

Open a GitHub issue with:

1. **What you did** — exact commands you ran (e.g. `bin/plan.bat --task JOI-123`).
2. **What you expected** — short, specific.
3. **What happened** — error message, screenshot, or link to the relevant run in the telemetry dashboard (`http://localhost:7331/runs/<run-id>`).
4. **Environment** — Windows version, Node version (`node --version`), and whether you're using Claude Code or the OpenRouter-routed launchers.

If the bug is **security-related**, please email the maintainer directly rather than opening a public issue.

## How to propose a feature

For anything beyond a small bugfix, open an issue first to discuss the approach. The project has architectural decisions documented as ADRs in `docs/adr/` — check there to see if your idea is already covered (and if not, propose an ADR of your own).

Small, clearly-scoped changes (typo fixes, doc improvements, dependency bumps) can go straight to a pull request.

## Development setup

```bat
git clone https://github.com/joint-hubs/linear-agents.git
cd linear-agents
copy .env.example .env
:: fill in keys: OPENROUTER_API_KEY, ANTHROPIC_API_KEY, LINEAR_API_KEY, etc.
node scripts/bootstrap-linear.mjs   :: one-time, creates labels/states in Linear
bin\dashboard.bat                   :: telemetry dashboard on :7331
```

See [README.en.md](README.en.md) for the full quickstart and requirements list.

## Commit message format

We follow [Conventional Commits](https://www.conventionalcommits.org/) with a `<prefix>(<area>):` shape. The full list is in [docs/FENIX_WORKFLOW.md](docs/FENIX_WORKFLOW.md#commit-message-format); the common ones:

| Prefix          | When                                  |
| --------------- | ------------------------------------- |
| `feat(area):`   | New feature                           |
| `fix(area):`    | Bug fix                               |
| `refactor:`     | Refactor / tech debt                  |
| `test:`         | Tests only                            |
| `chore:`        | Config, deps, release bump            |
| `docs:`         | Documentation                         |

Example:

```
feat(dev): surface `gh pr checks` status in run detail

- new section under RunDetail.jsx showing each check + bucket
- falls back to "pending" badge while checks are still running
- 3 unit tests for the new <CheckList> component
```

## Pull request process

1. **Branch from `main`** with a descriptive name (e.g. `fix/telemetry-spool-leak`, `feat/prompt-library-search`).
2. **One logical change per PR** — small, reviewable, easy to revert. Split larger refactors into multiple stacked PRs.
3. **Run the tests** before opening a PR: `node scripts/test-all.mjs` (or call individual `scripts/*.test.mjs` if you don't have the wrapper).
4. **Update docs** if your change affects user-facing behavior (CLI flags, env vars, config schema).
5. **Wait for CI** (when set up — see [docs/ops/ci-cd.md](docs/ops/ci-cd.md) for the plan) before requesting review.
6. **Squash-merge** with a message that matches the convention above.

## Code style

- **JavaScript:** Node 22.5+ ESM (`.mjs`), no transpilation, no TypeScript. Prefer `node:` prefix for built-ins (`node:fs/promises`, `node:path`).
- **Python:** 3.12, used only in `notebooks/` and a handful of Atlas tools. No framework.
- **Batch:** `.bat` launchers, Windows-only. The underlying `.mjs` scripts are portable.
- **Markdown:** link-rich, one concept per section, no orphan files.

## Out of scope (for now)

- **macOS/Linux launchers** — the `.bat` files are Windows-only by design. Porting to `.sh` is welcome but please coordinate in an issue first so we can agree on a parallel structure rather than a rewrite.
- **CI/CD** — the CI plan is in `docs/ops/ci-cd.md` but not yet implemented. PRs that wire up GitHub Actions are very welcome; please use a separate branch so they're easy to discuss independently.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

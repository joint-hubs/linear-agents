# CodeGraph prompt refresh — delivery report (2026-09-23)

**Verified: 84/84 test files passed (783171 ms).** Independent integration review: PASS. Implementation commits: `dbce3fe` (CodeGraph), `482f74a` (prompts).

## Changes

- Six role prompts slimmed (`agents/{dev,plan,review,test,cadence,supervisor}/CLAUDE.md`): mandated PRD/role-spec reads replaced by in-file topic→reference maps; relocated material lives in `docs/agents/`.
- CodeGraph guidance aligned across root `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`: one "query the right project" rule plus a freshness/fallback section.
- Shared freshness guard for CLI and MCP: canonical target root, exact-HEAD proof in local `.codegraph/synced-head`, pending-change checks, schema compatibility and bounded calls. Synchronize only when changes or missing revision proof require it; full rebuild is limited to authorized schema repair.
- MCP routes through the boundary adapter. Launch readiness covers new and reused worktrees, provisions the local index, and enables CodeGraph through both project trust and target-local MCP settings while preserving existing keys.

## Repo state

Baseline `70e40a4` (merge FOC-475, starting main HEAD); candidate `5abae90`. No push/fetch. Direct `git ls-remote` verified origin/main = `e2f76f7` — same as the cached ref, so the baseline is genuinely 32 commits ahead, not a cache artifact. Main checkout's untracked settings/prior audit docs and the stash are preserved.

## Metrics (final, measured)

LF-normalized bytes of each role's mandatory payload (role file + previously mandated PRD/spec reads; shared global context excluded). Bytes, not billed tokens; per role, never summed.

| Role | Before | After | Δ |
|---|---|---|---|
| DEV | 35261 | 21654 | −38.6% |
| PLAN | 23377 | 17569 | −24.8% |
| REVIEW | 25629 | 20325 | −20.7% |
| TEST | 24443 | 16636 | −31.9% |
| CADENCE | 17865 | 12868 | −28% |
| SUP | 20107 | 19670 | −2.2% |

Squad roles: ≈21–39% cut; supervisor −2.2%.

## Model diagnostics (two paid probes; no further paid probes)

Implementation workers used Atlas bridge delegation — the delegation mechanism for THIS implementation, which is DISTINCT from the Fenix product squads. Do not transplant Atlas model policy or workers: squads keep the repo `config/models.json` routing, unchanged.

Both diagnostics were launched directly by the root through a temporary Claude CLI configuration. Dollar values below are CLI-reported estimates (`costBasis: unknown`), not verified OpenRouter billing; do not use them to estimate savings.

- **Probe 1 — failed, $0.1217712:** `--setting-sources user` accidentally hid MCP, so the probe saw no MCP; a report-helper TDZ also hit. Helper repaired only in gitignored `.state`; the retry needed explicit user approval.
- **Probe 2 — success, GLM53 flash, $0.3713568, 180 s-bounded, session `7a6f042e-091a-4565-bbca-9ec07822f8c8`:** 4 CodeGraph calls (2 explore, 2 node), clean; every tool input's `projectPath` targeted the correct worktree; no other MCP. `--max-turns 4` was configured but the CLI counter reported 6 — known limitation, recorded honestly.

A copied DEV-prompt diagnostic proves prompt adoption only — it is not a production squad test. Production approval was separately verified without model/API calls: a fresh linked worktree reports CodeGraph Connected; repeating approval is a no-op. The installed CLI requires both canonical project trust and target-local enabledMcpjsonServers.

## Handoff state

- Run `2026-09-23T09-07-06-201-supervisor-xkpg` closed: 0 open children, no open gates, merge accepted; 80/80 files green at baseline (historical — the branch now carries 84 test files; checklist pins updated).
- Root re-verified plan.ac: 22 pass; graph valid.
- Linear: FOC-475 is In Progress; proof comments were not posted — this session made no Linear writes. The next session reconciles the 475 proof per its existing role: recheck AC/DoD against the current Linear state, close only if met, otherwise name the gap — no redo of merged work, no extra global permission.
- plan.ac eval: 12 cases, 42 event lines — 7 ok, 5 escalated; verdicts among successful cases: 2 pass, 5 partial. Not production readiness. See `docs/benchmark/plan-ac-eval.md`; raw artifacts remain in `C:/Users/mateu/Documents/GitHub/la-wt/linear-agents/foc-475-dev/.state/foc-475/eval/2026-09-23T10-19-26/`.

## CodeGraph contract (now correct)

- Target = repo-root cwd or explicit `--project-root`; no wrong-root fallback. The Windows runtime is NOT pinned to 1.5.0 — the wrapper selects the consistent installed binary (actual verified: codegraph 1.5, extract 24).
- Unprovable state yields UNKNOWN with an explicit file-reading fallback. The check and query are not an atomic snapshot; concurrent edits after the check remain a narrow race, handled where upstream staleness notices are available and rechecked on the next query.
- New MCP guard: 42 tests plus a real shared-environment probe (7 actual checks) — PASSED.
- Review corrections applied: raw examples fixed; external-MCP claim corrected — guarded MCP applies only when the own adapter is configured, otherwise use the CLI with an explicit target.

## Verification

Focused suites: runtime 51, CLI 130, MCP boundary 42, real-MCP fixture 7, MCP approval 26, spawn 34, benchmark 28 — all passed. Real CLI tests verify changed call relationships after dirty edits, backwards checkout and a backdated commit. Existing pinned-candidate and supervisor suites also pass. Final root regression: 84/84 files passed, exit 0 (783171 ms). The first run exposed two test-environment scrub failures; the global test-only override was removed and scoped to mock spawns. Existing assertions were preserved; the complete rerun passed.

Root checks: lint 472 files / 0 violations; graph validation passed; CodeGraph impact query refreshed 8 pending changes and returned affected tests. A following clean readiness check took 836 ms with synced:false. No Docker/service code changed; the new supervisor session loads the updated prompts and MCP definition.

## Next work

FOC-476 is the next integration, but check real blockers first: FOC-450 (egress) before publish; FOC-381 (telemetry dedup) before cost calibration. No blanket M1-before-M2 ordering; independent items allowed; safety M1 items take priority.

## Restart prompt

`docs/supervisor-restart-2026-09-23.md` starts the next supervisor: an explicit new session in `C:/Users/mateu/Documents/GitHub/linear-agents`, continuing the actual squads autonomously within unchanged gates — model routing, human H gates, pinned DEV candidate for review/test, no auto push, no unrelated cleanup. Reading order and the FOC-475 reconciliation rule live there.

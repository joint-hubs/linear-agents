# Prompt/context efficiency and fresh CodeGraph queries

Status: verified implementation complete; authorized commits and new-supervisor handoff prepared.
Owner: Mateusz. Prepared: 2026-09-23.
Planning baseline: `9a6d20e` (FOC-474 merged); refreshed after the supervisor paused.
Implementation baseline: `70e40a4` (FOC-475 merged); worktree `C:/Users/mateu/.codex/worktrees/prompt-codegraph-refresh/linear-agents`.
Related evidence: [self-development audit](../reviews/2026-09-23-fenix-self-development-audit.md).

## 1. Requirements, assumptions and boundaries

Confirmed requirements:

1. Optimize the supervisor and squad prompts/context after the currently running supervisor stops.
2. Make agents actually use CodeGraph for code navigation and impact analysis.
3. Check graph freshness before each query and synchronize often enough to avoid stale answers, without rebuilding unnecessarily.
4. Verify the changes, then commit the authorized implementation in logical batches.
5. Prepare a prompt for a **new supervisor session** later, based on the final implementation and shutdown handoff.
6. Planning-only restriction was superseded by Mateusz's follow-up: inspect FOC-475/Git, implement, commit and deliver the new-supervisor prompt.

Assumptions:

- The pause signal comes from Mateusz; this request does not authorize stopping the running supervisor now.
- Commits for this work are authorized once the pause, implementation and verification conditions are satisfied. No further commit-permission question is needed. Push is outside this request.
- Scope is this repository and the agent launch/query paths it owns. Do not edit global user memory or other repositories' instruction files as part of prompt cleanup.
- Freshness means checking the **actual target worktree**, including relevant uncommitted edits, not merely comparing a timestamp or main's HEAD.
- A new supervisor session must receive a concise handoff and read authoritative state; it should not automatically resume the old conversation.
- Atlas delegation used for this implementation is distinct from Fenix's own squad orchestration. Preserve the squad model routing/configuration; do not transplant Atlas workers, policy or lifecycle into the product. The GLM role probe is a separate diagnostic, not a production squad run (Mateusz clarified this during implementation).

No product question blocks planning. Exact guard wiring is an engineering choice to resolve from the existing CLI/MCP implementation and validation fixtures, not a new user approval gate.

Out of scope: unrelated runner/telemetry fixes from the audit, model-routing changes, autonomous session resets, training/calibration, broad dependency upgrades, remote publication and a rewrite of the prompt infrastructure.

## 2. Problem and intended operator journey

Current prompts mix executable rules, long specifications and examples. DEV/PLAN/REVIEW/TEST also require reading both their PRD and role specification before answering. These reads add approximately 14/6.3/6/8.2 kB respectively. Moving identical text between files does not save context if agents must still read it all.

CodeGraph instructions conflict: root instructions say graph-first, while `.claude/CLAUDE.md` says to skip it when no index exists. The audited execution worktrees had no index. The CLI wrapper already has a freshness check and conditional synchronization; MCP and target-worktree behaviour need to meet the same contract.

Operator journey: Mateusz confirms the pause → record final repository/run state → implement and validate on isolated fixtures → commit the coherent changes → provide the new-session prompt when requested → new supervisor verifies its environment, reads the handoff and continues from the agreed next task.

## 3. Prompt and context design

Retain a compact, self-contained mandatory contract in each role's `CLAUDE.md`:

- role responsibility and permitted actions;
- task/repository/candidate identity and supervised-mode precedence;
- required review/test/handoff and human-gate behaviour;
- verification honesty, handling of secrets and prohibited permission workarounds;
- model-routing source of truth, without duplicating model choices in prose;
- CodeGraph-first navigation, freshness requirements and the explicit UNKNOWN fallback.

Replace blanket PRD/spec reads with a short topic-to-reference map **inside the mandatory role `CLAUDE.md`**: read the relevant section when the current task needs it. The map itself must be discoverable without reading another optional file. Before removing a mandatory read, classify its unique requirements and retain any operational rule absent from the role contract. Do not make a safety or acceptance condition optional by relocating it. A short PRD can remain mandatory when its unique operational requirements justify that cost; quantify the tradeoff per role.

Move long examples and command tutorials to existing or small dedicated references. Remove repeated explanations, especially duplicate supervisor budget prose. Preserve headings/tags consumed by the prompt library, dashboard and drift checks unless their consumers change in the same batch.

Keep the existing `<supervised_mode>` block and precedence policies unchanged in this pass. `config-drift.test.mjs` requires the common supervised prefix to match across plan/dev/review/test, with the DEV-only suffix preserved; the generic-subagent model paragraph matches across those four plus cadence. Keep gate/notify riders and verdict semantics. Do not introduce a new templating system or a second unconditional common-file read. Repository duplication can be preferable to an extra runtime read; measure the **loaded path**, not the total size of `agents/`.

Measure before/after bytes and estimated tokens per role for both mandatory instructions and instructed startup reads. Label estimates. Record any exact token measurement separately if a suitable tokenizer is available. Acceptance requires a smaller startup payload without lost behaviour; do not promise a dollar saving from undeduplicated historical telemetry.

Initial targets: supervisor, dev, plan, review and test. Cadence also has 5,380 B of instructed PRD/role reads: include it in baseline measurements and apply the same targeted-read rule if it is a mechanical change; otherwise limit cadence changes to common CodeGraph consistency. `settings.json`, plugin cache and automatic-memory files are not prompt text merely because they are on disk.

## 4. CodeGraph freshness and worktree contract

### Resolve the right project

The launcher/query boundary must carry the canonical target worktree root. **Confirmed current defect:** `code-intel.mjs:55` sets ROOT from the script location, and `:343` passes that ROOT to queries. Invoking it through `$LA_ROOT/scripts/code-intel.mjs` therefore targets the tooling checkout even when the caller is in a task worktree. Add an explicit target-root contract and thread it through status, baseline validation, sync and the query itself. Preserve an intentional way to query Fenix's own tooling; never infer that intention merely from the script location. Reject conflicting project identities rather than answering from the wrong checkout.

Use the same known CLI/package resolution for readiness and query execution. Diagnose the existing Windows PATH/version discrepancy before choosing a binary; do not fix it with an unreviewed global package upgrade.

### Prepare once, check on every query

1. At authorized child launch readiness, for both newly created and reused worktrees, ensure the target has a usable local index and headless MCP access. Prefer a narrow launch-readiness step over adding unconditional side effects to the shared Git worktree helper. Initialization is once per missing index, not once per question. Keep indexes out of commits.
2. Before each index-backed query, check target identity and index freshness. Reuse the existing CLI freshness guard where possible.
3. If relevant changes are pending or the checkout changes, synchronize incrementally and verify again before serving the answer.
4. If nothing changed, skip synchronization. Do not use elapsed time alone as proof that an index is fresh.
5. Reuse the installed CodeGraph daemon's per-project ownership and writer locking: reconnaissance found one watcher/engine per root and an existing cross-process write lock. Do not add another watcher or a parallel lock/indexing subsystem. Handle contention with bounded retry or explicit UNKNOWN.
6. Use bounded waits. If the index cannot be made demonstrably fresh, return a structured UNKNOWN/degraded result and allow explicit direct-file fallback. Never translate this into "symbol not found".
7. Handle changes during a query honestly: retry within a bounded policy or mark affected graph results stale/unknown. A freshly reread source snippet alone does not validate stale call relationships.

### Cover both access paths

Preferred navigation remains MCP `codegraph_explore`; impact/affected queries support shared-symbol changes and test selection. CLI remains the scripted/headless fallback.

The MCP path must satisfy the same readiness contract as CLI. Reconnaissance found a roughly 2-second watcher debounce plus stale banners, which is **not by itself synchronization before each query**. Reuse the CLI guard algorithm and the server's existing writer coordination. Determine the narrowest supported shared guard at the tool/launch boundary; a Fenix-owned Claude CLI PreToolUse adapter is the first candidate, subject to a real headless-hook test. Resolve the target from actual tool arguments/context and prevent recursion. If the installed hook cannot reliably gate these calls, implement the equivalent thin MCP boundary guard rather than claiming the watcher provides the guarantee. A prompt telling the model to remember a separate sync command is insufficient.

Canonical instruction: ready index → graph-first with the guard; missing index in an authorized Fenix launch → provision once; unresolved initialization/freshness → explicit UNKNOWN and direct-file fallback. Provisioning fixes worktree readiness; editing prose alone does not. Do not silently initialize arbitrary external projects outside the owned launch scope.

Implementation anchors from reconnaissance:

- `scripts/codegraph-runtime.mjs` owns root selection and freshness; `scripts/code-intel.mjs` and the MCP adapter consume the same verdict. Preserve pending-change checks, add an exact per-worktree HEAD proof, and reject incompatible index schemas. The former duplicate CLI guard is removed.
- `scripts/supervisor-spawn.mjs`: readiness near `verifyPinnedState`, before registering/starting the child; this covers reused as well as newly created worktrees.
- `scripts/mcp-enable.mjs`, `.mcp.json`, `agents/*/settings.json`: headless access and, if verified, the query guard hook. Preserve the `CODEGRAPH_MCP_TOOLS` environment block; do not run `codegraph install` as a casual configuration update.
- The repo proves a **SessionStart** hook JSON adapter in `telemetry-hook.mjs`, not a PreToolUse contract. Verify the installed runtime's actual tool-hook fields, blocking semantics and timeout behaviour before adopting that wiring. Resolve an absent explicit project argument from verified tool-call cwd/project context; do not silently fall back to tooling-main. Measure a suitable bounded timeout rather than copying the telemetry hook's 5-second setting.
- `agents/{supervisor,dev,plan,review,test}/CLAUDE.md`, optional cadence consistency, root `CLAUDE.md` / `AGENTS.md` and `.claude/CLAUDE.md`: aligned instructions and reduced required reads. PRD/role reference files receive relocated examples only where useful.

An actual navigation record should identify the target project and freshness outcome sufficiently to diagnose fallback. Reuse existing telemetry where possible; avoid a new dashboard or elaborate event subsystem.

## 5. Implementation phases and dependencies

| Phase | Work | Execution / status |
|---|---|---|
| P0 — pause checkpoint | Confirm no relevant live supervisor/children are mutating the repo; capture HEAD, dirty paths, run/task/gate/candidate state and next intended work | Complete: FOC-475 merged, main remains 70e40a4 with no tracked source changes; the previously active FOC-433 child has also exited. Recheck HEAD immediately before integration. |
| P1 — runtime contract | Resolve target-root and CLI/MCP freshness gaps; provision worktree readiness; remove contradictory CodeGraph instructions | Complete; exact-HEAD/schema guard, bounded queries, real target-specific MCP approval; independent integration review PASS. |
| P2 — prompt reduction | Audit mandatory reads, retain unique rules, slim six role prompts and move reference material on demand | Complete; protected rules preserved; LF-normalized mandatory bytes reduced 21–39% per squad role, 2.2% supervisor. |
| P3 — integrated verification | Run relevant existing tests and real index fixtures; measure startup footprint and no-change query overhead | Complete: final root regression 84/84 files, exit 0 (783171 ms); lint and graph validation passed; real CLI/MCP freshness fixtures and the explicitly approved diagnostic retry passed. Fresh guard observed 836 ms with synced:false. |
| P3a — test environment isolation | Preserve the runner's LA_SUPERVISOR* scrub invariant while keeping mock spawns offline | Complete: global injection removed; both existing scrub assertions pass unchanged. Scoped mock entrypoints and relevant supervisor suites pass; no production code changed. |
| P4 — commits and handoff | Commit verified batches, record exact SHAs/results and restart handoff; prepare the startup prompt when requested | Complete: runtime commit dbce3fe, prompt commit 482f74a; delivery report, final plan and restart prompt form the documentation batch. |

P1 and P2 reconnaissance can overlap. Implement independent files in parallel only after the pause; one worker owns shared files. Final root approval covers the combined result, not only individual worker tests.

Refresh impact analysis before editing shared helpers. Preserve unrelated dirty files and completed work from the old supervisor. Do not reset/rebase its worktree to simplify implementation.

## 6. Acceptance and verification

### Freshness fixtures

- Fresh worktree without an index: preparation succeeds once, MCP is usable headlessly and a real structural query succeeds.
- Unchanged tree, consecutive queries: no unnecessary repeated full build/sync.
- Edit a call relationship without committing: the next query reports the new relationship, not just fresh file text. An explicit bounded pending/UNKNOWN result is acceptable during a genuine race; once the fixture is quiescent, a subsequent query must succeed with the new relationship. Always returning UNKNOWN does not satisfy adoption.
- Add/delete/rename an indexable source file and switch the candidate revision: refresh or explicitly refuse; no stale positive/negative answer.
- Two worktrees with different implementations: each returns its own symbols and edges, even when invoking the tooling through `LA_ROOT`.
- Concurrent queries, sync failure, unavailable index and pending changes: bounded behaviour, no duplicate writer race, UNKNOWN is distinguishable from an empty result.
- Check both MCP and CLI; verify a stale banner causes explicit handling rather than being ignored.

### Prompt/runtime fixtures

- Each role retains its permitted/prohibited actions and resolves conflicts the same way.
- Review failure reaches the existing fix/re-review path; a human gate remains a gate; the test candidate remains pinned.
- Missing context requests the necessary reference or emits a question; it does not invent an answer after startup reads become optional.
- Headless mock launch loads the intended role/project context and its topic map; no accidental all-role or whole-spec injection.
- Prompt-library, configuration-drift, CodeGraph wrapper/freshness and affected supervisor launch suites pass. `config-drift.test.mjs` checks the real role content; `prompt-library.test.mjs` mostly exercises temporary fixtures and is not sufficient alone. Also check `prompt-write.test.mjs` and lint where affected. Choose exact tests from affected-symbol analysis; do not add tests that merely mirror prose.
- Run one bounded, read-only GLM-5.3-Flash role probe on a navigation task using the final launch configuration. Confirm actual CodeGraph use and correct target/freshness in its tool trace; disable external writes. Mock loading alone does not prove instruction adoption. Record provider usage directly if captured, without interpreting the known-duplicated historical ledger as a before/after saving.

Use temporary fixtures and offline mocks for lifecycle tests; do not launch live agents that edit Linear. Real local CodeGraph calls are necessary for freshness validation. Report checks executed separately from author-reported suite results.

Record initial bootstrap time, clean-query overhead and changed-tree refresh time as observations. Preserve correctness first; compare against the existing guard instead of inventing a latency target. Apply the delivery-loop requirements appropriate to the components actually changed; redeploy a running service only if that service's code/config is affected.

## 7. Commit and rollback plan

Expected logical batches (adjust to the final diff):

1. `fix(codegraph): enforce fresh worktree-scoped queries` — runtime/bootstrap/wiring, aligned CodeGraph instructions and meaningful tests.
2. `refactor(agents): reduce mandatory startup context` — role prompts, on-demand references and necessary consumer/test updates.
3. `docs(supervisor): record verified restart handoff` — final plan status, measurements, state/handoff documentation and restart instructions if requested by then.

Only stage named files belonging to these batches. Existing audit documents and `.claude/settings.local.json` are not silently included; report their status separately. Commit authorization is already supplied for this implementation. Do not push automatically.

Keep old-session state artifacts. Rollback should revert the relevant logical commit(s) without resetting unrelated work or erasing run records. A new session must explicitly know if runtime and prompt versions differ after rollback.

## 8. Later new-supervisor prompt

Produce the actual prompt after implementation, using the final state rather than today's assumptions. It must contain:

- exact repository path, intended Linear project/task and verified implementation commit(s);
- concise shutdown/handoff state: completed work, unfinished ACs, open gates, candidate SHA and next allowed action;
- where to read the authoritative role contract and the small handoff file;
- readiness check for the new runtime and CodeGraph target/freshness behaviour;
- instruction to reconcile Linear with recorded evidence, without redoing merged work or automatically closing incomplete tasks;
- preserved approval boundaries and what to do if the recorded state differs from the checkout.

Do not paste the whole audit, PRDs or old transcript into the startup prompt. Do not assume that a similarly named global Fenix memory describes `linear-agents`; identify the repository explicitly.

## Planning checklist

- [x] Capture user scope, future commit authorization and pause condition.
- [x] Refresh main baseline after FOC-474 merged.
- [x] Specify per-query freshness, conditional synchronization and worktree identity.
- [x] Specify prompt invariants, verification scenarios and commit boundaries.
- [x] Incorporate bounded CLI/MCP and prompt-consumer reconnaissance.
- [x] GLM-5.3 review: preserve discoverable topic maps, explicit missing-index semantics and non-flaky pending/UNKNOWN handling; corrections incorporated.
- [x] Follow-up source verification: tooling-main root bug confirmed; MCP watcher alone is insufficient; spawn readiness covers reused worktrees; PreToolUse wiring explicitly remains an implementation validation step.

## Final implementation checkpoint

- FOC-475 merged at `70e40a4`, candidate `5abae90`; run `2026-09-23T09-07-06-201-supervisor-xkpg` has no open children/gates. Root independently verified plan.ac (22/22) and graph validation.
- Linear FOC-475 was still In Progress at the final read; no Linear writes were performed. The new supervisor must recheck AC/DoD before closing it.
- Starting main was 32 commits ahead of origin/main, verified directly by ls-remote (`e2f76f7`). No push/fetch. Existing unrelated stash, audit files and local settings are preserved.
- CLI and MCP now share a target-worktree, exact-HEAD and schema guard. Ordinary command hooks can fail open on startup errors/timeouts, so freshness is enforced at the MCP boundary. No additional watcher/locking subsystem was added.
- Six role prompts use targeted references and preserve their protected rules/model routing. Mandatory payload bytes fall 21–39% for squad roles and 2.2% for supervisor; shared global context excluded.
- Two explicitly approved direct-CLI GLM diagnostics completed: the first had a helper/MCP setup failure; the repaired retry made four successful CodeGraph calls against the exact worktree. This proves prompt adoption, not a production squad run. Atlas remains separate from Fenix squads.
- Real production MCP approval on a fresh worktree was separately verified Connected without paid model calls. Both canonical trust and target-local MCP enablement are required.
- Independent integration review PASS. Final full regression 84/84 (783171 ms), lint zero violations, graph valid. First-run environment failures were repaired without weakening assertions.
- Runtime `dbce3fe`; prompts `482f74a`. Final delivery evidence: `docs/reviews/2026-09-23-prompt-codegraph-delivery.md`. Ready-to-paste new-session instructions: `docs/supervisor-restart-2026-09-23.md`.

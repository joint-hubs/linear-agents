# FOC-286 — REVIEW round 1 (Conventional Comments)

- **Issue:** FOC-286 — Pinned-state kickoff prologue + spawn-time verification in supervisor-spawn (FOC-272 F-12)
- **Candidate:** branch `foc-286-dev` @ `b8f9f1835a5d3aaea36b32e2c8c515709cdb840e` (one scoped commit)
- **Base:** `674f8f4` · diff 4 files, +551/−5 (verified: `git diff --stat 674f8f4...foc-286-dev`)
- **Reviewer:** REVIEW squad, supervised run `2026-09-11T08-09-57-083-supervisor-fd22`, child `review-2`, 2026-09-11
- **Mode notes:** Linear unavailable (harness deny) — issue served from the Supervisor packet; Linear labels/status left to the Supervisor post-gate. No push (nothing to push). Legacy round counter untouched (supervised mode); round = 1.

## Passes (parallel)
| pass | result |
|---|---|
| first-pass (lint/style/defects) | 7 findings: 2 doc/test-completeness (weighed for issue-grade, ruled non-blocking — see lead notes), 3 nitpicks, 1 question, 1 praise; house style matched |
| security (auth/secrets/exposure) | no issue-severity findings; semgrep 0 findings / 0 errors (2 files); no Linear/network access added; deny-rules untouched; no file-content leaks |
| deep (architecture/hard correctness) | AC1–AC4 all pass; 2 suggestions, 2 nitpicks, 1 praise; EXECUTED 5 test suites against the candidate |

Merge authority applied (deep > security > first-pass per domain). No cross-pass contradictions: deep's AC4 pass and first-pass's coverage-gap finding are complementary, not conflicting.

## AC map (approve basis)
| AC | Verdict | Evidence |
|---|---|---|
| 1 — every child receives the 9-field prologue | **PASS** | Single launch path: the watcher always gets spawn's own prompt file (supervisor-spawn.mjs:463,475); `--release` replays re-enter the same main path (:104-110). New suite's e2e asserts the child `-p` payload `startsWith` the recorded prologue on BOTH entry paths (`--prompt`, `--prompt-file`). All 9 fields rendered; field 5 is a self-labeled pointer (Deviations #2). |
| 2 — verification before launch, named refusal | **PASS** | `verifyPinnedState()` at supervisor-spawn.mjs:300-318, immediately after `ensureWorktree`, BEFORE registry entry / childSettingsPath / telemetry / watcher launch. Every reason in the DEV list present in code (worktree-missing; branch-mismatch / branch-unreadable; base-revision-mismatch / base-revision-unreadable; tree-state-mismatch / tree-state-unreadable; prompt-file-unreadable). Refusal e2e: zero registry children + no generated settings file. |
| 3 — verification outcome in child record | **PASS** | `pinnedStateVerification {at, checks, reasons, cleanAtSpawn, dirtyPaths, prologue}` in the registry entry via `updateChild` (supervisor-spawn.mjs:391-395 — single-writer preserved, spawn still owns the entry) and in the success JSON (:573); prologue stored verbatim. Refusal records nothing (reason surfaces in stdout JSON, by design). |
| 4 — focused suites pass, spawn behavior unchanged | **PASS** | Deep pass EXECUTED against a scratch export of b8f9f18 (dev worktree untouched), env-scrubbed: pinned-state **14/14**, spawn **19/19**, cleanup **26/26**, gate **26/26**, verdict **21/21** — all equal the DEV's claims. Unchanged supervisor-spawn.test.mjs never asserted the `-p` payload (prologue-agnostic) — no silent assertion weakening. |

## Findings (merged, deduped by file:line, authority order)

**Blocking (`issue:`):** none.

**`suggestion:`** (non-blocking)
1. **suggestion:** `scripts/supervisor-lib.mjs:922-925` + `docs/adr/0009-supervisor-frontman-runtime.md:34` [first-pass] — The new JSDoc's stable-reason list and the ADR amendment both omit `branch-unreadable` and `base-revision-unreadable`, which the code emits (lib:958, 966 catch paths). The DEV report lists them — the two tracked docs are the drift. *Lead note: weighed for issue-grade; ruled non-blocking because AC2's named-reason contract is code-complete and the runtime `failJson` always emits the reason — documentation drift inside the diff, no AC undermined. Recommend a fast-follow.*
2. **suggestion:** `scripts/supervisor-pinned-state.test.mjs` [first-pass] — Zero coverage for the `branch-unreadable` / `base-revision-unreadable` catch branches (lib:956-968): the corrupt-index e2e deliberately avoids them (`rev-parse` never reads the index) and no unit test forces a `rev-parse` failure. *Lead note: same ruling as #1 — AC4's gate (focused suites pass, tests for both halves) is met; two named refusal reasons are nonetheless never executed by any test. Suggested unit: `worktree` = a plain non-git directory.*
3. **suggestion:** `scripts/supervisor-followup.mjs:211,219` [deep; security concurs] — The crash class FOC-286 closed on the spawn path is still live on the resume path: followup passes `--prompt-file` unresolved to the watcher (read with cwd=worktree), so a relative/missing path dies silently behind the 30s init timeout. Pre-existing and out of scope (Deviations #5), but the diff makes the same flag behave differently on the two paths. Clear fix direction: the same resolve+read-before-launch pattern.
4. **suggestion:** `scripts/supervisor-spawn.mjs:323-341` [deep] — Field 5's "verbatim issue + ACs: kickoff body below" rests on an unverified premise: nothing checks the body actually embeds the issue. A one-line `kickoff.includes(taskId)` guard (refuse, or annotate "(identifier not found in body)") would evidence it while keeping the no-Linear-read constraint.
5. **suggestion:** `scripts/supervisor-spawn.mjs:463` [security] — The combined prologue+kickoff (now including caller `--prompt-file` content) is written to a `mkdtemp` under os.tmpdir and never cleaned by spawn or watcher. Pre-existing for inline `--prompt`; the diff extends the surface. Suggest `rmSync(promptDir, {recursive, force})` after watcher start.

**`nitpick:`**
6. **nitpick:** `scripts/supervisor-spawn.mjs:330-339` [first-pass] — Asymmetric refusal payload: the success path pushes a `prompt-file-readable` check entry (:324), but the failure path only extends `reasons` (:337), leaving machine-readable `checks` contradicting `reasons` on this refusal. Push a failed check entry before `failJson`.
7. **nitpick:** `scripts/supervisor-lib.mjs:1024-1028` [first-pass] — Separator drift inside one "fixed shape" template: JSDoc promises `|`-separated sub-values, `pre-authorized`/`known-quirks` join with `"; "`, but `spawn-verified` joins with `", "`. Pick one convention for list sub-values.
8. **nitpick:** `docs/adr/0009-supervisor-frontman-runtime.md:34` [first-pass] — "leaves nothing behind" is overstated: when `ensureWorktree` just created the worktree and a race then fails branch/base/tree-state, the fresh worktree remains (nothing removes it, per FOC-167). True for registry/settings/watcher; qualify the claim.
9. **nitpick:** `scripts/supervisor-lib.mjs:1001` + `scripts/supervisor-spawn.mjs:463` [security + deep, merged] — Untrusted content vs the machine-readable block: a dirty filename containing `=== END PINNED STATE ===` can close the block early (bounded: win32 filenames cannot carry newlines; the block grants no privilege — pre-authorized comes from settings, not the list), and the kickoff body appended after the END marker is unfiltered, so quoted issue text can carry a forged second block. Low severity; consider rejecting the marker in body content.
10. **nitpick:** `scripts/supervisor-spawn.mjs:325` [deep] — `--prompt-file` with no value makes `parseArgs` yield `true`; `resolve(true)` then throws an uncaught, non-JSON TypeError. Fail-loud (better than the old silent watcher crash) but outside the named-reason contract — move the resolve inside the try.

**`question:`**
11. **question:** `scripts/supervisor-lib.mjs:990` (`preAuthorized`, `knownQuirks` params) [first-pass] — Never passed by the only production caller, so both fields always render accurate fallbacks ("(none — child settings are deny-only)"). Placeholder-by-design, or should a follow-up source them (delegation-side counterpart P7)?

**`praise:`**
12. **praise:** `supervisor-pinned-state.test.mjs` (refusal e2e) — Zero-registry-children + no-settings-file asserted on both refusal paths is exactly the no-partial-spawn invariant, and the measured corrupt-index-vs-stale-lock comment (stale `index.lock` tolerated, corrupt index fails) prevents re-learning it.
13. **praise:** `scripts/supervisor-lib.mjs:790-795` — all new git reads go through the pre-existing arg-array `git()` helper: no shell, no string interpolation of branch/worktree/prompt paths anywhere in the diff.
14. **praise:** `scripts/supervisor-lib.mjs:936-1027` — `tree-state-unreadable` treats UNKNOWN as refusal instead of clean; reused trees are pinned dirty rather than laundered; the seam (beside `dirtyTreeReport`, builtins+utils imports only, no cycle) is reusable by the followup audit.

## Deviation-claim verification (DEV report)
| # | Claim | Verdict |
|---|---|---|
| 1 | Worked inline (~0% delegation), per recovery directive | Process note, not a code finding. The verdict stands on the artifact, which was fully reviewed. |
| 2 | `issue:` field = identifier + pointer, not Linear verbatim | **Upheld.** Verified in code: spawn holds the kickoff body; triage.json stores signals, not the body (supervisor-triage.mjs:355), so no Linear-free verbatim alternative exists; the issue constraint forbids new Linear reads at spawn. Field is honestly self-labeled. AC1 ruled PASS; suggestion #4 hardens the premise. |
| 3 | Cleanup suite red only under inherited `LA_SUPERVISOR_CHILD` | **Upheld.** Deep ran it env-scrubbed: 26/26. Zero FOC-286-touched symbols in supervisor-cleanup.mjs (grep). FOC-167 guard behavior — environmental, not a defect of this diff. |
| 4 | Tree-state-unreadable e2e uses a corrupt index (stale lock tolerated by `git status --porcelain`) | **Upheld.** The test's comment records the measurement; fixture cleanup via `cleanupLater`. Coverage gap on the sibling unreadable branches → suggestion #2. |
| 5 | `supervisor-followup.mjs` resume path not audited — out of scope | **Confirmed.** The verbatim issue (Scope 1-4, AC 1-4) names only spawn/prologue/verification/tests. Deep found the live crash class there → suggestion #3 as a follow-up candidate. |

## Checks executed
- **Lead:** `git rev-parse --verify foc-286-dev` → b8f9f18…; `git diff --stat 674f8f4...foc-286-dev` → 4 files, +551/−5; run manifest tagged with FOC-286.
- **Deep:** `git archive b8f9f18` → scratch export under the review worktree (dev worktree untouched); `env -u LA_SUPERVISOR_CHILD node --test` ×5 → 14/0, 19/0, 26/0, 26/0, 21/0 — all match the DEV table; parseArgs probe (`--prompt-file` w/o value → `true`); caller grep (only the Supervisor frontman invokes spawn); cleanup/followup symbol grep.
- **Security:** semgrep 1.172.0 `--config auto` on both changed scripts → exit 0, 0 findings, 0 errors; npm audit N/A (no package.json/lockfile at repo root — scripts-only repo); added-lines secret-pattern grep → no matches; added-lines Linear/network grep → empty; deny-rule generation untouched; config/graph.json not in diff.
- **First-pass:** `git show --stat b8f9f18` → one scoped commit; test count via `grep -c "^test("` → 14; test-name→branch mapping (gap → suggestion #2); style comparison base↔head.

**Skipped/unavailable, stated explicitly:** Linear reads/writes (harness deny — issue served from the Supervisor packet; `ai:reviewed`/`dod-ok`/`stage:testing` labels and any Linear comment left to the Supervisor post-gate). No push performed (nothing to push; consent-gated anyway). first-pass/security did not execute suites (no-write posture on the dev worktree) — suite execution is deep-pass evidence, cross-checked against the DEV claims.

## Verdict
**VERDICT: PASS (approve).** All 4 ACs verified against the exact candidate with executed evidence; no `issue:`-grade findings. Findings 1-2 were weighed for issue-grade and ruled non-blocking (no AC undermined; lead judgment documented above); the Supervisor gate carries them for confirmation. Follow-up candidates out of scope: #3 (followup.mjs resume path), #11 (sourcing preAuthorized/knownQuirks), and the cleanup-suite env scrub noted in the DEV report.
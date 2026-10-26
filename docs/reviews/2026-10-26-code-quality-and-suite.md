# Code quality + test-suite review — 2026-10-26

Scope: `main` at `f1c0ad5` (local; `origin/main` is 7 commits ahead at `3160a7f`, PR #152).
Method: CodeGraph index (`.codegraph/codegraph.db`, 588 files, 14 445 symbols, 48 555 call edges)
queried directly; one full `node scripts/test-run.mjs` on the Windows host (2026-10-26 09:19);
`scripts/test-lanes.json`; the FOC-789 run log and the Linear FOC-789 comments for the VM record.

## 1. Code — what the graph says

Volume (JS only): 237 source files / 4.66 MB, 228 test files / 5.47 MB, UI 96 files / 0.93 MB.
Tests are **larger than the code they test** (105 590 vs 99 641 lines in `scripts/`).

| Metric | Value | Reading |
|---|---|---|
| import cycles among `scripts/*.mjs` (non-test), file level | **0** | clean layering; `utils.mjs` is documented as the bottom of the graph and really is |
| exported functions with a docstring | 859 / 1 122 (77 %) | good for a scripts tree |
| files > 1 000 lines (non-test) | 16 | `telemetry-store` 3 661, `supervisor-lib` 2 919, `telemetry-server` 2 898, `cockpit-routes` 2 057 |
| functions > 150 lines | 50 of 2 862 | the four giants are factories/routers: `createHost` 1 108, `createGraphRunner` 1 016, `handleCockpitRoute` 938, `createTaskSessionHost` 932 |
| files defining `main()` | 77 of 224 | `scripts/` is both the library and 77 CLIs; no `src/` vs `bin/` split |
| highest import fan-in | `supervisor-lib` 71, `fenix-paths` 69, `utils` 67, `telemetry-store` 61 | the real core; changes there need `codegraph_impact` |
| highest fan-out | `telemetry-server` imports 31 files | the API server is the integration point; it also owns the ingest sweep and Linear calls |
| exported functions no other file imports | 213 | over-exporting or dead; needs a pass (e.g. `graph-runner` step runners, `flow-db` query verbs, `delegation-outcomes` normalisers) |
| exported functions used only by tests | 359 | exported for testability — acceptable, but it is a third of the public surface |
| duplicated helper names across non-test files | `usage` ×20, `parseArgs` ×19, `printUsage` ×9, `sleep` ×8, `telemetryDbPath` ×6, `renderTable` ×6, `pct` ×6 | no shared `cli.mjs` / `format.mjs`; each script re-implements arg parsing and table output |
| lint | line-based only (`scripts/lint.mjs`: whitespace, tabs, debugger, JSON, conflict markers, BOM) | **no ESLint, no type check**; unused imports/vars are not caught |

Not measurable from the graph: the UI. Largest files there: `ToolProfiles.jsx` 999, `Manager.jsx` 972,
`SquadConfig.jsx` 857, `api.js` 810 — the same pattern (big screen components, one API module).

Verdict: the codebase is **consistent and well-commented, with a clean dependency graph**, but it has grown
by accretion into very large modules and a scripts tree without a library/CLI boundary. The risk is not
correctness (the suite is broad) but change cost: four factory functions of ~1 000 lines each are where
every Supervisor change lands.

Cheap, high-value fixes (in order):
1. Add ESLint with `no-unused-vars`, `no-undef`, `import/no-cycle` (flat config, zero style rules) — the
   first run will enumerate the real dead code behind the 213 candidates above.
2. Extract `scripts/lib/cli.mjs` (`parseArgs`/`usage`/`fail`) and `scripts/lib/format.mjs`
   (`renderTable`/`pct`/`usd`) — removes ~60 duplicate definitions mechanically.
3. Split `telemetry-server.mjs` route dispatch from ingest/sweep/Linear (it already delegates to
   `*-routes.mjs`; what remains is the sweep timer and the Linear GraphQL calls).
4. Decide the `main()` convention: `scripts/<name>.mjs` = CLI, `scripts/lib/<name>.mjs` = importable;
   today 77 files are both.

## 2. Test suite — why 18 minutes, and the 5-minute version

Run of 2026-10-26 on the Windows host: 210 files, 209 passed, wall **1 082 s (18 min)**; CPU sum 1 989 s.
The same suite in CI (Linux, in the image): the whole `linux` workflow including the image build takes
**5–7 min**; on the e2-standard-2 VM 8 min 35 s. Windows pays for process spawning: 95 of 210 test
files spawn child processes, and `supervisor-spawn.test` alone spawns 50 (21 through the mock `claude`).

The lanes decide the wall time, not the file count:

| Lane | Files | CPU sum | Effective wall |
|---|---|---|---|
| parallel (8 jobs) | 169 | 906 s | ~113 s |
| serial (1 job) | 41 | **1 083 s** | **1 083 s = the whole run** |

So the parallel lane is done after 2 minutes and the machine idles for 16 while the serial lane plods.
Ten files make 82 % of all CPU; the serial top ten are 850 s of the 1 083.

The serial justifications are **stale**. Nine of the twelve slowest serial files
(`supervisor-spawn/merge/semaphore/stop/followup/cleanup/pinned-state/gate/budget`) carry the reason
"supervisor-lib.mjs runDir is repo-anchored, no env redirect". `runDir` has honoured
`LA_SUPERVISOR_STATE_HOME` since 2026-09-28 (FOC-608, `scripts/utils.mjs:142`), 55 test files already
set it, and `supervisor-spawn.test` itself sets it in five places — yet it is still serial.
`cockpit-routes` / `work-routes` (135 s together) are serial for "ephemeral ports", which by definition
do not collide.

Plan (no test deleted, same assertions):
1. Point those nine files at a `mkdtemp` state home and move them to the parallel lane; run
   `node scripts/test-run.mjs --prove-isolation` (it exists for exactly this) to prove it.
   Expected serial lane: ~280 s; parallel lane at 8 jobs: ~215 s → **wall ≈ 5 min on Windows**.
2. Move the ten "ephemeral ports" serial files the same way after a prove-isolation run.
3. `--jobs` defaults to 8; this host has more cores — default to `os.availableParallelism()`.
4. PR-scoped runs locally: `node scripts/code-intel.mjs affected <changed files>` already lists the
   touched test files; wire it as `test-run.mjs --affected` so a normal edit runs ~10 files, not 210.
   Keep the full suite for CI and before a tag.
5. Only then look at the count: 28 files define their own `check()`, 54 their own `fail()`, 24 `eq()`,
   13 `tempDir()`, 13 `fixtureRun()`; 45 use `node:test`, 165 a home-made runner. A shared
   `scripts/test-lib.mjs` would cut lines, not minutes — minutes come from steps 1–4.

Correctness notes from this run: `settings-routes.test` "int keys GET present flags" is red on any dev
machine with a filled `.env` (the server under test loads the repo `.env`; `present` becomes true).
Same family as FOC-1049; worth a ticket. `security-scan.test` is documented load-sensitive.

### Applied the same day (steps 1–2 above, plus what they uncovered)

| | Before (09:19) | After (10:40) |
|---|---|---|
| lanes | 169 parallel / 41 serial | 196 parallel / 14 serial |
| serial lane CPU | 1 083 s (= the wall) | 62 s |
| parallel lane CPU | 906 s | 1 663 s (/8 jobs ≈ 208 s) |
| **wall, Windows host** | **1 082 s (18 min)** | **357 s (6 min)** |
| result | 209/210 (`settings-routes`, env leak) | 209/210 (`supervisor-followup`, see below) |

What changed: 27 files moved to the parallel lane — 14 `supervisor-*` suites (every one imports
`supervisor-test-fixtures.mjs`, which already redirects `LA_SUPERVISOR_STATE_HOME` to a per-process
mkdtemp home; their serial reasons predated that seam) and 13 ephemeral-port suites. The runner's static
audit now flags only `listen(<non-zero literal>)` and fixed-port constants: `createServer` / `net.connect`
over `listen(0, …)` cannot collide. `settings-routes.test` sets `LA_LINEAR_NO_ENV_FILE` for the server under
test and is green on a machine with a filled `.env`. Lane counts in `docs/supervisor-e2e-checklist.md`
updated; `docs-count-guard` and `test-run.test` green.

`--prove-isolation` (196 files at once) was **not** run to completion on this machine: it pegged 32 GB
of RAM and, see below, flooded the desktop. The proof here is two full runs at the real concurrency
(8 jobs) plus targeted reruns; run the all-at-once proof in the Linux container.

**Found on the way — console windows on Windows.** A process started with `windowsHide: true`
(CREATE_NO_WINDOW) or detached owns no console, so every console program it spawns without that flag
(git, getconf, taskkill, run-manifest, the mock claude) gets a new console, which Windows 11's default
terminal shows as a window and keeps open after exit. Console-less roots: the detached child watcher
(`supervisor-watch.mjs`), test servers from `test-spawn.mjs`, and any server started from a GUI tool. One
suite run left ~240 empty "Terminal" windows; ~300 spawn sites lack the flag. Fix: `scripts/spawn-windows-hide.mjs`
— a preload that defaults `windowsHide: true` for every `child_process` entry point on win32 (keeping
`util.promisify` shapes), imported by `test-run.mjs` and injected into every suite process via
`NODE_OPTIONS=--import`, and imported first by `supervisor-watch.mjs`. Measured: 0 new windows in the
final full run (1 in the run before the promisify fix). Residual: children reached through a non-Node
intermediate (`sh`, `cmd`) do not get the default.

The remaining red in the final run, `supervisor-followup.test` "a provider resolution failure on resume
refuses before any turn starts" (the followup launched with `ok:true` although `LA_PROVIDER=does-not-exist`),
is in the file HANDOFF §3.1 already names as load-flaky (FOC-1010), but it is a different case than the
one filed there. Green in the previous full run and green when rerun alone (68 s), so order/load-dependent;
it now runs in the parallel lane and will show more often — worth attaching to FOC-1010 with this
run's log.

Next for speed: the critical path is now the parallel lane's tail (`supervisor-spawn.test` 242 s,
`code-intel.test` 141 s). `--jobs` defaults to 8 on a 24-core host — raise the default to
`os.availableParallelism()` capped by memory, order the queue longest-first (a timing file next to
`test-lanes.json`), and split `supervisor-spawn.test` in two. An `--affected` mode on top of
`code-intel affected` is still the biggest win for day-to-day edits.

## 3. The VM record (FOC-789, `fenix-accept`, 2026-10-21 → 25)

Sources: `docs/releases/1.0.0/foc-789-run-log.md` (Day 1–3 on `origin/main`), Linear FOC-789 comments
(2026-10-20, 22, 25), `docs/STATE.md` 2026-10-22/23/25, `docs/HANDOFF.md`.

| Day | Image | What ran | Result |
|---|---|---|---|
| 1 (10-21) | rc.2 → rc.3 | `./fenix up` on a clean Debian 12 VM in ~5 min; FOC-963 and FOC-962 (small → Supervisor alone); FOC-958 (medium → DEV + TEST) | #133, #135 merged; FOC-958 DEV child killed by its own suite (FOC-979); 4 fixes shipped the same day (FOC-977/978/979/980) |
| 2 (10-22) | rc.4 | verify FOC-978/979/980; #139 review loop; cleanup | FOC-958 merged, Done, ≈ $2; **FOC-988** found (Supervisor patched `/opt/fenix` 4×), **FOC-1001** (git in child trees via `safe.directory`); cleanup blocked (FOC-1007) |
| 3 (10-25) | rc.5 | walk of HANDOFF §3.1 | FOC-990/1000/988 Done on the real install; FOC-1001/989/1007 verified in part; 3 new fixes in PR #152 (FOC-1047/1048/1049), snags S22–S30 |

Costs: FOC-963 $0.195, FOC-962 $0.092, FOC-958 ≈ $2 (crashed turn included). Operator interventions
per small ticket: 1–2 (working-state hold, push approval). Supervisor model on the VM: mimo-v2.6-pro.

What the record says about the product, beyond the ticket list:
- The pipeline works end to end for small and medium tickets, with a human at push/merge.
- The two serious findings were both the Supervisor **working around** tooling instead of stopping
  (self-patching the harness, `safe.directory`). rc.5 closes both with deny rules + a manifest check;
  Day 3 proved the denials with a live session.
- Auto mode's classifier is the recurring friction: it refused `supervisor-cleanup remove`, the verdict
  record when chained, CronCreate, background polls. The deterministic answer is exact-name MCP
  tools — the direction the repo already took (`fenix-linear`, `fenix-github`, `fenix-lifecycle`).
- Open for the gate: part 2 (two task sessions side by side, push from the dashboard), S1–S30 as
  backlog (AC2), FOC-790 dossier + tag. Three cleanup gates wait for a human answer on the next VM start.

No telemetry from the VM is on this machine — the data volume stays on `fenix-accept`; the run log,
STATE and Linear are the only local records.

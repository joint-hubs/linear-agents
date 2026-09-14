# CodeGraph wrapper — degraded-index evidence (FOC-114)

Observed behavior of `scripts/code-intel.mjs` and the CodeGraph CLI in the states where the
index is missing, unavailable or out of date. Everything below was **run and captured**, not
recalled: raw captures live in `evidence/raw/` (this directory), with SHA-256 hashes recorded in
`SHA256SUMS.txt` (verified per "Verifying the captures" below) and in the
run scratch under `.state/foc-114/` (gitignored) until integration.

- Worktree: branch `foc-114-dev`, base revision `5b691110fa61e6ab7c0dd97c006c028abbcfb82d`, tree clean before the run.
- Host: Windows 11, node v22.20.0.
- CLI resolution (measured, see "Version skew"): the wrapper's `spawnSync(..., { shell: true })`
  on win32 resolves `C:\Users\mateu\AppData\Local\codegraph\current\bin\codegraph.cmd` → **CLI 1.5.0**.
  The npm shim (`C:\Users\mateu\AppData\Roaming\npm\codegraph`) → **CLI 1.6.0**.

## Verifying the captures

`SHA256SUMS.txt` lists one SHA-256 row per **tracked** file in `evidence/raw/` (26 rows;
`raw/init.log` is deliberately absent — `*.log` is gitignored by repo rule and §2 points at the
run scratch for it). The hashes describe the **committed bytes**: `.gitattributes` pins this
directory to no EOL conversion (`docs/benchmark/evidence/** -text`), so a fresh checkout
reproduces them byte-for-byte on every platform. Quoted evidence must not be
line-ending-normalized, and a hash taken from a working copy would not survive
`core.autocrlf` — which is exactly how this list's first version failed to verify.

Check, from this directory (`docs/benchmark/evidence/`):

```bash
sha256sum -c SHA256SUMS.txt
```

A pass is `: OK` on all 26 rows and exit code 0. Any `FAILED` row means the capture on disk no
longer matches what was recorded — re-capture the observation, never edit the hash.

## 1. Missing index — every verb, before `codegraph init` (order-matters evidence)

All nine wrapper verbs were run against the worktree **before any `.codegraph/` existed**:

`explore | symbol | impact | callers | callees | find | files | affected | status`

All nine captures are committed: `raw/evidence-<verb>.out` + `raw/evidence-<verb>.err`
(stdout empty and stderr byte-identical across the verbs — the hashes in `SHA256SUMS.txt`
make that checkable).

| observed on every verb | value |
|---|---|
| exit code | **3** |
| stdout | empty (`e3b0c442…` — the empty-file hash) |
| stderr | one message, byte-identical across all nine verbs (`ea08d157…`) |
| queried symbol named anywhere in output | **no** — no absence claim about the symbol |

The refusal, verbatim (`raw/evidence-explore.err`):

```
[code-intel] No CodeGraph index in this repo (.codegraph/ is missing).

Nothing here can answer until it exists. Build it:  codegraph init
A negative result from this tool right now would be a lie, so it refuses instead.
```

Supplementary rows (same session): `--help` → exit 0; retired verbs `cycles`, `path`, `raw` →
exit 2, each refused **by name**; unknown verb → exit 2 with usage. Commands:

```bash
node scripts/code-intel.mjs <verb> [args]   # per verb; exit code + stdout/stderr captured
node scripts/code-intel.mjs --help          # exit 0
node scripts/code-intel.mjs cycles          # exit 2
node scripts/code-intel.mjs bogus           # exit 2
```

## 2. Index build record

`codegraph init -y .` in the worktree: **exit 0, 7056 ms wall** (internal parse reported 3.7 s),
191 files → 4086 nodes / 16530 edges. Full log: kept in the run scratch (`.state/foc-114/init.log`
in the execution worktree — `*.log` is gitignored by repo rule, so the raw log is not checked in);
the figures above are the complete content that matters. `status --json` after init:
`builtWithVersion: "1.6.0"`, `builtWithExtractionVersion: 25`, `currentExtractionVersion: 24`,
`reindexRecommended: false`.

## 3. Version skew (machine-level, affects the wrapper)

`cmd /c where codegraph` returns the AppData-Local install **before** the npm shim, so on win32
the wrapper deterministically talks to **1.5.0** while an interactive bash `codegraph` is
**1.6.0**. `status --json` reports `version: "1.5.0"` for the binary it runs. The benchmark
measures the wrapper path as squads actually run it and records both versions.

## 4. `codegraph` not on PATH — defect found, then fixed

Pre-fix, with `PATH` stripped (`env PATH="C:\Windows\System32" node scripts/code-intel.mjs symbol X`):

- **observed exit 1** (`raw/nopath-wrapper.err`): cmd's localized
  `'codegraph' is not recognized as an internal or external command` — the wrapper's ENOENT
  branch (exit 3) is dead code on win32, because `shell: true` means cmd.exe itself spawns fine
  and reports the failure as a plain non-zero status with `res.error == null`.
- Contract said exit 3 with UNKNOWN semantics; observed exit 1 with a raw shell error.
- **Fixed** in `scripts/code-intel.mjs`: on win32, a failing spawn with no `res.error` is
  disambiguated via a shell-free `where codegraph` (locale-independent exit code); still missing →
  the same `notOnPath()` refusal, exit 3. Post-fix re-run: **exit 3**, refusal printed, no symbol
  name in output.

## 5. Pending file (on disk, absent from a controlled fixture index)

Temp fixture (os.tmpdir, own `git init`, three small `.mjs` files, real `codegraph init -y`),
then a new file added on disk and **not** synced; queries after a 4 s settle, via the wrapper:

| probe | observed (CLI 1.5.0) | exit |
|---|---|---|
| `find foc114ProbePending` | `ℹ No results found for "foc114ProbePending"` | **0** |
| `symbol foc114ProbePending` | `Symbol "foc114ProbePending" not found in the codebase` | **0** |
| `status --json` | `pendingChanges: {"added":1,"modified":0,"removed":0}` | 0 |

Cross-check with the 1.6.0 binary directly (`codegraph node foc114ProbePending --path <fixture>`):
same confident `not found`, exit 0. Raw captures: `raw/pending-symbol.out`, `raw/pending-find.out`,
`raw/pending-status-json.out`. **Finding:** the query verbs report confident absence for a
pending symbol at both CLI versions; the only machine-readable UNKNOWN signal is
`status --json → pendingChanges`. `codegraph sync` takes a positional path (rejects `--path`).

## 6. Stale edit (indexed file modified, index not synced)

Same fixture; `src/lib.mjs` rewritten so the queried symbol moves from line 1 to line 5; query
after a 4 s settle:

- `symbol foc114ProbeTarget` still cites the **stale** location (`src/lib.mjs:1`) while the
  snippet it prints is re-read from current disk — an internally inconsistent answer;
- **no staleness banner, no `⚠️` marker, exit 0**;
- `status --json` → `pendingChanges.modified: 1` (the deterministic signal).

Raw captures: `raw/stale-symbol.out` (the inconsistent answer in one output: stale location,
fresh snippet), `raw/stale-status-json.out`.

One-shot CLI invocations do not auto-reconcile and do not flag staleness; the "watcher keeps the
index in sync" behavior belongs to a connected MCP server, not to CLI queries. Encoded as
tripwire tests in `scripts/code-intel.test.mjs`: if a future CLI starts auto-syncing or flagging,
those tests fail by design and must be updated to assert the new (better) behavior.

## What this evidence does not cover

- MCP-server behavior (watcher, debounce, `⚠️` banner) — measured here only via the CLI path.
- CLI versions other than the two installed on this machine (1.5.0 wrapper path, 1.6.0 direct).
- Whether `pendingChanges` is cleared by anything other than `codegraph sync` / a re-index.

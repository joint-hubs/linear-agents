# FOC-780 — retention: keep everything by default, one configurable limit, disk usage visible

Owner: delivery owner (orchestrator), 2026-10-15. Branch `foc-780-retention`, cut from `main` at #71. Parent FOC-768 (M8). Decision 2026-10-11: logs are training data — never deleted by default; `cleanupPeriodDays: 36500` is the immediate stop in every `agents/*/settings.json`.

## Facts (recon 2026-10-15)

- `scripts/fenix-retention.mjs` (FOC-786, read-only): `readRetention()` reads each squad's `cleanupPeriodDays`, classifies the policy (keep-all ≥ 3650 days, days, mixed, unknown), sums bytes of transcripts, telemetry, workspaces and state trees, reports free disk via `statfs`; `cachedRetention` has a 60 s TTL. No CLI, no writer, no deletion. 11 tests.
- `cleanupPeriodDays` is read only there; nothing writes it. The only deliberate prune in the repo is `supervisor-cleanup.mjs prune` (test artifacts, explicit CLI, KEEP 20 runs ∧ 14 days, `--dry-run`).
- `fenix doctor` already has a disk check (`fenix-doctor.mjs:119-138`): fail below 1 GiB, warn below 5 GiB, thresholds hardcoded, no usage breakdown.
- Dashboard Settings → Retention (`ui/src/components/settings/RetentionPanel.jsx`, `GET /api/settings/retention`) is read-only by design ("managed by FOC-780").
- The `fenix` launcher has a key wizard only (`fenix up` asks for keys when missing); no retention step.
- Docker: everything lives on the `fenix-data:/data` volume (`LA_SQUAD_HOME=/data/agents`, state, telemetry); natively `LA_SQUAD_HOME` defaults to `<repo>/agents`, so a written `cleanupPeriodDays` dirties tracked files there — documented, not avoided (Claude Code reads the limit from exactly those files).

## Design

1. **Settings key** `retention` in the overlay (`.fenix/config/settings.json`, via `fenix-settings.mjs`): `{ "keepDays": null | integer 1..36500, "minFreeGiB": number ≥ 0.5 (default 5) }`. `keepDays: null` (or absent) means keep everything — the default. Validation joins the whitelist next to `provider`/`routing`.
2. **Apply path** in `fenix-retention.mjs`: `resolveRetention(settings)` → `{ keepDays, cleanupPeriodDays: keepDays ?? 36500, minFreeGiB }`; `applyRetention({ dryRun })` writes `cleanupPeriodDays` into every squad `settings.json` under `LA_SQUAD_HOME` only where the value differs (atomic JSON write, 2-space, the files' own key order kept), and returns what changed. `pruneRuns({ keepDays, dryRun })` removes Fenix's own run logs older than `keepDays` — run directories under `runsDir()` and supervisor run directories (tees included) whose newest mtime is older than the limit — never when `keepDays` is null, never a run with a live child (registry check, same helper the cleanup uses), always with a per-run report `{ runId, bytes, newestAt }`. Telemetry rows are not touched (the store has its own lifecycle; noted as out of scope).
3. **CLI** `node scripts/fenix-retention.mjs show|apply [--dry-run]|prune [--dry-run]` (JSON out, exit 1 on a refused prune: `keepDays` null → "nothing to prune: retention keeps everything"). `fenix retention [show|apply|prune]` in the launcher forwards to it.
4. **Doctor**: thresholds come from `resolveRetention` (`minFreeGiB` warn, 1 GiB fail stays the floor); one extra OK line prints the usage breakdown (`transcripts X · telemetry Y · workspaces Z · state W, free F`) from `readRetention` so the number is visible without the dashboard.
5. **Settings route** `PUT /api/settings/retention` `{ keepDays, minFreeGiB }` → validate, `writeSettings`, `applyRetention()` (the `cleanupPeriodDays` write, never a prune), respond with the fresh `readRetention()` plus `prunable` = `pruneRuns({ dryRun: true })` totals so the UI can show "N runs · X MB older than the limit — run `fenix retention prune`". Same 127.0.0.1 / actor rules as the other settings writes (FOC-786).
6. **UI** RetentionPanel: the read-only note goes; a form with "Keep everything (default)" toggle, days input, min-free-GiB input, Save; after save the panel shows the applied policy and the prunable estimate with the CLI hint. Browser check on an acceptance stack before the PR (ui tests do not render components).
7. **Wizard**: `fenix up` first run (where the key wizard runs) asks once: "Keep all logs and transcripts? [Y/n]" → on `n` asks for days and writes the overlay through `fenix-settings.mjs set retention …`; skipped when the overlay already has the key.
8. Docs: `docs/plans/foc-780-retention.md` (this), the settings-keys plan gets a pointer, `docs/supervisor-e2e-checklist.md` test-file count if a test file is added, README quick-start one line under Settings.

## Acceptance (ticket)

1. A default install never deletes transcripts: with no overlay key `pruneRuns` refuses and `cleanupPeriodDays` stays 36500 — test. A configured `keepDays` is written to every squad `settings.json` and prunes only older runs, skipping live ones — tests with a temp squad home and temp runs.
2. `fenix doctor` warns below `minFreeGiB` (configurable) and prints the usage line — test via the injected fs seam.
3. PUT route validates, writes, applies, returns the estimate — route tests; UI renders the form and the estimate — browser check.

## Out of scope

Telemetry store retention, exporting data for training, deleting transcripts inside Claude Code's own cleanup (that is `cleanupPeriodDays`'s job), per-squad limits.

# Delivery Plan — FOC-809 Fenix sizing: a dev-squad run on the VM, p20/p50/p80 per phase

Linear: **FOC-809** (M8 Fenix 1.0.0, parent FOC-768, Medium, due 11-12; depends on FOC-807 — Done). Written
2026-10-19 by the delivery owner under the 2026-10-15 autonomy rule; VM work authorised by Mateusz the same day
(cost-aware). Test bed: `fenix-vm`, e2-standard-2 (2 vCPU / 8 GB / 100 GB pd-balanced), `main` after FOC-808.

## 0. What is known and what is a guess

The 2026-10-12 measurement (QUICKSTART "Fenix on a VM") covers idle and one **test**-squad child on an
e2-standard-4: ~1 % CPU / ~1.2 GB idle, ~1.5 vCPU and 2–3 GB above idle for the child, 9.7 GB disk after one
ticket. The **dev** squad (builds, full test suites, toolchains) was never measured, so "2 vCPU / 8 GB / 50 GB"
is a guess, and the e2-standard-2 resize of 2026-10-19 is exactly the question this ticket answers.

## 1. Contracts

### A — the sampler (host side, `tools/vm-sampler/`)
- `sample.sh`: one JSON line per minute to `~/fenix-sampler/samples.jsonl` — `ts`, `load1/5`, host memory
  (`free -m`: used, available, buff/cache), per-container CPU % and memory (`docker stats --no-stream`), the
  number of `claude` processes and the top 3 RSS processes inside `fenix-supervisor`
  (`docker compose exec -T fenix-supervisor ps -eo rss,comm --sort=-rss`), disk used under `/var/lib/docker` and
  the `fenix-data` / `fenix-cache` volumes (`docker system df -v` every 10th sample). Started with
  `nohup sample.sh &` (pid file), stopped with `sample.sh stop`; removed with the directory at the end (AC1).
- `report.mjs`: reads the JSONL plus the phase sources and prints the bands — **phase per sample** from the
  Supervisor registry (`/data/state/supervisor/<run>/children.json`: a live child's `squad` and its turn
  `startedAt`/`endedAt`), the telemetry store (`canonical_usage` rows of the Supervisor's own run = a
  Supervisor turn), and the `fenix update` timestamps (image build). Phases: `idle`, `supervisor-turn`,
  `dev-child`, `test-child`, `plan/review-child`, `image-build`; per phase and metric: n, p20 / p50 / p80, peak
  (Mateusz's band convention). Output as a Markdown table ready for the ticket and QUICKSTART.

### B — the load (≥ 3 real tickets, one of them dev)
- The VM Supervisor (GLM flash, `fenix attach`) takes three small FOC tickets from this repo's backlog — the
  candidates are FOC-914 (Team group filters, Low), FOC-915 (Insights precompute, Low) and one bug-sized
  ticket — so at least one dev-squad child runs the real toolchain (npm ci, vite build, the test lanes). Fallback
  when the Supervisor cannot be steered to a ticket: `node scripts/squad-start.mjs dev <ticket>` inside
  `fenix-supervisor`.
- Every resulting PR is reviewed and merged (or closed) by the delivery owner like any other; model costs are
  GLM flash only and are reported with the VM hours.
- `./fenix update` once during the window gives the image-build phase.

### C — the write-up
- QUICKSTART "Fenix on a VM" sizing table: **minimum** and **recommended** machine with the evidence date and
  the bands behind them (AC2); the 2026-10-12 numbers stay as the earlier data point.
- A downsizing recommendation for `fenix-vm`: keep e2-standard-2, or smaller, with the p80 and peak that decide
  it (memory headroom for a dev child + the image build is the binding constraint, not CPU).
- FOC-809 comment: the table, the ticket list, the hours and the model spend.

## 2. Slices

| Slice | Files / where |
|---|---|
| A sampler | `tools/vm-sampler/sample.sh`, `tools/vm-sampler/report.mjs` (+ a unit test on a 20-line fixture of samples and a fixture registry), README lines in `docs/QUICKSTART.md` |
| B load | VM only: start the sampler, run the tickets, `./fenix update`, stop and remove the sampler; copy `samples.jsonl` + the registry snapshot to the scratchpad |
| C write-up | `docs/QUICKSTART.md`, the Linear comment, `docs/plans/foc-809-vm-sizing.md` (this file, updated with the result) |

## 3. Verification

- `report.mjs` on the fixture reproduces hand-computed p20/p50/p80 (test); on the real samples the phase
  coverage is printed (samples per phase — a phase with n < 10 is marked as thin evidence).
- Sampler removal proven by `ls ~/fenix-sampler` → gone and `pgrep -f sample.sh` → nothing (in the comment).
- Costs: VM hours from `gcloud compute operations list` (start/stop) and the model spend from the telemetry
  Money panel for the window.

## 4. Out of scope

cgroup accounting per child (FOC-808 gives the mark; a per-child cgroup is a later ticket); autoscaling; any
machine type change beyond the recommendation (Mateusz decides; the VM is resized only while stopped).

## 5. Results (2026-10-19, final)

Load run on `fenix-vm` (e2-standard-2, main b8f195c), sampler every 60 s from 12:40Z to 17:47Z, 296 samples, four tickets (FOC-680 dev-squad child; FOC-523, FOC-915, FOC-914 worked by the Supervisor itself), one no-cache image build:

| phase | metric | n | p20 | p50 | p80 | peak |
|---|---|---|---|---|---|---|
| dev-child | load1 | 44 | 0.2 | 0.9 | 1.4 | 1.8 |
| dev-child | mem_used_mb | 44 | 1281.6 | 1323.5 | 1407.6 | 5916.0 |
| dev-child | supervisor_cpu_pct | 44 | 2.3 | 17.3 | 53.7 | 116.5 |
| dev-child | supervisor_mem_mb | 44 | 602.4 | 807.4 | 876.2 | 940.0 |
| idle | load1 | 172 | 0.0 | 0.1 | 0.2 | 3.3 |
| idle | mem_used_mb | 172 | 1062.2 | 1135.0 | 1207.6 | 3494.0 |
| idle | supervisor_cpu_pct | 172 | 0.2 | 1.4 | 3.6 | 4.9 |
| idle | supervisor_mem_mb | 172 | 535.9 | 683.9 | 743.6 | 839.2 |
| image-build | load1 | 4 | 0.9 | 1.8 | 2.4 | 2.4 |
| image-build | mem_used_mb | 4 | 1169.6 | 1226.5 | 1351.8 | 1485.0 |
| supervisor-active | load1 | 76 | 0.1 | 0.2 | 1.8 | 13.3 |
| supervisor-active | mem_used_mb | 76 | 1154.0 | 1220.5 | 1297.0 | 1737.0 |
| supervisor-active | supervisor_cpu_pct | 76 | 6.5 | 28.1 | 157.8 | 198.0 |
| supervisor-active | supervisor_mem_mb | 76 | 591.0 | 764.8 | 832.6 | 1319.9 |

What ran: the Supervisor resumed its crashed `dev-2` on FOC-680 (the dev-child phase, 52 min, pinned to
`xiaomi/mimo-v2.6-pro` by the pre-FOC-808 registry entry), then stalled on a Claude Code auto-mode classifier
prompt for `linear-ops transition FOC-680` (FOC-918); a fresh session (GLM flash) took FOC-523 itself without
delegating (the supervisor-active phase) and stalled on its own `Bash(rm -rf:*)` ask rule over a `/tmp` fixture
(FOC-918). The `--no-cache` image build ran between marks (13:45:54–13:50:08Z). A stray `pgserver` Postgres from
the resumed child survived its turn (FOC-917: the follow-up path sets no mark).

AC1 closed: four tickets incl. one dev-squad run; the Supervisor worked the other three itself (GLM flash) and each
produced a commit (FOC-523 → PR #111, FOC-915 → PR #112, FOC-914 → PR pending); the sampler was stopped and
purged from the VM at 17:47Z and the VM stopped at 17:48Z (7 h 38 min today, ≈ $0.51 of e2-standard-2). Two
stalls needed a human at the tmux pane (FOC-918); the resumed child left a stray Postgres (FOC-917, fixed).
Downsizing: `fenix-vm` stays e2-standard-2 — it fits one worker at a time; the Supervisor's own test runs
saturate both cores but finish.

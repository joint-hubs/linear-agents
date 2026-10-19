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

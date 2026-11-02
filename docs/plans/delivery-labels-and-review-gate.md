# Delivery labels and a REVIEW gate that holds — plan (2026-11-02)

Status: accepted by Mateusz on 2026-11-02 ("Etykiety + mocniejszy REVIEW"). Parent epic: FOC-1070
(measure before learn). Tickets: FOC-1169 (labels), FOC-1170 (REVIEW evidence as code), FOC-1171
(stronger REVIEW model, measured), FOC-1179 (the role set).

## Why

Numbers from the delivery session of 2026-11-01/02 (33 merges to main):

- Of the last ~11 results the Supervisor reported READY TO PUSH, delivery rejected about half
  (FOC-1147 twice, FOC-1156, FOC-1151, FOC-1088, FOC-1162, FOC-1155). Every one of them carried a
  REVIEW `pass` from a `glm-5.3-flash` child first. Three of those passes accepted evidence that
  could not have come out differently (a dry-run that skipped every input; a test with a hand-set
  `created: true`; a Linux liveness probe that returned "dead" because PowerShell was missing).
- A rejection costs one Supervisor fix-round turn (12–13 M cached tokens, 120–140 internal steps)
  plus delivery time. A REVIEW child costs $0.02–0.39. The asymmetry is at least 10×.
- Nothing records the rejection. `cost-quality.mjs` defines `firstTimeRight` as "round-1 REVIEW
  verdict PASS", which is exactly the signal that is wrong. The rewards ledger has no database on
  disk and nothing consumes it. The lessons ("read the evidence script, not its output", "check a
  config rule against the real config files") live only in the delivery owner's turn messages.

Without labels there is no signal to learn from, so this plan comes before any Harness² /
self-improvement work (FOC-944–946, FOC-967).

## What changes

### 1. Delivery verdicts as labels (FOC-1169)

`supervisor-verdict.mjs record` gains a delivery mode that needs no child:

```
node scripts/supervisor-verdict.mjs record --delivery --run <runId> --task FOC-n \
  --verdict pass|fail --reason <design|evidence|test-gap|ci|scope|other> \
  [--finding '<json>' ...] [--work-child <id>] [--recorded-at <iso> --backfill]
```

- The record has the normal shape plus `squad: "delivery"`, `childId: null`, `recordedBy:
  "delivery"`, `reason`. It fingerprints the work child's tree through the existing
  `resolveWorkChild` path (the dev child of that task in the run; `--work-child` when ambiguous).
- It lands in the task's round chain (`roundsFor`), so the FOC-1146 progress guard sees a delivery
  fail after a REVIEW pass as a new opinion on the same tree, which is what it is.
- `--recorded-at` is accepted only together with `--backfill`, and the record carries
  `backfill: true`. This is how the 2026-11-01/02 baseline gets written from the delivery owner's
  notes.
- `cost-quality.mjs` keeps the existing signal, renamed in its definition text to "review
  first-time-right", and adds:
  - `deliveryFirstTimeRight` — tickets whose first delivery verdict is `pass`, among tickets with any
    delivery verdict;
  - `reviewFalsePass` — REVIEW `pass` rounds followed by a delivery `fail` on the same fingerprint,
    among REVIEW `pass` rounds that have a later delivery verdict;
  - `ciRedAfterReady` — delivery fails with `reason: ci`, among tickets with any delivery verdict.
  Each one carries numerator, denominator and evidence task ids like the existing signals, and
  returns `null` when the denominator is 0. The work board panel shows them next to the old one.

### 2. REVIEW evidence as code (FOC-1170)

- A REVIEW `pass` must cite at least one command the reviewer ran itself:
  `--ran '{"cmd": "...", "exit": 0, "outputRef": "<path under the run's scratch>"}'`. The tool
  checks that `outputRef` exists and is non-empty and refuses a pass without one
  (`review-pass-without-evidence-run`).
- When the DEV journal cites a script or a test as evidence, REVIEW runs it and cites it. The rule
  goes into `agents/review/CLAUDE.md` and `agents/review/agents/first-pass.md`, pinned by a text
  test the way FOC-1166 pinned the deny rule.
- A red-first claim is recorded as `--red-first '{"cmd": "...", "baseExit": 1, "candidateExit": 0,
  "outputRef": "..."}'`; the shape is validated, and `baseExit === candidateExit` is refused.

### 3. A stronger model on the final REVIEW, measured (FOC-1171)

- The settings overlay sets `routing.review.lead = xiaomi/mimo-v2.6-pro` (local host now; the VM
  overlay when Mateusz next does UAT). DEV and TEST stay on `glm-5.3-flash`. The Supervisor stops
  passing `--model` for REVIEW spawns so the overlay decides.
- Cost expectation: a REVIEW child moves from $0.02–0.39 to roughly $0.3–4; one avoided fix round
  pays for several of them.
- Decision rule, written before the data: after 15 tickets or two weeks, whichever is later,
  compare `reviewFalsePass` with the backfilled baseline. If it did not drop by at least a third,
  the model goes back to flash and the next lever is a second REVIEW pass, not a third model.

### 4. The role set, for quality (FOC-1179)

Mateusz asked (2026-11-02) whether the roles in `config/graph.json` can be optimised from what
delivery observed. Quality first; cost is a later pass.

- REVIEW's three concurrent passes (`first-pass`, `security`, `deep`) produced one shallow
  opinion three times. They become one strong pass by the review lead, which reads and re-runs
  the evidence (FOC-1170); the security pass becomes a deterministic step (`security-scan`,
  egress screen) cited in the verdict.
- TEST re-ran REVIEW's runs on win32 only; both Linux-only CI reds of the session (FOC-1151,
  FOC-1162) were invisible to it. TEST runs the touched suites inside the Fenix image, as CI does,
  and says so in the verdict (`containerRun`).
- DEV fan-out into subagents split one change across contexts and caused the FOC-1166 incidents.
  Subagents read; the lead writes.
- The graph's round limit (two dev↔review cycles, then escalate) stays, and delivery verdicts
  count as rounds.

## What this does not do

- No training, no automatic prompt edits. The labels are the input the later reflector
  (FOC-946) will need; that work stays gated on a human-approved PR per rule change.
- No change to `agents/*/settings.json`.

## Order

FOC-1169 first (the labels and the backfill give the baseline), FOC-1170 in parallel (disjoint
files apart from `supervisor-verdict.mjs`, so sequential on that file), FOC-1171 is a config change
plus the decision rule and starts as soon as the overlay is set.

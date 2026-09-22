# Decision I/O log — record shapes, joins, export, retention (FOC-449)

The shadow log of registry-backed decision calls and their ACTUAL outcomes. One
JSONL file per supervisor run: `.state/runs/<LA_RUN_ID>/decisions.jsonl`
(`SHADOW_FILENAME`, written by `scripts/decision-call.mjs`; labels and exports
by `scripts/decision-log.mjs`). Two line types share the file:

- `{type:"event"}` — one per registry-backed decision call (everything with a
  `decisionId`, served success AND failure). Identity, the scrubbed input AS
  SENT, the typed output, usage/cost facts, taskKey.
- `{type:"label"}` — one recorded outcome per event: what actually happened.

Lines written before FOC-449 ("legacy", no `type`) are decision records
without an `eventId`. They still parse — nothing downstream crashes on them —
but they cannot carry a label and the export skips them.

Writes are best-effort by contract: a shadow failure is swallowed (a broken
log must never break a decision call), while a failed auto-join label is a
stderr warning, never a broken gate/verdict/merge.

## Event record (one decision call)

Written by `decision-call.mjs` for every call that carries a `decisionId`
(inline calls — no registry — keep the pre-FOC-449 shape byte-identical, no
`type`/`eventId`/`input`/`scrub`/`taskKey`/`durationMs`):

| field | meaning |
| --- | --- |
| `decisionId` | registry id this call served (`gate.screen`, …) |
| `criteriaVersion` | only where the registry entry actually resolved |
| `type` | `"event"` |
| `eventId` | stable random UUID (node:crypto `randomUUID`) — the join key |
| `input` | `{state, questions}` AS SENT, scrubbed (see below); `null` when the call failed pre-provider (nothing was sent) |
| `scrub` | `{variant:"mask-only", redacted, note}` — null together with `input` |
| `taskKey` | caller's `createDecisionCaller` option, else `LA_TASK_ID` from env, else `null` — recorded honestly, never guessed |
| `durationMs` | call wall time, from the envelope |
| `pinnedModel`, `model`, `tier`, `mode` | routing facts; `model` is `null` on failure envelopes (never invented) |
| `ok`, `answers`, `confidence`, `formatConfidence`, `responseId`, `error` | typed output, unchanged since FOC-397/448 |
| `usage` | `{inputTokens, outputTokens, cost}` exactly as the provider (OpenRouter) reported it, `null` when absent — no pricing math is applied anywhere |
| `ts`, `runId`, `hash` | wall time, owning run, pinned-model hash |

Existing fields and `inputsHash` semantics are untouched; the FOC-449 keys are
additive.

## Scrub routing (E1b)

`scripts/mcp/scrub.mjs` gained `scrubMask()` — the masking half of `scrub()`
(same key patterns: `Authorization`/Bearer/Basic headers, tokenized params
`access_token`/`api_key`/`token`/…, `sk-`-shaped keys, any 32+ char
`[A-Za-z0-9_-]` run) **without** the 120-char error-text cap. `scrub()` keeps
its exact old behaviour (mask, then truncate); every pre-existing caller is
byte-identical.

The full `state`/`questions` of an event route through `scrubMask`, so the
stored input is untruncated and secret-shaped material is replaced with
`[REDACTED]`. `questions` is stored as the serialized JSON actually sent.
If serialization itself fails, the whole input is `[REDACTED]` and the scrub
note says so (`redacted: true`). Raw secret-shaped material must never land in
`.state/` — the note documents the variant so a reader knows which patterns
were applied and that no cap ran.

## Label record + CLI (E2)

```json
{"type":"label","eventId":"…","outcome":"…","by":"human|agent","source":"manual|auto","via":"gate|verdict|merge","ts":"…"}
```

`via` appears only on auto labels. The outcome is NEVER derived from the
event's own answers — it is an explicit argument, or the gate/verdict/merge
result whose caller named the event.

```bash
node scripts/decision-log.mjs label --event <eventId> --outcome <value> --by human|agent [--run <runId>]
node scripts/decision-log.mjs export --decision <decisionId> [--out <path>]
```

`label` writes into the run file HOLDING the event — directly with `--run`,
otherwise by a newest-first scan of `.state/runs/*/decisions.jsonl`. Unknown
event, missing outcome, or a bad `--by` exits non-zero and writes nothing.

## Auto-joins (E3)

Gate emit, verdict record and merge accept repeatable provenance flags:

```bash
... --decision-event <eventId> ... [--decision-run <runId> ...]
```

One run id covers every event; N runs pair positionally and must match the
event count (mismatch is refused before any state is written). The pairing
rides the gate/verdict/merge record as `decisionEvents` — the key exists only
when provenance was given, so records without it stay byte-identical.

| join | outcome | by | via |
| --- | --- | --- | --- |
| gate answer (`supervisor-gate.mjs answer`) | the answer text, verbatim | `human` | `gate` |
| verdict record (`supervisor-verdict.mjs record`) | `pass` / `fail` | `agent` | `verdict` |
| merge report (`supervisor-merge.mjs`) | `merged` / `not-merged` | `agent` | `merge` |

Rules: no provenance ⇒ nothing labelled, nothing warned; a failed label (e.g.
unknown event) ⇒ warning on stderr (`[gate]`/`[merge]`) or in the verdict's
warnings trail, and the primary flow (gate record, verdict file, merge report)
lands anyway. No join ever labels with the decision's own answers.

## Export & splits (E4)

```bash
node scripts/decision-log.mjs export --decision <decisionId> [--out <path>]
```

One record per event of that decisionId, joined with its labels:

```
{splitVersion, split, eventId, decisionId, ts, taskKey, runId,
 input, output:{ok, answers, confidence, formatConfidence, model,
 pinnedModel, tier, mode, usage, responseId, error}, labels:[…]}
```

Split policy, deterministic and stable:

- seed: `sha256("<eventId>|<decisionId>")`, first 8 hex chars, `mod 1000`;
- bucket < 800 → `train`, < 900 → `val`, else `test`;
- `splitVersion: 1` — changing the seed, the thresholds or the record shape
  is a NEW splitVersion, never a silent reshuffle;
- same log content ⇒ byte-identical output: run logs are scanned
  name-ascending (the newest-first mtime order is reserved for label lookup),
  and each record's key order is fixed by the literal in
  `exportDecisionEvents`.

Legacy lines (no `type`, no `eventId`) parse but are skipped. An unknown
decisionId exports as empty, successful JSONL.

## Retention policy & size budget

- `.state/` is gitignored — the raw log is LOCAL working data, not a backup
  and not something to commit. The durable copy is the export file, which the
  operator stores consciously (it still contains decision inputs, scrubbed).
- Soft budget: keep the total of `.state/runs/*/decisions.jsonl` under
  ~100 MB. A full scrubbed event is typically a few KB; ten runs of pilot
  traffic stay orders of magnitude below this — the budget exists so the
  cleanup decision has a number, not a vibe.
- Compaction: export the run's decisions first (`export --decision` per
  decisionId), then delete that run's `decisions.jsonl`. Never delete a log
  that still holds unlabelled events you intend to label, and never delete
  anything but your own run's file — run dirs belong to their runs.
- Scrubbed does NOT mean harmless: treat exported files as internal data.
  Nothing from `.state/` is ever committed; `git status` should always be
  clean of it.

## AC5 — provider training/retention terms (recorded 2026-09-22)

Conclusion first: **the decision log must NOT be used for model training
until the OpenRouter account-side settings are confirmed** — recorded as
*not verified — must be checked before any training use*. No training happens
in this task; this record exists so the later one starts from evidence, not
memory.

- **TypeSafe (direct provider) — VERIFIED.** https://typesafe.ai/privacy
  (last updated Nov 19, 2025): "We will not train or fine tune any artificial
  intelligence or machine learning models on your prompts or other Input."
  and "(2) will not disclose any Input to a third party other than our
  service providers." No prompt-specific retention period is published.
- **OpenRouter (router, default path for this seam) — PARTIALLY VERIFIED.**
  https://openrouter.ai/docs/features/privacy-and-logging: "Wherever
  possible, OpenRouter works with providers to ensure that prompts will not
  be trained on, but there are exceptions." / "If you opt out of training in
  your account settings, OpenRouter will not route to providers that train."
  — but that opt-out "has no bearing on OpenRouter's own policies and what we
  do with your prompts." Paid and free endpoints have separate settings.
  Before ANY training use: check the account-side training/logging settings
  and re-read that page; the quotes above are a snapshot, not a contract.

## Verify

```bash
node scripts/decision-call.test.mjs     # event record shape, scrub routing
node scripts/decision-log.test.mjs      # label CLI, auto-joins, export/splits
node scripts/supervisor-gate.test.mjs && node scripts/supervisor-verdict.test.mjs && node scripts/supervisor-merge.test.mjs
node scripts/docs-count-guard.test.mjs
node scripts/lint.mjs
```
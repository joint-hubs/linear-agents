---
name: codegraph-expert
description: >
  Deeper guidance for CodeGraph work in this repo: query craft when the graph answers
  "not found" or UNKNOWN, the fallback ladder, and how to read a codegraph-eval-harness
  report (byTool / byOutcome / queries) without re-grading it. Referenced by squad role
  files (dev, review, test, plan) as the follow-up when the graph alone did not answer.
trigger: on demand — no slash command; squad role files name it when the graph returns not-found / UNKNOWN or when a codegraph eval report needs reading
---

# codegraph-expert

Advice for getting value out of CodeGraph — and for reading, honestly, what
the eval harness says about how CodeGraph queries actually went.

## When to reach for this

- The graph returned "not found", refused an unindexed project, or flagged its
  own freshness as UNKNOWN. A "not found" from the graph is never proof of
  absence — fall back explicitly to reading files directly, and say so in your
  output instead of quietly grepping on.
- An eval report from `node scripts/codegraph-eval-harness.mjs` is in front of
  you and the question is "what should querying have looked like".

## Query craft

- Ask the graph before grep. One `codegraph_explore` call returns verbatim
  source plus the call paths between symbols plus the blast radius of a
  change; a grep-and-read loop repeats that work more expensively and less
  accurately.
- Name concrete symbols and files in the query. A bag of names or a
  natural-language question both work, but "how does X reach Y" beats "tell
  me about X" — the answer you need is call paths, not prose.
- Query the right project. The tooling checkout's index is not the target's:
  pass `--project-root <target>` on the CLI, or the graph answers for the
  wrong tree and every downstream claim inherits the mistake.
- Run an impact check before editing a shared symbol, and check what a change
  reaches before committing — then run the tests that check names, not the
  whole suite.

## Reading an eval report

The report (schema contract: `docs/tools/codegraph-eval-harness.md`) is a
deterministic replay of recorded CodeGraph queries:

- `byOutcome` always carries all four outcome classes, even at zero. The
  vocabulary has exactly one implementation — `attributeOne` in
  `scripts/codegraph-trajectory.mjs`, whose `OUTCOMES` export is the single
  source. Never fork the class list into prose or code; consume it. A query
  with nothing at all following it grades `unknown` — the classification
  never fabricates a verdict without evidence.
- `byTool` is sorted, and its per-tool breakdowns are where the honest
  failures live: a tool whose queries grade `fallback` or `unused` is a
  finding about query craft or index state, not noise to average away.
- `queries[]` keeps one row per eval-set entry, in eval-set order, each with
  its outcome, freshness at query time, returned vs used identifiers, and the
  query id.
- Two facts of the design, stated as facts and not as opinions: `answered` is
  sticky — evidence of use wins outright, and a later pass can only widen it,
  never un-see it; and the report carries no collapsed success number and no
  wall-clock field anywhere — the classes are the deliverable, never their
  sum, so never quote a `successRate` or a `score` that does not exist.

## The consumption path

Do not eyeball the report, and do not re-derive outcomes — that would make
you a second grader, and the one implementation of the vocabulary lives in
`attributeOne`. Run:

```bash
node scripts/codegraph-expert-brief.mjs --report <report.json>
```

It validates the report's shape, prints the outcome mix, the per-tool
breakdown, per-tool advice for every failing class, and the query ids behind
each failing class. Its output is a pure function of the report —
deterministic, with no counts baked in and identifiers only. If it refuses
the file, the file is not a codegraph-eval-harness report; do not interpret
it anyway.

## Fallback ladder

- Freshness first: a stale or missing index answers UNKNOWN — the graph
  refuses rather than guessing. Resolve the freshness guard before trusting
  any miss.
- Reframe the query with concrete identifiers before giving up on the graph;
  a miss on vague prose is not evidence the answer is not in the graph.
- Still nothing usable → read the files directly, and say plainly that the
  graph did not answer. The silent fallback — quietly becoming a file-reading
  loop while claiming graph coverage — is the failure mode this skill exists
  to prevent.
---
type: analysis
status: proposal
audience: Mateusz (decision) → PLAN squad (tasks)
tags: [type/analysis, area/cost, topic/routing, topic/delegation]
created: 2026-07-03
data: ledger scan of 31 runs, $181.24 total (2026-06-25 → 07-03)
---

# Cost analysis — leads burn 93%; three levers

## Findings (ledger, all runs to date)

| Model | Cost | Share | Breakdown |
|---|---|---|---|
| z-ai/glm-5.2 | $103.44 | 57% | input $38.8 · output $18.6 · **cache reads $46.0** (328.8M tok) |
| claude-4.8-opus | $74.84 | 41% | output $19 · **cache read $27.9 + cache write $28** |
| minimax-m3 | $3.38 | 2% | |
| deepseek pro/flash, kimi | $0.44 | <1% | |

- **Lead vs subagents: $169.60 (93%) vs $12.49 (7%).** Delegation per squad: plan 4%,
  review 8%, dev 11%, test 0%.
- **Cache-read : fresh-input ratio = 404M : 36M ≈ 11:1** — leads drag a huge context for
  hours; every turn re-reads it (billed). Long solo sessions are the tax.
- The cheap-model routing **already exists** in `config/models.map` (plan: discovery=minimax,
  decompose=minimax; review: first_pass=deepseek_pro, security=kimi; dev: recon=minimax…) —
  leads simply don't delegate to it.
- Caveats: (a) GLM has no `cacheRead` price in `config/models.json` → ledger assumes 10% of
  input; if OpenRouter bills GLM cache reads higher, GLM cost is UNDERestimated. (b) Billing
  reconcile blocked: `cost-report.mjs` needs an OpenRouter **management** key
  (`403 Only management keys can fetch activity`) — add one to `.env` to verify.

## Levers (ordered by impact)

### L-A. Plan squad → subscription-native (`NATIVE=1`) — kills ~41% of spend
Opus plan-lead runs through OpenRouter (`native:false` in every manifest) while an Anthropic
subscription is already paid for. `set NATIVE=1&& bin\plan.bat` exists today (ADR-0001).
Trade-off: a native session is pure-Anthropic — plan subagents must run on sonnet/haiku
(also covered by the subscription) instead of minimax/deepseek. Marginal cost of planning → $0
(consumes subscription quota instead). No code change; optionally make plan.bat default to
NATIVE with an `OR=1` escape hatch.

### L-B. Delegation policy in lead CLAUDE.md — targets the 93%
Leads must orchestrate, not grind. Proposed section for `agents/*/CLAUDE.md` (each lead):

> ## Delegation policy (cost)
> You are an ORCHESTRATOR. Your own turns are expensive (long context × every turn).
> - Delegate any bounded work (analysis, code slice, review pass, test scenario) to the
>   role subagent from `config/models.map` via the Task tool. Delegate-first is the default.
> - Do not write code / full specs / full reviews yourself. You: read the task, slice it,
>   brief subagents (complete, self-contained briefs), integrate results, decide.
> - If your own reply is about to exceed ~30 lines of analysis or ANY code block — STOP,
>   delegate to the appropriate role instead.
> - Keep your context small: don't read large files yourself; have a subagent read and
>   return a summary. Every extra 100k tokens in YOUR context costs money on EVERY turn.

Expected effect: lead share 93% → ~40–50%; bulk moves to minimax/deepseek/kimi rates
(3–20× cheaper than GLM/Opus) AND fresh small subagent contexts cut the cache-read tax.

### L-C. Shorter sessions — one run per task
The 11:1 cache ratio comes from marathon windows ($27.54, $24.84, $24.62, $19.19 single
runs). One task = one launch (the dashboard `/api/launch` already enforces this shape);
close the window when the task is delivered. Also add the missing `cacheRead` price for
GLM in `config/models.json` once the real OpenRouter rate is confirmed.

## Proposed tasks (PLAN squad can push under JOI-51)
1. `chore(config)`: plan.bat NATIVE-by-default + docs note (L-A).
2. `feat(agents)`: add Delegation policy section to 5 lead CLAUDE.md + subagent brief
   template (L-B); acceptance: next dev/review run shows ≥40% subagent cost share in
   RunDetail "By agent".
3. `chore(config)`: GLM `cacheRead` pricing + OpenRouter management key for
   `cost-report.mjs` reconcile (L-C/caveat).
4. Dashboard (later): "delegation %" column per run — makes the behavior visible.

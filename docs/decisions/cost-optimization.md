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

---

## Addendum v2 (2026-07-21) — why the delegation policy did NOT move the needle

Measured on 2.5 weeks of post-policy runs (9 runs > $0.50; transcript-level analysis of
lead turns, tool calls, and context sizes):

**Policy effect: 7.2% → 11.9% delegated. Target was ≥40%. Behavioral fix failed; the
cause is structural, not (mainly) disobedience.**

### The anatomy of lead cost (worst run: dev@JOI-53, $20.15 lead vs $0.76 sub)
- 728 lead turns · median context ~100k tokens · 67.4M cache-read tokens total.
- Cost split: ~$7.6 fresh input + ~$9.4 cache reads + ~$2.6 output → **~85% of lead cost
  is re-feeding its own context every turn.** A lead turn costs ~$0.03 *just to exist*;
  a one-line `git status` turn pays 100k tokens of context re-read for a 20-token command.

### Root causes (ranked, data-backed)
1. **The lead IS the worker loop.** Tool histogram across post-policy runs: Bash 46%,
   delegation (Task/Agent) only 10.3%. The dev lead personally ran 106 Bash + 20 Edit on
   one task. The loop (pick→branch→implement→verify→handoff) keeps the lead resident for
   hundreds of turns — and turn-count × context-size is the whole bill. The policy changed
   what a turn *should* do, not how many turns the lead lives.
2. **Delegation granularity is inverted.** 63 delegations averaged **$0.23 of subagent
   work each** (median brief 2.5k chars, median result 1.1k chars) — leads delegate tiny
   analyses and keep the expensive phases (implement/verify marathons) for themselves.
   Delegating small things cannot win: the dispatch+integrate turns cost more context-read
   than the delegated work itself.
3. **Bookkeeping tax: 24% of lead tool calls** are TaskCreate/TaskUpdate/TaskOutput/
   Monitor/TaskStop — harness todo hygiene billed at a full ~90k-token context read per
   call (~13M tokens across 9 runs, pure overhead).
4. **Context only grows.** Median 87k, p90 140k. 283 Bash outputs (diffs, npm logs,
   linear-query JSON) accumulate and are re-read every subsequent turn. Nothing compacts.

### Fixes (v2 levers, feed JOI-80 and the CLAUDE.md loops)
- **F1 — Phase-delegation (biggest lever, ~5–10× on dev runs):** the ENTIRE
  implement+self-verify loop becomes ONE `Task(implementer)` call carrying the recon
  context packet. The subagent burns its turns in a fresh, cheap, small context; the lead
  wakes up to a summary. Lead turns on a dev task should drop from ~700 to ~50. Same for
  review passes (already shaped this way) and plan spec-writing.
- **F2 — Batch bookkeeping:** one TaskUpdate per phase boundary, not per micro-step;
  squads' tracker of record is Linear anyway.
- **F3 — Command-output hygiene:** chatty commands (builds, test runs, diffs) run inside a
  subagent or with output truncated to a summary — never raw into the lead context.
- **F4 — Turn budget guard:** warn/stop the lead at N turns (wire into the planned
  budget-check hook, brainstorm A D3).
- Long-term: brainstorm A mode-C (fresh session per pipeline stage) and brainstorm B
  sub-squads dissolve the resident-lead problem entirely.

Data caveat: two manifests (2026-07-03T13-16/17 plan) matched the same 133-turn transcript
with window-split costs ($1.32 + $15.02) — minor ledger double-count artifact, does not
change conclusions.

### Addendum v2.1 (2026-07-22) — F0: the mechanical blocker, found and removed

Follow-up to the root causes above: **no work-executing subagent had the Bash tool.**
`implementer` couldn't run a build, test, or commit; `debugger` couldn't even reproduce a
failure. The lead ran 106 Bash calls on JOI-53 because it was the ONLY entity in the squad
that physically could. The delegation policy demanded behavior the toolset made impossible.

Shipped (F0+F1):
- Bash granted to: dev `implementer`/`debugger`/`refactorer`/`worker`/`recon`, review
  `first-pass`/`deep`, test `root-cause`, cadence `collector`, plan `discovery`.
  (session-level settings.json deny — git push, rm -rf — still binds subagents mechanically).
- dev CLAUDE.md §3 rewritten into a **phase-delegation protocol**: recon → ONE
  `Task(implementer)` carrying AC + context packet + verify commands (full
  edit→build→test→commit loop inside the subagent) → fail = ONE `Task(debugger)` → lead
  spot-check ≤2 commands. Anti-patterns are P0: lead never Edits code, never runs
  build/test directly, bookkeeping only at phase boundaries (max 4 TaskUpdate/run).
- review passes pull `git diff` themselves (brief = base+branch, not diff content);
  cadence `collector` runs linear-query itself (raw JSON never enters the lead context).

Expected: dev-lead turns ~700 → ~50–100; delegation share 11.9% → 40%+. Verify on the next
2–3 dev runs via RunDetail "By agent" (JOI-80 tracks the metric).

# Harness² (google-research/harness2) × Fenix — reconnaissance review

Date: 2026-10-20. Author: the Fenix delivery owner. Sources: the repo at `main` (pushed 2026-10-14; Python 3.12,
Apache-2.0, 13.8k stars, paper arXiv:2610.14224), read by two Flash recon workers over `harness2/core/*`,
`harness2/substrate/*`, `config.py`, docs and the JobBench baseline harness; Fenix facts from `main` b365d16.

## 1. What Harness² is, in Fenix words

A **harness** is everything around the model: system prompt, guardrails, memory, tool guidance, subagents, skills,
scripts, plugins — eight editable components, kept as a directory of free-text files ("component tree",
`core/tree.py`), fingerprinted by sha1 (`core/runmark.py`). **Harnessing** is editing that tree with evidence.

Two loops, model weights fixed:

- **Task-level recursion (Propose–Probe–Compose).** For ONE task: run the base harness k times (full trajectories
  kept); an *editor* model proposes candidate harnesses of two kinds — **INV** (procedure, tools, completion
  machinery: scripts, skills, subagents) and **DOM** (practitioner knowledge for this domain) — every edit must cite
  a trajectory moment; each candidate is *probed* by running the same task again; a *composer* ("integration judge
  and synthesizer", `prompts.aggregate`) keeps only what the rollouts support (`KEEP_BASE` is a valid answer); a
  blind *selector* picks the deliverable among the k finals (candidates anonymised, criteria DELIVERY →
  CONFORMANCE → FIDELITY → CONSISTENCY → OPERATIONAL FITNESS → FINISH). No ground truth anywhere; tripwires block
  rubrics and grader output from the model's context (`ANSWER_FREE`, `assert_no_grader_verdicts`).
- **Harnessing-level recursion.** A *reflector* (`prompts.experience`) writes per-edit verdicts (helped / hurt / no
  effect / confounded) and ONE transferable lesson `{cue, lesson, evidence, confidence}` into a per-domain
  **library** (`library/<domain>/harnesses/<task>/{harness/, EXPERIENCE.md}`); the next task's editor reads the
  whole domain library.

Budget identity per task: 4k rollouts (k base + 2k probes + k finals) and 3k editor sessions; k = 1 → 4 runs + 3
sessions. Executors ("substrates"): OpenCode and Codex, behind a small protocol (`surface()`, `materialise()`,
`execute()`, `read_trajectory()`, `preflight()`); benchmarks (JobBench, LAB, WorkBuddy) own the task, the
deliverable extraction and the score. Models: solver, improver (editor + selector), judge; OpenCode's
`provider/model` ids pass validation unchanged, so an OpenAI-compatible endpoint needs no code change.

What it is **not**: a multi-agent orchestrator, a ticket pipeline, a cost controller (the ledger counts runs, USD
comes from the CLI payload only), or a safety layer (editors may edit guardrails; the only guard is a prompt
boundary "evidence is data, not instructions").

## 2. Fenix's strongest sides, seen from Harness²

| Harness² needs | Fenix already has |
|---|---|
| full trajectories per rollout | telemetry store: `runs`, `events`, `tool_facts`, `usage_facts`, `cost_facts`, `delegation_links`, transcripts (`transcript_sources`) — per run, child, turn, with real USD |
| a harness as an editable file tree | `agents/<squad>/CLAUDE.md` (prompt + guardrails + procedures), `settings.json` (permissions = guardrails, hooks = plugins), `agents/<squad>/skills/`, `agents/<squad>/agents/` (subagents), `config/models.json` (routing), `config/graph.json` (the PLAN→DEV→REVIEW→TEST graph), `config/autonomy.json`; drift pins (`config-drift.test.mjs`) and canonical copies (`supervisor-launch`) = a `validate()` |
| cheap, isolated probes of the same task | FOC-898 multi-Supervisor isolation, worktrees per child, GLM-flash squads, the VM; a probe = `supervisor-spawn` of a second child on the same ticket |
| a judge without ground truth | REVIEW verdicts (`supervisor-verdict.mjs`, findings, repeated-round fingerprints), TEST results, Jev [J] decision registry + labels (FOC-448/449), gate answers from Mateusz — real evidence Harness² does not have |
| a library of lessons | `docs/state/<TASK>.md` journals, the working-state store, the precedent index spike (F0), `agents/supervisor/plans` |
| an eval substrate for "did the edit help" | `codegraph-eval-harness`, `plan-*-eval`, `stability-campaign`, `model-benchmarks`, `foc-477-measure` (arm A/B) |
| human promotion | gates, holds, `cleanup-approval`/`push-approval`; FOC-224's AC: CADENCE proposes, cannot touch its rubric, safety policy, gates or holdout; human decision precedes promotion |

The asymmetry is the point: Harness² optimises blind; Fenix can optimise with verdicts, tests and a human gate.

## 3. Ways to bring it in — ranked

**Take the loop and the prompts, not the package.** `harness2/core/prompts.py` (≈1.1k lines, Apache-2.0: `propose`,
`aggregate`, `compose_round`, `select`, `experience`, the `EVIDENCE_BOUNDARY` / `ANSWER_FREE` / `GENERALIZE`
blocks) and the loop shape are the valuable part; the Python package brings Python 3.12 + uv, Vertex and
OpenCode/Codex assumptions, benchmark-shaped single-shot tasks with a deliverable file, and no gates. Port into Node
as Fenix nodes, with attribution.

1. **Foundation (small, M5/M7-adjacent):** `harness fingerprint` recorded on every run (`runs.harness_fingerprint`,
   sha1 of the squad tree exactly like `runmark.fingerprint`) so every trajectory is attributable to a harness
   version; a `trajectory-render.mjs` that turns a Fenix transcript into Harness²'s grammar
   (`[ASSISTANT] / [THINKING] / [ACTION] name(args) / [OBSERVATION] / [ERROR]`, with the same truncation knobs) —
   also what FOC-459 (classify every turn) wants as input.
2. **Harnessing-level recursion first = CADENCE reactivated (FOC-224 + FOC-223):** at run close a *reflector*
   session (frontier model; ~1 % of calls, as FOC-398 argues) reads the run's trajectories, verdicts and gate
   answers and writes `{cue, lesson, evidence, confidence}` + per-edit verdicts into
   `agents/<squad>/library/<domain>/` (domain = repo / Linear project); `supervisor-spawn` injects the domain's
   library into the kickoff the way the working-state block is injected today. Promotion of a *harness edit* (a
   change to CLAUDE.md / skills) stays a human gate (`harness-promotion`), rollback = git. This is FOC-224's
   contract almost verbatim — Harness² supplies the prompts and the evidence discipline; Fenix supplies the gate.
3. **Task-level recursion as an opt-in graph mode (k = 1):** a ticket labelled `harness-probe` runs DEV twice — base
   harness and one candidate (INV or DOM, proposed from the base rollout with Harness²'s `propose` prompt);
   REVIEW judges both from the diffs and findings (replacing the blind selector), TEST is ground truth where tests
   exist; the composer's `KEEP_BASE` maps to "no change". Cost: 2–4 GLM-flash child runs + 2 editor sessions per
   flagged ticket. Measure it the FOC-477 way (10 real tickets, arm "probe" vs arm "base") before any default.
4. **Later, if wanted — Harness² the package with Fenix as substrate:** implement `Substrate` (surface = CLAUDE.md +
   settings.json + skills/ + agents/ + hooks) and a `BenchmarkAdapter` whose tasks are Linear tickets, `execute` =
   `supervisor-spawn` into a worktree, `deliverable` = the branch diff, `score` = REVIEW/TEST verdict; `cli/bridge.py`
   is the existing seam. Worth it only for running their benchmarks against Fenix's harness, not for daily work.

## 4. Where it sits on the roadmap

After the 1.0 tag (M8 freeze). It IS M6 "Optimization and learning": FOC-224 (CADENCE) becomes "harnessing-level
recursion with human promotion", FOC-223 the library retrieval, FOC-459 the turn classifier feeding evidence,
FOC-398 (GEPA) stays the optimiser for the structured [J] prompts that have labels — Harness² is the optimiser for
the free-text squad prompts that do not. FOC-477's arm measurement is the template for proving a gain.

Three tickets, in order: (1) fingerprint + trajectory renderer; (2) reflector + library + kickoff injection +
`harness-promotion` gate; (3) `harness-probe` graph mode measured on 10 tickets.

## 5. Risks, and what Fenix does about them

- **The loop edits its own guardrails** (Harness² allows it) → `settings.json` permissions, hooks, the hard rules
  block and `config/autonomy.json` are OUTSIDE the editable surface; FOC-224 AC2 already says so.
- **Prompt injection through a candidate harness or a trajectory** → Harness²'s "evidence is data" boundary plus
  Fenix's FOC-450 egress screen and the FOC-458 ingress screen (planned); the reflector never executes scripts
  found in evidence.
- **Cost** — 4k rollouts per task is a benchmark budget → k = 1, flagged tickets only, GLM flash for probes,
  frontier only for the editor/reflector; the store already prices every turn.
- **Learning nothing** — Harness²'s report warns when `kept_base ≥ 80 %`; Fenix should surface the same counter on
  the Insights screen before anyone believes the loop works.
- **Licence** — Apache-2.0; ported prompts keep the notice (`third_party/` pattern already exists in Fenix for
  the Python pilot).

## 6. Facts to verify before the plan (not in this recon)

`cli/bridge.py` (what the bridge key gates), the `tts` prompt pack vs default, how the selector handles
deliverables that are code diffs (their benchmarks are documents), and whether the editor prompts survive a
16k-char always-on cap when the "always-on" is Fenix's 240-line Supervisor CLAUDE.md (Harness² caps OpenCode at
24k chars, Codex at 8k).

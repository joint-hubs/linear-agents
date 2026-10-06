# Quality & Accuracy Metrics for Fenix — State of the Art and Implementation Map

**Date:** 2026-09-29
**Question (Mateusz):** which state-of-the-art quality / accuracy metrics can Fenix implement?
**Method:** three parallel research passes (task outcome & delivery; decision/judge quality & calibration; process/trajectory quality & evaluation methodology), each with web access, mapped onto the data Fenix already records; key sources re-checked by the orchestrator. Claims a researcher could not verify online are marked *[unverified]*.
**Status:** research only — nothing implemented. Follow-up tasks are not yet filed.

---

## 1. Executive summary

- **Most high-value metrics can be computed from data Fenix already records** — supervisor verdict and merge-verification records, gate records, `decisions.jsonl` (events + labels), `tool_facts`, `canonical_usage`/`cost_facts`, git and Linear timestamps. The first wave needs almost no new instrumentation.
- **Current numbers must be reported differently.** The intake [J] decisions show 52–68 % agreement with labels at n≈19; the 95 % Wilson interval at that n is roughly ±20 pp (e.g. 68 % → ~[46 %, 84 %]). Today the nodes are not distinguishable from noise. Every rate needs a confidence interval, and agreement should be chance-corrected (Cohen's κ).
- **Three layers of metrics** are worth having: (1) *did Fenix deliver* (resolved rate, regressions, cost per resolved task, human-intervention rate, rework); (2) *can a model decision be trusted* (κ, Brier, reliability diagrams, risk–coverage, conformal risk control as the A0→A1 promotion rule); (3) *how efficient and grounded is the process* (tool redundancy and stuck loops, mechanical anchor verification, context precision/recall, paired A/B statistics).
- **Graders fail too.** An audit of SWE-bench Pro reported that roughly one third of trials were mis-graded and that agents read gold solutions from the repository's `.git` history. Fenix's own verdicts need periodic audit against Mateusz's decisions.

---

## 2. Layer 1 — Task outcome & delivery quality ("does Fenix deliver?")

### State of the art

- **Resolved rate via hidden tests (FAIL_TO_PASS + PASS_TO_PASS).** An instance is resolved only if the tests that should flip now pass *and* all previously passing tests still pass — fixing the issue is worthless without regression protection. [swebench.com](https://www.swebench.com), [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/).
- **SWE-bench Pro** — contamination-resistant (repository hold-out, fresh tasks, multi-file changes); frontier models drop from 70–80 %+ on Verified to ~23 % at release and ~45–60 % later. Its later audits are the key lesson for Fenix: graders mis-graded about a third of trials, and agents could recover gold patches from `.git` history. [arXiv:2509.16941](https://arxiv.org/abs/2509.16941), [leaderboard + audit notes](https://www.morphllm.com/swe-bench-pro).
- **pass@k vs pass^k (τ-bench).** pass@k = at least one of k trials succeeds (capability); pass^k = all k trials succeed (reliability). pass^k collapses as k grows (gpt-4o: pass^8 < 25 % in retail) — the metric that answers "can the pipeline run unattended". [arXiv:2406.12045](https://arxiv.org/abs/2406.12045), [Sierra](https://sierra.ai/blog/tau-bench-shaping-development-evaluation-agents).
- **METR task-completion time horizon.** Fit a logistic of success vs log(human expert time); the 50 % / 80 % horizon is the task length at which the agent succeeds with that probability. Expresses difficulty in human-time units with honest error bars. [metr.org/time-horizons](https://metr.org/time-horizons), [arXiv:2503.14499](https://arxiv.org/abs/2503.14499).
- **SWE-Lancer** — real freelance tasks with dollar value; IC tasks graded by end-to-end tests, management tasks by agreement with the original manager's choice. Introduces value-per-task and manager-agreement. [openai.com/index/swe-lancer](https://openai.com/index/swe-lancer/).
- **Terminal-Bench** — outcome-driven grading on final container state, oracle solutions, cost tracking. [tbench.ai](https://www.tbench.ai).
- **Cost per resolved task** (spend ÷ resolved, never per attempt) and **human-intervention rate** — standard reporting companions *[some specifics unverified]*.
- **Agent-authored PRs in production:** a 2025 study of ~33.6k agent PRs reports ~71 % merge rate (43–83 % by agent), lowest for bug fixes/perf; rejected PRs are larger; the top rejection pattern is reviewer abandonment *[arXiv id unverified]*.
- **DORA applied to agents:** rework rate and change-failure rate as first-class delivery metrics. [dora.dev](https://dora.dev/).
- **Test adequacy:** coverage delta on changed files, mutation score *[no canonical agent benchmark; unverified]*.
- **Code-review quality:** **AACR-Bench** (Alibaba) — 200 real PRs, 1,505 expert-verified comments, 10 languages; precision/recall of findings, line-level positioning precision, noise rate. [github.com/alibaba/aacr-bench](https://github.com/alibaba/aacr-bench). Production proxy: comment acceptance/"addressed" rate. Recall via seeded defects.

### Mapping to Fenix

| Metric | Computation from Fenix data | Missing | Effort | Where |
|---|---|---|---|---|
| **Resolved rate** | verdict PASS ∧ every AC has evidence ∧ combined suite green in merge verification | AC→evidence/test rollup | S–M | M4, FOC-617 |
| **Regression-at-merge rate** | P(combined fails ∧ candidate alone passes) from merge-verification records | nothing — aggregate | S | M4 |
| **Cost per resolved task** + failure-cost asymmetry | `cost_facts`/`canonical_usage` per run ÷ resolved; mean cost success vs failure | resolved label ↔ run join | S | FOC-477, M6 |
| **Time-to-merge / cycle time** | Linear start → Done, git merge dates | nothing | S | M1/M6 |
| **Human-intervention rate** | runs with ≥1 answered [H] gate ÷ runs, by decision type and autonomy level — the natural headline metric of M3 | gate tagging by node | S | M3 |
| **Rework / rounds-to-accept** | review rounds from supervisor records | nothing | S | M4, FOC-390 |
| **Review finding precision** | findings upheld by Mateusz ÷ all findings | per-finding disposition labels | S–M | FOC-390, FOC-617 |
| **Change-failure rate** | reverts/fix-ups of agent merges within N days ÷ agent merges | run → commit attribution | M | M1/M6 |
| **pass^k** | k repeats per task on the frozen eval set, grouped by task | frozen set + repeat budget | M | FOC-222, FOC-387 |
| **Review recall** | seeded defects in REVIEW inputs; escaped defects as missed findings | seeding harness | L | FOC-390, M6 |
| **Test adequacy** | coverage delta on changed files; sampled mutation score | tooling | M–L | M6 |
| **Fenix time horizon / value ratio** | logistic of resolved vs log(estimate); resolved value per dollar | more labelled runs; estimate hygiene | M | FOC-387, FOC-477 |

---

## 3. Layer 2 — Quality of model decisions and judges ([J] nodes, gate auto-answers, verdicts)

### State of the art

- **Agreement on small samples:** confusion matrix, balanced accuracy, macro-F1; **Cohen's κ / Krippendorff's α** instead of raw agreement (raw agreement overstates quality when one class dominates; judges with >90 % raw agreement can still deviate 10–20 points). [ACL GEM 2025](https://aclanthology.org/2025.gem-1.33.pdf). **Wilson or bootstrap intervals** on every rate; order-of-magnitude rule: ~50–100 labels per decision before a headline number means much *[rule of thumb]*.
- **Calibration:** binned ECE is unstable and hides over/under-confidence cancellation ([Nixon et al. 2019](https://openaccess.thecvf.com/content_CVPRW_2019/papers/Uncertainty_and_Robustness_in_Deep_Visual_Learning/Nixon_Measuring_Calibration_in_Deep_Learning_CVPRW_2019_paper.pdf)); small-sample estimators have ~10 % error even around 100 samples ([Famiglini et al., ECAI 2023](https://boa.unimib.it/bitstream/10281/456604/1/Famiglini-2023-ECAI-VoR.pdf)). **Brier score** (with reliability/resolution decomposition) and a **reliability diagram** work at n≈20. LLMs are systematically overconfident; verbalised confidence must be calibrated, not trusted ([survey arXiv:2503.15850](https://arxiv.org/html/2503.15850)). On small data only one-parameter scaling (Platt / temperature) is stable; isotonic overfits.
- **Selective prediction → autonomy thresholds:** risk–coverage curve and AURC; **conformal risk control / conformal abstention** picks a threshold on a labelled calibration set with a finite-sample guarantee that the error rate among auto-answered cases is ≤ α (under exchangeability). [Conformal abstention, NeurIPS 2024](https://neurips.cc/virtual/2024/105548), [SCOPE, selective conformal LLM judging](https://arxiv.org/abs/2602.13110), [arXiv:2405.01563](https://arxiv.org/html/2405.01563). This is the principled form of Fenix's A0 → A1 promotion.
- **LLM-as-judge reliability:** position bias (mitigate with order-swapped double scoring), verbosity/length bias, self-preference; rubric-based and multi-judge panels. [IJCNLP 2025](https://aclanthology.org/2025.ijcnlp-long.18/). **Agent-as-a-Judge** (judge with tools) reaches ~90 % human agreement vs ~70 % for a plain LLM judge, but needs meta-evaluation. [arXiv:2410.10934](https://arxiv.org/abs/2410.10934).
- **Drift of decision quality:** labels arrive late; windowed metrics with Wilson bands, EWMA and **CUSUM / Page–Hinkley** change-point detection on per-node correctness.

### Mapping to Fenix

| Metric | Source | Note | Effort | Where |
|---|---|---|---|---|
| **κ + Wilson CI per [J] node** (replace raw agreement) | `decisions.jsonl` events ⋈ LABEL lines; gate answers | no new data needed | S | FOC-387 |
| **Brier + reliability diagram per node** | confidence + correctness | the artifact Mateusz reads before A1 | S–M | FOC-387 |
| **Platt/temperature scaling of confidence** | labelled calibration split (grouped by run/task) | leave-one-out CV at small n | M | FOC-387, M3 |
| **Risk–coverage + AURC** | labelled decisions, scaled confidence | usable at ~100+ labels/node | M | FOC-387 |
| **Conformal risk control threshold for A1** | held-out calibration set | defines "auto-answer above λ̂ with expected error ≤ α"; re-checked on fresh labels | M | M3, FOC-384 |
| **Judge robustness test** (order swap, length confound) | REVIEW verdicts | needs a paired/swap variant of the node | M–L | M4, FOC-390, FOC-617 |
| **Judge–human agreement protocol** | sampled verdicts vs Mateusz's merge decisions | sampling + labelling step | M | FOC-222 |
| **CUSUM drift monitor** | rolling decisions + labels | handle label delay with confidence-distribution proxies | M | M3/M6 |

**Label flywheel:** every A0 advisory answer that goes to Mateusz is a free label — the abstain policy *is* the labelling budget. Target ≥ 50 labels per node before any A1 promotion.

---

## 4. Layer 3 — Process / trajectory quality and evaluation methodology

### State of the art

- **Efficiency under budget:** resolve rate under a fixed token/cost/time budget; failed trajectories cost ~4× more than successful ones (SWE-agent + GPT-4o-mini: ~8.8 M tokens vs ~1.8 M). [SWE-Effi, arXiv:2509.17195](https://arxiv.org/abs/2509.17195). Failed runs are consistently longer — length is a cheap dead-end indicator.
- **Waste detection:** OpenHands' stuck detector flags repeating action→observation cycles, action→error loops, monologues and ping-pong patterns; context condensers cut cost up to 2× without quality loss. [docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector).
- **Observability standard:** OpenTelemetry GenAI semantic conventions — `gen_ai.*` spans for `invoke_agent`, `chat`, `execute_tool` (incl. MCP), token-usage and duration metrics; agent conventions still in development. [semconv-genai](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).
- **Tool-use correctness:** BFCL (agentic / multi-turn / live / hallucination categories). [leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html). Error-recovery rate is an engineering metric rather than a named benchmark *[unverified]*.
- **Retrieval / localisation for code:** LocAgent / Loc-Bench — file-level Acc@1/3/5 and function-level Acc@5/10; best ~94 % file Acc@5 but ~77 % function Acc@10; a fine-tuned open model came within ~1.5 pp of a frontier model at a fraction of the cost. [arXiv:2503.09089](https://arxiv.org/abs/2503.09089). The reference metric set for CodeGraph evaluation and the planned CodeGraph-expert model.
- **Grounding of reports:** mechanical citation verification (every `file:start-end` checked against the source) eliminates non-existent-file/line hallucinations by construction *[source page unverified]*; code-hallucination taxonomies (CodeHaluEval, HALOGEN).
- **Methodology:** paired tests for prompt/model A/B — exact McNemar, paired sign-flip permutation, paired/cluster bootstrap; report CI + p-value + minimum detectable effect. Contamination is best handled by provenance (which commit, which issues) rather than detection. **GEPA/DSPy** overfit when the train set doubles as the validation set — keep a separate small validation set. [dspy.ai](https://dspy.ai).

### Mapping to Fenix

| Metric | Source / formula | Missing | Effort | Where |
|---|---|---|---|---|
| **Cost per success + failure asymmetry** | `cost_facts` ⋈ verdicts / `runs.status` | verdict↔run join | S | FOC-477, M6 |
| **Tool redundancy rate** | `tool_facts` repeat categories: (reread_after_edit + rerun_after_change + unchanged) ÷ calls, per tool / model / role | shrink the `unknown` bucket | S | M6 |
| **Stuck-loop rate** | ≥3 consecutive identical (tool, input identity, result) | ordered sequence query | S | M6 |
| **Tool error & recovery rate** | `has_error` ÷ calls; recovery = error followed within k turns by same tool with `tool_result_state = ok` | turn index + argument diff | M | M2/M6 |
| **Anchor validity** | parse `file:line` in verdict findings, verify against the repo at the candidate commit → hallucinated-anchor rate | structured anchors | S–M | FOC-617, FOC-390 |
| **Context precision/recall** | files read (`tool_facts`) vs files changed (git diff): changed∩read ÷ changed; read-but-unused ÷ read | run→commit→diff join | M | FOC-624, FOC-477 |
| **CodeGraph localisation Acc@k** | Loc-Bench-style file/function top-k on the FOC-624 question set | the eval set + trajectory capture | L | FOC-624, FOC-625 |
| **Time to first relevant action** | first tool call touching a file in the final diff ÷ run duration | same join as context recall | M | FOC-624 |
| **Paired A/B statistics** | McNemar / permutation / cluster bootstrap on labelled events and frozen-set runs | helper in the eval harness | S | FOC-387, FOC-477, M6 |
| **OTel `gen_ai.*` export** | map `usage_facts`/`tool_facts`/`delegation_links` to spans | exporter | M | M5/M6 |

---

## 5. Rules without which the numbers are meaningless

1. **Always report intervals.** At current n, no bare percentage is interpretable.
2. **Split by task, not by event.** Decisions within one run are correlated; random event splits leak and invalidate calibration and conformal guarantees. GEPA gets a disjoint validation set.
3. **Mechanical verification before LLM judges** wherever a claim is machine-checkable (anchors, tests, repo state); judges only for the residue, and judges are themselves meta-evaluated against Mateusz's labels.
4. **Pair metrics against Goodhart:** cost per success ↔ resolved quality; fewer gates ↔ escaped-defect rate; fewer review rounds ↔ finding precision; merge rate ↔ change-failure rate.
5. **Audit the grader.** Periodically compare verdicts with Mateusz's decisions; guard against children reading solutions from places they should not (other worktrees, git history of a reference branch).
6. **Single-rater ceiling.** Mateusz is the only gold-standard rater — re-rate a sample occasionally to measure his own consistency before treating his dispositions as ground truth.
7. **Frozen eval sets age.** Pin them to a commit, record provenance, rotate tasks; Tier-4 (task-level) contamination is indistinguishable from generalisation.

---

## 6. Recommended roadmap

**Wave 1 — S, existing data only** (one "Quality" panel on the Analysis screen):
- resolved rate + regression-at-merge rate;
- cost per resolved task + failure-cost asymmetry;
- human-intervention rate by decision type;
- tool redundancy + stuck-loop rates from `tool_facts`;
- per-[J]-node κ, Wilson CI and Brier score (replacing raw agreement).

**Wave 2 — M, M3/M4:**
- conformal risk control as the A0 → A1 promotion rule (FOC-384, FOC-387), with confidence scaling and risk–coverage curves;
- mechanical anchor verification (FOC-617) and finding precision from Mateusz's dispositions (FOC-390);
- context precision/recall, files read vs files changed (FOC-624);
- paired A/B statistics in the eval harness; judge robustness mini-eval.

**Wave 3 — M/L:**
- pass^k on the frozen eval set (FOC-222);
- review recall via seeded defects; change-failure rate; test adequacy (coverage delta, mutation score);
- CodeGraph localisation Acc@k (FOC-624/FOC-625); time horizon and value ratio; CUSUM drift monitoring; OTel export.

---

## 7. Sources (primary)

- τ-bench / pass^k — https://arxiv.org/abs/2406.12045 ; https://sierra.ai/blog/tau-bench-shaping-development-evaluation-agents
- METR time horizons — https://metr.org/time-horizons ; https://arxiv.org/abs/2503.14499
- SWE-bench / Verified / Pro — https://www.swebench.com ; https://openai.com/index/introducing-swe-bench-verified/ ; https://arxiv.org/abs/2509.16941 ; audit notes: https://www.morphllm.com/swe-bench-pro
- SWE-Lancer — https://openai.com/index/swe-lancer/
- Terminal-Bench — https://www.tbench.ai
- DORA — https://dora.dev/
- AACR-Bench — https://github.com/alibaba/aacr-bench
- Judging the judges (GEM 2025) — https://aclanthology.org/2025.gem-1.33.pdf
- LLM-judge position/length bias (IJCNLP 2025) — https://aclanthology.org/2025.ijcnlp-long.18/
- Agent-as-a-Judge — https://arxiv.org/abs/2410.10934
- Calibration: Nixon et al. 2019 — https://openaccess.thecvf.com/content_CVPRW_2019/papers/Uncertainty_and_Robustness_in_Deep_Visual_Learning/Nixon_Measuring_Calibration_in_Deep_Learning_CVPRW_2019_paper.pdf ; Famiglini et al. ECAI 2023 — https://boa.unimib.it/bitstream/10281/456604/1/Famiglini-2023-ECAI-VoR.pdf ; LLM confidence survey — https://arxiv.org/html/2503.15850
- Conformal abstention / risk control — https://neurips.cc/virtual/2024/105548 ; https://arxiv.org/html/2405.01563 ; SCOPE — https://arxiv.org/abs/2602.13110
- SWE-Effi — https://arxiv.org/abs/2509.17195
- OpenHands stuck detector — https://docs.openhands.dev/sdk/guides/agent-stuck-detector
- OpenTelemetry GenAI semantic conventions — https://github.com/open-telemetry/semantic-conventions-genai
- BFCL — https://gorilla.cs.berkeley.edu/leaderboard.html
- LocAgent / Loc-Bench — https://arxiv.org/abs/2503.09089
- DSPy / GEPA — https://dspy.ai

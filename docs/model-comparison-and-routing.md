---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/llm, topic/linear, topic/cost-optimization, topic/claude-code, topic/benchmarks]
created: 2026-06-22
updated: 2026-06-22
source: deep-web-research-2026-06 (multi-source, multi-benchmark)
maturity: research-v2
---

# Model comparison & cost-optimized routing — Linear AI Workflow (v2, zweryfikowane)

> Cel Mateusza: **minimalizacja kosztów**. Baza = **GLM-5.2**. **Opus 4.8 tylko punktowo**,
> ale na najwyższej dźwigni. **MiniMax M3 dużo (w tym polskie komentarze do Mateusza)**. **Sonnet 4.6** tylko w landscape/benchmark (escelacja PL).
> DeepSeek V4 i Kimi K2.7 Code w miksie.
>
> **Korekta vs v1:** wcześniej błędnie potraktowałem nowsze wersje jako spekulatywne.
> Wszystkie są REALNE i dostępne (czerwiec 2026). Poniżej dane z **≥5 źródeł** i
> **≥3 benchmarków** na model, z rozdzieleniem **niezależne (vals.ai, llm-stats, Scale SEAL)**
> vs **vendor-reported**.

---

## 0. Jak czytać te liczby (metodologia)

- **SWE-bench Verified** — 500 realnych GitHub issues. Niezależny harness: **vals.ai** (mini-SWE-agent).
- **SWE-bench Pro (Scale SEAL)** — trudniejszy, standaryzowany harness; **lepszy różnicownik na froncie**. Uwaga: vendor podaje wyższe (własny scaffold), SEAL niższe — różnica 10–30 pkt.
- **Terminal-Bench 2.x** — agentowe zadania w terminalu (deploy, shell, git) — istotne dla agenta DEV/TEST.
- **MCP-Atlas / MCP Mark** — niezawodność tool-callingu (kluczowe dla agentów na MCP/Linear).
- **DeepSWE** — long-horizon, 70-pkt rozrzut → najlepszy sygnał do routingu (mało modeli zgłoszonych).
- **Per-token tani ≠ per-task tani** — modele verbose (DeepSeek, Kimi, GLM-max) generują długie reasoningi → realny koszt/latencja rosną. Liczy się koszt/ukończone zadanie.

---

## 1. Profile modeli (zweryfikowane, ≥5 źródeł / ≥3 benchmarki każdy)

### GLM-5.2 — BAZA (Z.ai, 13.06.2026, 753B MoE, MIT, 1M kontekst, 131K out)
| Benchmark | Wynik | Źródło |
|---|---|---|
| SWE-bench Verified | **82.8%** (niezależnie, $0.71/test) | vals.ai |
| SWE-bench Pro | **62.1%** (bije GPT-5.5 58.6) | z.ai / HuggingFace |
| Terminal-Bench 2.1 | **81.0** (Terminus-2) / 82.7 (Claude Code) | z.ai / datacamp |
| MCP-Atlas | 76.8 | z.ai |
| FrontierSWE (Dominance) | 74.4 (~Opus 4.8 75.1) | venturebeat |
| DeepSWE | 44–46 (słabszy long-horizon, 5× wolniej) | reddit r/opencodeCLI |
- **Cena:** **$1.40 in / $4.40 out**, cache $0.26 · **GLM Coding Plan flat ~$12.60/mc** (działa natywnie w Claude Code → praktycznie zerowy koszt krańcowy dla bulku).
- **Werdykt:** świetny i tani base do kodowania/dekompozycji. PL: dobry, słabszy niż Claude.
- Źródła: [z.ai blog](https://z.ai/blog/glm-5.2) · [HuggingFace](https://huggingface.co/blog/zai-org/glm-52-blog) · [vals.ai](https://vals.ai/benchmarks/swebench) · [VentureBeat](https://venturebeat.com/technology/z-ais-open-weights-glm-5-2-beats-gpt-5-5-on-multiple-long-horizon-coding-benchmarks-for-1-6th-the-cost) · [DataCamp](https://www.datacamp.com/blog/glm-5-2) · [kilo.ai](https://kilo.ai/models/z-ai-glm-5-2) · [docs.z.ai](https://docs.z.ai/guides/llm/glm-5.2)

### MiniMax M3 — SZYBKI AGENT, UŻYWANY DUŻO (31.05.2026, MoE+MSA, 1M kontekst, multimodal, 512K out)
| Benchmark | Wynik | Źródło |
|---|---|---|
| SWE-bench Verified | **80.5%** | llm-stats / morphllm / qubrid |
| SWE-bench Pro | **59.0%** (bije GPT-5.5 58.6) | qubrid / ofox / startupfortune |
| Terminal-Bench 2.1 | 66.0% | qubrid / x |
| BrowseComp | 83.5 · MCP-Atlas 74.2 | lushbinary / qubrid |
| Vals Index (accuracy) | 58.94% (niezależnie) | vals.ai |
- **Cena:** **$0.60 in / $2.40 out** std; **promo $0.30/$1.20**. Multimodal (obraz/wideo) — atut dla agenta TEST (screenshoty deployu). MSA: 1M kontekst tanio.
- **Caveat (ważny):** benchmarki vendor; realne testy mieszane — BridgeMind: „8/12 testów UI fail, wolny, niepewny"; r/hermesagent: raz „unpredictable", raz „very good". → używać tam, gdzie błąd jest tani + fallback.
- Źródła: [qubrid](https://www.qubrid.com/blog/minimax-m3-is-now-available-on-qubrid-ai) · [lushbinary](https://lushbinary.com/blog/minimax-m3-developer-guide-benchmarks-pricing-msa-architecture) · [ofox](https://ofox.ai/blog/minimax-m3-vs-gpt-5-5-coding-benchmark-2026) · [vals.ai](https://www.vals.ai/models/minimax_MiniMax-M3) · [morphllm](https://www.morphllm.com/swe-bench-pro) · [startupfortune](https://startupfortune.com/minimax-m3-gives-chinese-ai-labs-a-new-frontier-coding-test) · [verdent](https://www.verdent.ai/guides/minimax-m3-coding-agents)

### DeepSeek V4 Pro / Flash — NAJTAŃSZY BULK (24.04.2026, MoE, 1M kontekst, MIT, OpenAI+Anthropic API)
| Benchmark | V4-Pro | V4-Flash | Źródło |
|---|---|---|---|
| SWE-bench Verified | **80.6%** | **79.0%** | llm-stats / morphllm / lightning |
| LiveCodeBench | 93.5% (top) | 91.6% | lightning / deepinfra |
| Codeforces | 3206 | 3052 | lightning / wavespeed |
| Terminal-Bench 2.0 | 67.9% | 56.9% | wavespeed |
| GPQA Diamond | 90.1 | 88.1 | lightning |
- **Cena Pro:** **$0.435 in / $0.87 out** (OpenRouter/AA, blended $0.18); część providerów $1.74/$3.48 (cache-miss). Cache hit $0.145.
- **Cena Flash:** **$0.14 in / $0.28 out** (cache hit $0.028) — ~36× taniej niż GPT-5.5. Szybszy (~60 t/s).
- **Caveat:** Pro verbose (180M tok na AA index, 62 t/s, długie reasoningi) → świetny do **batch/non-interactive**, nie do szybkich pętli.
- Źródła: [morphllm](https://www.morphllm.com/deepseek-v4) · [HuggingFace](https://huggingface.co/blog/deepseekv4) · [lightning.ai](https://lightning.ai/blog/deepseekv4comparison) · [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-pro) · [llm-stats](https://llm-stats.com/models/deepseek-v4-pro-max) · [ArtificialAnalysis](https://artificialanalysis.ai/models/deepseek-v4-pro) · [wavespeed](https://wavespeed.ai/blog/posts/deepseek-v4-pro-vs-flash)

### Kimi K2.7 Code — TOOL-CALLING / DŁUGI HORYZONT (Moonshot, 12.06.2026, 1T MoE/32B active, 256K, Modified MIT, thinking-only, temp=1.0)
| Benchmark | Wynik | Uwaga | Źródło |
|---|---|---|---|
| **MCP Mark Verified** | **81.1%** (bije Opus 4.8 76.4) | tool-calling king | totalum / flowtivity / reddit |
| Kimi Code Bench v2 | +21.8% vs K2.6 | vendor-only | cloudflare / venturebeat |
| Program Bench / MLS Bench | +11% / +31.5% | vendor-only | cloudflare |
| (proxy) K2.6 SWE-bench Verified | 80.2 / Pro 58.6 / TB2.0 66.7 | poprzednik | deepinfra / kili |
- **Cena:** **$0.95 in / $4.00 out**, cache $0.19. **−30% reasoning tokenów** vs K2.6 → tańszy realnie. Kimi Code CLI $19/mc.
- **Caveat:** brak niezależnych SWE-bench/Terminal-Bench (tylko vendor); VentureBeat: praktycy mówią, że headline'y „nie replikują się czysto"; nie zgłoszony do DeepSWE; thinking-only, brak kontroli temperatury.
- Źródła: [totalum](https://www.totalum.app/blog/kimi-k2-7-code-vs-claude-2026) · [flowtivity](https://flowtivity.ai/blog/kimi-k2-7-complete-review) · [VentureBeat](https://venturebeat.com/technology/kimi-k2-7-code-cuts-thinking-tokens-30-practitioners-say-benchmarks-dont-check-out) · [Cloudflare](https://developers.cloudflare.com/changelog/post/2026-06-12-kimi-k2-7-code-workers-ai) · [devops.com](https://devops.com/moonshot-ais-kimi-k2-7-code-targets-token-efficiency-in-agentic-coding) · [reddit r/kimi](https://www.reddit.com/r/kimi/comments/1u3ri2w/)

### Claude Opus 4.8 — KRYTYCZNE (Anthropic, 28.05.2026, `claude-opus-4-8`, 1M, 128K out)
| Benchmark | Wynik | Źródło |
|---|---|---|
| SWE-bench Verified | **88.6%** (niezależnie, $1.92) / 85.8 Claude Code | vals.ai |
| SWE-bench Pro | **69.2%** (najwyżej poza Fable 5) | morphllm / vm0 |
| OSWorld-Verified | 83.4 (najlepszy computer-use) | vm0 |
| MCP-Atlas | 82.2 (najlepszy tool-use) | vm0 |
| Terminal-Bench 2.1 | 74.6–85.0 | morphllm / z.ai |
- **Cena:** **$5 in / $25 out**, cache do −90%, batch −50%. Fast mode $10/$50 (2.5×, research preview).
- **Killer feature dla review:** „**~4× rzadziej przepuszcza błędy w code review**" niż 4.7 + najniższa halucynacja (abstynencja). Najlepszy PL.
- Źródła: [Anthropic](https://www.anthropic.com/news/claude-opus-4-8) · [vals.ai](https://vals.ai/benchmarks/swebench) · [morphllm](https://www.morphllm.com/claude-benchmarks) · [vm0](https://www.vm0.ai/en/models/claude-opus-4-8) · [Totalum](https://www.totalum.app/blog/claude-opus-4-8-totalum) · [Finout](https://www.finout.io/blog/claude-opus-4.8-pricing-2026-everything-you-need-to-know) · [simonwillison](https://simonwillison.net/2026/May/28/claude-opus-4-8)

### Claude Sonnet 4.6 — PL / KRYTYCZNY WORKHORSE (`claude-sonnet-4-6`, 200K/1M beta, 64K out)
| Benchmark | Wynik | Źródło |
|---|---|---|
| SWE-bench Verified | 79.6% | reddit r/compsci / onyx |
| Terminal-Bench 2.0 | 59.1 · OSWorld 72.5 | alexlavaee |
| GDPval-AA Elo | 1633 (bije Opus 4.6 na office) | reddit r/compsci |
- **Cena:** **$3 in / $15 out** (>200K: $10/$37.50). Najlepszy stosunek PL-jakość/cena.
- Źródła: [alexlavaee](https://alexlavaee.me/blog/sonnet-4-6-technical-breakdown) · [reddit r/compsci](https://www.reddit.com/r/compsci/comments/1r7ig2l/) · [onyx](https://onyx.app/insights/best-llms-for-coding-2026) · [morphllm](https://www.morphllm.com/claude-benchmarks)

### GPT-5.5 — TERMINAL/AGENTIC ALT (OpenAI, 23.04.2026, 1M, cutoff Dec 2025)
| Benchmark | Wynik | Źródło |
|---|---|---|
| SWE-bench Verified | **82.6%** (niezależnie, $1.36) | vals.ai |
| Terminal-Bench 2.0 | **82.7%** (dominuje; Opus 4.7 69.4) | openai / vellum |
| SWE-bench Pro | 58.6 (Opus 4.7 64.3 wyżej) | vellum / appwrite |
| DeepSWE | ~70 (lider) | startupfortune |
| OSWorld 78.7 · MCP-Atlas 75.3 · GDPval 84.9 | | openai |
- **Cena:** **$5 in / $30 out** (>272K: $8/$36). Pro $30/$180. **PL słabszy** (MMMLU 83.2 vs Opus 91.5).
- Źródła: [OpenAI](https://openai.com/index/introducing-gpt-5-5) · [Vellum](https://www.vellum.ai/blog/everything-you-need-to-know-about-gpt-5-5) · [Appwrite](https://appwrite.io/blog/post/gpt-5-5-launch) · [vals.ai](https://vals.ai/benchmarks/swebench) · [OpenRouter](https://openrouter.ai/openai/gpt-5.5) · [ai.cc](https://www.ai.cc/blogs/gpt-5-5-everything-you-need-to-know)

---

## 2. Master table (coding/agentic — najważniejsze)

| Model | SWE-V (indep.) | SWE-Pro | Terminal-B | MCP tool | $ in/out | Najlepsza rola |
|---|---|---|---|---|---|---|
| **GLM-5.2** | **82.8** | 62.1 | 81.0 | 76.8 | 1.40/4.40 (flat ~$12.6/mc) | **BAZA: dev lead/implementer, spec, deep review, root-cause, retro** |
| **MiniMax M3** | 80.5 | 59.0 | 66.0 | 74.2 | 0.30/1.20 (promo) | **szybki agent: discovery, spec-review, decomposer, recon, runner, cadence (multimodal)** |
| **DeepSeek V4 Flash** | 79.0 | — | 56.9 | dobry | **0.14/0.28** | **najtańszy bulk: test-gen, push, scenario-gen** |
| **DeepSeek V4 Pro** | 80.6 | 55.4 | 67.9 | dobry | 0.435/0.87 | debugger, first-pass, deployer, digest; alt coding (LiveCodeBench 93.5) |
| **Kimi K2.7 Code** | (K2.6: 80.2) | (58.6) | (66.7) | **81.1** MCP | 0.95/4.00 | refactorer, security, multi-file / MCP-heavy (tool-call king) |
| **Sonnet 4.6** | 79.6 | — | 59.1 | dobry | 3/15 | **PL user-facing, krytyczny tani** |
| **Opus 4.8** | **88.6** | **69.2** | 74.6–85 | **82.2** | 5/25 | **PLAN lead only** |
| GPT-5.5 | 82.6 | 58.6 | **82.7** | 75.3 | 5/30 | terminal (TEST) |

> PL ranking (multilingual): **Claude (Opus/Sonnet) > Gemini > GPT-5.5 > modele chińskie** (GLM/MiniMax/Kimi/DeepSeek słabsze w niuansach). → wszystko **user-facing po polsku = Claude**.

---

## 3. Routing po rolach — v2 (jeszcze taniej, GLM-centryczny)

| # | Etap | Primary | Escalacja | Uzasadnienie (dane) |
|---|---|---|---|---|
| P1 | Discovery synthesis | **MiniMax M3** | Opus 4.8 | szybki, tani; Opus tylko gdy złożone |
| P3 | Spec / design draft | **GLM-5.2** | Opus (arch) | SWE-V 82.8, Pro 62.1, flat-cost |
| P3b | Spec review (skeptic) | **MiniMax M3** | Opus 4.8 | szybki; Opus tylko przy wysokim ryzyku |
| P4 | Decompose → slices | **MiniMax M3** | GLM-5.2 | szybki, tani; GLM gdy złożone |
| P4b | Enrich AC/DoD (∥) | **MiniMax M3** | DeepSeek V4 Flash | szybki tani bulk równoległy |
| P6 | Linear push | **DeepSeek V4 Flash** | MiniMax M3 | najtańszy, JSON/tool OK |
| D1 | Dev recon | **MiniMax M3** | GLM-5.2 | szybki, multimodal |
| D2 | Dev follow-up (PL) | **MiniMax M3** | Opus | polski user-facing (modele CN słabsze) |
| D3 | Dev implement | **GLM-5.2** | Kimi K2.7 (multi-file/MCP), DeepSeek V4 Pro (hard/debugger) | SWE-V 82.8 baza; Kimi MCP 81.1 |
| R1 | Review first-pass | **DeepSeek V4 Pro** | MiniMax M3 | lepsza detekcja błędów niż Flash |
| R2 | Review deep | **GLM-5.2** | Kimi K2.7 Code / Opus 4.8 | SWE-Pro 62.1, flat-cost; Kimi/Opus przy wysokim ryzyku |
| T1 | Deploy orchestration (GCP) | **DeepSeek V4 Pro** | GPT-5.5 (terminal-heavy) | Terminal-B 67.9; GPT-5.5 82.7 gdy trzeba |
| T2 | Test scenario gen (bulk) | **DeepSeek V4 Flash** | MiniMax M3 | najtańszy |
| T3 | Test run + root-cause | **MiniMax M3** (runner, multimodal) → **GLM-5.2** (root-cause) | GPT-5.5 (terminal) | screenshoty UI; GLM root-cause; GPT-5.5 terminal |
| F | Eksperymenty | **Qwen3 Coder / GLM free** | — | zero kosztu |

**Efekt:** Opus tylko na leadzie PLAN; GLM-5.2 na deep review/root-cause/retro; MiniMax M3 na discovery/spec-review/decompose/recon/cadence; DeepSeek V4 Pro na debugger/first-pass/deployer/digest; DeepSeek V4 Flash na push/scenariusze; Kimi K2.7 Code na refaktor/security; GPT-5.5 na terminal. GLM Coding Plan (flat) sprawia, że bulk dev/spec jest ~zerowy krańcowo.

---

## 4. Mechanika `.bat` (provider + model w Claude Code)

Każdy agent = izolowany **`CLAUDE_CONFIG_DIR`** + provider przez env:
```bat
set CLAUDE_CONFIG_DIR=%~dp0configs\dev
set ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
set ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%
set ANTHROPIC_API_KEY=
set ANTHROPIC_MODEL=z-ai/glm-5.2
set ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4-8
set ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash
claude
```
- `ANTHROPIC_API_KEY=` pusty (inaczej CC wraca do Anthropic).
- Provider wymienny: OpenRouter / Z.ai (`/api/anthropic`) / Ollama / DeepSeek (Anthropic-format) / Kimi / MiniMax.
- ID modeli (OpenRouter): `z-ai/glm-5.2`, `minimax/minimax-m3`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2.7-code`, `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`.

---

## 5. Główne źródła zbiorcze (niezależne leaderboardy)
- [vals.ai — SWE-bench Verified](https://vals.ai/benchmarks/swebench) (Fable 5 95.0 · Opus 4.8 88.6 · GLM 5.2 82.8 · GPT-5.5 82.6)
- [morphllm — SWE-bench Pro leaderboard](https://www.morphllm.com/swe-bench-pro) (Opus 4.8 69.2 · GLM-5.2 62.1 · M3 59.0 · GPT-5.5 58.6)
- [SWE-bench.com](https://www.swebench.com) · [Artificial Analysis](https://artificialanalysis.ai) · [llm-stats](https://llm-stats.com)
- [Claude Code env vars](https://code.claude.com/docs/en/env-vars) · [Claude Code + OpenRouter](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)

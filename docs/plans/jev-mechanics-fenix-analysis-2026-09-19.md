# Jev (TypeSafe AI) — mechanika i zastosowanie w Fenixie

> **Data:** 2026-09-19
> **Autor:** supervisor (frontman)
> **Rodzaj:** analiza kierunku (nie task, nie PRD)
> **Pytanie Mateusza:** czym jest Jev, jak działa, i czy możemy odtworzyć jego mechaniki w Fenixie bez używania API typesafe.
> **Kontekst:** kontynuacja `docs/plans/mcp-pipeline-vision-analysis-2026-09-19.md` — Jev rozstrzyga napięcie §6.4 (API vs FT, extractive vs generative).

## 1. Czym jest Jev

Jev to pierwszy publiczny model **TypeSafe AI** (lab Diogo Almeida, ex-OpenAI; 2 lata w stealth; early access mid-September 2026). Reklamowany jako **„System One"** — szybki, intuicyjny odpowiednik wolnego, deliberatywnego „System Two" (reasoning LLM).

**Kontrakt:** *unstructured state in, typed probabilistic decisions out.* Dajesz tekst (email, log, ticket, JSON) + typed questions → dostajesz typed answers z calibrated probabilities i confidence.

**Kluczowa różnica vs LLM:** Jev **nie generuje tekstu w ogóle**. Zwraca decyzje z Fixed value space. Hallucination = ill-typed output, a że output space jest fixed z góry → „mathematically impossible", nie empirically measured.

## 2. Mechanika — precyzyjnie

### 2.1 Output types (co Jev potrafi zwrócić)

| Typ pola | Pytanie | Odpowiedź |
|---|---|---|
| `bool` | yes/no | `True` gdy probability ≥ threshold (default 0.5) |
| `Literal[...]` / string `Enum` | pick one | wybrana opcja (cardinality ≤ 255) |
| `IntEnum` 0,1,2,... z member docstrings | rubric score | najbliższy level + unrounded score |
| `list[Literal/Enum]` | one yes/no per option | opcje na które powiedział yes |
| `Literal \| None` | pick one, or none | opcja lub None |
| `float` ge=0 le=1 | probability of yes | unrounded probability |
| Nested model | its fields jako `outer.inner` | model |

**NIE wspierane (raises `UserError`):** `str`, unbounded `int`/`float`, `datetime`, `dict`, union-of-models jako field. **Jev nie potrafi zwrócić tekstu** — to jest fundament.

### 2.2 Typed questions (input)

- `state` — nieustrukturyzowany tekst do oceny („short, dense, detailed paragraph").
- `questions` — klucze zdefiniowane w `output_type` BaseModel. **Pytanie lives on field** (`Field(description=...)`), nie w prompcie. Prompt = tylko material to judge.
- Goal = output_type docstring. Shared framing = agent `instructions`.

### 2.3 Calibrated confidence

- `provider_details['confidence']` — 0..1 per field. **To margin, nie probability-that-right** — distance from deciding threshold, scaled 0 at threshold → 1 at certainty.
- `provider_details['probabilities']` — full distribution dla pick-one i rubric.
- `provider_details['scores']` — unrounded rubric positions.
- Claim: „higher confidence means higher accuracy" + „similar answers for similar inputs".
- Threshold tunable per use case (`typesafe_boolean_threshold`): podnieś gdy `True` musi być „earned", obniż gdy missing-true jest costly.

### 2.4 RLCD (Reinforcement Learning for Calibrated Decisions)

Training objective optimalizujący **calibrated decisions** na System One tasks. Nie RLHF (human preference), nie RLVR (verifiable rewards). Algorytmiczne szczegóły (reward function, loss) nieujawnione.

### 2.5 Parallel sampler

Wszystkie outputy w **jednym query**, nie autoregressive token-by-token. „Incredibly efficient and hardware-aware". Źródło claimed latency 70-500ms (vs 3-329s LLM) i free/cheap outputs.

### 2.6 Dwa nawyki (non-obvious)

1. **Ask one thing per field.** „Probably the most important concept." Złożone pytanie („is this a good pitch?") → plausible number z low confidence. Zamiast: rozbij na 3 konkretne (large market, feasible, differentiated) + combine w code.
2. **Question in prompt = just text to judge.** Jev nie sortuje pytań z materiału jak LLM — pytanie musi być na field description.

## 3. Dlaczego to jest relewantne dla Fenixa

Jev mechanika = **decision-shaped, typed, non-generative, calibrated**. To jest dokładnie brakujący kawałek z analizy wizji MCP (§6.4 napięcie API-vs-FT):

- **FOC-359 root cause:** 4B model *generuje* własne findings (findings_f1=0.04) zamiast *ekstraktować*. xgrammar gwarantuje shape, nie content.
- **Jev says:** nie generuj w ogóle. Decision-shape. Zwróć choice/score/bool, nie tekst.

**To rozstrzyga napięcie:** verdict-drafter FOC-359 style (parse review → findings JSON) jest **złego kształtu** — wymaga generacji tekstu (findings.text, evidence). Jev-style reframing: findings są **extracted deterministic** (regex/parser z passes), a model tylko **decision-shape'uje** (grounded? severity? evidence-prefix-match? yes/no per finding).

### 3.1 Co zyskujemy przez reframing

| Drafter (wizja) | Kształt FOC-359 (generative — fails) | Kształt Jev-style (decision — sound) |
|---|---|---|
| **verdict-drafter** | parse review → findings JSON (text) | given review + candidate findings (extracted), score each: grounded? severity-class? evidence-prefix-match? |
| **ac-drafter** | generate AC from issue body (text) | given issue + candidate AC labels (parsed), classify: is-AC? observable? testable? |
| **dod-drafter** | generate DoD (text) | given AC + candidate DoD items (template), rubric: covers-AC? verifiable? |
| **gate pre-screener** | (nie istnieje) | given question + docs, classify: answerable-from-docs? needs-human? type? |
| **review-round classifier** | fingerprint hash (deterministic) | given round N + round N-1, is-repeat? same-error-class? (semantic, nie hash) |
| **lint gate** | (nie istnieje) | rubric score per file: style/convention 0-2 |
| **routing** | deterministic config (models.json) | given issue content, which squad? which model tier? |

**Wzorzec:** ekstrakcja tekstu zostaje **deterministic** (regex/keyword/parser z passes/issue body). Model tylko **verify/score/classify/route** — decision-shaped, Jev-style. To eliminuje comprehension gap (FOC-359) bo model nie musi *reprodukować* tekstu, tylko *ocenić* go.

### 3.2 Co NIE jest Jev-style (zostaje generative)

- **handoff-compressor (FOC-283)** — musi generować compressed text/pinned-state. Nie decision-shaped. Zostaje extractive LLM (lesson FOC-359). **Ale:** *verifier* handoffa („does compressed preserve original state? rubric") = Jev-style.
- **spec-drafter** — generuje dokument. Nie decision-shaped.
- **digest-drafter** — generuje Polish prose. Nie decision-shaped.
- **root-cause-drafter** — reasoning, nie decision.

## 4. Jak odtworzyć mechaniki bez API typesafe — 3 ścieżki

### Ścieżka A: Frontier API model + forced tool-use (enum-only) — NAJPROSTSZE, działa dzisiaj

Claude / GPT z `tool_use` gdzie tool ma **tylko enum/bool/Int parametry** (jak `Literal`, `bool`, `IntEnum`). Model wybiera z enuma, nie generuje free-form.

- **Schema gate:** tool definition z `enum` params = model nie może wyjść poza enum. „Hallucination" = zły wybór wewnątrz enum (możliwa), ale **nie ill-typed output** (niemożliwa).
- **Confidence:** logprobs na enum tokenach → softmax → **margin** = `|p - threshold|` scaled 0→1. Anthropic zwraca `top_logprobs`; OpenAI też.
- **Parallel:** jedno `tool_use` z wieloma enum params = wszystkie pytania w jednym call. Mechanicznie równoległe (model wypełnia cały tool naraz).
- **Typed questions:** tool description = goal; per-param description = pytanie (jak `Field(description=...)`).
- **One thing per field:** rozbij złożone na osobne enum params, combine w code.
- **Limit:** API model nadal *generuje tokeny* (ograniczone do enum). Może wybrać złą opcję (comprehension), ale nie może złamać typu. Confidence = logprob margin (przybliżenie Jev's calibrated, nie RLCD-trained).

**To jest 80% Jev mechaniki na API modelu, dzisiaj, bez nowego runtime.**

### Ścieżka B: Open-weights + xgrammar enum-only — tanie, ale comprehension gap

xgrammar (FOC-359 Stage A, już dostępne) wymusza enum-only schema. Model generuje token enuma, xgrammar gwarantuje legalny.

- **Schema gate:** xgrammar `compile_json_schema` z enum properties = tylko legalne tokeny. FOC-359: 41%→91% schema (enum hallucination eliminated).
- **Confidence:** `model.output.logits` na enum tokenach → softmax → margin. Dostępne w HF `generate(return_dict_in_generate=True, output_logits=True)`.
- **Limit:** 4B model ma **comprehension gap** (FOC-359: findings_f1=0.04). Ale dla decision-shaped (yes/no, choice ≤255) gap jest **mniejszy** niż dla text generation — model ocenia, nie reprodukuje.
- **Limit:** xgrammar = Python; supervisor = Node. Cross-language (MCP server wrap). Nowy runtime component.
- **Limit:** Brak RLCD. Calibrated confidence = logit margin, nie RLCD-trained calibration. Może być over/underconfident.

### Ścieżka C: Klasyk ML (tabular) — dla decision-shaped z features

Dla zadań z ekstrahowalnymi features (gate pre-screener: question text + docs-presence + issue-state → features → classifier).

- **Model:** XGBoost / logreg z **calibrated probabilities** (Platt scaling / isotonic regression). `sklearn.calibration.CalibratedClassifierCV`.
- **Confidence:** calibrated proba = true probability-that-right (lepiej niż logit margin).
- **Limit:** potrzeba **labeled data**. Telemetria: 21 gate labels, 26 question-gates — za mało na cold start. FOC-359 memory: „gate pre-screener: 21 labels, zero negative class — not trainable yet."
- **Limit:** nie przetwarza raw text naturalnie (potrzeba features ekstrahowanych deterministic, nie end-to-end).
- **Plus:** rośnie z każdym runem (self-supervised pool 1143 sessions). Deterministyczny, audytowalny, tani.

### 4.1 Porównanie ścieżek

| Ścieżka | Schema gate | Confidence | Comprehension | Koszt | Dzisiaj? |
|---|---|---|---|---|---|
| **A: API + tool-use** | tool enum (strong) | logprob margin (ok) | frontier (best) | API $ | ✅ tak |
| **B: open-weights + xgrammar** | xgrammar enum (strong) | logit margin (ok) | 4B gap (decision OK, text fail) | lokalny | ✅ harness istnieje |
| **C: tabular ML** | n/a (deterministic) | calibrated proba (best) | features tylko | tani | ❌ za mało labels |
| **(ref: Jev API)** | structural (math) | RLCD-calibrated | frontier (claim) | $0.042/M | early access |

**Rekomendacja:** **Ścieżka A** dla prototypu (działa dzisiaj, frontier comprehension, tool-use = enum gate). **Ścieżka C** dla **gate pre-screener** gdy labels dorosną (21→100+, kalibrowany proba > logit margin). **Ścieżka B** dla high-volume decision-shaped gdy cost matters (4B decision OK, bo nie text).

## 5. Mapowanie na Fenix — konkretne kandydaty

### 5.1 Gate pre-screener (★★★★★, najlepszy cold start)

**Dzisiaj:** 26 question-gates w erze supervisor, 21 answered. **31% already answered by docs** (telemetry F4). 5/26 = kickoff-visibility failures (FOC-272 §6).

**Jev-style reframing:**
```python
class GateScreen(BaseModel):
    """Classify a child's question gate."""
    answerable_from_docs: bool = Field(description="Does docs/ACCESS.md or squad CLAUDE.md answer this?")
    needs_human_decision: bool = Field(description="Is this a decision only Mateusz can make?")
    gate_type: Literal["kickoff-visibility", "scope", "ambiguity", "push", "cleanup", "other"]
    confidence: float = Field(ge=0, le=1, description="probability answerable_from_docs is True")
```
- `answerable_from_docs=True` + high confidence → auto-route do docs lookup, nie relay do Mateusz.
- `needs_human_decision=True` → relay (HITL zachowany).
- **Kontrowersyjne:** auto-answering gate łamie hard rule „Never answer a gate on Mateusz's behalf". Ale: jeśli gate to „jak się zalogować?" (ACCESS.md) i confidence ≥0.95, to relay do Mateusz żeby potwierdził auto-answer, nie ciche auto-answer. HITL stays.

### 5.2 Verdict verifier (★★★★, rozwiązuje FOC-359)

**Dzisiaj:** frontman hand-pisze verdict (43.5% cost). FOC-359: 4B generuje findings → f1=0.04.

**Jev-style reframing:** findings EXTRACTED deterministic z passes (regex/keyword z Conventional Comments), model VERIFIES:
```python
class FindingVerify(BaseModel):
    """Verify a candidate finding extracted from review passes."""
    grounded: bool = Field(description="Does the review text support this finding?")
    severity: Literal["issue","todo","nit","question","praise"]
    evidence_prefix_match: bool = Field(description="Does evidence cite a real artefact:line?")
```
- Per finding, parallel (wszystkie w jednym call).
- `grounded=False` → drop. `severity` → classify. `evidence_prefix_match=False` → flag.
- **Eliminates comprehension gap:** model nie reprodukuje text, ocenia go. 4B / API oba działają.
- **HITL:** supervisor zatwierdza verified verdict (istniejący kontrakt).

### 5.3 Review-round repeat classifier (★★★)

**Dzisiaj:** `progressFingerprint` = hash(diff+failingTests). Repeated hash → refuse 3rd round. Ale: **54% round-pairs re-prezentuje samej klasy błędu** (telemetry B3) — hash łapie identyczne, nie semantyczne.

**Jev-style:** given round N findings + round N-1 findings, per-finding: `is_same_error_class: bool`. Semantyczne, nie hash. Łapie „same bug, different fix attempt".

### 5.4 Lint gate before review (★★★, telemetry R4)

**Dzisiaj:** 18% findings = style nits (linter's job). Review child traci czas na style.

**Jev-style:** rubric score per file przed review:
```python
class LintScore(IntEnum):
    clean = 0      # """No style/convention issues."""
    minor = 1      # """Nits only, non-blocking."""
    blocking = 2   # """Style issues that block review."""
```
- `blocking` → dev fix before review. `minor` → auto-fix lub ignore. `clean` → review focuses on logic.

### 5.5 DoR gate (★★★)

**Dzisiaj:** PLAN child检查 DoR heurystycznie. 5/26 gate failures = kickoff-visibility.

**Jev-style:** given issue body, rubric:
```python
class DoRScore(BaseModel):
    has_acceptance_criteria: bool
    has_scope: bool
    has_context: bool
    is_actionable: bool = Field(description="Could a DEV child start today?")
```

### 5.6 AC mapping verifier (★★★)

**Dzisiaj:** `acMapping` 72/89 populated, 17 missing. Pass wymaga AC-by-AC.

**Jev-style:** given AC list + review, per AC: `mapped: bool`, `evidence_grounded: bool`. Łapie brakujące mapowania.

## 6. Co musiałoby powstać w Fenixie (nieadditive)

### 6.1 Decision-shaped tool-use seam (Ścieżka A)

Supervisor potrzebuje call site: zamiast `supervisor-followup.mjs --review-loop` z raw findings, wywołać API model z **tool_use enum-only** i collect verified decisions. To jest:

- `scripts/decision-call.mjs` — wrapper: buduje tool definition z JSON schema (enum/bool/Int), call API, parse logprobs → margin, return `{decisions, confidences}`.
- Reuse `provider-resolve.mjs` (baseUrl + model). Reuse `config/models.json` pricing.
- **Nie nowy runtime** — Node, istniejąca infra.

### 6.2 Deterministic extractors (przed decision-shape)

Dla verdict verifier: `scripts/extract-findings.mjs` — regex/keyword z Conventional Comments passes → candidate findings[]. To jest parser, nie LLM. FOC-359 `export-dataset.mjs` ma część tego (condenseText, evidence extraction).

### 6.3 Confidence threshold policy

Per decision type, threshold (jak `typesafe_boolean_threshold`):
- `answerable_from_docs`: threshold 0.95 (high — auto-route tylko gdy very confident).
- `grounded`: threshold 0.5 (default).
- `is_repeat`: threshold 0.7.
- Konfigurowalne w `config/decision-thresholds.json`.

### 6.4 Telemetry dla decisions

`agent_key = "decision-call"`, meter per call: input tokens, decisions[], confidences, thresholds, outcomes (did supervisor accept?). Dziś `delegation_links` ma NULL cost — trzeba meterować.

### 6.5 HITL kontrakt (zachowany)

Każda decision → supervisor review + approve (istniejący gate contract). `draft-approval` gate type (nowy kind) lub reuse `question`. Model decision-shape'uje, supervisor zatwierdza — ten sam wzorzec co gates.

## 7. Sceptyczna ocena

### 7.1 Co jest sound

- **Reframing generative → decision-shaped** rozwiązuje FOC-359 root cause (comprehension gap). Model ocenia, nie reprodukuje.
- **Typed output (enum/bool/Int)** = schema validity by construction (Ścieżka A tool-use, Ścieżka B xgrammar). xgrammar już proven (41%→91%).
- **Calibrated confidence** (logit margin / Platt) lepsze niż subjective `--confidence` (dzisiaj frontman pisze 0-100).
- **Gate pre-screener** = najlepszy cold start (31% gates answerable z docs, realny lever).

### 7.2 Co jest ryzykowne / niepewne

- **Jev launch figures niezweryfikowane niezależnie.** 40-200× faster, „never hallucinates" — marketing, nie peer-reviewed. Mechanika jest sound, ale konkretne liczby wstrzymać.
- **RLCD nieujawnione.** Nie wiemy jak calibrated confidence jest trenowane. Nasze logit-margin / Platt to przybliżenie, nie RLCD. Może być over/underconfident na edge cases.
- **Comprehension gap dla decision-shaped na 4B** — mniejszy niż dla text, ale nonzero. FOC-359: verdict_accuracy 82% (decision-shaped OK), findings_f1 0.04 (text fail). Potwierdza: 4B decision OK, text nie.
- **Auto-answering gates** łamie hard rule jeśli ciche. HITL musi zostać — supervisor potwierdza auto-answer.
- **21 gate labels** za mało na tabular ML (Ścieżka C) cold start. Ale rośnie.
- **Deterministic extractors** (regex z passes) mogą gubić findings — garbage-in do verifier. Verifier ocenia candidate, nie wyciąga; jeśli extractor przegapi finding, verifier go nie zobaczy. **Extractor quality = ceiling.**
- **Więcej integration points** — telemetry F1: 22/38 bad turns = provider-side. Decision-call = kolejny integration point z własnym failure mode.

### 7.3 Co NIE działa (wprost)

- **Jev NIE zastępuje handoff-compressor** (FOC-283) — ten musi generować. Jev tylko verify.
- **Jev NIE zastępuje spec/digest/root-cause** — generative/reasoning.
- **Jev NIE ekstraktuje tekstu** (findings, evidence). Ekstrakcja zostaje deterministic; Jev decision-shape'uje na candidate.

## 8. Rekomendacja dla Mateusza

### 8.1 Kolejność (konsyserwatywna)

1. **Gate pre-screener (Ścieżka A, API + tool-use)** — najlepszy cold start, 31% gates answerable z docs, realny lever, mały scope. Tu rozstrzygnąć HITL (supervisor potwierdza auto-answer, nie ciche).
2. **Verdict verifier (Ścieżka A)** — rozwiązuje FOC-359. Findings extracted deterministic, model verify. Największy cost lever (43.5%).
3. **Lint gate (Ścieżka A)** — usuwa 18% style nits z review.
4. **Review-round repeat classifier** — semantyczny repeat detection (dziś hash).
5. **(później) Ścieżka C tabular** dla gate pre-screener gdy labels 21→100+.

### 8.2 Co odtworzyć, co nie

| Mechanika Jev | Odtworzyć w Fenixie? | Jak |
|---|---|---|
| Typed output (enum/bool/Int, nie str) | ✅ tak | tool-use enum (A) / xgrammar (B) |
| Calibrated confidence (margin) | ✅ częściowo | logprob margin (A/B), Platt (C) — nie RLCD |
| Parallel (all questions one call) | ✅ tak | jedno tool_use wieloparam (A) |
| One thing per field | ✅ tak | per-param description, combine w code |
| Question on field not prompt | ✅ tak | tool/param description |
| RLCD training | ❌ nie | nieujawnione; użyj API model (A) lub logit margin (B) |
| Parallel sampler hardware | ❌ nie | API model autoregressive (ale tool_use parallel w jednym call) |
| „Never hallucinate" structural | ✅ częściowo | enum gate = no ill-typed; zły wybór w enum możliwy |

### 8.3 Decyzje do Mateusza

1. **Czy reframing drafterów z generative na decision-shaped jest akceptowalny?** To zmienia kontrakt: findings extracted deterministic, model verify (nie generate). Verdict-drafter FOC-359-style → verdict-verifier Jev-style.
2. **Czy gate pre-screener z HITL-confirmed auto-answer jest OK?** (Hard rule: never answer gate on Mateusz's behalf — ale jeśli relay „auto-answer proposed: X, confidence 0.96, confirm?" to HITL stays.)
3. **Ścieżka A (API, $) czy B (open-weights, lokalny)?** A = frontier comprehension, koszt; B = tanie, comprehension gap na 4B (decision OK), xgrammar Python.
4. **Czy próbujemy Jev API (OpenRouter `typesafe/jev-1.13`)?** Mamy OpenRouter w config. Early access, ale daje RLCD-calibrated (nie nasz logit-margin). Mateusz mówił „niekoniecznie uzywac api od typesafe" — więc opcjonalne, jako benchmark.

---

*Źródła: [TypeSafe AI blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Pydantic AI docs](https://pydantic.dev/docs/ai/models/typesafe/), [Beam AI analysis](https://beam.ai/agentic-insights/jev-typesafe-ai-agents). Mechanika zweryfikowana przez `WebFetch` na blog + Pydantic docs. Launch figures niezależnie niezweryfikowane.*

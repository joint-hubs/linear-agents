# Verdict-parser fine-tuning — pełny przewodnik

> Dokument opisuje cały pipeline fine-tuningu dla pilota FOC-359: skąd dane, jak
> się je formatuje, jak trenujemy model, co się w nim zmienia, i jak xgrammar
> gwarantuje poprawność JSON na wyjściu. Pisane dla kogoś bez doświadczenia w LLM/FT.

## TL;DR — co robimy i dlaczego

Mamy system (supervisor), który po każdym code review generuje werdykt jako JSON
(`verdict`, `findings`, `acMapping`, `fingerprint`). Werdykt jest dziś pisany przez
duży model (Claude). Chcemy nauczyć **mały model** (Qwen3-4B), żeby robił to samo —
tłumaczył tekst recenzji na ten konkretny JSON — bo mały model jest tańszy i szybszy.

Fine-tuning = bierzemy gotowy model Qwen3-4B (bazowy, znający ogólnie język i JSON)
i "uczymy go" na 140 prawdziwych parach (review-text → verdict-JSON), żeby
specjalizował się w naszym konkretnym formacie. xgrammar = zabezpieczenie na
wyjściu: wymusza poprawność struktury JSON w momencie generowania, żeby model nie
mógł wyplcić niepoprawnego JSON-a.

---

## 1. Skąd mamy dane

### Źródło: `.state/supervisor/`

Każdy raz gdy supervisor przeprowadza code review, zapisuje na dysk:

- **Werdykt** — plik `.json` w `.state/supervisor/<run-id>/verdicts/<task-id>-round<N>.json`
  - Zawiera: `verdict` ("pass"/"fail"), `findings[]`, `acMapping[]`, `fingerprint`,
    `childId`, `runId`, `taskId`, `round`
- **Tee review-child** — plik `.jsonl` w `.state/supervisor/<run-id>/children/<child-id>.jsonl`
  - Pełny zapis rozmowy review-child z modelem (kolejne wiadomości assistant/user)
  - Ostatnia wiadomość `assistant` = **"odprawa"** — finalny tekst statusu recenzji

### Jak to łączymy w pary (export-dataset.mjs)

Skrypt `ft/verdict-parse/export-dataset.mjs`:

1. **Spacer po verdicts** — znajduje wszystkie `.json` w drzewie `verdicts/`
2. **Dla każdego verdict** — pobiera `childId` + `runId`, znajduje tee child-a,
   wyciąga **ostatnią wiadomość assistant** (= tekst recenzji)
3. **Projekcja output** — z verdictu wyciąga tylko pola, które model ma generować:
   - `verdict` (pass/fail)
   - `findings[]` — `severity`, `text`, `evidence` (każdy skrócony do ~40 znaków)
   - `acMapping[]` — `ac`, `evidence` (skrócony do 120 znaków)
   - `fingerprint.failingTests[]` (lista nazw testów, które failed)
   - Odrzuca: `declaredAcs`, `fingerprint.{diff,tests,combined,changedFiles,error}` —
     te są runtime-filled (model nie widzi worktree, nie może ich predictować)
4. **Walidacja schemy** — sprawdza czy output jest poprawny (verdict w enum, severity w
   enum, evidence nie-puste). Niepoprawne pary są dropowane z logiem przyczyny.

### Format pary

```json
{
  "input": "diff-stats: changedFiles=3\n[ostatni tekst recenzji — 'odprawa']",
  "output": {
    "verdict": "fail",
    "findings": [
      {"severity": "issue", "text": "broken CLI wrapper --model flag", "evidence": "scripts/cli.mjs:42"}
    ],
    "acMapping": [
      {"ac": "AC-1", "evidence": "scripts/test.mjs:12 — 64/64 pass"}
    ],
    "fingerprint": {"failingTests": []}
  },
  "_src": "FOC-114-round1@2026-09-14-supervisor-foc-114",
  "_verdict": "fail"
}
```

### Skrócenie tekstu (condenseText / condenseEvidence)

Oryginalne finding text'y z werdyktów mogą być długie (180+ znaków, pełne zdania).
Eksperyment pokazał że **krótki text = wyższy lemma_overlap** (patrz §5.2). Dlatego
`condenseText` obcina do **40 znaków** (pierwsze zdanie lub prefix), a `condenseEvidence`
do 120. To samo na train i eval — F1 mierzy się na skróconym goldzie.

### Split 80/20

- **Stratyfikowany po tasku** — wszystkie rundy jednego tasku trafiają do tego samego
  splitu (nie ma leakagu: model nie widzi w eval tasku, którego widział w train)
- 140 par train, 34 par eval (po re-export)
- Deterministyczny (sortowanie po src, równomierny sampling)

### Augmentacja (augment-paraphrase.mjs)

140 par to mało do fine-tuningu. `augment-paraphrase.mjs` podwaja zbiór:

- Dla każdej pary: bierze **input** (review body) i prosi glm-5.3 o parafrazę
  (inne słowa, ten sam sens, zachowane nazwy plików/liczby/AC)
- **Output (gold JSON) nie jest dotykany** — parafrazujemy tylko input
- Dlaczego: §5 bar ewaluuje na **prawdziwych** tekstach recenzji (held-out). Parafrazy
  w train dodają różnorodność leksykalną w stylu supervisora, nie zanieczyszczając eval.
- **Gotcha**: glm-5.3-flash ma mandatory reasoning, które zjada max_tokens na długich
  tekstach → `finish=length` → null content → 50/280 faili. glm-5.3 (nie-flash) ma
  minimalny reasoning, działa. Mimo to ~30% parafraz zawodzi na długich inputach.

---

## 2. Fine-tuning runtime — jak model się uczy

### QLoRA — co to i dlaczego

Pełny fine-tuning 4B modelu = aktualizacja wszystkich 4 miliardów wag. Na jednej GPU
(RTX 5070 Ti, 16 GB VRAM) to się nie mieści. **QLoRA** to trik, który rozwiązuje:

1. **4-bit quantization (nf4)** — bazowe wagi modelu są kompresowane do 4 bitów
   (zamiast 16/32). 4B model zajmuje ~1.5 GB zamiast ~8 GB. Wagi są **zamrożone**
   (frozen) — nie są aktualizowane w trakcie treningu.

2. **LoRA (Low-Rank Adaptation)** — zamiast modyfikować wagi, dokłada **małe
   adaptery** obok wybranych warstw. Każdy adapter to dwa małe matrixy A i B, gdzie
   wynik = A × B (low-rank: r=16, alpha=32). Te adaptery są trenowalne, ale mają
   drastycznie mniej parametrów niż oryginalne wagi (dla 4B modelu: ~40M vs 4B).

3. **BitsAndBytes (bnb)** — biblioteka, która realizuje 4-bit quant na GPU.

### Co się konkretnie zmienia w modelu

```
┌─────────────────────────────────────────────────┐
│  Qwen3-4B (frozen, 4-bit nf4)                    │
│                                                   │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    │
│  │ q_proj   │    │ k_proj   │    │ v_proj   │    │
│  │ (frozen) │    │ (frozen) │    │ (frozen) │    │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    │
│       │               │               │          │
│       ▼               ▼               ▼          │
│  ┌─────────┐     ┌─────────┐     ┌─────────┐     │
│  │ LoRA A  │     │ LoRA A  │     │ LoRA A  │     │
│  │ LoRA B  │     │ LoRA B  │     │ LoRA B  │     │
│  │(trained)│     │(trained)│     │(trained)│     │
│  └─────────┘     └─────────┘     └─────────┘     │
│                                                   │
│  + o_proj, gate_proj, up_proj, down_proj         │
│    (same pattern: frozen base + LoRA adapter)     │
└─────────────────────────────────────────────────┘
```

- **Wagi bazowe**: zamrożone, 4-bit, nie ruszają się
- **LoRA adaptery** (A, B na 7 warstwach: q/k/v/o/gate/up/down_proj): trenowalne,
  to one "noszą" wiedzę o naszym zadaniu
- Po treningu zapisujemy tylko adaptery (~100 MB), nie cały model

### Jak przebiega trening (train.py)

1. ** Ładowanie modelu**:
   - `BitsAndBytesConfig(load_in_4bit=True, nf4, double_quant)` — 4-bit z podwójnym
     kwantowaniem (dodatkowa kompresja)
   - `AutoModelForCausalLM.from_pretrained("Qwen/Qwen3-4B", quantization_config=bnb)`
   - `use_cache = False` — w treningu KV-cache nie jest potrzebny

2. **Format konwersacyjny**:
   ```python
   {"messages": [
     {"role": "system", "content": SYSTEM_PROMPT},
     {"role": "user", "content": r["input"]},
     {"role": "assistant", "content": json.dumps(r["output"])},
   ]}
   ```
   TRL `SFTTrainer` rozumie ten format i automatycznie maskuje prompt
   (`assistant_only_loss=True`) — loss liczy się tylko na tokenach assistant (nasz
   JSON), nie na promptach. Model uczy się **generować** JSON, nie odtwarzać inputu.

3. **Trening właściwy**:
   - `SFTTrainer` (Supervised Fine-Tuning) z `peft` (LoRA config)
   - Hiperparametry: 3 epoki, lr=2e-4, batch=2, grad_accum=4 (effective batch=8),
     cosine scheduler, warmup 3%
   - `bf16=True` — mieszana precyzja (bfloat16 dla stabilności numerycznej)
   - `max_length=4096` — długość sekwencji (dłuższe = więcej VRAM)
   - `packing=False` — każda para osobno, nie pakuje wielu w jedną sekwencję

4. **Co się dzieje w każdej iteracji**:
   - Forward pass: model dostaje prompt + target (assistant JSON), generuje logity
     (prawdopodobieństwa tokenów) dla każdej pozycji
   - Loss: cross-entropy między predykcją a rzeczywistymi tokenami — ale tylko na
     tokenach assistant (dzieki `assistant_only_loss`)
   - Backward pass: gradienty płyną tylko przez LoRA adaptery (base jest frozen)
   - Optimizer: AdamW z lr=2e-4 aktualizuje wagi adapterów
   - Po `grad_accum=4` krokach: jeden optymalizator step (akumulacja gradientów)

5. **Zapis**:
   - `trainer.save_model("adapter/")` — zapisuje tylko LoRA adaptery + tokenizer
   - ~100 MB, nie cały 4B model

### Jak model "dobiera dane"

Model nie dobiera danych — **my** je dobieramy. SFT (Supervised Fine-Tuning) to
uczenie nadzorowane: każda para ma input (X) i gold output (Y). Model uczy się
mapowania X → Y. Nie ma tu Reinforcement Learning, nie ma self-play, nie ma
exploration. Model po prostu minimalizuje loss na parach, które mu dajemy.

To, co **my** dobieramy:
- **Zbiór danych**: prawdziwe werdykty z `.state/supervisor/` (jedyne źródło prawdy)
- **Format**: skrócony text/evidence (żeby gold był kompaktowy i osiągalny)
- **Augmentację**: parafrazy inputu (żeby model widział różne sformułowania tego
  samego review)
- **Split**: stratyfikowany po tasku, bez leakagu
- **Hyperparametry**: lr, epoki, LoRA r/alpha — dobieramy empirycznie (4 itery, każda
  inna kombinacja)

---

## 3. xgrammar — constrained decoding szczegółowo

### Problem, który rozwiązuje

Nawet po fine-tuningu, model czasem generuje niepoprawny JSON:
- Zła wartość enum (np. `severity: "blocker"` zamiast `"issue"`)
- Brakujące pola, brak klamry, ucięty JSON
- Dodatkowy tekst (prose) poza JSON

W naszych 4 iteracjach: schema_validity 18%–41%. Model rozumie zadanie, ale gubi się
na szczegółach schemy.

### Jak działa constrained decoding

Klasycznie model generuje token po tokenu. W każdym kroku:
1. Model produkuje **logity** — wektor prawdopodobieństw dla każdego tokenu w słowniku
   (dla Qwen3: 151936 tokenów)
2. **Sampling** — wybiera token (greedy = argmax, albo sampling z temperaturą)
3. Wybrany token dokleja do sekwencji, idź do 1

xgrammar wstrzykuje się między (1) a (2):

1. Model produkuje logity (niezmienione)
2. **xgrammar oblicza bitmaskę** — dla każdego z 151936 tokenów: "czy ten token jest
   poprawny jako następny, biorąc pod uwagę co już wygenerowano i schemę JSON?"
   - Jeśli jesteśmy po `{verdict":` — tylko `"pass"` i `"fail"` (i ewentualne
     warianty z cudzysłowami) są poprawne → bitmask = 1 dla tych, 0 dla reszty
   - Jeśli jesteśmy po `{` na początku — tylko `"verdict"` (jako klucz) jest poprawne
3. **Apply bitmask** — wyzeruj logity dla niepoprawnych tokenów (softmax po nich → 0)
4. Sampling — wybierz token tylko z dozwolonych

### Co dokładnie xgrammar kompiluje

```python
schema = json.dumps({
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "findings": {"type": "array", "items": {"type": "object", ...}},
        ...
    },
    "required": ["verdict", "findings", "acMapping", "fingerprint"]
})
compiler = xgr.GrammarCompiler(tokenizer_info)
compiled = compiler.compile_json_schema(schema)  # CompiledGrammar
```

`compile_json_schema` zamienia JSON Schema na **Context-Free Grammar (CFG)** —
zestaw reguł produkcji typu:
- `root → '{' verdict_kv findings_kv acMapping_kv fingerprint_kv ',' '}'`
- `verdict_kv → '"verdict"' ':' string_pass_or_fail`
- `string_pass_or_fail → '"pass"' | '"fail"'`
- `findings → '[' finding_obj (',' finding_obj)* ']' | '[' ']'`

Następnie CFG jest kompilowana do automatu ze stanami — w każdym kroku xgrammar wie,
jakie tokeny są legalne w obecnym stanie. Enum (`pass`/`fail`, 5 severities) jest
obsługiwany natywnie (alternacja w CFG).

### LogitsProcessor — integracja z HF generate

xgrammar dostarcza `xgr.contrib.hf.LogitsProcessor`, który podpinamy do
`model.generate(logits_processor=[...])`:

```python
# Fresh LogitsProcessor per generate() call — holds matcher state
lp = xgr.contrib.hf.LogitsProcessor(compiled_grammar)
out_ids = model.generate(
    **inputs,
    max_new_tokens=2048,
    do_sample=False,
    pad_token_id=tok.pad_token_id,
    logits_processor=[lp],  # ← xgrammar constrained decoding
)
```

W każdej iteracji generate():
1. `lp(input_ids, scores)` jest wołany z obecnymi logitami
2. `GrammarMatcher.fill_next_token_bitmask` — buduje maskę dla obecnego stanu CFG
3. `apply_token_bitmask_inplace(scores, bitmask)` — wyzeruje niepoprawne logity
4. Matcher akceptuje wybrany token, przechodzi do następnego stanu

### Backend torch_native — dlaczego nie triton

xgrammar domyślnie używa **triton** do apply bitmask (szybki kernel GPU). Ale triton
**nie jest dostępny na Windows** (`pip install triton` → "no matching distribution").

Rozwiązanie: `backend="torch_native"` — czysty PyTorch kernel (wolniejszy, ale działa).
W eval.py patchujemy `xgr.apply_token_bitmask_inplace`, wymuszając `torch_native`:

```python
_orig = xgr.apply_token_bitmask_inplace
def _patched(logits, bitmask, **kw):
    kw.setdefault("backend", "torch_native")
    return _orig(logits, bitmask, **kw)
xgr.apply_token_bitmask_inplace = _patched
```

### float32 compute dtype — watch-item

xgrammar bitmask operuje na logitach. Jeśli logity są bf16, bitmask kernel może
mieć problemy numeryczne (bf16 ma niską precyzję). Dlatego w eval.py:

```python
bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_compute_dtype=torch.float32,  # ← float32 dla xgrammar bitmask
)
```

W treningu zostaje bf16 (szybszy, stabilny), w evalu — float32 (dla xgrammar).
Koszt: ~2× wolniejszy forward, ale eval jest 27 par, ~45s/pair = ~20 min — akceptowalne.

### vocab_size — watch-item

Qwen3 ma `tokenizer.vocab_size = 151680` ale `model.config.vocab_size = 151936`
(256 padding tokenów). xgrammar musi znać pełny rozmiar, żeby bitmaska pokrywała
wszystkie logity. Bez tego: ostrzeżenie "bitmask covers 151680 but logits have 151936"
i nieonguardowane tokeny mogą przecieknąć. W eval.py:

```python
full_vocab = getattr(base.config, "vocab_size", None) or len(tok)
tok_info = xgr.TokenizerInfo.from_huggingface(tok, vocab_size=full_vocab)
```

### Overhead

xgrammar dodaje ~0.1ms/token (sprawdzanie stanu CFG + apply bitmask). Dla 2048
tokenów: ~0.2 s dodatkowego czasu na generację. W praktyce <2% overhead pod obciążeniem.
W naszym eval: ~45s/pair unconstrained → ~45s/pair constrained (overhead pomijalny).

### Czego xgrammar NIE gwarantuje

- **Poprawność semantyczna** — xgrammar gwarantuje że JSON jest strukturalnie poprawny
  (klamry, enum, typy), ale nie że `text` ma sens albo że `findings` są kompletne.
- **Kompletność** — jeśli model wygeneruje pusty `findings: []`, xgrammar to
  akceptuje (pusta lista jest poprawna). Ale gold może mieć 5 findingów → F1 = 0.
- **Długość** — jeśli model wygeneruje bardzo długi JSON i wyczerpa `max_new_tokens`,
  xgrammar ucięcie w połowie → niepoprawny JSON (truncated). xgrammar nie kontroluje
  długości, tylko strukturę do punktu ucięcia.

---

## 4. Ewaluacja — §5 bar

### Dwa kryteria (oba muszą być spełnione)

1. **Schema validity 100%** — każdy output z eval parsuje się jako JSON i przechodzi
   `validate_output()` (verdict w enum, severity w enum, evidence nie-puste,
   fingerprint jest obiektem z failingTests array). Jedno niepoprawne = fail pilota.

2. **Field-level macro F1 ≥ 0.80** — średnia z trzech metryk:
   - **verdict_accuracy** — exact match na `verdict` (pass/fail)
   - **findings_f1** — F1 na liście findingów. Finding match = severity dokładnie +
     lemma_overlap(text) ≥ 0.60 + evidence_prefix_match (artefakt:linia)
   - **acMapping_f1** — F1 na liście AC. AC match = ac dokładnie (case-insensitive) +
     evidence_prefix_match

   `macro_f1 = (verdict_acc + findings_f1 + acMapping_f1) / 3`

### Jak liczy się F1

```
TP = predykowane findingi, które matchują gold (severity + lemma + evidence)
FP = predykowane findingi, które nie matchują żadnego gold
FN = gold findingi, które nie zostały predykowane

precision = TP / (TP + FP)
recall    = TP / (TP + FN)
F1 = 2 × P × R / (P + R)
```

Matching jest 1:1 (każdy gold matchuje się z co najwyżej jednym predykowanym).
lemma_overlap mierzy ile słów (lowercase, alfanumeryczne) mają wspólnego pred i gold,
dzielone przez min(długości). Próg 0.60 — teksty muszą być dość podobne leksykalnie.

### Diagnoza 3-warstwowa (z 4 iteracji)

| Warstwa | Problem | xgrammar fix? |
|---|---|---|
| 1. Severity enum | Model halucynuje `blocker`, `blocking`, `nitpick` | ✅ Tak — enum wymuszony |
| 2. Finding text | Model nie reprodukuje tekstu gold (lemma_overlap 0.17–0.48 < 0.60) | ❌ Nie — xgrammar nie zmienia treści |
| 3. Empty findings | Model generuje `[]` dla pass verdictów (10/11 valid) | ❌ Nie — pusta lista jest poprawna |

**Diagnostic A potwierdził**: xgrammar podniósł schema 41%→93%, verdict_acc 37%→74%,
ale findings_f1 = 0.0 (tekst nie matchuje) → macro_f1 = 0.25 (daleko od 0.80).

2 schema-invalid pary to **truncation** — długi text/evidence wyczerpał max_new_tokens.
40-char condensing ma to rozwiązać (krótszy text = mniej tokenów = mniej truncation +
  wyższy lemma_overlap).

---

## 5. Co jeszcze warto wiedzieć

### Dlaczego Qwen3 a nie inny model

- Qwen3-4B jest zoptymalizowany pod multilingual (polski + angielski) i reasoning
- 4B to "sweet spot": wystarczająco duży, żeby rozumieć JSON/schema, wystarczająco
  mały, żeby zmieścić się na jednej GPU w 4-bit (1.5 GB VRAM)
- Mniejszy (1.7B) nie miał pojemności — 4 itery na 1.7B: schema 0–22%, F1 0.06–0.08

### Dlaczego nie full fine-tuning

- 4B model w bf16 = ~8 GB VRAM na same wagi. Z gradientami + optimizer state: ~24 GB.
  RTX 5070 Ti ma 16 GB. Pełny FT się nie mieści.
- QLoRA rozwiązuje: 4-bit base (1.5 GB) + LoRA adaptery (~40M params) + optimizer
  state na adaptery → ~3 GB VRAM. Mieści się z zapasem.

### Dlaczego nie unsloth

- unsloth (biblioteka, która przyspiesza QLoRA 2×) potrzebuje natywnych C-ext DLLs.
- Na tym środowisku (Windows + WDAC policy) venv-blocked DLLs — unsloth nie startuje.
- Zajście: peft + trl + bitsandbytes (standard stack, nieco wolniejszy, ale działa).

### Dlaczego conversational format

- TRL `SFTTrainer` z `{"messages": [...]}` rozumie role (system/user/assistant)
- `assistant_only_loss=True` maskuje prompt automatycznie — loss tylko na assistant
  (nasz JSON). Bez tego model uczy się też odtwarzać input (marnuje pojemność).
- To kluczowe dla verdict-parser: chcemy, żeby model **generował** JSON, nie
  memorował review text.

### Dlaczego non-thinking mode

- Qwen3 ma "thinking mode" (generuje `<think>...</think>` block przed odpowiedzią).
- Dla JSON emission thinking jest zbędny (to zadanie strukturalne, nie reasoning).
- `enable_thinking=False` w `apply_chat_template` → model generuje bezpośrednio JSON.
- eval.py też stripuje `<think>` bloki na wszelki wypadek (`THINK_BLOCK_RE`).

### Przyszłość — co jeśli 40-char text + xgrammar + retrain nadal nie przejdzie §5

Trzy opcje (per PRD §11):
- **A** — xgrammar + 40-char text + retrain (w toku) — izoluje "schema solved" od
  "F1 is the gap"
- **B** — 1000+ par + jeszcze krótszy text (~20 znaków) — więcej danych + jeszcze
  wyższy lemma_overlap. Ryzyko: 4B@370 dawał overlap 0.48, 1000 par może dać 0.55,
  nadal < 0.60.
- **C** — abandon per §11 — raport "schema solvable via xgrammar (100%), ale F1 ≥ 0.80
  nie osiągalne przy 370 parach — małe modele nie reprodukują finding text przy
  wymogu lemma_overlap 0.60." FOC-359 → Done z raportem negatywnym.

### Środowisko (skrót)

- **Python**: C:\Python313 (system Python 3.13 — jedyny działający; venv zablokowany
  przez WDAC policy na DLL-e)
- **GPU**: RTX 5070 Ti, 16 GB VRAM
- **Stack**: peft 0.21 + trl 1.13 + bitsandbytes 0.50.2 + xgrammar 0.2.7
- **Model**: Qwen/Qwen3-4B (4-bit nf4, LoRA r=16 alpha=32)

---

## 6. Glossary

| Termin | Znaczenie |
|---|---|
| **FT (Fine-Tuning)** | Dostosowanie gotowego modelu do konkretnego zadania na nowych danych |
| **QLoRA** | Quantized LoRA — 4-bit quant + LoRA adaptery, mieści się na małej GPU |
| **LoRA** | Low-Rank Adaptation — małe trenowalne matrixy doklejone do zamrożonych wag |
| **SFT** | Supervised Fine-Tuning — uczenie nadzorowane (input → gold output) |
| **adapter** | Zapisany wynik treningu (LoRA wagi), ~100 MB, doklejany do bazowego modelu |
| **logity** | Wektor prawdopodobieństw dla każdego tokenu w słowniku (151936 dla Qwen3) |
| **token** | Kawałek tekstu (słowo, fragment) — model operuje na tokenach nie znakach |
| **constrained decoding** | Wymuszanie poprawności wyjścia w trakcie generowania (xgrammar) |
| **CFG** | Context-Free Grammar — reguły opisujące poprawne struktury (tu: JSON schema) |
| **bitmask** | Wektor 0/1 mówiący które tokeny są legalne w danym kroku |
| **schema validity** | Czy output parsuje się jako JSON zgodny ze schemą |
| **macro F1** | Średnia F1 po polach (verdict + findings + acMapping) |
| **lemma_overlap** | Jak dużo słów mają wspólnych pred i gold (próg 0.60) |
| **evidence_prefix_match** | Czy artefakt (path:line) w evidence jest ten sam w pred i gold |
| **§5 bar** | Próg akceptacji: schema 100% AND macro F1 ≥ 0.80 |
| **truncation** | Model wyczerpał max_new_tokens → ucięty, niepoprawny JSON |
| **assistant_only_loss** | Loss liczony tylko na tokenach assistant (nasz JSON), nie na prompcie |

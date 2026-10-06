---
type: brainstorm
status: approved-v2 — plan zaakceptowany przez Mateusza 2026-09-29 (decyzje D1–D14 w sekcji 2 wiążące; odpowiedzi na pytania z sekcji 18 zapisane). Zatwierdzona jest F0; F1+ czeka na bramkę go/no-go po F0
audience: Mateusz (iteracja) → PLAN squad (dekompozycja jako Draft w Linear; szkice w PRD)
topic: "precedent index" — dwuwarstwowy, wektorowy indeks zamkniętych ticketów, rozwiązań i łańcuchów reasoningu; „jak to już rozwiązaliśmy" i „kto zrobił to najszybciej"
related:
  - ./flowdb-learning-loop.md                        # warstwa 3 (experience packets) — ten dokument ją zastępuje
  - ./brainstorm-specialization-learning.md          # B — miner/playbooki: konsument klastrów i lekcji
  - ./brainstorm-graphify-thoughtmap-integration.md  # C — mapa kodu (dziś: CodeGraph)
  - ../adr/0012-decision-shaped-steps-four-kinds.md  # Jev, kroki decyzyjne, Path A/B
  - ../prd/prd-precedent-index.md                    # PRD (wymagania normatywne, fazy, szkice zadań)
  - ../adr/0014-precedent-index-two-layer.md         # ADR (proposed)
  - ../TELEMETRY-EXPLAINED.md
memory: [[precedent-search-design-context]]
---

# Brainstorm D — Precedent index: pamięć Fenixa o tym, jak już rozwiązywał podobne problemy

## 0. TL;DR

1. Indeksujemy **przypadki (case)**, nie surowe transkrypty: problem ▸ rozwiązanie (commity, pliki, funkcje) ▸ wynik (koszt, rundy, czas) ▸ **łańcuch reasoningu** (sekwencja kroków myśl → akcja → obserwacja) z relacjami.
2. **Dwie warstwy.** L1 = deterministyczna i automatyczna (skrypty, zero decyzji modelowych poza embeddingami). L2 = L1 przeanalizowana przez **CADENCE** (nowa rola `curator`): oceny, lekcje z cytatami, nazwy klastrów, „golden path". **L2 ma priorytet** i może unieważnić wynik L1.
3. **Embeddingi przez OpenRouter API** (state of the art, max precyzja). Model wybieramy po **bake-off na własnych danych** (37 modeli dostępnych, koszt groszowy), nie z rankingu.
4. **Wyszukiwanie hybrydowe** (BM25 + wektory + wspólne pliki/funkcje) → lane L2 najpierw → rerank **Jev** (`noul`, A0). Poprawna odpowiedź może brzmieć „brak precedensu".
5. **Klastrowanie** embeddingów wykrywa powtarzalne tematy; klastry nazywa L2, a „najlepszy przypadek w klastrze" zasila playbooki (brainstorm B).
6. **Klasyfikator typu Jev/Laya**: Jev teraz (już zintegrowany), Laya jako lokalny „student" i kandydat na Path B, gdy będą etykiety.
7. **Sukces (A2) = TEST pass + zatwierdzenie człowieka + Done.** Tylko takie przypadki trafiają do rankingu „najszybciej rozwiązanych".
8. **Bramka dowodowa przed infrastrukturą (F0):** offline spike na historii z progami go/no-go. Wyniki najpierw jako adnotacje A0 (doradcze), mierzone telemetrią.

## 1. Problem i cel

**Problem.** Każdy task w Fenixie zaczyna się od zera. PLAN nie wie, ile kosztowały i ile rund review zajęły podobne zadania; DEV odkrywa na nowo te same pułapki; REVIEW odsyła za te same błędy. Wiedza jest, ale rozproszona: Linear (opis, AC, hand-offy), git (commity), `.state/supervisor/` (gate'y, werdykty), telemetria (koszt, czas), transkrypty (myśli i akcje; 65% plików jeszcze istnieje, reszta zniknęła przez retencję). Istniejące próby są uśpione: `flow.db` (145 runów, 45 zadań, dane do 2026-08-02) i spec „experience packets" ([flowdb-learning-loop.md](flowdb-learning-loop.md)) bez implementacji.

**Cel.** Dla nowego problemu (ticket, objaw, plan, zestaw plików) zwrócić w budżecie tokenów:
1. **podobne zamknięte przypadki** i jak je rozwiązano (commity, pliki, funkcje, łańcuch kroków),
2. **które rozwiązano najefektywniej** (koszt, rundy, czas) przy zachowaniu jakości,
3. **znane pułapki** (findingi review na tych plikach, ślepe zaułki w łańcuchach),
4. **kalibrację**: ile takie zadania zwykle kosztują (input do estymat i budżetów).

**Poza zakresem (non-goals).** Baza wektorowa jako usługa; fine-tuning LLM-ów; indeksowanie FEN/PISI/pseudo-tasków `SUP:*`; automatyczne stosowanie precedensów bez człowieka i pomiaru; wyszukiwanie po kodzie (to robi CodeGraph); przebudowa dashboardu (tylko później mały panel).

## 2. Decyzje wiążące (Mateusz, 2026-09-29)

| # | Decyzja | Skutek dla projektu |
|---|---|---|
| D1 | **A2: sukces = TEST pass + zatwierdzenie przez człowieka + task w Done** | poziomy jakości V0/V1/V2 (sekcja 8); ranking „najszybszych" tylko z V2 |
| D2 | **Dwie warstwy**: L1 deterministyczna automatyczna; L2 = L1 przeanalizowana przez squad CADENCE; **L2 ma większy priorytet** | L2 jest warstwą governance nad L1 (endorse / caution / exclude / supersede) i źródłem lekcji (sekcja 7) |
| D3 | **Embeddingi: state of the art przez API OpenRouter, jak największa precyzja** | brak modeli lokalnych; wybór modelu po pomiarze; egress screen obowiązkowy (sekcja 13) |
| D4 | **Algorytm klastrujący + klasyfikator typu Jev lub Laya** w workflow | sekcje 9 i 10 |
| D5 | **Korpus: tylko FOC i JOI** | FEN, PISI i pseudo-taski poza indeksem |
| D6 | **Reasoning/myśli też indeksowane, jako sekwencje / łańcuchy / relacje** | model Case ▸ Chain ▸ Step + graf relacji (sekcje 5 i 11) |
| D7 | **To implementacja w Fenixie, nie analiza w Jupyterze** | skrypty Node + serwer MCP + krok grafu + rola CADENCE |
| D8 | **V2 = TEST pass + zatwierdzenie człowieka:** `cleanup-approval` lub `push-approval` = „tak" (era supervisora); era standalone najwyżej V1 (przyjęte domyślne) | definicja poziomów jakości w sekcji 8 |
| D9 | **„Najszybciej" = przede wszystkim najmniej tur**, pozostałe metryki też z wagą, ale mniejszą. „Tura" występuje w Fenixie w dwóch znaczeniach, więc obejmuję oba: **tury LLM** (wiadomości asystenta = wywołania modelu, dostępne dla każdego zadania z telemetrią), **tury dziecka** (`children.json → turns[]`: każde uruchomienie lub wznowienie dziecka supervisora, także po odpowiedzi na gate i w pętli review; tylko era supervisora) i **rundy review** (rekordy werdyktów). Domyślne wagi (rodzina „tur" razem 0,60): tury LLM 0,35, tury dziecka 0,15, rundy review 0,10, koszt loaded 0,20, czas aktywny 0,20; gdy metryka jest niedostępna dla danej ery, jej waga jest przenormowana na dostępne. Wagi w `config/precedent.json`, stabilność rankingu sprawdza F0 | sekcja 8 (efektywność) |
| D10 | **Treści JOI i transkrypty wolno wysyłać do API embeddingów** po egress screenie (fail-closed; bez wyników narzędzi) | sekcja 13; F0 może embedować prawdziwe dane |
| D11 | **Rola `curator` w CADENCE: zgoda.** Zmianę `agents/cadence/CLAUDE.md` wykonuje Mateusz; harmonogram tygodniowy + tryb na żądanie | F4; ADR-0014 |
| D12 | **Jev najpierw, Laya później** (student / Path B po zebraniu etykiet; nie w F0) | T0.6 tylko Jev; Laya → F6 |
| D13 | **Sidecar w Pythonie dozwolony** (klastrowanie, ewaluacja); rdzeń (ingest, wyszukiwanie, MCP) zostaje czystym JS + `node:sqlite` | sekcje 9 i 13 |
| D14 | **Progi go/no-go z sekcji 14 przyjęte** (Recall@5 ≥ 0,35; MAPE ≥ 15% lepsze niż mediana per typ; ≥ 60% klastrów spójnych) | bramka po F0 |

## 3. Zweryfikowane fakty (2026-09-29)

| Fakt | Jak sprawdzone | Konsekwencja |
|---|---|---|
| **OpenRouter ma 37 modeli embeddingów.** Kandydaci: `qwen/qwen3-embedding-8b` ($0,01/1M, ctx 32 768), `qwen3-embedding-4b`, `google/gemini-embedding-2` ($0,20; batch $0,10; ctx 8 192) i `-001`, `voyageai/voyage-4-large` i `voyage-code-4` ($0,12; ctx 32 000), `openai/text-embedding-3-large` ($0,13), `perplexity/pplx-embed-v1-4b`, `baai/bge-m3` | `GET /api/v1/models?output_modalities=embeddings` (HTTP 200) + żywe `POST /api/v1/embeddings` kluczem projektu | API działa na naszym koncie; bake-off kosztuje grosze. Zwraca `usage.cost` (do metryk). Pierwsze wywołanie Qwen 7,8 s (cold), Gemini/Voyage 0,3–0,5 s |
| Trzy modele: Qwen3-8B → 4096 wym., Gemini-2 → 3072, Voyage-4-large → 1024; cos(PL↔EN parafraza) 0,87–0,88 u wszystkich | test na dwóch zdaniach | wszystkie radzą sobie z mieszanym PL/EN; **różnic precyzji nie wolno wnioskować z jednej pary** — dlatego bake-off (F0) |
| **Jev** = `typesafe/jev-1.13` przez OR `POST /api/alpha/decisions`; odpowiedzi `choice` z prawdopodobieństwami i `noul` (P(true)); ok. 0,3–0,5 s, ok. $0,02 / 1000 decyzji | [provider-jev.mjs](../../scripts/mcp/provider-jev.mjs), [decision-call.mjs](../../scripts/decision-call.mjs), ADR-0012 | seam decyzyjny już jest (egress screen, meter, rekordy shadow, A0). Endpoint **alfa** — zmienił kształt w ciągu jednego dnia; ADR-0012 D4 definiuje **Path B** (lokalny model decyzyjny) jako plan awaryjny |
| **Laya** (Convai Innovations): open weights, **Apache-2.0**; ModernBERT-large 421M (512 tok.) / mmBERT-base 322M (1024, do 8192); typy `choice`/`score`/`noul`; ok. 33 ms/pytanie na T4 (**samoopisane**); dostępne `laya[serve]` i `laya[mcp]` | karta modelu HF `convaiinnovations/laya` + README repo `NandhaKishorM/laya` | to ten sam kontrakt co Jev, ale lokalnie i bez logprobs. **Słabości z ich własnego README:** zero-shot słaby (0,362 → 0,766 po fine-tuningu na ich benchmarku), słaba przy >20 opcji (Banking77 0,425 vs Jev 0,870), kalibracja dopiero po dopasowaniu temperatury na własnych danych. Porównania z Jevem = samoopisane |
| Link, który podałeś (blog HF „sora-2/bna") to **materiał promocyjny hostowany z zasobami `thejevai.com`** (obrazki i linki), nie niezależna recenzja | źródło strony, linki | nie opieramy decyzji na nim; źródłem są karta modelu i repo. Laya = kandydat na lokalnego „studenta" i Path B, nie punkt startu |
| **CADENCE** to lead delegujący collector → retro → digest, sam nie analizuje; kontrakt **„read-mostly"**, jedyny wyjątek zapisu poza `.state/cadence/` to `.state/flowdb/`; settings: `Write`, `Bash(node:*)`, **brak `Edit`**; `agents/**` edytuje tylko Mateusz. **W telemetrii 3 runy cadence w całym okresie (ostatni 2026-08-12, failed)** | [agents/cadence/CLAUDE.md](../../agents/cadence/CLAUDE.md), settings, telemetria | warstwa L2 wymaga (a) zmiany kontraktu i (b) realnego harmonogramu — dziś cadence praktycznie nie chodzi |
| **Zatwierdzenie człowieka jest w danych**: 294 gate'y — 261× `cleanup-approval` (odpowiedź „tak"; `propose` odmawia bez Done/TEST), 2× `push-approval`, 3× `plan.gate1`, 28× `question`; 137 werdyktów (findingi z evidence, mapa AC, runda, fingerprint) | `.state/supervisor/*/gates`, `verdicts` | A2 da się policzyć dla ery supervisora; era standalone (przed 2026-08-25) ma tylko stan w Linear |
| **Reasoning istnieje**: transkrypty powiązane z FOC/JOI: 2 830, na dysku 1 827 (65%). Blok `thinking` ma ok. 28–34% wierszy modeli nie-Claude (GLM, MiMo, DeepSeek), średnio ok. 3,5 tys. znaków; natywny Claude redaguje myśli. Szacunek: ok. 50 mln tokenów myśli na dysku (próbka 160 plików × 11,4) | skan próbki | embedowanie kosztuje $0,5–7 — **ograniczeniem jest jakość i prywatność, nie koszt**. Transkrypty znikają, więc **warstwa łańcuchów nie jest odtwarzalna po fakcie**: indeksować wcześnie, traktować jako dane pierwotne |
| `node:sqlite` 3.50.4 (Node 22.20): **FTS5 działa**, wektory float32 jako BLOB działają; tokenizer `unicode61 remove_diacritics 2` **nie składa polskiego „ł"** | test w Node | brute-force cosine w JS, bez natywnych rozszerzeń (Smart App Control); tekst PL/EN normalizować (ł→l) lub trigramy |
| Zamknięte, ale uśpione: FlowDB (`flow.db` od 2026-08-02). Embeddingi tylko w opcjonalnym notebooku. Lekcja **FOC-359**: ekstrakcyjne > generatywne; etykiet mało (21 gate labels) | repo, ADR, memory | destylaty muszą cytować źródła; ewaluacja na proxy, nie na ręcznych etykietach |
| Korpus: 255 ticketów w telemetrii (FOC 229, JOI 23, FEN 2, PISI 1), 740 commitów (138 ticketów z ID w tytule ≈ ⅓), 137 werdyktów, 102 raporty review | telemetria, git, `.state` | korpus **mały** — trudność to jakość i zaufanie, nie skala |

### 3a. Wyniki F0 (2026-09-29) — skrót; pełny raport: [../benchmark/precedent-index-spike.md](../benchmark/precedent-index-spike.md)

F0 wykonano w całości (T0.1–T0.7; T0.8 = decyzja Mateusza czeka). Co zmienia wcześniejsze fakty i założenia z tej sekcji:

| Wcześniej | F0 (zmierzone) |
|---|---|
| „255 ticketów w telemetrii, korpus mały" | Linear: 1 001 ticketów FOC+JOI; po zakresie (bez alertów intake, przeniesionych, projektów osobistych i katalogów roboczych z finansami/podatkami) **626 w zakresie**, z czego V0 368, V1 126, **V2 64** (era supervisora 28, graf v2 36) |
| „65% transkryptów na dysku" | **79% osiągalnych**: +386 plików w `.state/transcript-archive-20260910`; 21% zniknęło |
| Repo allowlist = 3 z `config/projects.json` | commity z ID ticketu w 11 repo (m.in. post-fraud-model 240, joint-flows 223); allowlista musi być własna |
| Egress screen „pomija element po trafieniu" | 8,6% tekstów ticketów (56/648) daje trafienie „high-entropy" (długie slugi, nazwy branchy) → **maskuj-i-skanuj-ponownie**, blokuj tylko pozostałe rodziny (2 teksty) |
| Embedding = model z rankingu SOTA | modele **kodowe** (Codestral Embed, Voyage Code 4) na szczycie; Qwen3-8B (top MTEB) w ogonie; szczyt nierozróżnialny statystycznie; wybór wg spójności i operacji: **voyage-code-4 + BM25 (RRF)** |
| Predykcja kosztu z sąsiadów (D14 kryt. 2) | **niespełnione**: mediana poprawy vs mediana per typ −0,9% (12 modeli); sąsiedzi nie biją mediany „ostatnich 10" |
| Ranking „najszybciej" | stabilny wobec wag (ρ 0,985), **niestabilny wobec znaczenia „tury"** (rankingi wg tur dziecka i rund ≈ niezależne od tur LLM, ρ 0,30–0,34) |
| Klastry | HDBSCAN najlepszy (45 klastrów, ARI 0,86, 45% nieprzypisanych); wstępnie ≥ 85% spójnych; sporo klastrów to dekompozycje epików |
| Jev | relevance: rerank plausibly lepszy (Hit@1 0,42→0,54), nieistotny przy 24 zapytaniach; problem_type 0,63 (kNN 0,50) |
| Łańcuchy | 1 789 transkryptów → 67 400 kroków → 11 128 epizodów w 9 s; 46,5% sygnatur błędów wraca, 27% powracających ma wcześniejszy rozwiązany epizod |

**Rekomendacja F0: go, zawężone** (bez obietnicy „oczekiwany koszt z sąsiadów"; hybrydowe wyszukiwanie, klastry i łańcuchy zostają). Zmiany w wymaganiach: raport §8.

## 4. Architektura w jednym obrazku

```
 ŹRÓDŁA (tylko FOC/JOI)         L1 — DETERMINISTYCZNA, AUTOMATYCZNA                          L2 — CADENCE (curator)
 Linear: issue, AC, komentarze ─┐  ┌─────────────────────────────────────────────┐            ┌────────────────────────────┐
 git: commity, pliki, funkcje   │  │ extract → egress screen → segment → embed   │   L1 ───►  │ ocena przypadków:           │
 .state: gate'y, werdykty       ├─►│ (OpenRouter) → link → score → SQLite        ├──────────► │ endorse / caution / exclude │
 telemetria: koszt, czas, rundy │  │ facets: problem • approach • episode • step │            │ lekcje z cytatami, nazwy    │
 transkrypty: myśli + akcje     ┘  │ graf: next/retry/resolves/touches/similar   │  ◄──────── │ klastrów, golden path,      │
                                   └───────────────────┬─────────────────────────┘ adnotacje  │ stale-check, dedupe         │
                                                       │ wektory + FTS5 + graf                └──────────────┬─────────────┘
                                                       ▼                                                     │ pliki lekcji (git)
              WYSZUKIWANIE: BM25 + wektory + pliki/funkcje → RRF → lane L2 najpierw → rerank Jev(noul) → karty
                                                       ▼
          CLI • serwer MCP • krok grafu plan.precedents • intake.task_size (A0) • DEV recon • REVIEW • dashboard
```

## 5. Model danych: przypadek ▸ łańcuch ▸ krok + relacje (to jest „mapowanie na kod")

Jedna baza SQLite (`precedents.sqlite`, **pochodna**, obok `telemetry.sqlite`, poza gitem). Węzły i krawędzie w zwykłych tabelach — bez bazy grafowej.

**Węzły**

| Węzeł | Zawartość | Źródło |
|---|---|---|
| `case` | ticket FOC/JOI: tytuł, opis + AC (po screenie), typ, estymata, relacje (`blocked by`, `related`, duplikat), repo, daty, **poziom jakości V0/V1/V2**, metryki: koszt bezpośredni i loaded, czas aktywny, rundy review, wywołania narzędzi, koszt pętli | Linear (`linear-query issue/comments`), telemetria, werdykty |
| `artifact` | commit (sha, temat, treść „dlaczego", pliki, **funkcje z nagłówków hunków gita**, +/−), werdykt (findingi z evidence, mapa AC), gate człowieka, hand-off z Linear, dotknięte dokumenty/ADR | git, `.state/supervisor`, Linear |
| `chain` / `episode` / `step` | łańcuch runu ▸ epizod (segment o jednym celu) ▸ **krok = trójka myśl → akcja → obserwacja**: fragment myśli (po screenie), akcja (narzędzie, cel, sygnatura argumentów), obserwacja (stan wyniku, rozmiar, sygnatura błędu), koszt, wskaźnik do transkryptu (ścieżka + offset) | transkrypty |
| `vec` | (typ obiektu, id, **facet**, model, wymiary, wektor BLOB, hash tekstu). Facety: `problem`, `approach`, `pitfall`, `finding`, `episode`, `step`, `lesson` | embeddingi |
| L2: `annotation`, `lesson`, `cluster` | oceny przypadków, lekcje, klastry z nazwami — **osobne tabele, nigdy nadpisywane przez L1** | CADENCE |

**Krawędzie** (`edge(src, rel, dst, weight, provenance{layer, method})`)

| Relacja | Znaczenie / jak liczona (deterministycznie) |
|---|---|
| `next` | kolejność kroków / epizodów / runów |
| `retry_of` | podobne wywołanie wcześniej (moduł podobieństwa, próg τ) |
| `responds_to_error` | krok po wywołaniu, które zwróciło błąd (ten sam wątek, wspólny cel) |
| `resolves` | epizod naprawczy zakończony sukcesem (błąd → edycje → zielony test) |
| `touches_file` / `touches_function` | cele narzędzi + nagłówki hunków (`git diff -U0`) |
| `returned_by` | odesłanie REVIEW → DEV (rekord werdyktu, runda) |
| `blocked_by` / `related_to` / `duplicate_of` | relacje z Linear |
| `similar_to` | kNN po embeddingach powyżej progu (materializowane co tydzień) |
| `member_of` | przynależność do klastra |
| `supersedes` / `annotates` | tylko L2 |

**Dwa kierunki wyszukiwania kodu ↔ problem:**
- *problem → rozwiązanie*: tekst ticketu → podobne przypadki → ich commity, pliki, funkcje i łańcuch (diff pobierany **na żądanie** przez `git show <sha>`, nie kopiowany do indeksu),
- *kod → problemy*: plik lub funkcja → przypadki, które je ruszały, wraz z findingami review i pułapkami (indeks odwrotny). Dla zadań kodowych bywa precyzyjniejszy niż samo podobieństwo tekstu.

Ilustracja formatu wyniku (schemat, nie dane): karta precedensu = `{id, warstwa L1|L2, podobieństwo{dense,bm25,strukturalne}, dlaczego[wspólne pliki, terminy], wynik{poziom V2, rundy, koszt loaded, czas aktywny, efektywność −42% vs sąsiedzi, n}, rozwiązanie{commity, pliki, funkcje, podejście, pułapki}, łańcuch{kroki, golden:true}, zastrzeżenia[różnice do sprawdzenia, stale?], proweniencja{źródła, curated_by}}`.

## 6. Warstwa 1 — deterministyczna i automatyczna

**„Deterministyczna" znaczy:** zero decyzji generatywnych; wynik odtwarzalny ze źródeł przy przypiętym modelu embeddingów (id modelu i wymiary zapisane przy każdym wektorze). Jedyne wywołania modeli to embeddingi (i opcjonalnie Jev `choice` do tagowania — wtedy oznaczone w proweniencji).

Potok (idempotentny, klucz = hash treści, jak `telemetry-ingest`):

1. **Extract** — snapshoty z Linear (issue + komentarze), git (commity po tytule *oraz* po rejestrze dzieci: branch `foc-XXX-dev`, `baseRevision`), `.state/supervisor` (gate'y, werdykty), telemetria (koszt, czas, rundy; read-only), transkrypty (przyrostowo, po offsetach; tylko dla runów powiązanych z FOC/JOI).
2. **Screen** — cały tekst przechodzi przez [egress-screen.mjs](../../scripts/egress-screen.mjs) (`scanEgress` / `assertEgressClean` na surowych liściach, lekcja FOC-643). Trafienie = pominięcie elementu i licznik; nigdy „ciche" wysłanie. Surowe wyniki narzędzi nie są przechowywane, tylko sygnatury i rozmiary.
3. **Normalize** — ł→l dla FTS5, ucięcie do budżetu, ekstrakcja sygnatur błędów (pierwsza linia, znormalizowana).
4. **Segment** — kroki, epizody, łańcuchy (sekcja 11).
5. **Embed** — OpenRouter `POST /api/v1/embeddings`, model przypięty w `config/models.json` (nowa sekcja embeddings + wiersz cennika, zgodnie z niezmiennikiem „każdy używany model ma cennik"), batch, retry/backoff (jak `makeRetryFetch`), **meter kosztu** jako zdarzenie telemetrii (`usage.cost`), cache po hashu tekstu, opcjonalne obcięcie wymiarów (Matryoshka — do sprawdzenia per model w F0).
6. **Link** — krawędzie z tabeli w sekcji 5.
7. **Score** — metryki efektywności (sekcja 8).
8. **Store** — SQLite; wektory jako float32 BLOB; wyszukiwanie brute-force w JS.

**Wyzwalacze:** (a) po zamknięciu zadania — supervisor po Done + odpowiedzi na `cleanup-approval` woła `precedent ingest --task FOC-xxx`; (b) przyrostowo po zakończeniu runu (ten sam tick co ingest telemetrii); (c) nocny sweep. **Indeksować wcześnie**: transkrypty znikają (retencja), więc krok segmentacji i wektory muszą powstać, zanim plik zniknie.

**Odtwarzalność.** Warstwa przypadków jest w pełni odtwarzalna (Linear/git/`.state`). Warstwa łańcuchów **nie** (transkrypt może zniknąć) — dlatego wymaga kopii zapasowej jak store telemetrii i osobnego zadania na retencję.

**Świeżość:** komenda `precedent status` + guard jak w `server-codegraph.mjs` — gdy świeżości nie da się udowodnić, serwer zwraca typowane **UNKNOWN**, a nie odpowiedź z nieaktualnego indeksu.

## 7. Warstwa 2 — CADENCE (rola `curator`) i priorytet

**Co robi L2** (tygodniowo i na żądanie), na wejściu widząc tylko L1 przez CLI (`precedent show/list`):

| Zadanie | Wynik | Gwarancja jakości |
|---|---|---|
| Ocena przypadków | adnotacja `endorsed` / `caution` / `exclude` / `superseded` + powód | **ekstrakcyjnie**: każda ocena cytuje metryki i id artefaktów; deterministyczny checker sprawdza, że cytowane id istnieją, a cytaty występują dosłownie w źródle (lekcja FOC-359) |
| **Lekcje** | „wzorzec problemu → zalecane podejście → pułapki → dowody" | jw.; lekcja bez dowodów jest odrzucana; `staleAfter`; pliki `.md` **w gicie** (`docs/lessons/`), więc człowiek może je edytować i wetować |
| Klastry | nazwy, opisy, scalanie/podział | wsparcie Jeva `choice` (taksonomia), człowiek widzi w digeście |
| **Golden path** i antywzorce | najkrótszy łańcuch do rozwiązania wśród przypadków V2 w klastrze; pętle i ślepe zaułki | metryki z L1, cytowane kroki |
| Stale-check | oflagowanie przypadków, których pliki/funkcje już nie istnieją | CodeGraph (`files`/`symbol`) |
| Deduplikacja | scalanie duplikatów | `noul` „ten sam problem?" + metryki |

**Priorytet L2 — trzy mechanizmy:**
1. **Lane**: wyniki L2 (lekcje + przypadki `endorsed`) zwracane **przed** L1 i przy niższym progu podobieństwa (`θ_L2 = θ_L1 − δ`).
2. **Veto**: `exclude` usuwa przypadek z wyników; `caution` dołącza ostrzeżenie; `superseded` podmienia rekord wskazanym.
3. **Dedupe**: przypadki cytowane w lekcji znikają z listy L1 i są pokazywane pod lekcją jako dowody.
**L1 nigdy nie nadpisuje L2** (osobne tabele, klucz = stabilne id przypadku), więc pełna przebudowa L1 nie niszczy curacji.

**Koszt L2:** kilkadziesiąt nowych przypadków tygodniowo × tanie modele squadu (MiniMax M3, GLM-5.2) ⇒ rząd $0,5–2 tygodniowo (szacunek do zmierzenia w F4).

**Zmiany kontraktu (wymagają Mateusza):** (a) `agents/cadence/CLAUDE.md` — nowy krok „3b. Curate precedents" i jawny wyjątek zapisu (`.state/precedents/`, `docs/lessons/`), analogiczny do wyjątku `.state/flowdb/`; (b) [config/graph.json](../../config/graph.json) — węzeł `cadence` dziś ma `changes: none — read-mostly`; nowe artefakty wyjściowe; (c) ADR-0014; (d) **harmonogram** (Windows Task Scheduler co tydzień + tryb na żądanie), bo dziś cadence prawie nie chodzi. Bez (d) L2 nie powstanie — to zależność, nie szczegół.

## 8. Wyszukiwanie, ranking i „najszybciej rozwiązane"

**Tryby zapytania:** `problem` (tekst ticketu), `symptom` (błąd/log → epizody naprawcze), `plan` (szkic podejścia → pułapki), `files` (ścieżki → przypadki i findingi), `fastest` (ranking efektywności w sąsiedztwie), `chain` (rozwinięcie łańcucha).

**Potok:**
1. Kandydaci: **BM25** (FTS5) + **wektory** (facet `problem`, w trybie `symptom` facety `episode`/`step` + dopasowanie sygnatury błędu) + **strukturalnie** (wspólne pliki/funkcje przez krawędzie `touches_*`).
2. Fuzja: **Reciprocal Rank Fusion** (k = 60), wagi startowe: wektory 1,0, BM25 0,6, struktura 1,2 (gdy zapytanie zna pliki). Wagi stroimy w F0.
3. **Lane L2 → L1** (sekcja 7), filtry: workspace ∈ {FOC, JOI}, repo z `config/projects.json`, minimalny poziom jakości.
4. **Rerank Jev `noul`** dla top-N (N ≈ 10): „czy ten precedens dotyczy tej samej przyczyny/obszaru?" — jako **adnotacja A0** (P(true) obok wyniku), nie jako jedyne kryterium, dopóki nie skalibrowane.
5. **Abstencja**: poniżej progu → „brak precedensu" (logowane; braki pokrycia są sygnałem samym w sobie).
6. Karty w twardym budżecie tokenów (2–4 tys., jak w spec FlowDB), z proweniencją i „różnicami do sprawdzenia".

**Jakość sukcesu (D1):** V0 = `Done` w Linear; V1 = V0 + werdykt TEST pass; **V2 = V1 + ≥1 zatwierdzenie człowieka** (`cleanup-approval`/`push-approval` = „tak"). Era standalone nie ma ustrukturyzowanego zatwierdzenia, więc dostaje najwyżej V1 z niższą wagą. Dodatkowe bramki: brak reopen (do sprawdzenia w F0, czy API zwraca historię stanów; proxy: brak późniejszego ticketu z relacją „fixes/caused by"), mapa AC pokrywa deklarowane AC (`verdict.acMapping` vs `declaredAcs`), przypadek nie jest `excluded` przez L2, zadanie jest „settled".

**Efektywność („najkrócej i najszybciej") — bez pułapki Goodharta:**
- Cechy: **tury LLM** (kanoniczne wiadomości asystenta ze wszystkich runów zadania), **tury dziecka** (`children.json → turns[]`, era supervisora), **rundy review** (rekordy werdyktów: zwroty REVIEW/TEST → DEV), koszt loaded, czas aktywny (bez przestojów). Diagnostycznie, poza wynikiem: liczba gate'ów, koszt pętli, liczba wywołań narzędzi.
- **Oczekiwanie liczymy z sąsiadów** (kNN po embeddingach, tylko wcześniejsze przypadki V2, k = 5–10, ważone podobieństwem): `reszta = log(rzeczywiste / oczekiwane)`; `efektywność = −Σ w_m · reszta_m`. Bez tego wygrywają zadania trywialne.
- **Wagi `w_m` (D9)**: rodzina „tur" ma największą wagę. Start: tury LLM 0,35, tury dziecka 0,15, rundy review 0,10 (razem 0,60), koszt loaded 0,20, czas aktywny 0,20; plik `config/precedent.json`; niedostępna metryka = jej waga przenormowana na dostępne. F0 sprawdza, jak bardzo zmienia się ranking „najszybszych" przy zaburzeniu wag (np. ±0,15) oraz czy wynik zależy od tego, które znaczenie „tury" przyjąć — jeśli ranking jest niestabilny, pokazujemy wynik jako przedział, a nie pojedynczą pozycję.
- Poniżej 5 sąsiadów → „n/d", zawsze pokazujemy `n` i przedział (bootstrap).
- **Krótkość łańcucha** = liczba kroków od pierwszej eksploracji do pierwszej udanej weryfikacji, osobno od kosztu.

## 9. Klastrowanie embeddingów

**Cel:** wykrywanie powtarzalnych tematów (przypadki), podproblemów (epizody) i kształtów rozwiązań (sekwencje rodzin akcji), a także wskazanie „najlepszego przypadku w klastrze" dla playbooków (brainstorm B).

| Opcja | Zalety | Wady |
|---|---|---|
| **HDBSCAN** (po redukcji do ~50 wymiarów) | wykrywa szum, nie wymaga k, standard dla embeddingów | Python (sidecar); tożsamość klastrów dryfuje między przebiegami |
| **Graf kNN + Louvain** w czystym JS | deterministyczny, bez zależności, hierarchia przez rozdzielczość | mniej odporny na różne gęstości |
| Aglomeracyjne (średnie wiązanie, cięcie po cosinusie) | proste, deterministyczne, N ≤ kilka tysięcy OK | słabe przy wielu skalach |

**Sidecar w Pythonie (D13):** klastrowanie działa jako **zadanie wsadowe** (nie usługa): Node eksportuje wektory i id do pliku, skrypt Pythona (`scikit-learn`: HDBSCAN, aglomeracyjne; `numpy`) zapisuje przypisania do pliku JSON, Node je importuje. Bez procesu długo żyjącego, bez współdzielenia połączenia SQLite. Sidecar jest **opcjonalny i fail-soft**: gdy Python albo natywna biblioteka jest zablokowana (Smart App Control), ingest i wyszukiwanie działają dalej, a klastry po prostu się nie odświeżają (a rezerwowy wariant Louvain/aglomeracyjny w JS pozostaje możliwy, jeśli F0 pokaże, że jest wystarczający).

**Rekomendacja robocza (rozstrzyga F0):** odkrywanie tematów okresowo (HDBSCAN lub Louvain — wybór po metrykach: spójność wewnątrzklastrowa, stabilność przy bootstrapie (ARI), zgodność z etykietami/epikami), a **przypisywanie online do przypiętych centroidów** z progiem odległości (inaczej „nieprzypisany"). **Tożsamość klastra należy do L2**: CADENCE nazywa i przypina klastry, a kolejne przebiegi L1 mapują się na przypięte przez maksymalne nakładanie się członków (stabilne id). Poziomy: klastry przypadków (tematy), epizodów (podproblemy), sygnatur sekwencji (kształt rozwiązania).

## 10. Klasyfikator typu Jev / Laya w workflow

Wszystko jako **wpisy rejestru decyzji** ([config/decisions.json](../../config/decisions.json)), autonomia **A0** (adnotacja, nigdy akcja), przez istniejący seam `decision-call` (egress screen, meter, rekordy shadow, `criteriaVersion`).

| Decyzja | Typ | Pytanie | Gdzie |
|---|---|---|---|
| `precedent.relevance` | noul | czy ten precedens dotyczy tej samej przyczyny/obszaru? | rerank top-N |
| `precedent.problem_type` | choice (≤ 12) | bug / feature / refactor / infra / docs / test / security / perf… | tagowanie przypadków |
| `precedent.area` | choice (do 20) | komponent (supervisor, telemetria, UI, graf, decyzje, linear-ops…) | tagowanie |
| `precedent.step_kind` | choice (8) | orient / hypothesis / reproduce / implement / verify / dead_end / recover / finalize | tagowanie kroków łańcucha |
| `precedent.resolved` | noul | czy ten epizod rozwiązał problem? | wynik epizodu |
| `precedent.duplicate` | noul | czy to ten sam problem co…? | deduplikacja (L2) |

**Polityka modelu:**
- **Jev teraz**: już zintegrowany, ok. $0,02/1000 decyzji i 0,3–0,5 s (pomiar z 2026-09-19 w [provider-jev.mjs](../../scripts/mcp/provider-jev.mjs)) ⇒ oznaczenie ok. 50 tys. kroków to rząd $1 (równolegle). Limit „do 255 opcji" pochodzi z README Layi (konkurenta), więc **do sprawdzenia w T0.6**, zanim polegamy na nim dla `precedent.area`.
- **Laya jako lokalny „student" i kandydat na Path B**: pasuje do ADR-0012 D4 (lokalny model decyzyjny; natywne prawdopodobieństwa, więc problem logprobs z Ollamą nie występuje; `laya[mcp]` odpowiada wzorcowi MCP z D5). Warunki: (a) etykiety — **darmowe z logu decyzji Jeva** (rekordy shadow, FOC-449), czyli destylacja teacher → student; (b) fine-tuning na własnych danych (README modelu wskazuje, że zero-shot jest słaby), kalibracja temperatury; (c) ≤ 20 opcji; (d) checkpoint wielojęzyczny (PL), wejście ≤ 1024 tokeny ⇒ podsumowania kroków, nie surowe łańcuchy; (e) **ewaluacja Jev vs Laya** na ~100–200 ręcznie zweryfikowanych przykładach (dokładność, ECE). Wymaga poprawki ADR-0012 (Path B dziś = Ollama + xgrammar, FOC-399).
- **Ryzyka**: Jev to endpoint alfa (zmienia kształt); liczby porównawcze Laya vs Jev są samoopisane; klasyfikator nie zastępuje metryk deterministycznych (efektywność liczymy z liczb, nie z werdyktu modelu).

## 11. Reasoning jako sekwencje, łańcuchy i relacje

**Zasada:** myśl bez kontekstu (co robił agent, co zwróciło narzędzie, czym się skończyło) jest szumem. Indeksujemy **trajektorie**, nie luźne bloki.

**Segmentacja (deterministyczna, L1)** — port logiki rodzin akcji: `explore`, `edit`, `test`, `run`, `mutate`, `delegate`, `plan`:
- **Krok** = wiadomość asystenta z jej wywołaniami i wynikami (trójka myśl → akcja → obserwacja).
- **Epizod** = ciąg kroków o jednym celu, granice: zmiana dominującej rodziny (z histerezą ≥ 2 kroki), przejście błąd → sukces, granica testu, przestój > ~10 min, wiadomość człowieka/gate.
- Rodzaj epizodu: `orient` (eksploracja przed pierwszą edycją), `implement`, `verify`, `recover` (od błędu do następnego sukcesu), `coordinate`. Wynik: `resolved` / `stuck` (silna pętla) / `abandoned`. Pętle są zwijane (`retry_of`), żeby nie zaśmiecać łańcucha.
- **Łańcuch zadania** = epizody kolejnych runów (plan → dev → review → dev → review → test → człowiek) połączone `next`/`returned_by`.

**Co embedujemy** (podejście „small-to-big"): (1) kartę problemu, (2) **podsumowanie epizodu** (deterministyczne w L1: cel z pierwszego zdania, główne pliki, sygnatury błędów, wynik, rozmiar; w L2 dodatkowo narracja z cytatami kroków), (3) **wybrane kroki-decyzje** (po błędzie, przed edycją, długie rozumowanie), a nie wszystkie. Trafienie w krok/epizod rozwijamy do fragmentu łańcucha (±k kroków) kończącego się `resolves` — czyli odpowiadamy „jak od objawu doszli do naprawy".

**Kształt rozwiązania:** sygnatura sekwencji rodzin (np. E-E-X-T-X-T) + odległość edycyjna pozwalają szukać trajektorii **podobnych z kształtu**, a nie tylko z treści.

**Prywatność myśli:** przechowujemy ucięty, ekranowany fragment (początek + koniec) i pełną długość; nie przechowujemy wyników narzędzi; wskaźnik do transkryptu (może wygasnąć). Native Claude redaguje myśli, więc łańcuchy tych modeli mają kroki bez tekstu myśli, ale z akcjami i obserwacjami.

## 12. Integracja z Fenixem, persony i user journey

**Persony (użytkownicy):** **Mateusz** (właściciel, async HITL: chce szybko ocenić zaufanie do sugestii, woli digest i dashboard, edytuje lekcje w gicie); **PLAN** (potrzebuje kalibracji estymat i wcześniejszych AC/dekompozycji); **DEV** (pułapki i „jak to naprawiono" dla plików, które rusza); **REVIEW** (wcześniejsze findingi na tych plikach); **supervisor** (estymata rozmiaru, budżet); **CADENCE/curator** (wsad do curacji).

**Konsumenci i miejsca wpięcia:**

| Konsument | Wpięcie | Uwagi |
|---|---|---|
| CLI | `scripts/precedent.mjs` (`search`, `show`, `chain`, `fastest`, `files`, `ingest`, `status`, `verify`, `eval`) | konwencja repo: JSON na stdout, log na stderr; rejestr w `docs/tools/README.md` |
| MCP | `scripts/mcp/server-precedent.mjs` (hand-rolled JSON-RPC jak pozostałe), tylko odczyt, guard świeżości | wpis w `.mcp.json` |
| Graf | nowy krok deterministyczny **`plan.precedents [D]`** po `plan.dor`; jego wynik czytają `plan.dod`, `plan.ac`, `plan.decompose` (estymaty t-shirt z rzeczywistych kosztów sąsiadów) | pusty wynik ≠ błąd |
| Rejestr decyzji | `intake.task_size` dostaje `state.neighbors` (mediana kosztu loaded k najbliższych V2, `n`) | A0 |
| Supervisor / DEV recon | najpierw adnotacja w wyniku triage dla Mateusza; **dopiero po wynikach** blok w prologu dziecka (`--precedent-file`, jak `--referenced-file`) | pomiar markerem `##PRECEDENT <id>` (jak `##PLAYBOOK`) |
| REVIEW | `precedent files <zmienione pliki>` → „poprzednie findingi na tych plikach" | blast radius dla pułapek |
| CADENCE | krok curator | sekcja 7 |
| Dashboard (późno) | panel „podobne zadania" na ekranie Tasks | F6 |

**User journey:**
1. Wpada nowy ticket → intake pokazuje: „3 podobne zamknięte (L2: 1 lekcja + 2 przypadki), mediana kosztu $X, zwykle Y rund; golden path: …". PLAN używa tego do estymaty i AC.
2. DEV zaczyna recon na plikach A, B → dostaje pułapki z poprzednich zadań i skrót „jak to naprawiono" (advisory, z różnicami do sprawdzenia).
3. Po Done i „tak" na cleanup → L1 ingest automatycznie.
4. Co tydzień CADENCE dorzuca do digestu: nowe lekcje, przypadki oflagowane, najszybsze rozwiązania per klaster. Mateusz edytuje lub wetuje lekcje w PR.

**Ton UX:** zawsze „doradczo, z dowodami": każdy wynik ma proweniencję, poziom pewności i „czego sprawdzić, zanim skopiujesz". Nigdy rozkaz.

## 13. Bezpieczeństwo, prywatność, governance

- **Egress**: każdy tekst wychodzący z maszyny (embeddingi, Jev) przechodzi przez screen na surowych liściach; trafienie = pominięcie elementu + licznik, fail-closed. Surowe wyniki narzędzi nie są ani przechowywane, ani wysyłane.
- **Zakres (D5)**: `^(FOC|JOI)-\d+$` **plus** allowlista repozytoriów (`joint-flows`, `office`, `linear-agents` z `config/projects.json`) **plus** denylista ścieżek. Powód: w transkryptach widziałem ścieżki spoza repo Fenixa (m.in. `jointhubs-os\Second Brain\...` z materiałem klienckim); nie sprawdziłem, czy są powiązane z biletami FOC/JOI, więc F0 to liczy (T0.1).
- **Treść pobrana = dane, nie instrukcje**: karty mają delimitery i nagłówek „advisory"; agenci ignorują polecenia zawarte w precedensach (tekst pochodzi od modeli i ludzi — możliwy prompt injection); rozmiary ograniczone.
- **Zatrucie i nieaktualność**: veto L2, stale-check przez CodeGraph, `staleAfter` dla lekcji.
- **Koszty**: każde wywołanie embeddingów/Jeva emituje zdarzenie telemetrii z `usage.cost`; twardy limit `LA_PRECEDENT_MAX_COST_USD`.
- **Retencja**: indeks lokalny, poza gitem; `precedent purge --task`; lekcje (git) nie zawierają sekretów (checker + screen).
- **Bez natywnych zależności w rdzeniu** (Smart App Control): ingest, wyszukiwanie i MCP = czysty JS + `node:sqlite`. Python tylko jako opcjonalny, wsadowy sidecar (klastrowanie, ewaluacja; D13); Laya, jeśli wejdzie, jako osobna usługa/MCP w Pythonie (F6).

## 14. Ewaluacja — bramka dowodowa (F0) i pomiar online

Wzorzec repo: `scripts/*-eval.mjs` + fixtures + raport w `docs/benchmark/` (jak `plan-ac-eval`, `plan-dod-eval`).

**Offline (F0), podział czasowy (zapytanie widzi tylko wcześniejsze przypadki — bez przecieku):**

| Test | Metryka | Punkt odniesienia |
|---|---|---|
| Trafność wyszukiwania (proxy: wspólne pliki, ten sam epik, relacje) | Recall@5, MRR, nDCG@10 | BM25, losowo, oracle po plikach |
| **Bake-off embeddingów** (4–6 modeli × facety × wymiary; prefiks instrukcji dla zapytań; parametr `dimensions`) | jw. + koszt + opóźnienie | wzajemnie |
| Predykcja kosztu/rund z sąsiadów | MAPE, Spearman | mediana globalna, mediana per typ |
| Rerank Jev (`noul`) | precision@3 z/bez rerankingu | bez rerankingu; podzbiór ręcznie zweryfikowany (50–100 par) |
| Wyszukiwanie epizodów po sygnaturze błędu | hit@k | dopasowanie dokładne sygnatury |
| Klastrowanie | spójność, stabilność (ARI), zgodność z etykietami | wzajemnie |
| Jev vs Laya na `step_kind` / `problem_type` | dokładność, ECE | ręczna próbka |

**Proponowane progi go/no-go (do zatwierdzenia):** Recall@5 ≥ 0,35 na przypadkach mających ≥ 1 pozytyw; poprawa MAPE predykcji kosztu ≥ 15% względem mediany per typ; ≥ 60% klastrów spójnych wg przeglądu ręcznego. **Nie spełnione ⇒ stop lub zawężenie do indeksu „plik → przypadki" (struktura bez wektorów).**

**Online:** każde zapytanie, wynik i użycie (`##PRECEDENT`) logowane; po ~4 tygodniach porównanie zadań z adnotacją i bez (dopasowanie po typie/rozmiarze; **mała próba — raportować przedziały i nie twierdzić przyczynowości**).

## 15. Fazy i taski (plan zaakceptowany 2026-09-29; F0 zatwierdzona do startu, F1+ po bramce go/no-go)

**F0 — Evidence spike (offline, bez infrastruktury; 2–4 dni)**
- [x] T0.1 Korpus: snapshot przypadków FOC/JOI z poziomami V0/V1/V2, mapowaniem ticket → commity/branch/pliki, liczeniem transkryptów według repo i cwd (test zakresu D5)
- [x] T0.2 Bake-off embeddingów przez OpenRouter (Qwen3-8B/4B, Gemini-2, Voyage-4-large i code-4, OpenAI 3-large, opcjonalnie pplx-embed) + test `dimensions` i prefiksu instrukcji
- [x] T0.3 Ewaluacja trafności z podziałem czasowym + punkty odniesienia
- [x] T0.4 Predykcja kosztu/rund z sąsiadów
- [x] T0.5 Porównanie algorytmów klastrujących
- [x] T0.6 Pilotaż Jev (D12): `relevance`, `step_kind`, `problem_type` na 200 elementach, z zapisem etykiet jako materiału do przyszłej destylacji. **Laya nie wchodzi do F0** (przeniesiona do F6; pobranie modelu i osobne środowisko dopiero wtedy)
- [x] T0.7 Wykonalność łańcuchów: segmentacja 50 transkryptów, sanity epizodów, wyszukiwanie po sygnaturze błędu
- [ ] T0.8 Raport `docs/benchmark/precedent-index-spike.md` (napisany 2026-09-29) + **decyzja go/no-go (Mateusz) — czeka**

**F1 — L1: indexer, magazyn, CLI (2–3 tyg.)** — schemat SQLite; konektory (Linear, git, `.state`, telemetria, transkrypty); screen; klient embeddingów z meterem i wpisem w `config/models.json`; ingest idempotentny; `precedent search/show/status/ingest`; testy (`*.test.mjs`, lane w `test-lanes.json`, lint); guard świeżości; hook supervisora po Done. **AC:** ingest całego korpusu FOC/JOI < 15 min i < $5; powtórny ingest nic nie zmienia i nic nie kosztuje; zapytanie < 1 s; pokrycie testami ścieżek fail-closed.

**F2 — Łańcuchy i relacje** — segmentacja, krawędzie, `precedent chain`, tagowanie `step_kind` (Jev), wyszukiwanie po sygnaturze błędu. **AC:** dla próbki 50 epizodów `recover` ≥ 70% zgodności z ręczną oceną rodzaju/wyniku.

**F3 — MCP i integracja A0** — `server-precedent.mjs`, krok `plan.precedents`, `state.neighbors` w `intake.task_size`, blok w wyniku triage, REVIEW „findingi na tych plikach", marker `##PRECEDENT`, zdarzenia telemetrii. **AC:** zapytania i użycia widoczne w telemetrii; brak zmian w zachowaniu agentów poza adnotacją.

**F4 — L2: CADENCE curator** — ADR-0014, zmiana `agents/cadence/CLAUDE.md` (Mateusz), rola `curator`, checker cytatów, lekcje w `docs/lessons/`, lane i veto w wyszukiwaniu, harmonogram. **AC:** tygodniowy przebieg produkuje adnotacje i ≥ 1 lekcję z dowodami zweryfikowanymi checkerem; lekcja bez dowodów jest odrzucana; L2 wygrywa z L1 zgodnie z regułami.

**F5 — Klastry, efektywność, playbooki** — produkcyjne klastrowanie z przypiętymi id, ranking `fastest` z sąsiadami i bramkami, best-of-cluster → szkice playbooków (brainstorm B). **AC:** stabilne id klastrów między przebiegami (ARI ≥ ustalony próg); ranking pokazuje `n` i przedział.

**F6 — Dashboard, monitoring, Laya, retencja** — panel „podobne zadania", metryki pokrycia/hit-rate/dryfu/kosztu, decyzja o Layi (student/Path B), kopia zapasowa warstwy łańcuchów.

## 16. Ryzyka

| Ryzyko | Mitygacja |
|---|---|
| Mały korpus ⇒ niski hit-rate | bramka F0, abstencja, indeks strukturalny jako plan awaryjny |
| Wyciek poufnych treści (JOI, myśli) przez API | screen fail-closed, allowlista repo, denylista ścieżek, brak wyników narzędzi |
| Kotwiczenie na przestarzałych/złych rozwiązaniach | doradczo, „różnice do sprawdzenia", stale-check, veto L2 |
| Prompt injection przez pobrany tekst | delimitery, nagłówek advisory, limity |
| Goodhart na „najszybciej" | oczekiwanie z sąsiadów, bramka V2, `n` i przedział |
| **CADENCE nie chodzi / kontrakt read-mostly** | ADR + zmiana kontraktu + harmonogram jako jawne zadania F4 |
| Endpoint Jev alfa się zmienia | pin modelu, typowane błędy, Path B (Laya) |
| Dryf tożsamości klastrów | przypinanie i nazwy przez L2 |
| Retencja transkryptów ⇒ utrata łańcuchów | indeksowanie wcześnie, kopia zapasowa |
| Parytet portu logiki pętli/segmentacji z notebookiem (Python → Node) | testy parytetu na próbce |
| Deprecacja/zmiana modelu embeddingów | id modelu przy każdym wektorze, zadanie re-embed |
| Opóźnienie pierwszego wywołania (Qwen ~8 s) | batch, asynchronicznie, cache |

## 17. Odrzucone alternatywy

Lokalne embeddingi (Ollama) — sprzeczne z D3; usługa bazy wektorowej lub `sqlite-vec` (natywna biblioteka, ryzyko Smart App Control, korpus za mały); indeksowanie surowych transkryptów jako jedyne źródło (retencja, prywatność, szum); jedna warstwa bez curacji (brak kontroli jakości); LLM-owy „sędzia" jako jedyny ranking (koszt, brak kalibracji, nieodtwarzalność); budowa na `flow.db` (uśpiony, 45 zadań).

## 18. Pytania z rundy 1 — rozstrzygnięte 2026-09-29

| # | Pytanie | Odpowiedź Mateusza | Zapisane jako |
|---|---|---|---|
| 1 | Sygnał zatwierdzenia człowieka (V2) | „ok" (domyślne) | D8 |
| 2 | Waga „najszybciej" | „najmniej tur, ale inne też z jakąś wagą" | D9 (interpretacja liczbowa i rozszerzenie „tury" na tury LLM + tury dziecka + rundy review są moje — do korekty w `config/precedent.json`) |
| 3 | Wysyłka treści JOI/transkryptów do API embeddingów | „tak, wolno" | D10 |
| 4 | Rola `curator` w CADENCE | zgoda | D11 |
| 5 | Jev najpierw, Laya później | „tak, Jev najpierw" | D12 |
| 6 | Sidecar w Pythonie | „tak" | D13 |
| 7 | Progi go/no-go | „tak" | D14 |

**Nadal otwarte (nie blokują F0):** (a) dokładna interpretacja „tur" (tury LLM vs tury dziecka supervisora vs rundy review — F0 sprawdza, czy ranking zależy od tego rozróżnienia); (b) termin zmiany `agents/cadence/CLAUDE.md` i uruchomienia harmonogramu (F4); (c) czy zmieniać ADR-0012 w sprawie Path B (Ollama vs Laya) — dopiero w F6.

## 19. Status prac nad tym dokumentem

- [x] Rekonesans repo (FlowDB, brainstormy A/B/C, ADR-0012, CADENCE, gate'y i werdykty, transkrypty)
- [x] Weryfikacja faktów zewnętrznych (lista modeli OpenRouter, żywe wywołania embeddingów, karta modelu Laya)
- [x] Zapis brainstormu (ten plik)
- [x] Akceptacja Mateusza (sekcje 2, 14, 15, 18) — 2026-09-29
- [x] PRD `docs/prd/prd-precedent-index.md` (2026-09-29)
- [x] ADR-0014 `docs/adr/0014-precedent-index-two-layer.md` (Proposed, 2026-09-29)
- [x] F0 wykonana (T0.1–T0.7); wyniki i rekomendacja „go, zawężone": `docs/benchmark/precedent-index-spike.md`, skrót w sekcji 3a
- [ ] Decyzja go/no-go (T0.8, Mateusz) → dopiero potem F1

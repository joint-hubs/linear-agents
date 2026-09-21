# Jev w architekturze Fenixa — mapa zastosowań

> **Data:** 2026-09-21
> **Autor:** Claude (sesja audytowa), z Mateuszem
> **Rodzaj:** plan rozmieszczenia (nie PRD, nie task)
> **Kontekst:** FOC-380, ADR-0012 (typy kroków, warstwa decyzyjna), FOC-386 (moduł `decision-call.mjs`),
> FOC-401 (serwery MCP). Uzupełnia `docs/plans/fenix-architecture-gaps-2026-09-19.md`.
>
> **Status (2026-09-21, później):** mapa zostaje referencją „gdzie Jev". **Kolejność i przypisanie
> do tasków wyznacza roadmapa Fenix** — milestone'y M1–M6 i epiki w projekcie FENIX w Linear.
> Sekcje 5 i 7 są historyczne (FOC-380 i FOC-447 zamknięte jako zastąpione). Poprawki po niezależnym
> review: definicja A2, #21 sekrety (najpierw lokalnie), węzły [G] do generowania małych struktur.

## 1. Założenie

Jev to szybki, tani klasyfikator z kalibrowaną pewnością. Pytanie nie brzmi „czy go używać", tylko
**w których miejscach architektury każda decyzja o kształcie klasyfikacji ma trafić do Jev zamiast do
LLM-a albo do prymitywnej heurystyki**. Dziś takie decyzje podejmuje głównie frontman (~40% tokenów),
prompty squadów albo reguły typu „10 minut ciszy = utknął".

**Parametry (zmierzone na OpenRouter Decisions API, `typesafe/jev-1.13`):**
- 0,3–0,55 s na wywołanie;
- ok. $0,00002 za wywołanie z kilkoma pytaniami naraz;
- limit 1 200 wywołań na minutę.

Można go więc wołać przy każdym zdarzeniu: każdej komendzie, turze, gate'cie, commicie, komentarzu.

**Trzy poziomy autonomii — każde miejsce startuje od A0 i awansuje osobno:**

| Poziom | Znaczenie | Kiedy wolno |
|---|---|---|
| **A0 — doradczo** | Jev dopisuje ocenę; decyduje człowiek albo agent | od razu, bez kalibracji |
| **A1 — bramkowane** | działa sam powyżej skalibrowanego progu, poniżej eskaluje w kaskadzie | po pomiarze kalibracji dla tej decyzji (FOC-387) |
| **A2 — samodzielnie** | decyduje bez człowieka, ale nadal eskaluje przy niskiej pewności, nieznanym typie wejścia, nowej wersji modelu, dryfie odsetka decyzji i błędzie API | po okresie A1 bez regresji, Twoją edycją |

**Zasady projektowania (z dokumentacji TypeSafe i naszych sond):**
- **Kod zbiera fakty, Jev ocenia.** W sondzie porażek testów decydujące były fakty dołączone do stanu (który checkout, czy są `node_modules`, jaka zmiana weszła wcześniej). Jakość decyzji = jakość zebranych faktów.
- **Jedno pytanie na pole.** Złożony osąd rozbijamy na kilka pytań, a wynik składamy w kodzie.
- **Krótki, przefiltrowany stan.** Trafność spada z każdą nieistotną informacją.
- **Zero arytmetyki i dat** — to liczy kod.
- **Jev nie pisze tekstu.** Tekst generują szablony, węzły [G] (jedno wywołanie API z minimalnym kontekstem i schematem JSON, np. DoD i kryteria akceptacji w PLAN) albo kroki agentowe.
- **„Prompt" to `instructions` i `criteria` każdego pytania.** Są wersjonowane i można je optymalizować (GEPA, FOC-398).

## 2. Dowody — sondy na prawdziwych danych repo

| Zadanie | Przypadki | Wynik | Czas | Koszt |
|---|---|---|---|---|
| Klasyfikacja gate'ów (typ, „wymaga Mateusza") | 3 | typ 3/3; „wymaga Mateusza" rozdzielone czysto | 0,29–0,49 s | $0,00007 |
| Przyczyna porażki testu | 3 przypadki z tego tygodnia (security-scan, supervisor-verdict, verdict-evidence) | **3/3** (brak zależności 0,9 · nieaktualny test 0,76 · stan środowiska 1,0) | 0,39–0,55 s | $0,00006 |
| Sekret w komentarzu przed wysłaniem do Linear | klucz vs sama nazwa zmiennej | **2/2** (p = 0,99 vs 0,04) | 0,34–0,35 s | $0,00004 |

Przyczyny tych trzech porażek ustalaliśmy w tym tygodniu przez kilka godzin. Jev przy tych samych
faktach trafił w nie w 1,4 s. Słabe miejsce: pytanie „czy dokumentacja odpowiada" przy gate'ach dało
tylko 0,61–0,73. Część pytań będzie więc wymagała lepszych `criteria` albo lepiej zebranych faktów,
a progi zawsze wynikają z kalibracji.

## 3. Mapa — 28 punktów decyzyjnych na 8 płaszczyznach

Legenda wartości: **K** koszt, **J** jakość, **B** bezpieczeństwo, **N** niezawodność.

### A. Wejście i planowanie

| # | Punkt decyzyjny | Pytania (typ) | Co decyduje dziś | Wartość | Autonomia start → cel | Task |
|---|---|---|---|---|---|---|
| 1 | Triage issue → węzeł (plan/dev/review/test/ask) | `choice` + `noul` „są kryteria akceptacji?" | frontman sam wpisuje `--confidence 0–100` (`supervisor-triage.mjs`) | K, J | A0 → A1 | nowy |
| 2 | Rozmiar zadania → ścieżka small / medium / large | `choice` | frontman | **K** (małe zadania bez pełnego pipeline'u) | A0 → A1 | FOC-401 (zbudowane, niepodpięte) |
| 3 | Definition of Ready: kryteria testowalne? zakres jasny? kontekst wystarczający? | `noul` × n | PLAN (LLM) | J | A0 → A1 | nowy |
| 4 | Etykiety: typ, ryzyko, estymata, czy potrzebny ADR, czy wrażliwe na bezpieczeństwo | `choice` / `score` / `noul` | PLAN (LLM) | J (spójność) | A0 → A2 | nowy |
| 5 | Duplikat albo powiązane issue (kandydatów wybiera kod) | `choice` | nikt | J | A0 | nowy |
| 6 | Ekstrakcja funkcji z dyktowanego opisu | `noul` na kandydata | — | J | A0 | FOC-401 (zbudowane) |

### B. Routing modeli i eskalacja

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 7 | Tier modelu dla dziecka (flash / standard / frontier) | `choice` | konfiguracja albo decyzja ad hoc (FOC-403: Sonnet 5, $435) | **K**, J | A0 → A1 | FOC-389 + nowy |
| 8 | Wyzwalacz eskalacji do Fable 5.1 / GPT-6 Astra | `noul` „wysoka stawka", `noul` „trudne" | — | J | A1 | FOC-395 |

### C. Wykonanie (DEV / TEST)

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 9 | Które z kandydujących plików (z codegraph) przypiąć w prologu dziecka | `noul` na plik | dziecko odtwarza stan samo (27–50% pierwszych wywołań) | **K**, szybkość | A1 | nowy (łączy FOC-382 / FOC-283) |
| 10 | Przyczyna porażki testu: brak zależności / stan środowiska / nieaktualny test / regresja | `choice` + `noul` | godziny śledztwa (klasa FOC-351 / FOC-355) | **J**, N | A0 → A1 | nowy (**sonda 3/3**) |
| 11 | Czy zmiana wymaga testów i jakich (unit / e2e / obciążeniowe) | `noul` / `choice` | DEV (LLM) | J | A0 | nowy |

### D. Weryfikacja (REVIEW / TEST)

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 12 | Finding: waga i ugruntowanie | `choice` + `noul` | recenzent (LLM) | J | A0 → A1 | FOC-390 |
| 13 | Czy każde kryterium akceptacji jest pokryte przez diff i dowody | `noul` na kryterium | recenzent (LLM); 155 mapowań już zapisanych | J | A0 → A1 | nowy |
| 14 | Głębokość review (first-pass / deep / security) | `choice` | stała konfiguracja | K | A1 | nowy |
| 15 | Ta sama klasa błędu co w poprzedniej rundzie | `noul` na parę findingów | hash identycznych diffów | K, J | A0 → A1 | FOC-393 |

### E. Orkiestracja — największa dźwignia kosztowa

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 16 | Następny krok dla dziecka (czekaj / wznów / przejdź dalej / eskaluj / zapytaj Mateusza) | `choice` | tura frontmana (LLM) | **K** (~40% tokenów) | A0 → A1 | FOC-397 (dopisać) |
| 17 | Utknął / pracuje / czeka — na podstawie końcówki logu dziecka | `choice` | heurystyka „10 minut ciszy" (`supervisor-status.mjs`, `STALL_SILENCE_MS`) | N, szybkość reakcji | A1 | nowy |
| 18 | Czy raport dziecka jest kompletny | `noul` na wymagane pole | frontman czyta całość | K | A1 | nowy (razem z FOC-382) |
| 19 | Gate: typ / odpowiadalny z dokumentacji / wymaga Mateusza / pilność | `choice` + `noul` | frontman przekazuje dalej | K, mniej przerwań | A0 → A1 (auto-odpowiedź: ADR-0013) | FOC-391 / FOC-392 |

### F. Bezpieczeństwo

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 20 | Czy komenda jest nieodwracalna (hook PreToolUse) — może zastąpić klasyfikator auto mode | `noul` × 2 + `choice` | lista blokad, do obejścia przez `cmd /c` | **B**, K | A0 → A1 | FOC-394 |
| 21 | Sekret w tekście przed wysłaniem do Linear / GitHub (repo publiczne) | `noul` — **tylko na zamaskowanym tekście, jako druga linia** | regex `redact()` — sam kod mówi, że to „nie jest skaner" | **B** | najpierw lokalny skaner blokuje bez wysyłki; Jev dopiero potem | FOC-450 (**sonda 2/2**) |

> **#21 — granica bezpieczeństwa.** Wysłanie tekstu do zewnętrznego klasyfikatora, żeby sprawdzić, czy zawiera sekret, już przekracza granicę. Kolejność jest więc stała: lokalny skaner (prefiksy kluczy, entropia, linie `KEY=value`, reguły secretlint z FOC-285) blokuje post bez żadnej wysyłki. Jev widzi wyłącznie tekst z zamaskowanymi kandydatami, np. `<token 48 znaków, prefiks sk-or->`.
| 22 | Prompt injection w niezaufanym wejściu (issue, strony, tekst review) | `noul` | nic | B | A0 → A1 | nowy |
| 23 | Zmiana wykracza poza zakres zadania (semantycznie, obok deterministycznego `pathsOutsideDeclaration`) | `noul` | tylko ścieżki | J, B | A0 | nowy |

### G. Obserwowalność i analityka (masowe przetwarzanie korpusu)

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 24 | Klasyfikacja każdej tury w korpusie (odtwarzanie stanu, pętla, zły tool) | `choice` | dopasowanie po nazwie narzędzia (`context-attribution.mjs`, `classifyToolResult`) | J telemetrii | A2 (offline) | nowy |
| 25 | Przyczyna złej tury (dostawca / prompt / kod) | `choice` | ręczna analiza (22 z 38 to dostawca) | N | A2 (offline) | nowy |
| 26 | Etykiety wyników sesji → przyszłe dane do fine-tuningu | różne | — | przyszły fine-tuning | A2 (offline) | nowy (dziennik decyzji) |

### H. Komunikacja i pamięć

| # | Punkt decyzyjny | Pytania | Dziś | Wartość | Autonomia | Task |
|---|---|---|---|---|---|---|
| 27 | Czy zdarzenie wymaga Mateusza teraz (pilność powiadomienia) | `choice` | — | mniej przerwań | A0 → A1 | nowy |
| 28 | Czy fakt warto zapisać w STATE albo w pamięci | `noul` | — | higiena kontekstu | A0 | nowy |

## 4. Warstwa wspólna — bez niej każde miejsce to osobny kod

1. **Rejestr decyzji (konfiguracja, nie kod).** Każda decyzja ma wpis:
   - `id` i krok, do którego należy;
   - pytania + `criteria` (plik wersjonowany);
   - poziom autonomii;
   - próg z kalibracji;
   - ścieżka zapasowa;
   - metryki.

   Nowe miejsce użycia = nowy wpis + `criteria`. Wszystkie punkty podpięcia wołają `decision-call.mjs` po `id`. Dzisiejszy katalog MCP (`docs/mcp-decision-steps-catalog.md`) staje się tym rejestrem.
2. **Dziennik decyzji z pełnym wejściem i faktycznym wynikiem.** Dziś zapisuje się tylko hash wejścia. Potrzebne są:
   - pełny stan i wersja `criteria` — lokalnie w `.state`, gitignorowane, oczyszczone z sekretów;
   - odpowiedź, pewność i wersja modelu;
   - to, co ostatecznie zdecydował człowiek albo agent — to jest etykieta.

   Służy kalibracji teraz i fine-tuningowi później. Etykietą jest faktyczna decyzja, nie odpowiedź Jev.
3. **Punkty podpięcia:**
   - hooki Claude Code: PreToolUse (#20, #21), PostToolUse / Stop (#17, #18);
   - krawędzie `decide:` w `graph.json` v2 (#1, #2, #14, #16 — FOC-396 / FOC-397);
   - serwery MCP dla agentów (#2, #6);
   - skrypty: `supervisor-triage.mjs` (#1), `supervisor-status.mjs` (#17), publikacja w Linear (#21), analityka (#24, #25).
4. **Kalibracja (FOC-387)** — progi osobno dla każdej decyzji, awans A0 → A1 → A2 osobno dla każdej decyzji.
5. **Niezawodność:**
   - endpoint Decisions API jest w wersji alpha, więc ścieżka zapasowa jest obowiązkowa dla wszystkiego, co nie może stanąć;
   - limit 1 200 wywołań na minutę;
   - kilka pytań w jednym wywołaniu tnie liczbę wywołań.
6. **Optymalizacja `criteria` (GEPA, FOC-398)** — każde miejsce ma swój „prompt" do strojenia na etykietach z dziennika.

## 5. Kolejność (fale)

| Fala | Co | Dlaczego teraz |
|---|---|---|
| **1 — od razu** | rejestr + dziennik (enablery 1–2); #21 sekrety przed Linear; #1 triage z mierzoną pewnością; #2 rozmiar zadania → ścieżka (podpięcie FOC-401); #10 przyczyna porażki testu; #19 gate w trybie doradczym | niskie ryzyko (A0), natychmiastowa wartość; każde z tych miejsc zaczyna od razu zbierać etykiety do kalibracji |
| **2 — dźwignia kosztu** | #16 następny krok, #17 utknął/pracuje, #18 kompletność raportu — razem z FOC-396 / FOC-397 | frontman to ~40% tokenów; tu Jev zastępuje tury LLM-a |
| **3 — jakość weryfikacji** | #12, #13, #14, #15; #7 routing modeli, #8 eskalacja | potrzebują harnessu kalibracji (FOC-387) i benchmarku (FOC-389) |
| **4 — bezpieczeństwo samodzielne** | #20 nieodwracalne komendy (zamiennik klasyfikatora auto mode), #22 prompt injection | wymagają A1 z kalibracją; wysoka stawka błędu |
| **Stale, offline** | #24, #25, #26 analityka korpusu i etykiety | tanie masowe przetwarzanie; buduje dane do fine-tuningu |

## 6. Czego Jev nie robi

- **Nie pisze tekstu:** specyfikacji, kodu, raportów, handoffów. To zadanie węzłów [G], kroków agentowych i szablonów. Jev ocenia ich wynik na bramce.
- **Nie liczy i nie porównuje dat** — to robi kod.
- **Nie zastępuje testów ani linterów** — ocenia ich wyniki (#10), nie wykonuje ich pracy.
- **Nie decyduje sam o push, merge ani sprzątaniu worktree.** Te gate'y zostają ludzkie (ADR-0013 wyklucza je z auto-odpowiedzi).

## 7. Wpięcie w Linear (zrobione 2026-09-21)

**Nowy podepik FOC-447 „Jev decision layer"** pod FOC-380:

| Fala | Issue | Miejsca z mapy |
|---|---|---|
| W1 | **FOC-448** rejestr decyzji | enabler 1 |
| W1 | **FOC-449** dziennik decyzji z pełnym wejściem i etykietą | enabler 2, #26 |
| W1 | FOC-450 sekrety przed wysłaniem do Linear/GitHub | #21 |
| W1 | FOC-451 wejście: triage + rozmiar zadania → ścieżka (podpina FOC-401) | #1, #2, #6 |
| W1 | FOC-453 przyczyna porażki testu | #10 |
| W2 | FOC-454 monitoring: utknął / pracuje / czeka, pilność powiadomień | #17, #27 |
| W2 | FOC-455 trafność kontekstu dla prologu | #9 |
| W3 | FOC-452 decyzje PLAN: DoR, etykiety, duplikaty | #3, #4, #5 |
| W3 | FOC-456 decyzje REVIEW: pokrycie kryteriów, głębokość | #13, #14 |
| W3 | FOC-457 tier modelu dla dziecka | #7 |
| W4 | FOC-458 prompt injection, zmiany poza zakresem | #22, #23 |
| offline | FOC-459 analityka korpusu | #24, #25 |

**Istniejące taski dostały sekcję „Jev integration — plan v2":**

| Issue | Co doszło | Miejsca z mapy |
|---|---|---|
| FOC-382 | kompletność raportu | #18 |
| FOC-387 | kalibracja per id decyzji | — |
| FOC-390 | weryfikacja findings w trybie A0 | #12 |
| **FOC-391** | **teraz doradczo**, nowy tytuł | #19 |
| FOC-392 | progi z rejestru | — |
| FOC-393 | powtórzenia klasy błędu | #15 |
| FOC-394 | nieodwracalne komendy; kandydat na zamiennik płatnego klasyfikatora auto mode | #20 |
| FOC-395 | wyzwalacz eskalacji | #8 |
| FOC-396 / FOC-397 | krawędzie `decide:` i runner, który je wykonuje | #16 |
| FOC-398 | GEPA na criteria z rejestru | — |
| FOC-399 | fine-tuning odłożony z wyzwalaczem | — |

**Relacje:**
- FOC-448 blokuje wszystkie miejsca użycia oraz FOC-390, 391, 393, 394, 395, 397;
- FOC-449 blokuje FOC-392, 398, 399 i jest powiązany z FOC-387;
- FOC-389 blokuje FOC-457.

**Fine-tuning:** FOC-359 zamknięty jako zastąpiony; FOC-273 i FOC-281 dostały notę o dzienniku jako przyszłym źródle danych.

Poza issue zostały dwa miejsca o małej wartości: #11 (jakie testy są potrzebne) i #28 (co zapisać w pamięci). Łatwo je dodać jako wpisy w rejestrze, gdy FOC-448 będzie gotowy.

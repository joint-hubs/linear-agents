# Dobór modeli do składów Fenixa — propozycja i porównanie kosztów

> Data: 2026-10-21 · Dane: `telemetry.sqlite` (30 dni: 21.09–20.10, wiadomości zdeduplikowane po `source_path` + `message_id`, tylko flota OpenRouter — bez interaktywnych sesji Claude/OpenAI), benchmarki Artificial Analysis ze snapshotu `docs/ui/model-explorer.html` (2026-10-21), ceny OpenRouter z tego samego dnia.
> Poprzednia analiza: `docs/prd/model-role-fit-analysis.md` (2026-07-28) — jej główny wniosek nadal obowiązuje: **pieniądze są w leadach, nie w rolach**.

## Decyzja (Mateusz, 2026-10-21)

- **Wariant B wchodzi** (FOC-964): Supervisor na `xiaomi/mimo-v2.6-pro`; `z-ai/glm-5.3` dla REVIEW `deep`/`security`, TEST `root-cause`, DEV `debugger`/`refactorer`; mimo dla leada PLAN, `spec`, `spec-review` oraz CADENCE `retro`/`digest`; glm-5.3-flash wszędzie indziej (łącznie z aliasami Supervisora/CADENCE). **Tier `sonnet` zostaje `google/gemini-2.5-flash-lite`** — Claude Code używa go dla klasyfikatora auto mode, więc benchmarki ogólne są tu bez znaczenia (korekta Mateusza).
- **Grok 4.7 — nie.** Ta sama inteligencja co mimo przy ~12× wyższym koszcie Supervisora.
- **Test A/B Supervisora** (FOC-965) — mimo jako baseline, kandydaci porównywalni cenowo i jakościowo:

| Supervisor (lead + `general-purpose`, 30 dni) | cennik listowy | cennik jakościowy (fp8 / first-party) | Intel | Długi kontekst | Bez halucynacji | Agentic |
|---|---:|---:|---:|---:|---:|---:|
| **anthropic/claude-haiku-5.5** (max) — kandydat 1 | $84 | $84 (tylko Anthropic) | 43,4 | 82,7 | 59,6 | — |
| xiaomi/mimo-v2.6-pro — baseline | $138 | $142 | 46,3 | 86,3 | 59,4 | — |
| **z-ai/glm-5.3-flash** — kandydat 2 (tanie dno) | $24 | $138 | 41,8 | 80,0 | 72,4 | 50,9 |
| z-ai/glm-5.3 (max) — odrzucony jako Supervisor | $294 | **$1 222** | 44,8 | 79,7 | 70,4 | 53,1 |

  Przełączanie bez zmiany kodu: `routing.supervisor.lead` w nakładce ustawień (dashboard → Settings → Routing albo `fenix settings set routing.supervisor.lead <id>`). Każdy kandydat ma wiersz cennika, więc koszt na ticket jest liczony.

### Mocniejsze modele do testu (Supervisor i leady)

Przy pełnym ruchu każdy mocniejszy model to 6–10× kosztu mimo — dlatego test na kilku ticketach (FOC-965), nie przestawienie. Koszt 30 dni przy obecnym ruchu (zapisy do cache liczone jako 4% odczytu po cenie *cache write*):

| Model | Supervisor | lead PLAN | lead DEV | lead REVIEW | lead TEST | Intel | Długi kontekst | Bez halucynacji | Agentic / Code |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| xiaomi/mimo-v2.6-pro (baseline) | $138 | $4 | $33 | $20 | $18 | 46,3 | 86,3 | 59,4 | — |
| **google/gemini-4-argon** (high) | $1 112 | **$32** | $249 | $148 | $140 | 52,6 | 79,7 | **84,9** | — |
| **meta/muse-spark-1.3** (max) | **$864** | $21 | **$179** | $103 | $103 | 48,1 | 83,0 | 67,1 | **55,5 / 75,8** |
| **anthropic/claude-sonnet-5.5** (max) | $1 381 | $37 | $295 | $172 | $168 | **56,0** | 82,7 | 53,0 | — |
| openai/gpt-6.1-sol (high) | ~$1 100+ | — | — | — | — | 50,2 | 82,3 | 50,6 | — |
| anthropic/claude-opus-5.5 (max) | $2 761 | — | — | — | — | 57,6 | 84,7 | 41,4 | — |

Propozycja: **lead PLAN na gemini-4-argon** (≈ $32/mies. — najtańsze miejsce na jakość, błąd planu rozlewa się dalej); **Supervisor A/B**: gemini-4-argon (jakość + uczciwość), muse-spark-1.3 (agentic, ~6× mimo), opcjonalnie claude-sonnet-5.5 (natywny Claude Code); lead DEV ewentualnie muse-spark-1.3. GPT-6.1 Sol i Opus 5.5 odpadają (gorsza uczciwość, drogie zapisy do cache / cena). Wszyscy trzej kandydaci mają jednego dostawcę — cena stabilna, bez problemu fp4. Wiersze cenników dodane w FOC-964; przełączanie z dashboardu (Settings → Provider & routing, wiersz Supervisora lub leada składu).

Wcześniejsze $872 dla Sonnet 5.5 w tabelach niżej nie liczyło zapisów do cache ($2,50/M u Anthropic) — poprawna wartość to ≈ $1 381.

### Cena zależy od dostawcy (FOC-966)

„Cena modelu” na OpenRouter to cena **najtańszego endpointu**, często kwantyzowanego do fp4. glm-5.3: Wafer fp4 $0,079 / 1,40 / 0,078 per 1M, a Z.AI (first-party, fp8) $1,40 / 4,40 / 0,26. glm-5.3-flash: OpenInference fp4 $0,041 / 0,12 / 0,0037 wobec Z.AI fp8 $0,15 / 0,50 / 0,03. mimo kosztuje tyle samo u wszystkich dostawców (fp8), Haiku jest tylko u Anthropic.

Benchmarki AA mierzą model first-party — tę jakość dostajemy dopiero przy dostawcy fp8. Ten sam ruch z 30 dni:

| | cennik listowy (najtańszy endpoint) | cennik jakościowy (fp8 / first-party) |
|---|---:|---:|
| Wariant A | $169 | $310 |
| **Wariant B** | **$205** | **$433** |

Telemetria liczy koszt z wierszy `config/models.json` (ceny fp8), a domyślny routing OpenRouter preferuje tanich dostawców — prawdziwy rachunek i jakość leżą gdzieś pomiędzy. `providerPins` działa dziś tylko dla węzła grafu PLAN, nie dla sesji Claude Code. Do zmierzenia i decyzji w FOC-966 (miks dostawców z eksportu aktywności OpenRouter, ewentualnie allowlista fp8 na poziomie konta).

Tabele niżej (pisane przed decyzją) używają cennika listowego ze snapshotu explorera (glm-5.3-flash z wyjściem $0,375/M); z cennikiem listowym z API z tego samego dnia (wyjście $0,12/M) wariant A to $169, a B $205.

## TL;DR

| Konfiguracja | Koszt 30 dni (ten sam ruch) |
|---|---:|
| Historycznie (to, co faktycznie zapłaciliśmy) | **$302** |
| **Obecny routing** (Supervisor na `x-ai/grok-4.7`) | **≈ $2 158** |
| **Propozycja A — oszczędna** (Supervisor na mimo, reszta glm-5.3-flash) | **≈ $184** |
| **Propozycja B — jakość tam, gdzie się opłaca** | **≈ $218** |

1. **Supervisor wraca na `xiaomi/mimo-v2.6-pro`.** Grok 4.7 ma tę samą inteligencję (AA 46,3 = 46,3), gorszy długi kontekst (77 vs 86,3) i ~15× droższy odczyt z cache ($0,50 vs $0,0036/M) — a 92% tokenów Supervisora to odczyt z cache. Na obecnym routingu Supervisor + jego subagenci `general-purpose` (dziedziczą model leada) kosztowaliby ≈ $2 113 / 30 dni zamiast ≈ $139.
2. **`z-ai/glm-5.3-flash` zostaje koniem pociągowym** wszystkich składów-dzieci: najtańszy sensowny model w katalogu (cache $0,0037/M) i jednocześnie jeden z najlepszych na `agentic`, `coding` i *non-hallucination* w swojej klasie.
3. **Trzy sprzątnięcia bez dyskusji** (tańsze *i* lepsze): ~~tier `sonnet` → glm-5.3-flash~~ (wycofane: to model klasyfikatora auto mode); aliasy `glm` (= glm-5.2, wyjście $7/M) i `deepseek_pro` (non-hallucination 5,9) → nowe modele.
4. **Gdzie dopłacić za jakość** (wariant B, +$34/mies.): leada PLAN + `spec` + `spec-review` na mimo (planowanie rozlewa błędy na wszystko dalej), trudne role (`debugger`, `refactorer`, review `deep`/`security`, test `root-cause`) na `z-ai/glm-5.3`.

## Metoda i zastrzeżenia

- **Wolumen** = rzeczywiste tokeny każdego slotu (skład × rola) z 30 dni; **koszt propozycji** = ten sam wolumen przeliczony po cenach innego modelu. Inny model zużyje inną liczbę tokenów (modele z wysokim reasoningiem — więcej wyjścia), więc to szacunek rzędu wielkości, nie faktura. Sprawdzian metody: dla mimo jako Supervisora przeliczenie daje $108, faktycznie zapłaciliśmy $112.
- **Odczyt z cache dominuje koszt** każdego długo żyjącego agenta (lead, implementer): Supervisor 92%, implementer DEV 93% tokenów. Cena *cache read* jest ważniejsza niż cena wejścia czy wyjścia.
- **Benchmarki AA nie mierzą pracy w harnessie Claude Code** (wywołania narzędzi przez endpoint Anthropic-compatible, długie sesje, kompaktowanie). Najmocniejszym dowodem jest nasza telemetria: mimo przepracował jako Supervisor 212 sesji / 24,8 tys. wiadomości.
- AA zmieniło skalę indeksu inteligencji między snapshotami (mediana −13,9 pkt) — liczby z lipcowej analizy nie są porównywalne z dzisiejszymi.
- Pominięte z zasady: warianty `:free` i `-contributor` (prompty mogą trafiać do trenowania — nie wysyłamy tam kodu z repo), modele bez pomiarów AA (GPT-6.1 Sol Pro, GLM-5.3 Prime, Qwen3.8 Max Prime, Fugu, DeepSeek Pro latest) — do ponownego sprawdzenia po kolejnym snapshocie.

## Kandydaci (snapshot AA 2026-10-21)

| Model | $ in / out / cache per 1M | Intel | Code | Agentic | Długi kontekst | Bez halucynacji | GDPval |
|---|---|---:|---:|---:|---:|---:|---:|
| z-ai/glm-5.3-flash | 0,041 / 0,375 / **0,0037** | 41,8 | 71,5 | 50,9 | 80,0 | **72,4** | 57,1 |
| z-ai/glm-5.3 (max) | 0,079 / 1,40 / 0,078 | 44,8 | 74,8 | 53,1 | 79,7 | 70,4 | 57,5 |
| xiaomi/mimo-v2.6-pro | 0,435 / 0,87 / **0,0036** | 46,3 | — | — | **86,3** | 59,4 | 59,2 |
| anthropic/claude-haiku-5.5 (max) | 0,10 / 0,50 / 0,01 | 43,4 | — | — | 82,7 | 59,6 | 55,9 |
| meta/muse-spark-1.3 (max) | 1,25 / 4,25 / 0,15 | 48,1 | **75,8** | **55,5** | 83,0 | 67,1 | 59,0 |
| google/gemini-4-argon (high) | 2,00 / 10,0 / 0,10 | 52,6 | — | — | 79,7 | **84,9** | 56,2 |
| anthropic/claude-sonnet-5.5 (max) | 2,00 / 10,0 / 0,10 | **56,0** | — | — | 82,7 | 53,0 | **66,9** |
| x-ai/grok-4.7 (xhigh) | 2,00 / 6,00 / **0,50** | 46,4 | — | — | 76,7 | 70,7 | 60,6 |
| minimax/minimax-m3 | 0,30 / 1,20 / 0,06 | 29,2 | 58,6 | 29,5 | 83,0 | 81,6 | 37,1 |
| z-ai/glm-5.2 (max) | 0,034 / **7,00** / 0,033 | 33,7 | 68,8 | 38,4 | 78,3 | 73,7 | 43,6 |
| deepseek/deepseek-v4-pro (max) | 0,96 / 1,91 / 0,08 | 30,4 | 59,4 | 26,3 | 74,7 | **5,9** | 32,8 |
| deepseek/deepseek-v4.1-flash-1017 | 0,30 / 1,20 / 0,006 | 39,5 | — | — | 84,0 | **3,5** | 55,0 |
| google/gemini-2.5-flash-lite | 0,10 / 0,40 / 0,01 | **10,4** | — | — | 64,7 | 12,2 | — |

„—” = AA jeszcze nie zmierzyło tego indeksu dla tej wersji.

## Składy — co robią i co proponuję

### Supervisor (frontman)

Stały lead w kontenerze: bierze tickety z kolejki, uruchamia i nadzoruje dzieci (PLAN → DEV → REVIEW → TEST), odpowiada na bramki, pisze do Lineara/GitHuba (FOC-943), raportuje Mateuszowi. Najdłuższe sesje (średnio ~100 tys. tokenów kontekstu na wiadomość); ~40% wiadomości i 60% historycznego kosztu floty.
Wymagania: długi kontekst, uczciwość raportów (bez konfabulacji), wywołania narzędzi, stabilność w harnessie.

| Slot | Teraz | Propozycja | Dlaczego |
|---|---|---|---|
| lead | x-ai/grok-4.7 | **xiaomi/mimo-v2.6-pro** | ta sama inteligencja, najlepszy długi kontekst w katalogu, cache 140× tańszy; sprawdzony w 212 sesjach |
| subagenci `general-purpose` | dziedziczą leada (Grok) | dziedziczą leada (mimo) | — |
| `Explore` / tier `haiku`, `smallFast`, `opus` | glm-5.3-flash | glm-5.3-flash | bez zmian |
| tier `sonnet` | google/gemini-2.5-flash-lite | **bez zmian** | Claude Code używa go dla klasyfikatora auto mode — krótkie wywołania, liczy się opóźnienie i cena, nie benchmarki |
| aliasy `routing.supervisor` (default/worker/flash) | glm-5.2 / minimax-m3 / deepseek-v4-flash | **glm-5.3-flash** dla wszystkich | stare modele; glm-5.2 ma wyjście $7/M |

Kandydat do testu A/B: **`anthropic/claude-haiku-5.5`** — w przeliczeniu ≈ $56 zamiast $109 za leada, natywny model Claude Code, długi kontekst 82,7; ryzyko: na wysiłku `max` więcej tokenów wyjścia i zapisy do cache (Anthropic liczy je 1,25× wejścia). Nie zmieniać bez przebiegu na prawdziwych ticketach.

### PLAN

Zamienia ticket w plan: `discovery` (wymagania i dowody), `spec` (kontrakty, scenariusze testowe, decyzje), `spec-review` (adwersarialny przegląd specyfikacji), `decomposer` (cięcie na weryfikowalne kawałki), `push` (publikacja do Lineara), `worker`/`flash` (formatowanie, DoR, tabele). Błąd planu kosztuje wszystkie dalsze składy.

| Slot | Teraz | Propozycja A | Propozycja B |
|---|---|---|---|
| lead | glm-5.3-flash | glm-5.3-flash | **mimo-v2.6-pro** |
| spec, spec-review | glm-5.3-flash | glm-5.3-flash | **mimo-v2.6-pro** |
| discovery, decomposer, push, worker, flash | glm-5.3-flash | glm-5.3-flash | glm-5.3-flash |

Koszt B: +$5,35 / 30 dni. Uzasadnienie: wyższa inteligencja (46,3 vs 41,8) i najlepszy długi kontekst przy praktycznie tej samej cenie cache.

### DEV

Implementuje: `recon` (pakiet kontekstu i wpływu zmian), `implementer` (cała implementacja i weryfikacja — największy pojedynczy slot floty po Supervisorze), `refactorer` (zmiany wieloplikowe), `debugger` (trudne błędy, przyczyna źródłowa), `worker`/`flash` (wąskie zmiany, formatowanie).

| Slot | Teraz | Propozycja A | Propozycja B |
|---|---|---|---|
| lead, implementer, recon, worker, flash | glm-5.3-flash | glm-5.3-flash | glm-5.3-flash |
| debugger, refactorer | glm-5.3-flash | glm-5.3-flash | **z-ai/glm-5.3** |

Implementer **zostaje na flashu**: przeniesienie go na glm-5.3 to +$129 / 30 dni za +3,3 pkt `coding` — za mało. Koszt B: +$3,93.

### REVIEW

Recenzuje kandydata: `first-pass` (lint, styl, oczywiste błędy, brakujące testy), `deep` (poprawność, architektura, przypadki brzegowe), `security` (skanery + analiza kodu), `worker`/`flash` (inwentarz, deduplikacja ustaleń).

| Slot | Teraz | Propozycja A | Propozycja B |
|---|---|---|---|
| lead, first-pass, worker, flash | glm-5.3-flash | glm-5.3-flash | glm-5.3-flash |
| deep, security | glm-5.3-flash | glm-5.3-flash | **z-ai/glm-5.3** |

Koszt B: +$24,10 — największa dopłata w wariancie B, bo `deep` czyta dużo kontekstu, a cache glm-5.3 jest 21× droższy niż flasha. Zysk jakości jest umiarkowany (code 74,8 vs 71,5, agentic 53,1 vs 50,9; uczciwość praktycznie równa). **Jeśli tniemy — tniemy tu pierwsze.**

### TEST

Weryfikuje: `deployer` (środowisko, wdrożenie), `scenario-gen` (scenariusze akceptacyjne i negatywne), `runner` (wykonanie, dowody), `root-cause` (diagnoza porażek bez ślepych powtórek), `worker`/`flash` (logi, tabele).

| Slot | Teraz | Propozycja A | Propozycja B |
|---|---|---|---|
| lead, deployer, scenario-gen, runner, worker, flash | glm-5.3-flash | glm-5.3-flash | glm-5.3-flash |
| root-cause | glm-5.3-flash | glm-5.3-flash | **z-ai/glm-5.3** |

Koszt B: +$0,42.

### CADENCE

Rytm i retrospektywy: `collector` (stan Lineara i flow-db), `digest` (cotygodniowy digest dla Mateusza), `retro` (dryf, retro bez szukania winnych), `worker`/`flash`. **W ostatnich 30 dniach nie uruchomiony** — zmiana nie ma wpływu na koszt, ma na jakość, gdy wróci.

| Slot | Teraz | Propozycja |
|---|---|---|
| lead, collector, worker | minimax/minimax-m3 | **glm-5.3-flash** (inteligencja 41,8 vs 29,2, uczciwość podobna) |
| digest (`pl`) | deepseek/deepseek-v4-pro | **mimo-v2.6-pro** (non-hallucination 5,9 to dyskwalifikacja dla raportu) |
| retro | z-ai/glm-5.2 | **mimo-v2.6-pro** |
| flash | deepseek/deepseek-v4-flash | **glm-5.3-flash** |

## Porównanie kosztów (30 dni, ten sam ruch)

| Skład | Historycznie | Obecny routing | Propozycja A | Propozycja B |
|---|---:|---:|---:|---:|
| Supervisor | $181,80 | **$2 114,42** | $140,12 | $140,12 |
| DEV | $69,38 | $25,83 | $25,83 | $29,76 |
| REVIEW | $26,35 | $9,43 | $9,43 | $33,52 |
| TEST | $17,99 | $6,21 | $6,21 | $6,63 |
| PLAN | $6,34 | $2,43 | $2,43 | $7,78 |
| CADENCE | $0 | $0 | $0 | $0 |
| **Razem** | **$301,86** | **≈ $2 158** | **≈ $184** | **≈ $218** |

„Historycznie” jest wyższe od „obecnego routingu” dla dzieci, bo we wrześniu leady DEV/REVIEW/TEST/PLAN chodziły częściowo na mimo i glm-5.3; od FOC-791 wszystkie są na glm-5.3-flash.

Warianty pomocnicze (cała flota, 30 dni): wszystko na glm-5.3-flash, łącznie z Supervisorem — $78; propozycja B z Supervisorem na Haiku 5.5 — $148; z Supervisorem na Gemini 4 Argon — $1 175; propozycja B + implementer na glm-5.3 — $347.

## Wdrożenie (proponowane kroki)

1. **Przed przebiegiem akceptacyjnym FOC-789:** Supervisor → `xiaomi/mimo-v2.6-pro` (cofnięcie zmiany z PR #122 w `config/models.json` `defaultModel`, `SUPERVISOR_FALLBACK_MODEL` w `squad-start.mjs` / `squad-config.mjs` / `entrypoint.sh`, testy). Inaczej koszt na ticket w dossier 1.0 będzie ~15× zawyżony.
2. Aliasy `routing.supervisor.*` i `routing.cadence.*` na nowe modele; frontmatter `model:` w `agents/cadence/agents/*.md`. Pin w `config-drift`.
3. Wariant B (PLAN lead/spec/spec-review → mimo; trudne role → glm-5.3) — jako jedna zmiana routingu, mierzona przez 2 tygodnie na koszt i *first-time-right* (Dashboard → Costs & quality).
4. Test A/B Supervisora: mimo vs claude-haiku-5.5 na kilku prawdziwych ticketach (koszt, liczba interwencji, jakość raportów).
5. Odświeżać snapshot (`python -I docs/ui/refresh-model-data.py --out docs/ui/model-explorer.html`) co ~2 tygodnie — pięć kandydatów z listy nie ma jeszcze pomiarów AA.

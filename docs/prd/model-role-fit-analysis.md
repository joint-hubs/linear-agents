# Raport — dopasowanie modeli do ról w składach

> Data: 2026-07-28 · Repo: `linear-agents` · Dane: `telemetry.sqlite` (130 przebiegów, $580.92)
> Założenie wejściowe: **Opus 5 poza analizą, na stałe lead PLAN.** Pozostałe 30 slotów ról — do przeglądu.
> Powiązane: `config/models.json`, `agents/*/agents/*.md`, `bin/*.bat`

---

## 0. Wniosek, który podważa samo pytanie

Pytanie brzmi „jak dopasować modele do ról". Telemetria mówi, że **role to nie jest miejsce, gdzie są pieniądze**:

| | kwota | udział |
|---|---:|---:|
| leady składów (5 slotów) | **$497.89** | **85.7%** |
| wszyscy subagenci (30 slotów) | $83.03 | 14.3% |

Wyzerowanie **wszystkich trzydziestu** ról subagentów oszczędza $83. Zmiana modelu **jednego** leada DEV rusza $214.

To nie znaczy, że dobór ról jest bez znaczenia — znaczy, że jest to optymalizacja **jakości**, a nie kosztu. Rekomendacje niżej rozdzielam na te dwie osie i nie udaję, że tanie role coś oszczędzą.

## 1. Blokada: cennik w repo jest niezgodny z Twoją tabelą

`config/models.json` ma **ceny katalogowe**, Twoja tabela **promocyjne**:

| model | config | Twoja tabela | różnica |
|---|---|---|---|
| `z-ai/glm-5.2` | $1.4 / $4.4 | $0.7504 / $2.358 (−46%) | **1.87×** |
| `minimax/minimax-m3` | $0.3 / $1.2 | $0.24 / $0.96 | 1.25× |
| `deepseek/deepseek-v4-pro` | $0.435 / $0.87 | to samo | — |
| `anthropic/claude-sonnet-5` | $2 / $10 | to samo | — |

Konsekwencja policzona na realnych tokenach GLM:

```
wg config/models.json   $355.32
wg Twojej tabeli        $190.45
zawyżenie               $164.87  (87%)
```

**Dashboard zawyża wydatek o ~$165 na samym GLM.** Każda decyzja „drogi vs tani model" oparta na obecnym dashboardzie jest przesunięta. To trzeba naprawić **przed** czymkolwiek innym — inaczej optymalizujemy fikcję.

Do ustalenia: czy −46% na GLM to promo czasowe (wtedy trzeba wiedzieć, do kiedy), czy stała stawka.

## 2. Struktura kosztu: liczy się cena **wejścia**, nie wyjścia

Nieoczywiste, a decydujące. Realny miks tokenów leada DEV:

```
input 91.6M · output 7.5M · cache-read 518.9M
```

Cache-read to **87% wolumenu** i bilowany jest jako 0.1× ceny wejścia. Czyli rachunek leada to w praktyce `cena_wejścia × (0.11 + 0.087)`, a wyjście waży 1.3%. Skrajny przypadek — lead PLAN: 25k wejścia przy 120.1M cache-read, stosunek **4800:1**.

Dlatego ranking „po cenie wyjścia" (naturalny odruch) jest dla leadów bezużyteczny. Poniższa tabela to koszt 1M tokenów **przy realnym miksie danej roli**, wyliczonym z telemetrii:

| model | lead | generator | reader | mechanical |
|---|---:|---:|---:|---:|
| nemotron-3-super (free) | $0.000 | $0.000 | $0.000 | $0.000 |
| minimax-m3 | **$0.060** | **$0.287** | **$0.190** | **$0.228** |
| qwen3.7-plus | $0.080 | $0.382 | $0.253 | $0.305 |
| qwen3.6-plus | $0.089 | $0.518 | $0.289 | $0.361 |
| deepseek-v4-pro | $0.097 | $0.346 | $0.300 | $0.345 |
| kimi-k2.5 | $0.100 | $0.553 | $0.323 | $0.399 |
| glm-5.2 | $0.178 | $0.768 | $0.561 | $0.663 |
| qwen3.7-max | $0.348 | $1.468 | $1.092 | $1.286 |
| grok-4.5 | $0.472 | $1.990 | $1.480 | $1.744 |
| claude-sonnet-5 | $0.524 | $2.790 | $1.680 | $2.064 |
| kimi-k3 | $0.786 | $4.185 | $2.520 | $3.096 |

*Miksy: lead 11/1.3/87 (in/out/cache), generator 35/20/45, reader 55/5/40, mechanical 60/8/32.*

## 3. Metodyka i jej granice — przeczytaj przed użyciem liczb

Każdemu archetypowi roli przypisałem wagi benchmarków wg tego, co rola faktycznie robi (np. implementer: coding .40, python .30, terminal .20, agentic .10). Wynik = średnia ważona, koszt = z tabeli wyżej.

**Trzy ograniczenia, które realnie zmieniają wnioski:**

1. **Braki w danych nie są zerami.** `claude-sonnet-5`, `grok-4.5` i `kimi-k3` nie mają wyników dla `terminal`, `IFBench` i `τ²-bench`. Liczę je na węższym podzbiorze — **ich wyniki nie są wprost porównywalne** z modelami mającymi komplet. GLM wygrywa archetyp „lead" częściowo dlatego, że ma τ²=99.1 (najwyższe w stawce), a trzej konkurenci nie mają tego pomiaru wcale. To artefakt dostępności danych, nie dowód przewagi.

2. **8 z 30 slotów jest niemierzalnych.** Obecna flota używa `deepseek/deepseek-v4-flash` (6 slotów) i `moonshotai/kimi-k2.7-code` (2 sloty) — **żadnego nie ma w Twojej tabeli**. Nie mam podstaw, by je oceniać ani wymieniać. Tabela ma `kimi-k2.5` i `kimi-k3`, ale to inne modele niż `k2.7-code`.

3. **Metryka „punkty na dolara" zawsze wskaże najtańszy model.** MiniMax M3 wygrywa value/$ w 12 z 13 archetypów — bo jest najtańszy niedarmowy i ma przyzwoite wyniki. To nie znaczy „wszędzie MiniMax". Dla roli, w której słabszy model **pętli się lub nie przechodzi bramki**, dodatkowe tury kosztują więcej niż zaoszczędzona stawka. Dlatego rekomendacje niżej stawiam jako *„najtańszy, który przechodzi próg jakości"*, nie *„najwyższy stosunek"*.

## 4. Wyniki per archetyp

Score = średnia ważona benchmarków dla archetypu. „Value" = score / koszt 1M.

| archetyp | najlepszy jakościowo | najtańszy sensowny | obecnie w składach |
|---|---|---|---|
| lead (orkiestracja) | glm-5.2 (66.0) | minimax-m3 (63.3, **−4%, 3× taniej**) | glm ×2, minimax ×2, opus ×1 |
| implementer | kimi-k3 (66.4) | deepseek-v4-pro (51.6) | glm-5.2 (57.1) |
| refactorer | kimi-k3 (63.7) | deepseek-v4-pro (49.1) | kimi-k2.7-code *(niemierzalny)* |
| debugger | kimi-k3 (60.5) | deepseek-v4-pro (48.0) | deepseek-v4-pro ✔ |
| recon | kimi-k3 (68.8) | minimax-m3 (**68.8 — remis**, 13× taniej) | minimax-m3 ✔ |
| deep review | kimi-k3 (62.9) | minimax-m3 (51.6) | glm-5.2 (55.9) |
| security review | kimi-k3 (73.3) | minimax-m3 (56.1) | kimi-k2.7-code *(niemierzalny)* |
| first-pass review | kimi-k3 (75.8) | minimax-m3 (69.0) | deepseek-v4-pro (58.6) |
| spec / ADR | kimi-k3 (58.7) | minimax-m3 (48.9) | glm-5.2 (52.7) |
| decomposer / discovery | **minimax-m3 (59.8)** | minimax-m3 | minimax-m3 ✔ |
| deployer / runner | glm-5.2 (52.6) | minimax-m3 (48.0) | deepseek-v4-pro / minimax |
| worker / flash / push | qwen3.7-max (69.0) | minimax-m3 (68.4) | minimax / deepseek-flash |
| digest / retro | kimi-k3 (64.0) | minimax-m3 (54.8) | deepseek-v4-pro / glm |

## 5. Rekomendacje

### 5.1 Zrób najpierw (bez tego reszta jest zgadywaniem)

1. **Uzgodnij `config/models.json` z realnym cennikiem OpenRoutera.** Efekt: −$165 fikcyjnego kosztu GLM, poprawne „koszt na task" i budżety.
2. **Ustal, czy promo na GLM/MiniMax/Qwen jest czasowe.** Jeśli tak — data wygaśnięcia do `_doc` w `models.json`, inaczej cennik znów się rozjedzie.

### 5.2 Zmiany, które mają uzasadnienie

| rola | z | na | dlaczego |
|---|---|---|---|
| `plan/spec-review` | minimax-m3 | **bez zmian** | rola sceptyka; MiniMax ma najwyższy IFBench (82.9) w stawce — trafiony wybór |
| `plan/decomposer` | minimax-m3 | **bez zmian** | jedyny archetyp, gdzie MiniMax wygrywa *jakościowo*, nie tylko ceną |
| `dev/recon` | minimax-m3 | **bez zmian** | remis z kimi-k3 (68.8) przy 13× niższym koszcie — najlepiej dobrana rola w całym systemie |
| `review/first-pass` | deepseek-v4-pro | **minimax-m3** | 69.0 vs 58.6 score **i** taniej ($0.190 vs $0.300 reader) — wygrywa na obu osiach |
| `*/flash`, `*/worker` (mechaniczne) | deepseek-v4-flash / minimax | **rozważ nemotron (free)** | 77% jakości lidera archetypu przy $0; ryzyko: 262K kontekstu i najniższy agentic (8.7) — tylko do zadań o sztywnym formacie, nigdy do niczego z narzędziami |
| `dev/implementer` | glm-5.2 (57.1) | **zostaw** | deepseek-v4-pro to −10% jakości za −$20 na całej historii. Największa linia subagenta ($37.15), ale jakość kodu to nie miejsce na oszczędzanie 3% budżetu |

### 5.3 Czego NIE robić

- **Nie zmieniaj leada DEV/REVIEW z GLM na MiniMax „bo 3× taniej".** Różnica 4% w score jest w granicach błędu metodyki (patrz §3.1 — przewaga GLM opiera się na τ², którego konkurenci nie mają zmierzonego), a agentic index GLM jest **22% wyższy** (43.1 vs 35.4). Dla roli, która przez cały przebieg podejmuje decyzje o delegacji, to najbardziej wprost relewantna metryka. Ewentualną zmianę zrób jako **eksperyment na jednym składzie z pomiarem**, nie jako globalny przełącznik.
- **Nie wstawiaj kimi-k3 / sonnet-5 / grok-4.5 do ról produkcyjnych na podstawie tego raportu.** Wygrywają większość archetypów jakościowo, ale przy 4–14× koszcie i **z niepełnym pokryciem benchmarków**. Jeśli któryś ma wejść — najpierw dokup brakujące pomiary albo zrób własny test na realnym tasku.
- **Nie licz na oszczędności z ról.** Cała pula subagentów to $83. Optymalizuj tu **jakość**, koszt szukaj gdzie indziej.

## 6. Gdzie naprawdę są pieniądze

Cel `≥40% kosztu u subagentów` (zapisany we wszystkich pięciu promptach) jest realizowany na poziomie **14.3%**. To nie jest problem doboru modeli — to problem tego, ile pracy lead oddaje.

Rachunek: przesunięcie 25 punktów procentowych z leada (GLM, $0.178/1M lead-mix) na subagentów (MiniMax, $0.287/1M generator-mix) **nie oszczędza wprost** — subagent w swoim miksie jest droższy za token. Oszczędność bierze się z tego, że **subagent robi to samo w mniejszej liczbie tokenów**: startuje ze świeżym, małym kontekstem, zamiast doklejać zadanie do 500M cache-read leada.

To jest dźwignia rzędu setek dolarów, podczas gdy cały spór o modele ról dotyczy dziesiątek. Osobny temat — ale to jest ten właściwy.

## 7. Otwarte

- [ ] `deepseek-v4-flash` i `kimi-k2.7-code` — brak w tabeli benchmarków; 8 slotów bez podstawy do oceny
- [ ] Brak `terminal` / `IFBench` / `τ²` dla sonnet-5, grok-4.5, kimi-k3
- [ ] Czy promo GLM/MiniMax/Qwen jest czasowe
- [ ] Metryka jakości per rola: dziś nie mierzymy, czy dana rola *wykonała zadanie dobrze* — tylko ile kosztowała. Bez tego każdy taki raport zostaje analizą benchmarków, nie analizą Twojego systemu.

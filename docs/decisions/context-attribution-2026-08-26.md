# Co naprawdę wypełnia okno kontekstu leada (FOC-166)

**Data:** 2026-08-26 · **Metoda:** `scripts/context-attribution.mjs` + `scripts/floor-probe.mjs`
· **Próbka:** 151 sesji leada / 161 segmentów / 7 204 wywołań API, ostatnie 30 dni

---

## Odpowiedź w jednym zdaniu

Przycinanie promptów jest **złą dźwignią** — squadowy CLAUDE.md to ~3,9% rachunku. Największy
pojedynczy składnik to **stała podłoga sesji (34,6%)**, a w niej **8,7k tokenów schematów narzędzi,
których headless dziecko nie może użyć**. Zdjęcie ich to **~$46/mies.**, przy zerowym ryzyku
jakościowym — **17× więcej niż przycięcie 500 tokenów promptu** ($2,64/mies.).

---

## Jak zrobiono liczby uczciwymi

Dwie kotwice, żadna nie jest zgadywaniem.

**Stosunek znaki→tokeny jest dopasowany, nie założony.** Każde wywołanie raportuje rozmiar swojego
promptu, a z transkryptu wiadomo, ile znaków konwersacji było wtedy zebrane. Regresja MNK z wyrazem
wolnym po wszystkich turach daje **3,96 znaku na token przy R² = 0,983**. Klasyczne „~4 znaki na
token" okazuje się prawdziwe — ale teraz jest zmierzone, z błędem, a nie zacytowane.

**Podłoga jest wyrazem wolnym tej regresji**, nie szacunkiem. Wychodzi 38,2k tokenów (mediana
34,7k), co niezależnie potwierdza bezpośredni pomiar `floor-probe.mjs`: 42,8k dla realnego configu
deva.

Segmenty z R² < 0,7 albo z arytmetycznie niemożliwą podłogą są **odrzucane i liczone** (42 z 203),
nigdy po cichu uśredniane. Kompaktowanie resetuje okno, więc każda granica `isCompactSummary`
zaczyna nowy segment z własną podłogą i własnym dopasowaniem — inaczej regresja przechodziłaby
przez piłę.

**Dlaczego nie z `tool_facts`.** Tabela zapisuje `tool_input` (ucięty do 1000 znaków) i **nie
zapisuje rozmiaru WYNIKU**. Wynik jest tym, co wchodzi do okna: `Read` zwracający 40k pliku to jeden
wiersz z 60-znakowym inputem. Sprawdzone w schemacie, nie założone. Decyzja: **czytamy transkrypty**.
Dodanie kolumny z rozmiarem wyniku naprawiłoby przyszłe runy i nie odpowiedziałoby nic o 37 234
turach już wydanych.

---

## Dwie metryki, dwa różne pytania

`RESIDENT` mówi, co jest w oknie na koniec sesji. `TOKEN-TURNS` sumuje po turach to, co było
rezydentne w danej turze — i to **ta** mapuje się na pieniądze, bo blok 20k dodany w turze 3 z 300
jest odczytany ponownie 297 razy, a ten sam blok dodany w turze 299 nie. Cache-read to 73% wolumenu
tokenów squadów, więc płacimy właśnie za to.

| Źródło | token-turns | udział |
|---|---:|---:|
| **podłoga** (system prompt + schematy narzędzi + CLAUDE.md) | 275,1 mln | **34,6%** |
| wyniki narzędzi | 176,3 mln | 22,2% |
| wstrzyknięcia harnessu (`attachment`) | 112,5 mln | 14,2% |
| wywołania narzędzi (inputy) | 108,6 mln | 13,7% |
| thinking | 60,5 mln | 7,6% |
| konwersacja (człowiek + asystent) | 57,1 mln | 7,2% |

Wewnątrz wyników narzędzi: **Bash 52,6%**, **Read 21,6%**, reszta ogonem. Czyli **samo wyjście
Bash to 11,7% całego rachunku** — trzy razy więcej niż cały squadowy prompt.

---

## Z czego składa się podłoga

Transkrypt nie zapisuje system promptu, więc podłogę rozłożono **eksperymentem różnicowym**: to samo
trywialne wywołanie `-p` pod configami różniącymi się dokładnie jedną rzeczą (`floor-probe.mjs`).

| Konfiguracja | tokeny | delta |
|---|---:|---:|
| zaufany katalog, bez squadowego promptu | 25,8k | — |
| + `agents/dev/CLAUDE.md` | 30,2k | **+4,3k** |
| + cache feature-flagów | 41,8k | **+11,7k** |
| realny config deva, MCP off | 39,7k | — |
| realny config deva, MCP on | 42,8k | +3,1k (codegraph) |
| flagi on, 4 nieużywalne narzędzia zdjęte | 33,1k | **−8,7k** |

**Zaufanie katalogu trzeba ustawić, inaczej mierzy się nie to.** Nieautoryzowany katalog dostaje
okrojony zestaw narzędzi. Pierwsze podejście do tego eksperymentu było przez to 9k za lekkie, a luka
wyglądała, jakby brała się z zawartości `.claude.json`.

**Feature-flagi dokładają 11,7k.** Cache `cachedGrowthBookFeatures` włącza pięć narzędzi:
`Artifact`, `ListAgents`, `Monitor`, `PowerShell`, `PushNotification`. Reszta `.claude.json` kosztuje
zero — sprawdzone przez usunięcie samego bloku flag (30,2k, identycznie jak bez niego).

---

## Dźwignia

Cztery z tych narzędzi są dla headless dziecka **niemożliwe do użycia**: `Artifact` publikuje stronę
na claude.ai, `PushNotification` wysyła powiadomienie na telefon, `ListAgents` i `Monitor` obsługują
interaktywne sesje obok. Dziecko squadu nie ma przeglądarki, telefonu ani sesji obok. Ich schematy
kosztują **8,7k tokenów w każdym wywołaniu** — dwa razy tyle co cały squadowy prompt.

**`permissions.deny` je zdejmuje z promptu, nie tylko z ręki wywołującego.** To było warte
zmierzenia, bo założenie było odwrotne (deny blokuje wywołanie, schemat i tak leci) i **było
błędne** — 33 138 tokenów przez `deny` vs 33 149 przez `--disallowed-tools`, identycznie w granicach
szumu. To decyduje, gdzie mieszka poprawka: **commitowany `settings.json`**, którego może pilnować
`config-drift.test.mjs`, a nie flaga launchera, o której każde nowe wejście musi pamiętać.

### Rachunek

Cache-read glm-5.2: **$0,221/mln**. Leadów: 23 933 tur w 30 dni, 37 234 od zawsze.
Cały historyczny rachunek za cache-read: **2,258 mld tokenów = $499**.

| Zmiana | oszczędność / mies. | historycznie |
|---|---:|---:|
| **zdjęcie 4 nieużywalnych narzędzi** | **$45,96** | $71,50 (14,3% całego rachunku) |
| przycięcie 500 tokenów promptu | $2,64 | $4,11 |
| usunięcie bloku Supervised mode (703 tok.) | $3,72 | — |

---

## Rekomendacje

**1. Zdejmij cztery narzędzia w `agents/*/settings.json`.** Jedyna zmiana z wymiernym zwrotem i
zerowym ryzykiem jakościowym. Osobny, recenzowalny commit — ten task nic nie edytuje.

**2. Nie przycinaj promptów.** Squadowy CLAUDE.md to 4,3k z 38,2k podłogi, czyli **3,9% rachunku**.
Edycje promptów są najbardziej ryzykowną zmianą w tym repo — nic w suicie nie łapie „ten prompt się
pogorszył" — a górna granica zysku to kilka dolarów miesięcznie. Stosunek ryzyka do zwrotu jest zły.

**3. Blok Supervised mode zostaje.** Ma 703 tokeny (nie 500) i jest martwy w runach nienadzorowanych,
ale wart jest $3,72/mies., a jego identyczność w czterech składach jest wymagana przez AC FOC-125 i
pilnowana testem. Nie warto ruszać.

**4. Wyjście Bash — 11,7% rachunku — to następna dźwignia po narzędziach.** Konkretnie: limit na
rozmiar wyniku, nie „mniej używajcie Bash". Wymaga osobnego pomiaru rozkładu (mediana vs ogon),
zanim ktokolwiek wybierze próg.

**5. Wstrzyknięcia harnessu to 14,2%** i nikt ich nie pisze. Nie mamy nad nimi kontroli; odnotowane,
żeby nie szukać ich w promptach.

---

## Uwaga o CodeGraphie, zamknięta

Task ostrzegał, że README CodeGrapha mierzy ~80% większy rezydentny ślad niż agent czytający pliki.
Zmierzone tutaj: `codegraph_explore` to **3,2% wyników narzędzi = 0,7% rachunku**, a serwer MCP
dokłada **3,1k do podłogi**. Dla porównania `Read` to 4,8% rachunku. Przy obecnym wolumenie CodeGraph
jest tani; ostrzeżenie było uzasadnione, ale nie zmaterializowało się w tej skali użycia.

## Luka w danych, zgłoszona osobno

`tool_name_canon` jest **NULL we wszystkich 34 166 wierszach** `tool_facts` — nie tylko w 12 837
wierszach leadów, jak zakładał task. Przyczyna: `telemetry-tool-extract.mjs:129` ustawia
`tool_name_canon: null, // filled by normalization pass`, a **żaden taki pass nie istnieje** —
maszyneria `buildCanonMap`/`resolve` w tym samym pliku nigdy nie jest wywoływana ze ścieżki ingestu.

Nie blokuje to niczego tutaj: `tool_name_raw` jest wypełniony i to z niego pochodzi cały podział na
narzędzia powyżej. Zgłoszone jako osobny task, bo naprawa wymaga backfillu 34k wierszy i testu.

## Retencja

`check-transcript-retention.mjs`: **95,1%** w 30 dniach (49 880 z 52 471). Task cytował 98,8% —
transkrypty się starzeją, więc okno pomiarowe kurczy się samo. Jeśli ten pomiar ma być powtarzalny
za rok, transkrypty trzeba archiwizować albo `tool_facts` musi dostać kolumnę z rozmiarem wyniku.

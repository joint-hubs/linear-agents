# Audyt jakości danych telemetrii — 2026-08-03

> Pytanie: czy dane z monitoringu są dobre i czy dobrze się zbierają.
> Baza: `%LOCALAPPDATA%\linear-agents\telemetry\telemetry.sqlite`, schema v2,
> 206 przebiegów / 38 289 rekordów usage / $713,84 kosztu.

---

## Werdykt

**Zbieranie i liczenie jest poprawne. Zepsute jest raportowanie o jakości tych danych.**

Nie znalazłem ani jednego przypadku utraty lub przekłamania kosztu. Znalazłem cztery rzeczy,
które sprawiają, że dashboard *wygląda* na zepsuty i że nie da się tego niezależnie potwierdzić.

---

## Co zweryfikowałem pozytywnie

### Arytmetyka kosztu — dokładna

Przeliczyłem koszt **od zera** z surowych tokenów × cen z odpowiedniego `price_set`
i porównałem z zapisanym `cost_facts`:

| | |
|---|---|
| sprawdzonych rekordów | 29 156 |
| rozbieżnych (>1e-9) | **0** |
| największa rozbieżność | $0,00 |
| suma zapisana vs przeliczona | $545,8448 vs $545,8448 |

### Deduplikacja sesji — działa

27 lipca powstało **8 manifestów wskazujących na jedną sesję** `aae50511`
(`run_sessions.source = "echo test"` — ktoś testował). Transkrypt ma 243 tury i 20,5 mln tokenów.

Telemetria przypisała te tokeny **dokładnie raz**, do jednego `run_id`. Gdyby liczyła naiwnie,
zawyżyłaby zużycie ośmiokrotnie. To zachowanie poprawne — i to jest powód, dla którego
7 przebiegów „nie ma danych". Nie mają, bo nie powinny.

> Zanim to sprawdziłem, policzyłem „143 mln utraconych tokenów". To była nieprawda —
> ta sama sesja liczona 7 razy. Warto pamiętać przy czytaniu podobnych metryk.

### Pokrycie cenowe — 99%

`usage_facts` = 38 289, `cost_facts` = 38 289. Modele z sufiksem daty
(`z-ai/glm-5.2-20260616`, `anthropic/claude-4.8-opus-20260528`) są poprawnie normalizowane
do cen bazowych.

---

## Cztery realne problemy

### 1. `data_quality_issues` nigdy nic nie zamyka

| typ | otwarte | zamknięte |
|---|---:|---:|
| transcript_missing | 111 | **0** |
| pricing_missing | 11 | **0** |
| legacy_session_ambiguous | 2 | **0** |

Tabela jest append-only. Sprawdziłem te 11 `pricing_missing`: **6 jest dziś wycenionych**,
5 dotyczy modelu `<synthetic>` (z definicji nie do wyceny). Czyli realnie otwartych: **zero**.
Podobnie 50 ze 111 `transcript_missing` dotyczy przebiegów, które **mają** dane — flaga
zapaliła się przejściowo, zanim transkrypt trafił na dysk.

**Skutek:** `/api/telemetry/health` pokazuje 124 problemy tam, gdzie realnie jest ~0. Sygnał
tylko rośnie, nigdy nie maleje — więc gdy pojawi się prawdziwy problem, będzie nieodróżnialny
od szumu. To najgorszy możliwy stan wskaźnika zdrowia.

**Fix:** przy ingeście zamykać wpis (`resolved_at`), gdy warunek ustąpił; nie flagować
`<synthetic>` jako brak ceny.

### 2. Fikstury testowe siedzą w produkcyjnej bazie

**51 z 206 przebiegów (25%)** ma `run_id` typu `test-pid-091417`, `test-cpid-1785136512191`.
Do tego 8 wpisów `run_sessions` ze `source='echo test'`.

Koszt tych fikstur to **$0,00**, więc sumy pieniężne są czyste. Ale:

| metryka | z fiksturami | bez |
|---|---:|---:|
| przebiegi | 206 | 163 |
| bez danych usage | 65 (31,6%) | 22 (13,5%) |

Czyli „jedna trzecia przebiegów nie ma danych" to artefakt. Realnie 13,5%, a z tego większość
to starty, w których agent nigdy nie wystartował (brak `sessionId`) albo transkrypt wygasł.

**Fix:** testy powinny pisać do bazy tymczasowej (`TELEMETRY_DB_PATH`), a nie do produkcyjnej.
Istniejące fikstury do usunięcia jednorazowo.

### 3. 366 rekordów bez kosztu — stary snapshot cen

| model | rekordów | tokenów |
|---|---:|---:|
| `anthropic/claude-haiku-4.5` | 255 | 3 943 170 |
| `anthropic/claude-4.5-haiku-20251001` | 94 | 2 063 454 |
| `<synthetic>` | 17 | 0 |

To 1,0% rekordów. Oba modele Haiku **mają** dziś ceny w `config/models.json` — ale te
przebiegi zostały wycenione względem starszego `price_set`, w którym ich jeszcze nie było.
`price_set` jest snapshotem per przebieg (to celowe — historia nie ma się zmieniać), więc
dodanie ceny dziś nie naprawia wstecz.

**Skala:** ~6 mln tokenów Haiku nieujętych w koszcie. Przy cenniku 1/5 USD za mln to rząd
kilkunastu dolarów przy sumie $713 — mało, ale to realna dziura, nie zaokrąglenie.

**Fix:** jednorazowy backfill tych rekordów pod aktualny `price_set`, świadomie i z adnotacją.

### 4. Niezależna kontrola kosztu nie działa

```
node scripts/cost-report.mjs --since 2026-07-01
→ Error: OpenRouter API 403 Forbidden
  {"error":{"message":"Only management keys can fetch activity for an account"}}
```

`cost-report.mjs` istnieje **właśnie po to**, żeby porównać nasze liczby z rozliczeniem
OpenRoutera i flagować >10% rozbieżności. `OPENROUTER_API_KEY` w `.env` to klucz inferencyjny,
a endpoint activity wymaga **management key**.

**Skutek:** cała weryfikacja kosztu jest dziś wyłącznie wewnętrzna. Potwierdziłem, że
arytmetyka zgadza się sama ze sobą — ale nikt nie potwierdził, że zgadza się z rzeczywistością.
Jeśli cennik w `models.json` odbiega od realnego, żaden mechanizm tego nie wyłapie.

**Fix:** management key w `.env` jako osobna zmienna (`OPENROUTER_MANAGEMENT_KEY`),
`cost-report.mjs` czyta ją zamiast klucza inferencyjnego.

---

## Czego audyt NIE obejmuje

- **Poprawności atrybucji rola↔model** — sprawdzałem, że liczby się zgadzają, nie że
  przypisano je właściwej roli. To wymagałoby porównania z tym, co realnie ustawił launcher,
  a launcher czyta z `config/models.map`, który jest niespójny (osobne znalezisko).
- **Czy ceny w `models.json` odpowiadają cennikowi OpenRoutera** — zablokowane przez §4.

---

## Kolejność napraw

1. **Management key** (§4) — bez tego reszta to wiara na słowo. Jedna zmienna w `.env`.
2. **Zamykanie `data_quality_issues`** (§1) — przywraca sens wskaźnikowi zdrowia.
3. **Fikstury poza produkcyjną bazę** (§2) — porządkuje liczniki.
4. **Backfill Haiku** (§3) — najmniejszy zysk, robić na końcu i świadomie.

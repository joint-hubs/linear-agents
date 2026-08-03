# Przegląd kodu — 2026-08-03

> Narzędzie: GitNexus (indeks `fc78dd7`, 221 plików / 3399 węzłów / 6500 krawędzi).
> Poprzedni przegląd: `code-audit-2026-07-30.md`, `squad-review-2026-07-27.md`.
> Każde znalezisko poniżej **zweryfikowane ręcznie** po sygnale z grafu — sekcja 6
> wymienia to, co graf zgłosił, a co okazało się fałszywym alarmem.

---

## 1. Co jest zdrowe

- **Zero cykli importów** (`gitnexus check --cycles`).
- `linear-client.mjs` to prawdziwy wspólny klient: 6 modułów go importuje, a jego
  `graphql()` ma promień rażenia **23 symboli, ryzyko HIGH** — czyli jest realnym
  wąskim gardłem, a nie ozdobnikiem.
- Podział `Prompts.jsx` (1112 → 396) i `squad-config.test.mjs` z 30 lipca się utrzymał.

---

## 2. Duplikacja klienta Linear — najpilniejsze

`bootstrap-linear.mjs` i `linear-push.mjs` **nie importują** `linear-client.mjs`.
Zamiast tego mają własne kopie pięciu funkcji:

| Funkcja | linear-client | bootstrap-linear | linear-push |
|---|---|---|---|
| `graphql` | ✅ eksportuje | 🔁 kopia | 🔁 kopia |
| `resolveTeam` | ✅ eksportuje | 🔁 kopia | 🔁 kopia |
| `loadEnv` | ✅ eksportuje | 🔁 kopia | 🔁 kopia |
| `fetchExistingStates` | — | 🔁 | 🔁 |
| `fetchExistingLabels` | — | 🔁 | 🔁 |

**To nie jest kosmetyka — kopie już się rozjechały.** Obsługa błędu GraphQL:

```js
// bootstrap-linear.mjs:88-91  → czytelny komunikat
const msgs = body.errors.map((e) => e.message).join("; ");
throw new Error(`GraphQL error: ${msgs}`);

// linear-push.mjs:119-121     → surowy JSON
throw new Error("GraphQL error: " + JSON.stringify(body.errors[0]));
```

Ten sam błąd API daje inny komunikat zależnie od tego, który skrypt go trafi — a
`linear-push` to ścieżka, którą PLAN wypycha epiki do Linear. Diagnostyka najgorzej
działa dokładnie tam, gdzie jest najbardziej potrzebna.

**Zrobione (2026-08-03).** Oba skrypty importują teraz `loadEnv`/`graphql`/`resolveTeam`
(+ `chooseApiKey` w push) z `linear-client.mjs`; przewleczony parametr `key` zniknął
z 13 funkcji w bootstrapie i 6 w push.

Trzy rzeczy, które wyszły dopiero przy robocie:

1. **Sygnatury się nie zgadzały.** Lokalne `graphql(query, vars, **key**)` vs kanoniczne
   `graphql(query, vars, **workspace**)`. Naiwna podmiana przekazałaby klucz API tam, gdzie
   oczekiwana jest nazwa workspace'u — zadziałałoby przez przypadek dla jointhubs i cicho
   zepsuło pisi.
2. **bootstrap nigdy nie honorował `LINEAR_WORKSPACE`** — zawsze brał `LINEAR_API_KEY`,
   a `LINEAR_WORKSPACE` czytał wyłącznie do opisu dry-runu. Zachowanie utrwalone przez
   `const WORKSPACE = "jointhubs"`, żeby refaktor niczego nie zmienił. Czy to docelowo
   poprawne — osobna decyzja, nie sprzątanie.
3. **`fetchExisting*` NIE zostały scalone** — wbrew pierwotnej rekomendacji. Nie są
   identyczne: bootstrap pobiera `labels(first: 100)`, push `labels(first: 200)` i inny
   selection set. Scalenie zregresowałoby push przy zespole z >100 etykietami. Sygnał
   z grafu był tylko zbieżnością nazw; przy dwóch ~20-linijkowych funkcjach nie warto.

Ujednolicony komunikat błędu poszedł w stronę **czytelniejszej** wersji z bootstrapu
(`join("; ")` po `e.message`), a nie w stronę `JSON.stringify` z push.

---

## 3. `atomicWriteJSON` — pięć identycznych kopii

`backfill-task-ids.mjs`, `reconcile-runs.mjs`, `run-manifest.mjs`, `squad-config.mjs`,
`utils.mjs` — pięć bajtowo identycznych ciał (tmp + `randomBytes` + `renameSync`).

Niuans, który zmienia rekomendację: **`utils.mjs` ma tę funkcję prywatnie, nie eksportuje jej.**
Czyli pozostałe cztery nie „zignorowały" wspólnego helpera — nie miały czego zaimportować.

**Do zrobienia:** `export` w `utils.mjs` + cztery importy. Zmiana mechaniczna, zero ryzyka
semantycznego (ciała identyczne), dobra robota dla `flash`.

---

## 4. `flow-db.mjs` — od 30 lipca bez konsumenta runtime

Po usunięciu fallbacku w `db8f9ff` (`/api/flow/trace|patterns` czytają teraz wyłącznie
centralny store) **jedynym importerem `flow-db.mjs` jest jego własny self-test.**
482 linie kodu + test, których nic nie woła.

Dwie rzeczy do odnotowania uczciwie:

1. To **nie jest nowe odkrycie** — `squad-review-2026-07-27.md` §86-88 już to zgłosił
   („jest w praktyce martwa i myląca"), z rekomendacją: albo wpiąć `flow-db ingest`
   w CADENCE, albo usunąć. Moja zmiana z 30 lipca tylko domknęła sprawę.
2. **`code-audit-2026-07-30.md` §113 jest teraz nieaktualny** — twierdzi, że
   „`ledger.mjs` i `flow-db.mjs` — oba mają realnych konsumentów". Dla `ledger.mjs` to
   nadal prawda, dla `flow-db.mjs` już nie. Zostawiam tamten dokument bez zmian (to
   zapis punktu w czasie), ale przy następnym czytaniu warto o tym pamiętać.

**Rozstrzygnięte 2026-08-03: wpięte w CADENCE, nie usunięte** (decyzja Mateusza).

Krok 0 pętli w `agents/cadence/CLAUDE.md` woła `flow-db ingest`; collector dociąga
`patterns --json`; retro liczy z tego dwie rzeczy, których wcześniej nikt nie mierzył;
digest raportuje je w sekcji „Jak pracowały składy". Zapis idzie do `.state/flowdb/`,
czyli w obrębie dozwolonego `.state/` — read-mostly wobec Linear obowiązuje bez zmian.

**Co pokazał pierwszy ingest** (163 przebiegi, 145 wciągniętych, 37 629 kroków; baza była
nieaktualna od 5 lipca):

| Skład | Udział subagentów w koszcie | Cel |
|---|---:|---|
| plan | **5,0 %** | ≥40 % |
| cadence | 7,5 % | ≥40 % |
| review | 18,6 % | ≥40 % |
| dev | 24,7 % | ≥40 % |
| test | 30,2 % | ≥40 % |

**Żaden skład nie trafia w swój własny deklarowany cel.** „≥40% kosztu runa u subagentów"
stoi w CLAUDE.md każdego składu jako „cel mierzalny" — i nikt go nie mierzył, bo dane
leżały w bazie bez konsumenta. PLAN wydaje 209 USD na leada i 11 USD na subagentów.

Odbicia REVIEW→DEV: 11 tasków odbiło, pięć dobiło do limitu 2, **żaden go nie przekroczył** —
reguła „max 2 rundy, potem escalated" trzyma się w praktyce.

To jest dokładnie ten rodzaj sygnału, którego Linear nie pokaże: statusy mówią CO zostało
zrobione, ta baza mówi JAK.

---

## 5. Braki testów — uszeregowane wg dźwigni

| Moduł | Linie | Testy | Dlaczego to boli |
|---|---:|---|---|
| `linear-client.mjs` | 272 | **brak** | 6 importerów, blast radius 23, HIGH. **Najlepszy stosunek wartości do wysiłku.** |
| `telemetry-server.mjs` | 1552 | brak | patrz §6 |
| `linear-ops.mjs` | 935 | brak | jedyna ścieżka zapisu do Linear |
| `bootstrap-linear.mjs` | 841 | brak | idempotentny provisioning — dokładnie to, co trzeba testować |
| `delegation-outcomes.mjs` | 536 | brak | |

Kolejność nie jest wg rozmiaru, tylko wg tego, ile pęknie, gdy się zepsuje.
`linear-client.mjs` jest mały **i** krytyczny — dlatego jest pierwszy.

---

## 6. Duży kod, który nadal czeka

| Symbol | Linie | Status |
|---|---:|---|
| `telemetry-server.mjs::server` | **1028** | audyt §1 z 30.07, świadomie odłożony |
| `SquadConfig.jsx::SquadConfig` | **813** | **nowe** — większe niż `Prompts.jsx` przed podziałem |
| `SquadLeaf.jsx::SquadLeaf` | 562 | efekt podziału `Prompts.jsx`; do obserwacji |
| `Costs.jsx::Costs` | 544 | |
| `Tasks.jsx::Tasks` | 456 | |

**`SquadConfig.jsx` — zrobione (2026-08-03): 1016 → 623 linii.**

Pierwotna diagnoza była **błędna**: pisałem, że wystarczy wynieść `SquadCard`, bo „granica
podziału jest już znaleziona". Nieprawda — `SquadCard` był komponentem **siostrzanym**,
nie zagnieżdżonym, więc jego wyniesienie nie ruszyłoby 813-linijkowego `SquadConfig`
ani o linijkę. Prawdziwe szwy leżały gdzie indziej:

| Wyniesione | Dokąd | Co zabrało ze sobą |
|---|---|---|
| `SquadCard` | `components/SquadCard.jsx` | `SQUAD_LABELS`, `SQUAD_COLOR`, `hasPrice` (używane wyłącznie przez niego) |
| edytor narzędzi | `components/ToolEditorModal.jsx` | 5 zmiennych stanu, 3 handlery, 172 linie JSX |

Zostało do wyniesienia: **tabela cennika** (~200 linii JSX + 4 handlery + 3 zmienne stanu).
To ostatni duży blok w tym pliku.

---

## 7. Fałszywe alarmy — czego NIE robić

Odnotowane, żeby następny przegląd nie deptał tej samej ścieżki:

- **`parseArgs` ×4** (`linear-ops`, `linear-query`, `linear-push`, `publish-linear-comment`)
  — kolizja nazw, **nie** copy-paste. Każdy parsuje inny zestaw flag. Ujednolicanie ich
  pod wspólny helper dołożyłoby abstrakcji bez zysku.
- **`printUsage` ×4, `main` ×14** — konwencja CLI, nie dług.
- **Zapytanie „funkcje bez wywołań"** zwraca w UI głównie śmieci: handlery JSX
  (`handleCopy`, `onKey`) i wyniki `useMemo` (`byAgent`, `kpi`) nie mają statycznych
  krawędzi `CALLS`, bo woła je React. Do martwego kodu w UI graf się nie nadaje.
- **`telemetry-concurrency.test.mjs`** — flaky (EBUSY przy sprzątaniu temp na Windows,
  ~1/3 przebiegów). Asercje przechodzą; problem jest w teardownie.

---

## 8. Kolejność i status

1. ✅ **`atomicWriteJSON`** — jedna definicja w `utils.mjs`, czterech importerów.
2. ✅ **Testy `linear-client.mjs`** — `linear-client.test.mjs`, 42 asercje, fetch stubowany.
3. ✅ **Konsolidacja klienta Linear** (§2).
4. ✅ **`SquadConfig.jsx`** 1016 → 623 (§6). Tabela cennika została.
5. ✅ **`flow-db.mjs`** (§4) — wpięte w CADENCE jako krok 0 + metryki w retro i digeście.
6. ⬜ **`telemetry-server.mjs::server`** — 1028 linii, zero testów. Największy dług,
   najdroższy ruch. Osobny task, nie doklejka do niczego innego.

### Jak weryfikowano kroki 1–4

Build przechodzący nie jest dowodem, więc każdy krok dostał własny:

| Krok | Dowód |
|---|---|
| 1 | 13 pakietów testowych zielonych; `run-manifest start` zapisał realny manifest przez wspólny helper |
| 2 | 42/42; dwa sabotaże (wyłączony pre-flight check klucza, `===` → `startsWith`) wykryte |
| 3 | `bootstrap --check` na żywym JOI (4 grupy, 60 etykiet); `linear-push --dry-run` **bajtowo identyczny** z wersją z HEAD (159 linii) |
| 4 | Przeglądarka: 5 kart, edytor otwarty, dry-run pokazał `ReadGrepGlobWrite → ReadGrepGlobWriteBash`, po Anuluj stan wrócił, `decomposer.md` nietknięty |
| 5 | Każda komenda z instrukcji uruchomiona z `$LA_ROOT` tak, jak zrobi to agent; `ingest` idempotentny (drugi przebieg: 2 wciągnięte, 143 pominięte); `--dry-run` nic nie zapisuje; `config-drift.test.mjs` 10/10 |

Sondy `scripts/_test_*.mjs` są **gitignorowane i jednorazowe** — cztery z nich padają
(wskazują na nieistniejący zespół FEN i projekt „Linear Agents"). Sprawdzone na czystym
worktree z HEAD: padają identycznie przed zmianami. Nie mylić z pakietem `*.test.mjs`.

### Znaleziska poboczne (nie ruszane)

- `.env` ma `LINEAR_TEAM_KEY=FEN`, a takiego zespołu w workspace nie ma (są `JOI`, `FOC`).
  `bootstrap --check` i `linear-push` wywalają się na tym od dawna — również przed zmianami.
- Brief `planning/briefs/joi-51.json` celuje w projekt „Linear Agents", którego też nie ma.
- **`config/models.map` jest z 3 lipca i nie zna nowych modeli.** `node scripts/check.mjs`
  zgłasza 6 naruszeń: `x-ai/grok-4.5` (×5) i `openai/gpt-5.6-terra-pro` (×1) siedzą we
  frontmatterze ról, ale nie ma ich w mapie. `bin/agent.bat` routuje rolę→model **właśnie
  z tej mapy**, więc `bin\agent.bat dev implementer` nie dostanie dziś właściwego modelu.
  Naprawa to `node scripts/gen-model-map.mjs`, ale to część niezacommitowanej pracy
  Mateusza — nie ruszane.

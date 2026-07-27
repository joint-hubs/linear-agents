# PRD — Edycja przypisania zadania przy przebiegu

> Status: **draft do akceptacji** · Data: 2026-07-27 · Repo: `linear-agents`
> Powiązane: `docs/prd/telemetry-v2-central-tracing-prd.md`, `docs/ui/terminal-panel-and-editors.md`

---

## 1. Problem

Zakładka Costs pokazuje dziś ostrzeżenie:

> ⚠ Untagged waste: $39.19 across 13 runs with no taskId

i nie da się z tym nic zrobić z poziomu platformy. Przypisanie zadania wymaga ręcznego
`node scripts/run-manifest.mjs set-task <runId> <taskId>` i tylko dla przebiegów, które
mają jeszcze manifest na dysku. Przebieg z błędnie wykrytym zadaniem (np. z nazwy brancha,
która poszła w odstawkę) zostaje z tym błędem na stałe.

**Cel:** zmienić, dodać lub usunąć zadanie przypisane do przebiegu z dashboardu — tak, żeby
koszt trafił tam, gdzie powinien.

---

## 2. Co już jest pod spodem (nie budujemy od nowa)

Telemetria v2 ma **czasowe** powiązania zadań:

```
run_task_links(link_id, run_id, task_id, role, valid_from, valid_to,
               source, confidence, supersedes_link_id, created_at)
```

- Koszt każdej tury liczony jest wg linku **aktywnego w jej znaczniku czasu** — dlatego
  samo dopisanie linku „od teraz" NIE naprawia historycznego kosztu.
- `applyTaskLinked` przyjmuje `payload.validFrom`, więc **przypisanie wsteczne jest możliwe**:
  `validFrom = run.startedAt` przenosi cały koszt przebiegu.
- Zmiana nie kasuje historii: poprzedni link dostaje `valid_to`, nowy `supersedes_link_id`.
  Widać więc, że korekta była ręczna i kiedy nastąpiła.
- `confidence` dla źródła `manual` = 1, czyli ręczne przypisanie **wygrywa** z wykryciem
  z brancha czy z kickoffu.

## 3. Decyzje

| Pytanie | Decyzja |
|---|---|
| Ile zadań na przebieg | **Jedno** (`role='primary'`). Rozliczenie zostaje jednoznaczne; `related` zostaje nieużywane. |
| Zmiana na zakończonym przebiegu | **Przenosi cały koszt** — `validFrom = startedAt`. |
| Zmiana na trwającym przebiegu | Domyślnie też cały koszt, ale z widocznym wyborem „od teraz" (pierwsza część pracy mogła dotyczyć czego innego). |
| Usunięcie zadania | Zamknięcie aktywnego linku → przebieg wraca do `untagged`. Nic nie jest kasowane. |
| Gdzie w UI | Trzy wejścia do **jednego** modala. Zero nowych zakładek. |

## 4. UX

**Wejścia:** wiersz w **Runs**, szczegóły przebiegu (**RunDetail**), oraz lista untagged
w **Costs** — to tam problem jest widoczny, więc tam naprawa musi być pod ręką.

**Modal „Przypisanie zadania":**
- Obecne zadanie + skąd się wzięło (`launch` / `agent_pick` / `kickoff` / `branch` / `manual`)
  i z jaką pewnością — żeby było widać, czy to twarde przypisanie, czy zgadywanka z brancha.
- Pole na numer zadania, walidacja wzorca `^[A-Z]+-\d+$`, ostrzeżenie (nieblokujące) gdy
  prefiks nie jest znany (`FEN`/`JOI`/`PISI`/`FOC`).
- **Podgląd skutku:** „Przeniesie **$X** z *Y* na *Z*" — kwota liczona z kosztu przebiegu.
  Bez tego użytkownik nie wie, co robi.
- Przełącznik zakresu: *cały przebieg* (domyślnie) / *od teraz* (tylko dla trwających).
- Przycisk **Usuń przypisanie** (przebieg → untagged), z potwierdzeniem inline.
- Historia zmian przypisania (kiedy, z czego na co, jakie źródło).

## 5. Backend

- `GET /api/runs/:runId/task` → `{ current: {taskId, source, confidence, validFrom}, history: [...] }`
- `POST /api/runs/task` `{ runId, taskId | null, scope: 'run' | 'now' }` — localhost-only.
  - `taskId` niepusty → `recordTaskLink(runId, taskId, 'manual', { validFrom, confidence: 1 })`,
    gdzie `validFrom = scope==='run' ? run.startedAt : now()`.
  - `taskId === null` → zamknij aktywny link (`valid_to = now()`), bez kasowania wierszy.
  - Walidacja `^[A-Z]+-\d+$`; zły format → 400.
  - Nieznany `runId` → 404.
- Po zapisie odpowiedź zawiera przeliczony koszt per zadanie, żeby UI mogło pokazać efekt.

## 6. Kryteria akceptacji

- [ ] Przypisanie zadania do przebiegu bez zadania **zmniejsza „Untagged waste"** o koszt tego przebiegu.
- [ ] Zmiana zadania przenosi **cały** koszt przebiegu (przy zakresie „cały przebieg").
- [ ] Usunięcie przypisania zwraca przebieg do untagged; historia linków zostaje.
- [ ] Ręczne przypisanie nie jest nadpisywane przez późniejsze wykrycie z brancha/kickoffu.
- [ ] Modal pokazuje źródło i pewność obecnego przypisania oraz kwotę, która się przeniesie.
- [ ] Zły format numeru → 400 i czytelny komunikat, nie cichy zapis.
- [ ] Liczba zakładek bez zmian.
- [ ] Wszystkie istniejące testy przechodzą.

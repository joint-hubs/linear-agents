# Fenix backlog — triage 2026-09-19

> Companion to the FOC-359 verdict-parse abandon report (`docs/plans/ft-verdict-parse-abandon-report.md`).
> Source: Linear workspace `jointhubs`, epic FOC-102 (Fenix 1.0: stabilize delivery and trustworthy
> evidence), epic FOC-273 (FT feasibility), and adjacent P0s. Snapshot 2026-09-19.
>
> **Decisions recorded 2026-09-19** (Mateusz): FOC-351 → opcja A (hermetyczne fixture per test);
> FOC-350 → usun row 4.8 (nie pinujemy); FOC-356 → opcja A (normalize-checkout);
> FOC-353 → hash-stream; FOC-283 → tak, ale po stabilizacji (koszyki 1–3), extractive framing,
> w ramach większej wizji pipeline'a (patrz sekcja „Wizja" na końcu).

## Skala

- **Czy potrzebne:** tak (blokuje / realny koszt) / nie-niezbędne (higiena, ergonomiczne) / spike (decyzja)
- **Nakład:** XS ~1–2h · S ~2–4h · M ~4–8h · L ~1–2 dni · XL > 2 dni (jedna osoba, lokalne)
- **Usprawni Fenix (1–5):** 5 = core runtime lub najwyższy koszt; 3 = realna higiena; 1 = nit
- **Zależności:** od czego zależy / co blokuje; „niezależny" = można robić w dowolnej kolejności
- **Routing:** jak wykonać jako supervisor:
  - **Sam** — drobna zmiana (~XS), znam dokładnie z opisu, robię bez pełnego triage (core_behaviors §8: „drobne zmiany rób od razu"); review to moja weryfikacja + suite
  - **Dev→verify** — dev child koduje, ja review+test (średnie, bez osobnego plan-node — dev dostań gotowy kontrakt z opisu)
  - **Triage** — pełny graph plan→dev→review→test (duży / spike / core-runtime, niepewne AC)
  - **Decyzja** — spike / observation-only: najpierw Twoja decyzja, potem routing

## Tabela

| Task | Co trzeba zrobić | Co to da | Czy potrzebne | Nakład | Usprawni | Zależności | Routing |
|---|---|---|---|---|---|---|---|
| **FOC-356** `supervisor-merge` fałszywy „could not be replayed" | `replay()` pokazać `err.stderr` zamiast `err.message.split("\n")[0]`; **opcja A: normalize-checkout** — `git -C <tree> checkout -- .` po `makeIntegrationTree()`, drzewo czyste, cherry-pick nie odmawia | Zniknie godzina diagnozy przy każdym odrzuconym merge'u; frontman dowie się *dlaczego* i może naprawić | **tak** — blokuje diagnozę core'owego narzędzia merge | S | 5 | niezależny; dotyka `supervisor-merge.mjs` (core) → musi przez pełny test suite | **Triage** — core runtime; opcja A wybrana (normalize-checkout); plan-node zatwierdza AC |
| **FOC-351** Fragile test suite (3 env-reds + async pair) | **opcja A: hermetyczne fixture per test** — każdy test dostaje własny `tmp/.state/` fixture (utworzony przed, usunięty po); test czyta tylko fikstur, nigdy realne `.state/`; `supervisor-semaphore` timing-flake ustabilizowany; `telemetry-store` async pair policzony (assertions przed `process.exit`) | Red run znów *oznacza* regresję — dzisiaj czerwony suite w głównym checkout nie niesie informacji („pewnie env, nie kod") | **tak** — suite bez sygnału to suite bez wartości | M | 5 | **observation-only** — Linear opis mówi „no implementation proposed"; trzy niezależne sub-fixy, każdy dotyka innego testu; opcja A wybrana | **Triage** — opcja A wybrana (hermetyczne fixture); 3 sub-fixy, każdy osobny dev→test |
| **FOC-353** `progressFingerprint` UNKNOWN na diffach >1 MiB | **hash-stream** — `git diff <base> \| sha256` streamed (memory O(1), działa przy dowolnym rozmiarze); `null` odróżnialny od computed-equal w record i logu. **Po co:** `progressFingerprint` liczy diff dla anti-repetition guard (czy coś się zmieniło od ostatniej rundy?) + verdict record (`fingerprint.diff`). Przy diffie >1 MiB (FOC-242 commituje multi-MB manifesty) `git diff` przelewa `maxBuffer` 1 MiB → `null` → guard fail-open. Hash-stream: 64 znaki, memory stałe | Anti-repetition guard działa na dużych commitach; dzisiaj cicho przepuszcza powtórzone failujące rundy | **tak** — guard fail open dokładnie tam, gdzie zmarnowana runda jest najdroższa | S | 4 | niezależny; dotyka `supervisor-lib.mjs:1148` (`progressFingerprint`) — shared, blast-radius → Triage | **Triage** — hash-stream wybrany; plan-node zatwierdza AC (null vs computed-equal distinguishability) |
| **FOC-164** Provider `baseUrl` override z env | `LA_PROVIDER_BASEURL_<PROVIDER>` w `provider-resolve.mjs`; `--check` pokazuje źródło (config vs env); drift test fail na committed `localhost`/`127.0.0.1`; `config/models.json` przywrócony do remote nebul URL | Local-proxy dev bez ryzyka commita; **publiczny repo** ma zawsze realne remote URL-e; zamyka realny wyciek configa (`git add -A` od shipa `localhost:8899`) | **tak** — repo jest publiczne, committed localhost psuje config dla każdej maszyny | M | 4 | niezależny; additive (żaden existing behaviour się nie zmienia); ADR-0010 gap, nie nowy mechanizm | **Dev→verify** — additive + drift test, AC jasne z opisu; dev dostań kontrakt, ja verify drift test + `--check` output |
| **FOC-355** `supervisor-verdict`: 3 przypadki stale vs guard FOC-220 | 3 przypadki dostają `--no-failing-tests` (testują env-scrub/dry-run, nie realny failing review) albo zostają hermetyczne; drop `HAS_DOTENV` skip | Suite green w każdym worktree, nie tylko na main checkout (gdzie `.env` maskuje); tester nie wpada w pułapkę „green u mnie, red w CI" | **tak** — 3/39 red w czystym worktree | S | 4 | niezależny; **test-only** (`supervisor-verdict.test.mjs`), produkcja `supervisor-verdict.mjs` bez zmian | **Sam** — test-only, znam z opisu (3 konkretne linie + `--no-failing-tests`), suite jest weryfikacją |
| **FOC-256** `supervisor-cleanup.test.mjs` buduj spawn env explicit | Test buduje spawn env explicit (unset/override `LA_SUPERVISOR_CHILD`), bez produkcji zmian | Test green niezależnie od env; znikają `env -u LA_SUPERVISOR_CHILD` workarounds w każdym TEST child | **tak** — workaround w każdym TEST child | XS | 3 | niezależny; **test-only**, produkcja bez zmian | **Sam** — test-only, znam z opisu, suite jest weryfikacją |
| **FOC-350** Align aliasu Opus z `claude-opus-5` | 4 powierzchnie config (`models.map _id.opus`, `models.json ids.opus`, `models.native.map plan.lead` + `spec-review`) → `claude-opus-5`; `check.mjs:355` allowed set +`claude-opus-5`; mutation-verified test; **usun row 4.8** (nie pinujemy) | NATIVE profil faktycznie używa najnowszego Opusa (decyzja 2026-09-15); dzisiaj `bin/supervisor.bat` ustawia jedno, config mówi drugie | **tak** — alias vs config mismatch, ale nie release-blocking | S | 3 | niezależny; open question rozwiązany: **usun** 4.8 (nie pinujemy starych modeli) | **Dev→verify** — 4 powierzchnie + `check.mjs` + test; ja verify `check.mjs` + mutation test |
| **FOC-255** `verdict-evidence` CLI parity seam | CLI strona parity dostaje ten sam `roundsPath` co in-process (seam, nie check); główny checkout 78/1 → 79/0 | Suite green w każdym checkout; parity in-process vs CLI realnie weryfikowane | **tak** — deterministyczny red z main checkout | XS | 3 | niezależny; **test-only** (`verdict-evidence.test.mjs`), seam nie check → musi zachować parność assertion | **Sam** — test-only seam, znam z opisu (CLI `roundsPath` = in-process pin), suite jest weryfikacją |
| **FOC-354** Guard: docs count == faktyczna `*.test.mjs` count | Test parse'ujący literał „N files" w `docs/supervisor-e2e-checklist.md` (3 miejsca) + porównanie z `scripts/*.test.mjs` na dysku; fail z diff („docs say 67, found 68") | Drift łapany przez CI, nie Mateusza ręcznie (drifił 3× po wave #29–#32) | **tak** — higiena, ale nawracająca | XS | 3 | **rób na końcu** — każdy inny task dodaje testy → liczba `*.test.mjs` rośnie; ten guard musi złapać final count | **Sam** — nowy test, znam z opisu; rób po wszystkich test-count-zmieniających taskach |
| **FOC-257** `verdict-evidence` test hardening (2 nity) | (1) key-order guard assertuje exact key set per row shape (łapie *usunięty* klucz); (2) literalny `"UNKNOWN"` raw verdict → ta sama anomalia `unrecognized-verdict-value` co inne nie-pass/fail (albo taxonomy dokumentuje dlaczego nie) | Usunięty klucz w row łapany; spójna klasyfikacja nieznanych wartości (dzisiaj asymetria cicha) | **nie-niezbędne** — nit, bez corpus case | XS | 2 | **zależy od FOC-255** — ten sam moduł `verdict-evidence`, nit po seam; rób po 255 | **Sam** — 2 nity, znam z opisu; rób po FOC-255 |
| **FOC-283** FT: handoff compressor (spike) | Phase 0 self-supervised na 1143-session archive → outline; Phase 1 supervised 86 real pairs (dev→review, review→test); metryka downstream (context-call share vs baseline 27–33%), nie tekstowa; **gated na FOC-278** (pinned-state schema); **extractive framing** (nie generation — lesson z FOC-359) | Największy lever kosztowy (frontman ~44% corpus); jeśli działa — runda dev→review bez re-derivation context-calls | **spike** — blocked deliberately (schema FOC-278 nie istnieje); 4B *generuje* nie *ekstraktuje* → zacząć od extractive framingu | XL | 5 jeśli działa | **blocked** — FOC-278 (pinned-state schema) musi istnieć najpierw; **rób po stabilizacji** (koszyki 1–3 done) | **Decyzja** — tak (Mateusz 2026-09-19), ale po stabilizacji; extractive framing; w ramach większej wizji pipeline'a (patrz sekcja niżej) |
| **FOC-103** Linear task graph na UI | Audit co dashboard już ma (po FOC-217/FOC-221); nowy ekran: graf projekt→task→subtask z drill-down do noda, logów, commitów, linków GitHub; control panel (live running + terminal, agregacja po repo/status); **bez** live terminal/spawn omijających human gates | Mateusz widzi przebieg run-u grafowo zamiast czytać tee; drill-down do logów/commitów; największa widoczność Fenixa | **tak** — ale duży, roadmap mówi „after FOC-217/FOC-221" | L | 5 | **blocked** — FOC-217 + FOC-221 (roadmap reconciliation); audit-first (co dashboard już ma) | **Triage** — duży, wiele powierzchni (UI + backend + log wiring); plan-node najpierw: audit dashboard, potem missing user journey |

## Priorytetyzacja (mój odczyt)

**Koszyk 1 — core stabilizacja (~1 dzień, Triage):** FOC-356 (merge diagnoza, opcja A) + FOC-353 (guard fail-open, hash-stream). Core runtime, musi przez pełny graph — ale każde to kilka linijek + test. FOC-351 osobno (koszyk 4).

**Koszyk 2 — Dev→verify (~pół dnia):** FOC-164 (baseUrl, publiczny repo) + FOC-350 (Opus alias, usun 4.8). AC jasne z opisu, dev dostaje kontrakt, ja verify.

**Koszyk 3 — Sam (~2h, test-only):** FOC-355 + FOC-256 + FOC-255 + FOC-257 (po 255) + FOC-354 (na końcu). Test/config hygiena, znam z opisu, suite jest weryfikacją.

**Koszyk 4 — Triage (opcja A wybrana):** FOC-351 (hermetyczne fixture per test, 3 sub-fixy). Po koszykach 1–3.

**Koszyk 5 — Spike (po stabilizacji):** FOC-283 (handoff compressor) — po FOC-278, extractive framing, w ramach większej wizji (patrz niżej).

**Koszyk 6 — Duży (osobny backlog):** FOC-103 (UI graph) — po FOC-217/FOC-221.

*Estymaty z Linear tam gdzie podane (FOC-353: ~$3–8 = ~2–4h); reszta z comparable past work (FOC-102 wave), nie point values.*

## Wizja — pipeline z izolowanymi modelami za MCP (Mateusz, 2026-09-19)

> Nie task — kierunek. Po stabilizacji (koszyki 1–4 done), Mateusz chce przeprojektować pipeline:
> supervisor wywołuje MCP, za którym stoi osobny agent robiący izolowane akcje.
> Więcej akcji, mniejsze izolowane modele, każdy robi jedną rzecz.

**Obraz docelowy:**

```
supervisor (frontman)
  ├─ MCP: handoff-compressor    (FOC-283 — handoff draft, extractive)
  ├─ MCP: dod-drafter            (DoD generowanie z briefu)
  ├─ MCP: ac-drafter             (AC generowanie z issue body)
  ├─ MCP: verdict-drafter        (Stage A z FOC-359 — xgrammar + API model, schema-gated)
  ├─ MCP: ...                    (więcej izolowanych akcji)
  └─ supervisor zatwierdza każdy (HITL — ten sam kontrakt co gates)
```

**Kluczowe lessons (z FOC-359):**
- **Extractive, nie generative.** 4B model generuje własne treści zamiast ekstraktować (findings_f1=0.04). Każdy drafter musi być extractive (wyciągaj z wejścia, nie komponuj od zera) albo API-model (frontier model dostarcza comprehension, xgrammar gwarantuje schema).
- **Schema-gated.** xgrammar constrained decoding gwarantuje schema validity — to jest Stage A z FOC-359, reusable. Każdy MCP drafter powinien mieć schema gate.
- **Izolowane, jedna akcja.** Każdy model robi jedną rzecz (handoff / DoD / AC / verdict). Nie multi-task w jednym adapterze — FOC-359 pokazał, że multi-task mixing nie pomaga gdy root cause to comprehension.
- **HITL.** Supervisor zatwierdza każdy draft — ten sam kontrakt co gates. Model draftuje, supervisor records.

**Kolejność:**
1. Stabilizacja runtime'u (koszyki 1–4) — bez tego nie ma sensu budować pipeline'a na kruchym fundamencie.
2. FOC-278 (pinned-state schema) — musi istnieć przed handoff-compressor.
3. FOC-283 (handoff compressor) — pierwszy MCP drafter, extractive framing, metryka downstream (context-call share, nie tekstowa).
4. Kolejne draftery (DoD, AC, verdict Stage A) — każdy osobny PRD, osobny pilot, osobny §5 bar.
5. FOC-103 (UI graph) — widoczność całego pipeline'a.

**To jest kierunek, nie task.** Każdy draf터 dostanie własny PRD (template: `docs/plans/verdict-parse-ft-pilot.md`) i własny §5 bar. Nie w jednym PRD — jeden adapter na akcję, split tylko jeśli bar powie.

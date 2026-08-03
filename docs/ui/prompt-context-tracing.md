# PRD — Śledzenie kontekstu promptów (jakie pliki wpadają do składu)

> Status: **zaimplementowane** (2026-08-02) · Repo: `linear-agents`
> Rozszerza: `docs/ui/prompt-library.md` (§3 „Liść składu", §6 architektura)

---

## 1. Problem

Zakładka **Prompty** pokazuje dziś prompt kickoff — jedną linijkę w rodzaju:

> „Weź task {taskId}. Pełna pętla jest w Twoim CLAUDE.md (sekcja Pętla) — …"

Ten prompt **nie zawiera instrukcji**. Odsyła do `CLAUDE.md`, a `CLAUDE.md` odsyła dalej:

```
kickoff (config/prompts.json)
  └─ agents/dev/CLAUDE.md                    ← faktyczna instrukcja leada
       ├─ docs/prd/prd-development.md         ← "Spec:"
       ├─ docs/agents/agent-2-dev.md          ← "Spec:"
       ├─ docs/FENIX_WORKFLOW.md §5           ← widok przekrojowy
       ├─ config/projects.json                ← dane
       ├─ scripts/linear-query.mjs            ← narzędzie (14 wywołań)
       └─ agents/dev/agents/*.md              ← instrukcje subagentów
```

Żeby zobaczyć, **co skład naprawdę wie**, trzeba wyjść z dashboardu i kopać w repo.
Dashboard pokazuje wierzchołek łańcucha i nic pod spodem.

**Cel:** z liścia składu widać cały łańcuch kontekstu — każdy plik, do którego prompt
się odwołuje, z jego treścią, bez wychodzenia z aplikacji.

---

## 2. Kluczowe rozróżnienie: co jest wstrzykiwane, a co tylko wskazane

To nie jest kosmetyka — to odpowiedź na pytanie „co agent wie w turze 0".

| Rodzaj | Znaczenie | Przykład |
|---|---|---|
| `auto` | Ładowane **automatycznie** przez Claude Code do kontekstu | `agents/dev/CLAUDE.md` |
| `read` | Prompt **każe przeczytać**; agent otwiera to sam (albo nie) | `docs/prd/prd-development.md` |
| `tool` | Plik **wykonywalny** — wołany, nie czytany | `scripts/linear-query.mjs` |
| `config` | Dane czytane przez narzędzia | `config/projects.json` |

Różnica `auto` vs `read` jest realna: `CLAUDE.md` jest w kontekście zawsze, PRD tylko wtedy,
gdy agent posłucha instrukcji. UI musi je rozróżniać wizualnie.

---

## 3. Zakres

**In:**
- Ekstrakcja ścieżek plików z dokumentów promptowych (kickoff + lead `CLAUDE.md` + role `*.md`).
- Rozwiązanie każdej ścieżki: istnieje? ile linii? jakiego rodzaju? kto się odwołuje?
- Rekurencja **1 poziom w głąb** dla dokumentów `.md` (PRD też odsyła dalej) — z licznikiem
  głębokości i strażnikiem cykli.
- Wykrywanie **martwych odwołań** (plik nie istnieje) — to realny bug w prompcie.
- Rozpoznanie **wzorców** (`docs/adr/NNN-slug.md`, `agents/*/agents/*.md`, `planning/inbox/<plik>.md`)
  — to nie są martwe linki, tylko szablony. Nie oznaczać ich na czerwono.
- Podgląd treści pliku w UI (leniwy, na kliknięcie).
- Sekcja **„Kontekst składu"** na liściu składu i liściu roli.

**Out:**
- Śledzenie plików, które agent **naprawdę otworzył** w danym przebiegu (dane są w
  transkryptach przez `contentToolUses`, ale `input` jest ucinany do 300 znaków — osobny temat,
  osobne ryzyko). To jest widok *dynamiczny*; ten PRD robi *statyczny*.
- Edycja plików kontekstu z UI.
- Liczenie tokenów kontekstu.

---

## 4. Architektura

### `scripts/prompt-library.mjs` (rozszerzenie)

```js
extractRefs(text)                     // → [{ path, raw, isTemplate }]
resolvePromptRefs(root, { squad, role })  // → { sources, refs, stats }
listContextFiles(root)                // → Set<string> — allowlista dla czytania
readContextFile(root, path)           // → { path, body, lines } | { error }
```

Ekstrakcja: ścieżka = segmenty rozdzielone `/` lub `\`, zakończone znanym rozszerzeniem
(`md|json|mjs|js|bat|ps1|sh|yml|yaml`), z opcjonalnym prefiksem `$LA_ROOT/`.
Szablon = zawiera `*`, `<`, `>` albo segment `NNN+`.

### Endpointy (`telemetry-server.mjs`)

- `GET /api/prompts/refs?squad=&role=` → graf odwołań (metadane, bez treści).
- `GET /api/prompts/file?path=` → treść jednego pliku.

**Bezpieczeństwo `/api/prompts/file`:** to jest endpoint czytający pliki z dysku, więc
nie wystarczy sprawdzenie prefiksu ścieżki. Guard jest dwustopniowy:
1. Ścieżka musi należeć do **allowlisty** = zbiór wszystkich plików, do których odwołuje się
   którykolwiek prompt (liczony na żądanie — to ~30 plików, koszt pomijalny).
2. Ścieżka po `resolve()` musi leżeć wewnątrz `root`.

Punkt 1 jest właściwym zabezpieczeniem; punkt 2 to obrona w głąb. Serwer i tak słucha
tylko na `127.0.0.1`, ale endpoint czytający dowolny plik zasługuje na własny zamek.

### UI

- `ui/src/components/PromptContext.jsx` — nowy komponent (lista odwołań + podgląd).
- Wpięcie w `SquadLeaf.jsx` (pod „Instrukcja leada") i `RoleLeaf.jsx`.

---

## 5. Fazy

1. `extractRefs` + `resolvePromptRefs` + testy na fiksturach (`prompt-refs.test.mjs`).
2. `listContextFiles` + `readContextFile` + testy guardu (path traversal).
3. Endpointy + klient w `ui/src/api.js`.
4. `PromptContext.jsx` + wpięcie w oba liście.
5. Weryfikacja e2e w przeglądarce.

---

## 6. Kryteria akceptacji

- [x] Liść składu DEV listuje ≥6 plików kontekstu z podziałem na `auto`/`read`/`tool`/`config`
      — realnie **28 plików** (7 auto, 6 read, 12 tool, 1 config, 2 state).
- [x] Klik w plik pokazuje jego treść bez przeładowania strony.
- [x] `agents/dev/CLAUDE.md` jest oznaczony jako `auto`, `docs/prd/prd-development.md` jako `read`.
- [x] Odwołanie do nieistniejącego pliku jest oznaczone jako błąd.
- [x] `docs/adr/NNN-slug.md` **nie** jest oznaczone jako błąd (szablon).
- [x] Każde odwołanie pokazuje, z którego dokumentu pochodzi (`referencedBy`).
- [x] `GET /api/prompts/file?path=../../.env` → 403; `?path=.env` → 403 (spoza allowlisty).
- [x] Liść roli pokazuje kontekst tej konkretnej roli (dla `implementer`: 6 plików zamiast 28).
- [x] Wszystkie istniejące testy przechodzą.

## 7. Co wyszło przy okazji

Pierwsza wersja regexu gubiła prefiks `../`, przez co doc-relatywny link
`[agent-2-dev](../agents/agent-2-dev.md)` z `docs/prd/prd-development.md` był raportowany jako
zepsute odwołanie do nieistniejącego `agents/agent-2-dev.md`. To **nie był** bug w promptach,
tylko w ekstraktorze — stąd `resolveRefPath()` i test 12, który pilnuje, żeby fantomowa ścieżka
nigdy nie trafiła na listę. Warto pamiętać przy dokładaniu wzorców: fałszywy alarm w tym panelu
kosztuje więcej niż przeoczone odwołanie, bo podważa zaufanie do całej listy.

`docs/prd/graph-first-squads.md` ma tabelę ręcznie skatalogowanych zepsutych linków —
ten panel liczy to samo automatycznie i na bieżąco.

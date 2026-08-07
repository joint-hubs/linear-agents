# PRD — Edycja promptów i plików kontekstu z dashboardu

> Status: **plan** · Data: 2026-08-03 · Repo: `linear-agents`
> Rozszerza: `docs/ui/prompt-library.md`, `docs/ui/prompt-context-tracing.md`

---

## 1. Problem

Budowanie agenta zaczyna się od promptu, który **odsyła do plików**. Żeby zmienić zachowanie
składu, trzeba dziś edytować pliki w repo — dashboard pokazuje je, ale tylko do odczytu.

Stan obecny ekranu **Prompty**:

| Element | Odczyt | Zapis |
|---|---|---|
| kickoff (`config/prompts.json`) | ✅ | ✅ (jest) |
| instrukcja leada (`agents/<squad>/CLAUDE.md`) | ✅ | ❌ |
| instrukcja roli (`agents/<squad>/agents/<rola>.md`) | ✅ | ❌ |
| pliki kontekstu (PRD, docs/agents/*, FENIX_WORKFLOW…) | ✅ | ❌ |

**Nie budujemy nowego ekranu.** Nawigacja, drzewo i śledzenie łańcucha kontekstu już działają —
brakuje wyłącznie zapisu. Osobny edytor rozdzieliłby narzędzia i zdublował drzewo.

---

## 2. Co jest edytowalne — i co świadomie NIE jest

Inwentarz (`resolvePromptRefs` po pięciu składach) to **85 unikalnych plików**. Edytowalne
jest tylko to, co realnie jest tekstem instrukcji:

| Rodzaj | Plików | Edytowalne | Dlaczego |
|---|---:|---|---|
| `auto` — ładowane do kontekstu | 32 | **tak** | 5 × `CLAUDE.md` + 27 ról = rdzeń promptów |
| `read` — wskazane w prompcie | ~13 realnych | **tak** | PRD, `docs/agents/*`, FENIX_WORKFLOW, ACCESS |
| `config` — dane dla narzędzi | 5 | **nie** | `models.json`, `projects.json` — mają własne ekrany |
| `tool` — skrypty | 16 | **nie** | to kod, nie prompt |
| `state` — runtime | 6 | **nie** | generowane między przebiegami |
| wzorce (`*.md`, `NNN-slug`) | — | **nie** | nie są plikami |

**Twarda reguła: edytowalne wyłącznie `.md` z allowlisty odwołań.** Nie dlatego, że reszta
jest nieciekawa — tylko dlatego, że edytor promptów, który potrafi nadpisać `linear-ops.mjs`,
to już nie edytor promptów.

---

## 3. Architektura

### Backend — `scripts/prompt-library.mjs`

```js
writeContextFile(root, relPath, body, { dryRun })
  -> { path, before, after, changed, bytes } | { error }
```

Guardy, w tej kolejności (pierwszy odrzuca najtaniej):
1. `relPath` kończy się na `.md` — inaczej `forbidden: only .md files are editable`
2. resolve trzyma się wewnątrz `root` — obrona w głąb
3. `relPath ∈ listContextFiles(root)` — **właściwy zamek**: plik musi być realnie
   wskazywany przez któryś prompt
4. `kind` pliku ∈ {`auto`, `read`} — blokuje `.md` ze `.state/`

Zapis: `atomicWriteText` z zachowaniem EOL pliku (repo miesza CRLF/LF — nadpisanie całości
jednym stylem zrobiłoby diff na 150 linii zamiast na trzech).

### Endpoint — `telemetry-server.mjs`

`POST /api/prompts/file` — `{ path, body, dryRun }`.
127.0.0.1 only + origin check, dokładnie jak `/api/launch` i `/api/squad-config`.
`dryRun: true` zwraca `before`/`after` bez zapisu.

### UI

Bez nowych ekranów. Trzy miejsca dostają ten sam komponent `<MarkdownEditor>`:
- `SquadLeaf` → „Instrukcja leada"
- `RoleLeaf` → „Instrukcja roli"
- `PromptContext` → wiersz pliku `auto`/`read`

Wzorzec zapisu **taki sam jak istniejąca edycja kickoffu**: *Podgląd zmian* (dry-run,
pokazuje before/after) → *Zapisz*. Spójność z tym, co Mateusz już zna z tego ekranu.

---

## 4. Czego NIE robimy

- **Bez git commit z UI.** Zapis zostawia brudny working tree; commit to osobna, świadoma
  decyzja (zasada z `git-checkpoint`).
- **Bez edycji `config/models.json` i `projects.json`** — mają własny ekran Konfiguracja.
- **Bez edycji skryptów.** Patrz §2.
- **Bez wersjonowania w aplikacji.** Historię ma git.

---

## 5. Kryteria akceptacji

- [ ] Instrukcję leada DEV da się zmienić z dashboardu i zmiana ląduje w `agents/dev/CLAUDE.md`.
- [ ] To samo dla dowolnej roli i dla pliku kontekstu (np. `docs/prd/prd-development.md`).
- [ ] *Podgląd zmian* pokazuje before/after i **nie** dotyka pliku.
- [ ] `POST /api/prompts/file` z `path=scripts/linear-ops.mjs` → **403**.
- [ ] `path=../../.env` → 403; `path=.state/mock/dev-task.json` → 403.
- [ ] Plik z CRLF pozostaje CRLF po zapisie (diff pokazuje tylko realne zmiany).
- [ ] Żądanie spoza 127.0.0.1 → 403.
- [ ] Istniejące testy przechodzą.

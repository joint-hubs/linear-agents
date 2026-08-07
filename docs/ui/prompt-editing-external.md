# PRD — Edycja promptów spoza repo (orkiestratory + Hermes)

> Status: **plan** · Data: 2026-08-03 · Repo: `linear-agents`
> Rozszerza: `docs/ui/prompt-editing.md`

---

## 1. Problem

Mateusz ma **trzy niezależne systemy promptów**, a dashboard edytuje tylko jeden:

| System | Gdzie żyje | Edytowalne z dashboardu |
|---|---|---|
| składy Fenix | `linear-agents/` | ✅ (zrobione) |
| orkiestratory (`orchestrate*.bat`) | `~\.claude\` | ❌ |
| asystent Hermes (Discord) | `%LOCALAPPDATA%\hermes\` | ❌ |

---

## 2. Dlaczego to nie jest zwykłe rozluźnienie guardu

Dotychczasowy zamek brzmiał: *ścieżka po `resolve()` musi zostać wewnątrz repo*. To jedno
zdanie zabezpieczało cały endpoint zapisu. Wychodząc poza repo, tracimy je i musimy je
zastąpić czymś równie twardym — inaczej lokalny serwer HTTP staje się dowolnym zapisem do
katalogu domowego.

Zamiast jednego korzenia mamy **jawną listę korzeni z listą wzorców**, a nie „cały katalog".

### Guardy (kolejność od najtańszego)

1. ścieżka ma postać `@<rootId>/<relative>` — brak prefiksu = ścieżka repo, stara droga
2. `rootId` istnieje w `config/prompt-roots.json`
3. rozszerzenie `.md` — bez wyjątków
4. `realpathSync` katalogu docelowego mieści się w `realpathSync` korzenia
   (**realpath, nie resolve** — inaczej symlink w środku korzenia wyprowadza na zewnątrz)
5. ścieżka pasuje do któregoś `include` danego korzenia
6. ścieżka nie pasuje do żadnego `exclude`

`config/prompt-roots.json` jest `.json`, więc **sam nie jest edytowalny przez ten edytor** —
inaczej pierwszą rzeczą, jaką dałoby się zrobić, byłoby dopisanie korzenia `C:\`.

---

## 3. Co świadomie zostaje NIEedytowalne

### `orchestrate.bat` i `orchestrate-openrouter.bat`

Prompt orkiestracji (~1500 znaków) siedzi **wewnątrz pliku `.bat`**, w argumencie
`--append-system-prompt`. Kuszące, żeby go tu wystawić. Nie robimy tego:

**`.bat` jest wykonywalny.** Edytor promptów z prawem zapisu do pliku, który Mateusz
uruchamia dwuklikiem, to zdalne wykonanie kodu przez lokalny serwer HTTP. Reguła „tylko `.md`"
istnieje dokładnie po to.

**Właściwe rozwiązanie jest i tak lepsze:** przenieść treść promptu do
`~\.claude\memory\orchestration.md` (oba launchery już każą go przeczytać — *„Read
~/.claude/memory/orchestration.md first"*), a w `.bat` zostawić jedno zdanie. Wtedy prompt
edytuje się jako markdown, a `.bat` przestaje być plikiem, który ktokolwiek chce ruszać.
To osobna zmiana, do decyzji Mateusza.

### `hermes\config.yaml`

680 linii YAML-a: model, limity, toolsety, presety `personalities`. Presety to faktycznie
prompty — ale złamana składnia YAML wywala całego bota, a repo jest zero-dep, więc nie ma
czym zwalidować pliku przed zapisem. Edytor bez walidatora to tu pułapka, nie ułatwienie.

### `~\.claude-or\`

Odtwarzany przy każdym starcie `orchestrate-openrouter.bat` (`copy /y` + `robocopy /MIR`).
Cokolwiek się tam wpisze, zniknie. Wykluczone, żeby nie kusiło.

### `~\.claude\plans\*.md`, `cache\`, `hermes\.skills_prompt_snapshot.json`

Artefakty runtime.

---

## 4. Zakres — 28 plików

| Korzeń | Wzorce | Plików |
|---|---|---|
| `@claude` → `~\.claude` | `CLAUDE.md`, `memory/*.md`, `skills/*/SKILL.md` | 17 |
| `@hermes` → `%LOCALAPPDATA%\hermes` | `SOUL.md`, `memories/*.md`, `skills/*/SKILL.md` | 11 |

---

## 5. UI

Nowa gałąź w drzewie ekranu **Prompty**: *„Prompty globalne i Hermes"* → korzeń → plik →
ten sam `MarkdownEditor`. Zero nowych wzorców interakcji.

Przy każdym korzeniu jedno zdanie, czego dotyczy — bo „CLAUDE.md" znaczy co innego
w repo, a co innego w `~\.claude`.

---

## 6. Kryteria akceptacji

- [ ] `~\.claude\memory\orchestration.md` da się otworzyć i zapisać z dashboardu.
- [ ] `hermes\SOUL.md` — j.w.
- [ ] `@claude/../../secret.md` → 403 (ucieczka z korzenia).
- [ ] `@hermes/config.yaml` → 403 (nie `.md`).
- [ ] `@claude/plans/foo.md` → 403 (poza `include`).
- [ ] `@nieistniejacy/x.md` → 403.
- [ ] `scripts/orchestrate.bat` w żadnej formie → 403.
- [ ] Zapis zachowuje końce linii pliku.
- [ ] Ścieżki repo (bez `@`) działają jak dotąd — zero regresji.

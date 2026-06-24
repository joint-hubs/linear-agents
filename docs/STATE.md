# STATE — linear-agents (pilotaż orkiestratora)

> Stan długiej pracy. Sesje wypadają z kontekstu — ten plik to tani start. Aktualizuj po każdej fazie.
> Orkiestrator: GLM-5.2. Plan wykonawczy: `docs/BUILD-BACKLOG.md`. Polityka: `~/.claude/memory/orchestration.md`.

## Ostatnia aktualizacja: 2026-06-24 — T-A1 DONE + 3 bugi P0 naprawione, Faza A w toku (równolegle)

### Zrobione
- **T-A1 SPIKE — DONE.** Architektura „model per subagent" **DZIAŁA**: explicit OpenRouter slug we
  frontmatter `model:` honorowany (pass-through do API); aliasy `opus/sonnet/haiku` mapują przez
  `ANTHROPIC_DEFAULT_*_MODEL`. Warunek: `CLAUDE_CODE_SUBAGENT_MODEL` nie ustawiony. ADR:
  `docs/adr/0002-subagent-model-mechanism.md` (Accepted). Dowód: `.spike-a1`/`.spike-a2` (Test 3a/3b).
- **T-A1-fix (bug #1) — DONE+verified:** `bin/_lib.bat` base URL `…/api/v1`→`…/api` (było 404 we
  wszystkich squadach; SDK dopisuje `/v1/messages`). Weryfikacja: `set ANTHROPIC_BASE_URL` = `https://openrouter.ai/api`.
- **T-A1-fix (bug #2) — DONE+verified:** `set "CLAUDE_CODE_SUBAGENT_MODEL="` w `_lib.bat` (dziedziczony
  override nadpisywał frontmatter). Weryfikacja: var `not defined` po `call _lib.bat`.
- **T-A1-fixb (bug #3) — DONE+verified:** wszystkie `bin/*.bat` miały LF-ending → cmd nie parsował
  (`setlocal`→`etlocal`). Skonwertowane LF→CRLF + `.gitattributes` (`*.bat/*.cmd text eol=crlf`).
  Weryfikacja end-to-end: `bin\dev.bat -p "Reply OK"` → model replied `OK`, zero błędów (OpenRouter 200).
- **BACKLOG/STATE** zaktualizowane; T-A1 odhaczony; T-A1-fix/T-A1-fixb dopisane.

### Zrobione (cd. — Faza A, równolegle DeepSeek Flash, verified + Pro review)
- **T-A2** `scripts/check.mjs` — consistency linter. `node scripts/check.mjs` → `OK: 4 checks, 0 violations`;
  negative-test (zły model) → `DRIFT` (łapie drift). Pro review: frontmatter quote-stripping fix applied.
- **T-A3** `planning/inbox/sample.md` — WIP-age tracking w CADENCE digest, ~4 subtaski, realne artefakty.
- **T-A5** `scripts/cost-guard.mjs` + wire do `cost-report.mjs` (pre-flight + loop check, marker `.state/over-budget.json`).
  5/5 testów + `--dry-run` bez regresji.
- **T-A6** `scripts/utils.mjs` — `idempotentCreate` (store `.state/created-keys.json`, atomic write) + `reviewRound` (escalation).
  25/25 testów. Pro review: input-validation fix (TypeError brak key/existsFn) + race TODO.
- **T-A6b** (follow-up, post-pilot): race-condition hardening (lock/CAS) — task #9, odroczone.

### W toku
- (brak — czeka na decyzję Mateusza: commit checkpoint + start T-A4)

### Następne
- **T-A4** PLAN dry-run (mock Linear) — deps spełnione (T-A1 ✅, T-A3 ✅, launchery działają). Ostatni milstone offline Fazy A.
- **Faza B** (T-B1..B3, provider mechanism / native profil) — po Fazie A.

### Blokady (czeka na Mateusza)
- Faza C (Linear live): workspace/team + bot `@flow` (OAuth) + klucz Linear.
- Faza D / T-D4 / Faza G: GCP VM (nazwa/projekt/zone).
- Odblokowane: OPENROUTER_API_KEY ✅ w `.env`.

## Jak uruchomić
- Squad launchery (DZIAŁAJĄ po fixach): `bin\plan.bat` (lead Opus), `bin\dev.bat`, `bin\review.bat`,
  `bin\test.bat`, `bin\cadence.bat`, `bin\all.bat`, `bin\agent.bat <area> <role>`. Wszystkie wołają `bin\_lib.bat`.
- Spike T-A1 (re-runnable): `.spike-a1\run-spike.ps1`, `.spike-a1\run-clean.ps1`, `.spike-a2\run-spike.ps1`.

## Niecommitowane zmiany w working tree (proponuję git-checkpoint gdy Mateusz zgodzi)
- `bin/_lib.bat` (base URL + clear SUBAGENT_MODEL)
- `bin/*.bat` (LF→CRLF, 8 plików)
- `.gitattributes` (nowy)
- `docs/adr/0002-subagent-model-mechanism.md` (nowy)
- `docs/BUILD-BACKLOG.md`, `docs/STATE.md` (higiena)
- `.spike-a1/`, `.spike-a2/` (scratch — usunąć przed commit lub zostawić jako re-runnable dowód)

## Notatki
- Orkiestrator (GLM) biegnie przez **Ollama** (`ANTHROPIC_BASE_URL=127.0.0.1:11434`), NIE OpenRouter.
  Squad launchery celowo na OpenRouter. Nie mylić env sesji orkiestratora z env squadu.
- Claude Code: 2.1.187. Przy upgrade CC — re-run spike'a T-A1 (ryzyko zmiany pass-through `model:`).
- `CLAUDE_CODE_SUBAGENT_MODEL` ustawiony w env orkiestratora (=glm-5.2:cloud) — dlatego squady muszą
  go czyścić (zrobione w `_lib.bat`); bez tego subagenty spłaszczają się na jeden model.
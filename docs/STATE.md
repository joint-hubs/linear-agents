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

### Zrobione (cd.)
- **T-A4 PLAN dry-run — DONE+verified (2026-06-24).** Realny squad `bin\plan-dry.bat` (lead Opus, OpenRouter)
  na `planning/inbox/sample.md`: discovery(minimax)→spec(glm-5.2, 18KB tech design + ADR-0003)→spec-review→
  decomposer(minimax, draft JSON 14.4KB). Mock `scripts/mock-linear.mjs` waliduje + idempotentny ingest (reużywa T-A6).
  **AC spełnione:** 9 subtasków (≥3) z type/estimate(t-shirt)/AC(Given/When/Then)/slice; DoR (rejected=0, <3→fail);
  idempotencja (re-ingest → `idempotent_skip=1`, 1 brief, 1 store entry, 0 duplikatów); check.mjs zielony.
  Tryb normalny squadu nietknięty (push zostaje realny dla Fazy C).
- **Bug-fixy w locie (T-A4):** (1) `plan-dry.bat` KICKOFF — multiline `^` continuation rozbijał prompt → cmd wykonywał
  `Read`/`Run…` jako komendy + `>` redirect; naprawione na 1 linię (literał `<>` w cudzysłowach). (2) `decomposer.md`
  `tools:` brak `Write` → nie mógł zapisać draft JSON; dodano `Write`.

### W toku
- (brak — T-A4 DONE, czeka na checkpoint Mateusza)

### Następne
- **Faza B** (T-B1..B3, provider mechanism / native profil) — po Fazie A.
- **T-A6b** (post-pilot): idempotency race-condition hardening — task #9, odroczone.
- **Faza C** ⛔ (Linear live): workspace/team + bot @flow (OAuth) + klucz.

### Blokady (czeka na Mateusza)
- Faza C (Linear live): workspace/team + bot `@flow` (OAuth) + klucz Linear.
- Faza D / T-D4 / Faza G: GCP VM (nazwa/projekt/zone).
- Odblokowane: OPENROUTER_API_KEY ✅ w `.env`.

## Jak uruchomić
- Squad launchery (DZIAŁAJĄ po fixach): `bin\plan.bat` (lead Opus), `bin\dev.bat`, `bin\review.bat`,
  `bin\test.bat`, `bin\cadence.bat`, `bin\all.bat`, `bin\agent.bat <area> <role>`. Wszystkie wołają `bin\_lib.bat`.
- Spike T-A1 (re-runnable): `.spike-a1\run-spike.ps1`, `.spike-a1\run-clean.ps1`, `.spike-a2\run-spike.ps1`.

## Git checkpoint (2026-06-24)
Branch `feat/phase-a-offline-foundation` (NIE zmergowany, NIE pushowany — czeka na Mateusza):
- `b3fc4f3` fix(bin): base URL + clear SUBAGENT_MODEL + .gitattributes (CRLF)
- `5efc05d` feat(scripts): check.mjs + cost-guard.mjs + utils.mjs + cost-report.mjs wire + .gitignore
- `e0491dc` docs(adr): ADR-0002 + BUILD-BACKLOG + STATE
- `2862972` feat(planning): inbox/sample.md

Working tree czyste (poza STATE.md — ten plik jest living-doc). Scratch `.spike-a1/`/`.spike-a2/`
i `scripts/_test_*.mjs` gitignored (na dysku jako re-runnable dowód/testy).

## Notatki
- Orkiestrator (GLM) biegnie przez **Ollama** (`ANTHROPIC_BASE_URL=127.0.0.1:11434`), NIE OpenRouter.
  Squad launchery celowo na OpenRouter. Nie mylić env sesji orkiestratora z env squadu.
- Claude Code: 2.1.187. Przy upgrade CC — re-run spike'a T-A1 (ryzyko zmiany pass-through `model:`).
- `CLAUDE_CODE_SUBAGENT_MODEL` ustawiony w env orkiestratora (=glm-5.2:cloud) — dlatego squady muszą
  go czyścić (zrobione w `_lib.bat`); bez tego subagenty spłaszczają się na jeden model.
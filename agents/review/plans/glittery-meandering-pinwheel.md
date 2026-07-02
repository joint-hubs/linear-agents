# Plan: Stażysta agent mode — default ON, usuń toggle + global kill-switch

## Context

Mateusz przetestował Stażystę na la-test-runner (PISI-98 deploy) i stwierdził: toggle "Tryb agenta" w UI jest zbędny — po jego wyłączeniu asystent i tak cytował źródła, a domyślnym oczekiwaniem jest że rag_chat **zawsze** działa w trybie agenta (ReAct loop). Decyzja produktowa: usunąć toggle z UI, usunąć global kill-switch, per-session flag default True, backfill wszystkich istniejących sesji.

To odwraca kontrakt security z REVIEW round-1 ("feature behind two OFF-by-default flags"). Scoping jest verified-safe (round-1: `DocumentAccessService.build_document_filter` server-side, LLM query tylko rankuje). Odroczony follow-up PII-redaction align (LLM-rewritten query unredacted w embedding+audit) staje się bardziej istotny przy zawsze-ON — zostaje jako follow-up (PISI-130-style), nie blokuje.

## Zakres

Nowy branch `feat/pisi-98-agent-default-on` od `feat/pisi-98-stazysta-agent-similarity-search`. Po zmianach: rebuild backend+frontend na VM, alembic upgrade, redeploy.

## Zmiany

### Backend

1. **`backend/app/core/config.py:243`** — usuń linię `staztysta_enable_agentic_search: bool = False` (zostaw `staztysta_agent_max_iterations` i `staztysta_agent_top_k`).

2. **`backend/app/services/staztysta_service.py:521-524`** — usuń AND-gate z global flag. Agent path zależy tylko od per-session flag (default True):
   ```python
   agentic_enabled = bool(getattr(session, "agent_search_enabled", True))
   ```
   (gałęzie agent-loop vs single-shot zostają — single-shot to fallback gdy session jawnie False, pożyteczne defensywnie).

3. **`backend/app/models/staztysta.py:62-64`** — default True + server_default true:
   ```python
   agent_search_enabled = Column(
       Boolean, nullable=False, default=True, server_default=text("true")
   )
   ```
   + zaktualizuj komentarz (nie "Off by default; user opts in" lecz "Default ON; agentic ReAct loop for rag_chat").

4. **`backend/app/api/v1/endpoints/staztysta.py:144`** — fallback True:
   ```python
   agent_search_enabled=bool(getattr(session, "agent_search_enabled", True))
   ```

5. **`backend/app/api/v1/endpoints/staztysta.py:415-438`** `toggle_agent_search` endpoint — **zostawić bez zmian** (backward compat API; UI go nie woła, ale inne klienty mogą). Nie usuwamy route'a (mniej ryzyka).

### Migracja (nowa rewizja)

**`backend/alembic/versions/<new>_agent_default_on.py`**:
- `revision = "<new>_agent_default_on"` (np. `pisi98_agent_default_on`)
- `down_revision = "pisi98_staztysta_agent_search"`
- upgrade():
  ```python
  op.execute("ALTER TABLE staztysta_sessions ALTER COLUMN agent_search_enabled SET DEFAULT true")
  op.execute("UPDATE staztysta_sessions SET agent_search_enabled = true")
  ```
- downgrade(): `SET DEFAULT false` (bez rollback danych — backfill nieodwracalny, akceptowalne).

### Frontend

6. **`frontend/src/pages/StaztystaPage.tsx:343-361`** — usuń cały blok `{isRagChat && (<Box>...Switch + label + caption...</Box>)}`. Zostaw `Typography` opis powyżej (już pasuje: "zadaj pytanie, AI przeszuka dokumenty... z cytowaniem źródeł").

7. **`frontend/src/pages/StaztystaPage.tsx:243-267`** — usuń funkcję `handleToggleAgentSearch` (nieużywana po usunięciu toggle). Usuń też jej referencje jeśli gdzieś bound.

8. **`frontend/src/api/client.ts:1252-1261`** `setStaztystaAgentSearch` — usuń funkcję (tylko `handleToggleAgentSearch` jej używał). Pole `agent_search_enabled` w `SessionDetail` (linie 1205, 1217) **zostawić** — backend nadal zwraca, frontend może je ignorować.

9. **`frontend/src/components/staztysta/StaztystaChat.tsx`** — bez zmian. SSE handling `tool_call`/`tool_result` (linie 152-158) nie zależy od flagi, tylko od eventów od backendu. Działa tak samo.

### Testy

10. **`backend/tests/integration/test_staztysta_agent_loop.py`**:
    - `test_agentic_disabled_by_global_flag` (linia ~674) — **usuń** (global flag nie istnieje; nie da się wyłączyć globalnie).
    - `test_agentic_disabled_by_session_flag` (linia ~721) — **zostawić**, ale upewnij się że jawnie ustawia `agent_search_enabled=False` na sesji (test per-session opt-out — nadal sensowny: sesja z False → single-shot).
    - `_agentic_settings` fixture (~100) — usuń ustawianie/przywracanie `staztysta_enable_agentic_search` (field usunięty). Zostaw max_iter/top_k.
    - `_make_session` (~53) — `agent_search_enabled=True` default OK (pasuje do nowego default).
    - Testy agent-loop happy path (`test_agent_loop_search_then_answer`, must-fix #1/#2) — bez zmian, zielone.

## Wykonanie na VM (la-test-runner)

1. Na VM: `cd ~/office && git fetch --bundle`? Nie — sklonuję zmiany przez nowy git bundle z lokalnego (jak wcześniej) ALBO push brancha na VM przez scp bundle. Najprościej: lokalnie commit na nowym branchu → `git bundle` → scp na VM → `git fetch` z bundle + checkout.
2. Rebuild backend: `docker compose -p office-local-openrouter-only ... up -d --build backend backend-worker` (remote overlay).
3. Rebuild frontend: `... up -d --build frontend`.
4. Alembic upgrade: `docker exec backend alembic upgrade head` (nowa migracja backfill).
5. Restart backend/frontend.

## Weryfikacja

- **Backend runtime**: `docker exec backend python -c "from app.core.config import settings; print(hasattr(settings,'staztysta_enable_agentic_search'))"` → False (field usunięty). `print(settings.staztysta_agent_max_iterations)` → 3.
- **DB**: `psql -c "SELECT agent_search_enabled, count(*) FROM staztysta_sessions GROUP BY 1"` → wszystkie true (backfill). `\d staztysta_sessions` → default true.
- **Migracja**: `alembic current` → nowa rewizja; `alembic heads` → jeden head.
- **pytest**: `pytest tests/integration/test_staztysta_agent_loop.py tests/integration/test_qa_audit_details.py tests/unit/services/test_staztysta_service.py tests/unit/services/test_llm_service_agent_decision.py` → zielone (must-fix #1/#2 nadal pokryte, test global-flag usunięty).
- **UI (przeglądarka)**: https://34.116.198.247/ → Stażysta → brak toggle "Tryb agenta". Nowa sesja rag_chat → pytanie wiedzy → "Szukam w bazie…" (tool_call) + odpowiedź z cytowaniem. Powitanie "cześć" → brak "Nie znaleziono" (must-fix #1 nadal działa).
- **SSE**: StaztystaChat.tsx odbiera tool_call/tool_result bez zmian.

## Follow-up (nie blokuje, odroczone)

- PII-redaction align w `search_for_assistant` (LLM-rewritten query unredacted) — przy zawsze-ON bardziej istotne. Track jako osobny issue (z PISI-130 env-var typo i odłączoną migracją pii_vault).
- `toggle_agent_search` endpoint zostaje (backward compat) — można usunąć w osobnym cleanupie jeśli nieużywany.

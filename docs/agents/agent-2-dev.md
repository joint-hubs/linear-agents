<dev_agent_session>

> Bierze taski z `Todo`, rozumie je (pytając gdy trzeba), planuje, koduje, oddaje do review.
> Launcher: `bin/dev.bat` (`CLAUDE_CONFIG_DIR=configs/dev`). 

</dev_agent_session>

<dev_agent_trigger>
Ręczne odpalenie `.bat` (lub webhook na assign `@flow`). Agent sam wybiera task z `Todo`.
</dev_agent_trigger>

<dev_agent_steps>
## Kroki
1. **Recon (MiniMax).** Czyta opis + komentarze + checklist; skan kodu → **context packet** (kluczowe pliki, wzorce, luki, tagi) (M7).
2. **Env-check (delivery-loop).** `docker compose up` / seed; env działa? Nie → `needs:access` + @Mateusz (M6).
3. **Clarify (jeśli niejasne).** Komentarz @Mateusz + `needs:answer`
4. **GATE — approve (HITL).** `needs:approval`; Mateusz reaguje
5. Implement
6. **Self-verify (delivery-loop).** Build/test/rebuild+redeploy lokalnie; DoD-checklist.
7. **Hand-off.** Komentarz-podsumowanie (co zrobione, jak testować) + odhacza checklist → status `In Review`, label `ai:coded`. Ryzykowne → `risk:high`.
</dev_agent_steps>
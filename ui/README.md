# Control panel (UI) — plan

> Later. Cel: jeden panel do zarządzania całością. Rekomendacja: **rozszerzyć istniejący
> `Desktop/experiments/0_linear`** (Next.js, ma już LINEAR_API_KEY + OPENROUTER_API_KEY).

## Zakres (MVP)
1. **Przełącznik workspace/team Linear** — łatwa zmiana na którym Linearze pracujesz.
2. **Uruchamianie agentów** — przyciski odpalające `bin/*.bat` (lub agenty w tle), status każdego.
3. **Inbox artefaktów** — drag&drop voice memo + plików → `planning/inbox/` (wejście PLAN).
4. **Widoki sygnałów** — odbicie zapisanych filtrów Linear: 🔔 needs / 🤖 working / ⚠️ attention / 🚧 blocked.
5. **Cost dashboard** — `scripts/cost-report.mjs` → wydatki per agent/task, alert `over-budget`.

## Uwagi
- Sekrety przez `.env` (nie w UI).
- Decyzja do potwierdzenia: rozszerzyć `0_linear` czy osobny minimalny panel? (patrz STATE.md §5).

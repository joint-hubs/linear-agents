---
type: review
status: active
tags: [type/review, area/ui, topic/ux, topic/monitoring, topic/model-routing]
created: 2026-06-23
maturity: review-v1
---

# UX design — analiza + usprawnienia (do v3)

> Analiza `docs/ui/ux-design.md` (v2) pod kątem 3 życzeń: (1) subskrypcja-first + fallback,
> (2) łatwy swap modelu per czynność, (3) monitoring tokenów/agenta/kosztu/czasu. Non-destructive —
> osobny plik, nie nadpisuję v2.

## Werdykt
UX v2 jest **mocny**: Config › Model Routing (dropdown per rola z ceną+benchmarkiem) = gotowy „swap per czynność";
Costs dashboard = solidny monitoring; signal views + terminal-spawn + workspace switch + Keys — kompletny MVP.
Poniżej luki/usprawnienia, głównie wokół Twoich nowych wymagań.

## 1. Subskrypcja-first + fallback (rozjazd z v2 — do poprawy)
v2 zakłada **OpenRouter primary dla wszystkiego** (Keys: „Anthropic … fallback only; OpenRouter is primary";
terminal-spawn wstrzykuje `ANTHROPIC_BASE_URL=openrouter` zawsze). To **sprzeczne** z „subskrypcja-first dla Opus/Sonnet". Zgodnie z [ADR-0001](../adr/0001-provider-routing-and-fallback.md):
- **Config › Model Routing:** dodać kolumnę **Provider** per rola: `anthropic-sub` (subskrypcja, natywnie) / `openrouter`. Walidacja: rola `anthropic-sub` ⇒ model musi być Anthropic; ostrzeżenie, że taka sesja nie może mixować tanich modeli.
- **Kolumna Fallback** per rola (np. `openrouter:anthropic/claude-opus-4.8`).
- **Terminal-spawn:** gdy agent jest „native", **nie** wstrzykuj `ANTHROPIC_BASE_URL` (login subskrypcyjny); na błąd auth/limit → relaunch w trybie OpenRouter (toast „fallback → OpenRouter").
- **Keys screen:** odwróć narrację — Anthropic **subskrypcja = primary** dla modeli Anthropic; OpenRouter = fallback + provider tanich modeli. Dodać widget **„subscription quota / reset"** (ile zostało, kiedy reset) — kluczowe dla decyzji o fallbacku.

## 2. Monitoring per-agent / per-task (rozszerzyć v2)
v2 Costs dashboard jest **per-model** (bo OpenRouter Activity API jest per-model). Twoje życzenie „który agent ile zużył + czas" wymaga więcej:
- **Lokalny token-log** (tag: area, role, issue-id, model, in/out/reasoning tokens, latency, ts) zapisywany przez launcher/sesję → **przesuń z Phase 3 do Phase 2** (to wprost Twój wymóg).
- Dashboard: dodać **breakdown per area** (PLAN/DEV/REVIEW/TEST/CADENCE) i **drill-down per task (issue)**, oraz kolumny **czas/latencja** i **# requests**.
- **Live token-meter** podczas pracy agenta (jeśli token-log pisze na bieżąco) — mały licznik w karcie agenta.
- Subskrypcja: osobny licznik zużycia subskrypcji vs OpenRouter (dwa źródła kosztu).
- Router/proxy (ADR-0001 opcja B, Phase 3) dałby to „za darmo" jako centralny choke-point logujący wszystko per-agent — rozważyć gdy monitoring per-agent stanie się krytyczny.

## 3. Swap modelu per czynność (drobne usprawnienia)
Config › Model Routing już jest. Dodać:
- **Add-model flow:** wklej OpenRouter id → auto-fetch ceny z `GET /api/v1/models` → dodaj do `ids`+`pricing` → rola dostępna w dropdownie. (Dziś trzeba ręcznie edytować models.json.)
- **Presety per area:** jeden klik „cheap" / „balanced" / „quality" (np. quality = podmień deep/hard na Opus). 
- **Ostrzeżenie kosztowe** przy wyborze drogiego modelu (np. „+8× output vs obecny").
- **Diff vs defaults** + „Reset role to default".
- **„Duplicate role"** (gdy dojdzie PR-feature i role typu `pr-responder`).

## 4. Drobne / spójność
- **fugu-ultra**: po dodaniu do `config/models.json → ids`+`pricing` pojawi się w dropdownie automatycznie (v2 §3c). Patrz `docs/backlog/model-candidates.md`.
- **Dry-run toggle** w karcie agenta (PLAN dry-run = mock Linear) — wpięte w S2 z dev-readiness.
- **PR/Copilot** (backlog `pr-review-loop-*`): gdy wejdzie, dodać do signal-views akcję „judge Copilot comment" (fix/accept) i kolumnę wersji (`version:`).
- **Provider health** (OpenRouter up? Anthropic up?) obok Keys.

## Rekomendacja phasingu (zmiana vs v2)
- Do **Phase 1**: kolumna Provider + Fallback w Model Routing (bo to steruje subskrypcją — fundament).
- Do **Phase 2**: lokalny token-log + per-agent/per-task monitoring (Twój wprost wymóg) — z Phase 3.
- **Phase 3**: router/proxy (auto per-model fallback + monitoring jako efekt uboczny), embedded terminal.

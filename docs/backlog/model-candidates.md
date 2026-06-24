---
type: backlog
status: backlog
tags: [type/backlog, topic/models]
created: 2026-06-23
---

# Kandydaci modeli do dodania (później)

Modele do ewentualnego dodania/podmiany, gdy Mateusz uzna. **Jak dodać:** wpis do
`config/models.json → ids` + `pricing`, opcjonalnie `routing`/`config/models.map` (rola→model);
wtedy pojawi się automatycznie w UI (Config › Model Routing dropdown). Przed routowaniem realnej
pracy — zweryfikuj cenę i benchmark.

| Model (OpenRouter id) | Status na OpenRouter | Notatka |
|---|---|---|
| `sakana/fugu-ultra` (też `sakana/fugu-ultra-20260615`) | ✅ dostępny (zweryfikowane na `/models`) | Kandydat Mateusza „na później". Do sprawdzenia: cena (in/out $/1M), benchmark coding/agentic, tool-call reliability — zanim podmienić któryś z obecnych. |

> Uwaga: dodanie do `ids` bez `pricing` złamie walidację UI (każdy `ids` musi mieć `pricing`) — dodawaj parami.

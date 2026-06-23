# ACCESS — dostępy, porty, sekrety (gdzie co leży)

> Reguła globalna #6. Aktualizuj przy każdej zmianie konta/klucza/portu/VM.
> **Sekrety NIE są tu wpisywane** — tu tylko **gdzie** ich szukać.

## Klucze API — 5 TODO
| Co | Gdzie trzymane | Status |
|---|---|---|
| OpenRouter | `.env` → `OPENROUTER_API_KEY` | TODO |
| Anthropic (Opus/Sonnet) | `.env` → `ANTHROPIC_API_KEY` | TODO |
| Linear JOI | `.env` → `LINEAR_API_KEY` (lub `LINEAR_JOI_API_KEY`) | TODO |
| Linear PISI | `.env` → `LINEAR_PISI_API_KEY` | TODO |
| Bot `@flow` (OAuth actor=app, webhooks) | `.env` → `LINEAR_AGENT_OAUTH_TOKEN` | TODO utworzyć app w Linear |

## Linear
- **Workspace**: JOI + PISI (oba). `config/projects.json` już workspace-keyed: Neo/AU/Fenix→joi, PISI→pisi (guess, do potwierdzenia).
- Bot `@flow`: utworzyć OAuth Application (API → New OAuth app), scope `app:assignable`+`app:mentionable`, włączyć webhooks (mention/assign/reaction/comment). Endpoint webhooka: **TODO** (cloud; lokalnie tunel np. Hookdeck/ngrok).
- Labelki/statusy/templates: tworzone przez `scripts/bootstrap-linear.mjs` z `config/linear/`. Kod gotowy, czeka na klucz API.

## Deploy
- **GCP VM** (build OpenRouter): projekt/zone/nazwa → `.env` (`GCP_*`). **Nazwy VM — TODO** (wpisać w `config/projects.json` → `deploy.vm`).
- **Lambda AI** (build Ollama/GPU): **deferred** (`config/projects.json` → `platforms.lambda-gpu.status: deferred`). Wrócić gdy GCP VM działa.

## Repo ↔ projekt
- Mapowanie w `config/projects.json` (Linear project → workspace + repo path + deploy target). **Struktura gotowa, wartości VM do uzupełnienia.**

## Uruchamianie
- Launchery: `bin\<agent>.bat`. Każdy ustawia `CLAUDE_CONFIG_DIR=agents\<agent>`.
- UI: rozszerzenie `Desktop/experiments/0_linear` (Next.js, LINEAR+OPENROUTER). UX design v1 w `docs/ui/ux-design.md`. Sonnet refine zablokowany na Anthropic spend limit.

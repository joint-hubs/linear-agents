# ADR-0007: trading_assist architecture — stack reuse, selective migration from stocks-ui, LLM-generated company context, and fundamentals scoring

**Status:** Proposed

**Date:** 2026-08-12 (rev 2, after spec_review loop 1)

## Context

Linear FOC-81 kicks off `trading_assist` — a new, empty repo that evolves the existing
`stocks-ui` project into a personal investment-support platform for Polish stocks (GPW only,
17 companies: 14 portfolio + 3 watchlist). The existing `stocks-ui` repo is a working,
e2e-verified FastAPI + React + pgvector application with 341 passing tests, 2161 news items,
14 208 price sessions, and a set of battle-tested mechanisms (semantic map with UMAP+KMeans,
LLM sentiment classification, source-health auditing, drain-loop pipeline orchestration,
editable query templates, and four Polish news sources built as scraper templates).

Four architectural questions needed answering before decomposition:

1. **Stack**: keep the existing FastAPI + React + pgvector stack, or switch to something
   else (e.g. Next.js, a different DB, a managed backend)?
2. **Migration strategy**: copy the whole `stocks-ui` repo and evolve in place, start from
   scratch, or selectively copy proven mechanisms into a fresh structure?
3. **Company context**: the new "company context" feature (founders, products, clients,
   competitors, suppliers, vendors, partners) has no existing data source. Options: pure
   LLM generation, pure web scraping, manual curation in Second Brain, or LLM grounded by
   a search API + curated notes.
4. **Fundamentals scoring**: the "ocena danych finansowych spółki" dashboard widget was
   initially misread as a pipeline data-quality metric. Mateusz confirmed it means
   **financial fundamentals scoring** (P/E, ROE, debt/EBITDA, margins, revenue — "is the
   company financially healthy"). This requires a new data source and scoring pipeline.

Constraints from GATE 1 (locked by Mateusz):
- Same stack as `stocks-ui` (FastAPI + SQLAlchemy + pgvector/pg16 + React/Vite/Tailwind +
  docker-compose).
- Only a small percentage of existing code is carried over — mostly re-architect, but the
  semantic map + clustering + cluster-summarization mechanism MUST be preserved.
- No brokerage API (ING Makler API sunset, XTB retail API disabled). Portfolio source of
  truth = manually maintained `Dashboard.md` in Second Brain.
- Five Polish news sources: stooq.pl, bankier.pl, biznesradar.pl, stockwatch.pl,
  investing.com (PL). Reddit, MSN Finance, Google Finance, X/Twitter are all out.
- Sentiment scale changed from -1..+1 to **-100..+100** (LLM returns int directly in
  this scale; no multiplication).
- Refresh cadence: every 4 hours in the window 05:00–18:00 Europe/Warsaw.

## Decision

### D1 — Stack: reuse FastAPI + React + pgvector (no change)

Keep the exact stack from `stocks-ui`:
- **Backend**: FastAPI + SQLAlchemy 2.0 + PostgreSQL 16 (pgvector/pgvector:pg16) + httpx +
  tenacity + APScheduler
- **Frontend**: React 18 + Vite 6 + TypeScript + react-query 5 + recharts 3 + Tailwind 3
- **Infra**: docker-compose (db + backend + frontend)
- **LLM**: OpenRouter (Gemini 2.5 Flash) for sentiment/classification/summaries;
  text-embedding-3-small (1536 dims) for embeddings
- **Search**: Tavily (Search + Extract APIs)

Rationale: the stack is proven in production (341 tests, e2e-verified), Mateusz knows it,
and the heavy dependencies (umap-learn, scikit-learn, statsmodels, pgvector) are already
resolved and pinned. Switching would burn the entire migration budget on re-solving
problems that are already solved.

### D2 — Migration: selective copy into a fresh repo (not wholesale, not from-scratch)

New repo `trading_assist` starts empty. We copy specific, proven mechanisms from
`stocks-ui` and re-architect everything else. The canonical list of carried-forward
mechanisms, rebuilt components, and dropped components lives in the spec
(`planning/briefs/spec-foc-81-trading-stocks-ui.md` §1.1–1.3) — that table is the single
source of truth and is not duplicated here to prevent drift.

Key carried-forward mechanisms (summary, not exhaustive): semantic map (UMAP+KMeans+LLM
cluster summaries), embeddings, LLM sentiment with ai_summary in the same batch call,
drain-loop pipeline orchestration, source_health with 7-day retry, APScheduler pattern,
editable query templates, date parsing, text extraction, insights store, forecast (4 models,
on-demand endpoint only), frontend map/charts, pipeline UX.

Key new components: portfolio MD ingest, 5 PL news scrapers, text cleaning pipeline,
TF-IDF classic NLP, company context (LLM+Tavily), Second Brain notes importer, fundamentals
scraper + scoring, dashboard widgets API, news panel API, portfolio page.

Dropped: US-stock scrapers (reddit, stocktwits, secedgar), dead stooq CSV price fetcher,
Google News (poor PL coverage), AddCompany flow.

### D3 — Company context: LLM + Tavily grounded by Second Brain notes

Company context (founders, products, clients, competitors, suppliers, vendors, partners)
is generated by an LLM pipeline:

1. **Grounding**: Second Brain company notes (`companies/*.md`, cleaned markdown) provide
   curated, Mateusz-verified background. These are the primary source.
2. **Search**: Tavily Search API runs 5 perspective queries (founders, products, clients,
   competitors, partners) per company, returning up to 5 results each with content snippets.
3. **Synthesis**: A single LLM call (Gemini 2.5 Flash) receives the Second Brain notes +
   Tavily results and produces a structured JSON output (8 sections) plus a narrative
   summary (`synthesis_md`).
4. **Versioning**: Each generation creates a new row in `company_context` with
   `version = max+1` and `is_current=TRUE` (previous version deactivated atomically).
   `sb_notes_hash` detects when Second Brain notes change and triggers regeneration.
5. **Budget**: ~17k tokens per regeneration (~$0.005); regeneration is rare (on note change
   or manual trigger), so steady-state cost is zero.

### D4 — Fundamentals scoring: biznesradar.pl + bankier.pl scraping with LLM interpretation

The "ocena danych finansowych spółki" widget is a **financial health score** based on
fundamental data, not a pipeline hygiene metric. The pipeline hygiene metrics (has_full_text
%, has_embedding %, etc.) are kept as a separate internal observability table
(`pipeline_health`) that is NOT exposed as a dashboard widget.

Fundamentals pipeline:
1. **Source**: biznesradar.pl (`/raporty-fundamentalne/{ticker}`) provides the best
   structured fundamentals table for GPW equities (P/E, P/BV, ROE, ROA, margins, revenue,
   net profit, debt/EBITDA, dividend yield). bankier.pl profile pages provide supplementary
   indicators.
2. **Scrape**: Once daily (05:00 run), per ticker. New row per day per ticker (snapshot
   history).
3. **LLM scoring**: One call per ticker with raw fundamentals → score 0-100 + score_text
   (1-2 sentence interpretation) + score_components (JSON with per-indicator sub-scores).
   Only when raw data changed (hash comparison) — not daily.
4. **Dashboard widget**: `fundamentals.score` + `fundamentals.score_text` +
   `fundamentals.score_components` + raw indicators. Displayed as a card with score badge
   and expandable detail.

## Consequences

- **Positive:**
  - Semantic map, the most valuable and hardest-to-rebuild mechanism, is preserved intact.
  - The `_drain()` + `source_health` patterns prevent two classes of production bugs that
    cost real debugging time in `stocks-ui`.
  - Fresh repo with Alembic eliminates the manual-ALTER technical debt.
  - Company context is auditable (sources_used, token_usage, tavily_queries_used stored).
  - Fundamentals scoring gives Mateusz a quick "is this company financially healthy" answer
    without reading annual reports.
  - Pipeline hygiene metrics are separated from the fundamentals widget — no conflation.
  - Portfolio data stays in Second Brain (single source of truth); no brokerage API risk.
  - 5 dedicated PL scrapers replace the noisy Google News / Reddit / StockTwits pipeline.
  - LLM budget is bounded (~$18/month steady state) and auditable per-run.
  - Weekend behavior is simple: scheduler runs, price fetch naturally no-ops (no new
    candles), news/context proceed normally.

- **Negative:**
  - Selective copy means some adaptation work per carried module (e.g. sentiment scale
    change, new pipeline steps in refresh_all). This is deliberate — wholesale copy would
    carry over the US-stock dead weight.
  - 5 new HTML scrapers + 2 fundamentals scrapers are fragile by nature (no APIs). Each
    needs a `source_health` pattern and may break on site redesigns. Mitigation: the
    source_health pattern is already proven; each scraper is independent and can be
    disabled via feature flag.
  - Investing.com requires a manual ticker→slug mapping table (17 entries). If Investing
    changes URL structure, the mapping breaks silently until the next refresh.
  - The 4×/day refresh cadence increases LLM spend vs the old nightly-only schedule.
    Accepted as a product decision; budgeted at ~$18/month.
  - Fundamentals scraping depends on biznesradar.pl's HTML structure — a redesign would
    break the parser. Mitigation: feature flag, source_health, and bankier.pl as fallback.

- **Risks:**
  - *Investing.com anti-bot blocking*: if the scraper gets 403s, source_health will mark it
    dead after 4 runs and skip it. It gets a retry after 7 days. If permanently blocked,
    the feature flag `INVESTING_PL_ENABLED=false` disables it cleanly.
  - *Dashboard.md format drift*: if Mateusz changes the Markdown table format, the parser
    breaks. Mitigation: parser validates structure and reports line-number-specific errors;
    previous holdings are preserved on parse failure.
  - *Second Brain path coupling*: the importer reads from a hardcoded path relative to the
    Docker host. If the Second Brain repo moves, the path must be updated in `.env`.
    Documented in ACCESS.md.
  - *Fundamentals LLM scoring bias*: the LLM may systematically over- or under-score certain
    sectors (e.g. banks vs tech). Mitigation: score_components expose the per-indicator
    sub-scores so Mateusz can see why a score was assigned.

## Alternatives Considered

### For D1 (stack):

1. **Next.js + Vercel + managed Postgres** — Rejected: moves away from docker-compose
   (Mateusz's preferred local dev pattern), adds hosting cost, and solves no problem that
   FastAPI + React doesn't already solve. The Vite + FastAPI split is proven.
2. **Django + HTMX** — Rejected: would require rewriting the entire frontend (React
   components, recharts, the semantic map scatter). No benefit for a single-user tool.
3. **SQLite instead of Postgres** — Rejected: pgvector requires Postgres. The map
   mechanism depends on vector similarity queries.

### For D2 (migration):

1. **Copy the whole `stocks-ui` repo and evolve in place** — Rejected: carries over US-stock
   scrapers, the broken stooq CSV fetcher, the Reddit integration, and 12-company seed data
   that doesn't match the new 17-company scope. The "small % copy" decision from GATE 1
   explicitly rejects this.
2. **Start from scratch, no code carried** — Rejected: would lose the e2e-verified semantic
   map, the drain-loop pattern, source_health, and date_parsing — all of which were debugged
   through real production failures. The map alone took a full PRD cycle to get right.
3. **Monorepo with stocks-ui as a package** — Rejected: over-engineering for a single-user
   tool. The two repos have different lifecycles; `stocks-ui` becomes an archive.

### For D3 (company context):

1. **Pure LLM generation (no grounding)** — Rejected: hallucination risk is too high for
   factual company data (founders, clients, competitors). The LLM would invent plausible-
   sounding but wrong facts. Grounding in Second Brain notes + Tavily search results is
   the minimum viable verification.
2. **Pure web scraping (no LLM)** — Rejected: no single source has structured
   founder/client/competitor data for Polish companies. Would require scraping Wikipedia +
   company websites + annual reports, then parsing unstructured HTML into structured data —
   essentially building an LLM pipeline with worse tools.
3. **Manual curation in Second Brain only** — Rejected: Mateusz already curates notes, but
   they don't follow a rigid schema (founders/clients/competitors as separate fields).
   The LLM extracts structure from the notes + fills gaps from web search. Manual curation
   alone would make the dashboard widget empty for companies without detailed notes.
4. **Perplexity API instead of Tavily** — Evaluated but rejected: Perplexity's API returns
   pre-synthesized answers, not raw search results. We need the raw snippets for the LLM
   synthesis step and for `sources_used` auditability. Tavily's `search_depth=advanced`
   with `include_answer=false` gives us the raw material we need.

### For D4 (fundamentals):

1. **Pipeline data-quality metric as the widget** — Rejected by Mateusz: "ocena danych
   finansowych" means financial health (P/E, ROE, etc.), not "how clean is our pipeline
   data". The pipeline hygiene metrics are kept as internal observability only.
2. **Yahoo Finance fundamentals API** — Rejected: `quoteSummary` and `v7/finance/quote`
   return 401 (verified in `stocks-ui`). No free Yahoo fundamentals endpoint exists.
3. **Manual entry of fundamentals** — Rejected: 17 companies × ~10 indicators = 170 data
   points to maintain manually. Scraping + LLM scoring is sustainable; manual entry is not.
4. **Deterministic scoring (no LLM)** — Considered: a rules-based scorer (P/E < 15 = good,
   etc.) is deterministic and free. Rejected because sector context matters (P/E 45 is
   normal for a growth company, alarming for a utility). LLM can apply sector-aware
   judgment. The deterministic approach could be a fallback if LLM cost becomes an issue.

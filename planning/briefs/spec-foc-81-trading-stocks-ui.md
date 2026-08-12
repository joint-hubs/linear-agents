# Spec — FOC-81: TRADING nowa wersja stocks-ui (`trading_assist`)

**Data:** 2026-08-12 (rev 2, po spec_review loop 1)
**Linear:** FOC-81 (epic)
**Brief źródłowy:** `planning/briefs/discovery-foc-81-trading-stocks-ui.md`
**Status:** draft spec — po GATE 1, po spec_review loop 1
**Repo docelowe:** `C:\Users\mateu\Desktop\experiments\trading_assist` (puste)
**Repo źródłowe (baseline):** `Second Brain\Projects\stocks-ui` (e2e-zweryfikowane)

---

## 0. Decyzje produktu z GATE 1 (LOCKED — spec pisany pod nie, nie otwieramy ponownie)

| # | Decyzja | Skutek dla specu |
|---|---------|------------------|
| 1 | Zakres spółek: 14 portfolio + 3 watchlist = **17 spółek** | Tabela `companies` z flagą `kind ∈ {portfolio, watchlist}`; źródło prawdy dla składu portfela = `Dashboard.md` |
| 2 | Brak integracji z ING Makler / XTB API | Portfolio wczytywane z `Dashboard.md` (parsowanie Markdown tabeli pozycji) — `ingest.portfolio_md` |
| 3 | Reddit, MSN Finance, Google Finance, X (Twitter) — OUT | Tylko 5 źródeł PL (stooq/bankier/biznesradar/stockwatch/investing.com) + Second Brain |
| 4 | Stos ten sam co `stocks-ui` | FastAPI + SQLAlchemy 2 + pgvector/pg16 + React 18 + Vite 6 + Tailwind 3 + docker-compose; nowe repo = czysta struktura, ale kod kopiowany wybiórczo |
| 5 | Mechanizmy, które MUSZĄ zostać przeniesione wprost | mapa semantyczna (UMAP→2D + KMeans + LLM podsumowania klastrów), LLM sentiment score, wzorzec `source_health` z `RETRY_AFTER_DAYS=7`, wzorzec `_drain()` z `MAX_DRAIN_PASSES=20`, `refresh_all` jako jeden PipelineRun, edytowalne `query_templates`, polskie źródła (`tavily_pl`, `rss_pl`, `ir`, `stockwatch_forum`) jako szablony scraperów |
| 6 | Ścieżka cenowa | Yahoo Finance (działa, bez klucza); stooq CSV auto-fetch **OUT** (już zablokowany JS-challenge w `stocks-ui`); używamy stooq **wyłącznie jako źródła newsów** (HTML news-list page, nie CSV) |
| 7 | Sentyment: skala **-100 do +100** (nie -1..+1) | `News.sentiment_score` i `SentimentSummary.score` w skali int -100..+100; LLM prompt zwraca int w tej skali; UI badge z kolorem |
| 8 | `{n}` dni: dropdown z **{1, 3, 7, 30, 90, 180, 360, 720}** | Endpoint `/companies/{ticker}/avg-price?days=N` oraz `/forecast?days=N` walidują whitelist |
| 9 | Klasyczne NLP obok LLM: **TF-IDF** potwierdzone | Nowy pipeline step `nlp_classic` (TF-IDF keywords/topic) równolegle do LLM sentiment — wyniki jako osobne kolumny; LLM nie jest zastępowany |
| 10 | "Oczyszczony tekst" = pipeline `raw_text → cleaned_text` | Strip HTML, strip markdown, usuń boilerplate (cookie-bars, social-media embeds), usuń base64/data-URI, usuń inline images, normalizacja whitespace; kolumny `raw_text` + `cleaned_text` osobno |
| 11 | "Company context" (founders/products/clients/competitors/suppliers/vendors/partners) | Nowa encja `company_context`, generowana przez LLM+Tavily na podstawie Second Brain notes; wersjonowana, cache'owana, przycisk "Regeneruj" |
| 12 | Odświeżanie co 4h w oknie 05:00–18:00 Europe/Warsaw | APScheduler 4 crony: **05:00, 09:00, 13:00, 17:00**; weekend (Sat/Sun) = tylko newsy + kontekst (bez cen; GPW zamknięte, brak nowych świec); dni świąteczne GPW obsługiwane przez naturalne "no new candle" z Yahoo |
| 13 | 11 widgetów dashboard + 9 pól news panel | Sekcje 6.1 i 6.2 poniżej — wszystkie wymagane |
| 14 | **"Ocena danych finansowych spółki" = scoring fundamentalny** (P/E, ROE, dług/EBITDA, marże, przychody) — NIE metryka jakości pipeline'u | Nowa encja `fundamentals` + pipeline step `fundamentals`; źródło: biznesradar.pl (najlepsze pokrycie fundamentalne dla GPW) + bankier.pl (uzupełniająco); LLM interpretacja wyniku |

---

## 0.1 Kanoniczna tabela 17 spółek

| Dashboard.md | Yahoo ticker | kind | investing.com slug | Second Brain note |
|---|---|---|---|---|
| PZU | PZU.WA | portfolio | pzu | `companies/20260804_analiza_spolki_pzu_doglebna.md` |
| RAINBOW | RBW.WA | portfolio | rainbow-tours | `companies/20260804_analiza_spolki_rainbow_doglebna.md` |
| DINOPL | DNP.WA | portfolio | dino-polska | `companies/20260804_analiza_spolki_dino_doglebna.md` |
| PKNORLEN | PKN.WA | portfolio | pkn-orlen | `companies/20260804_analiza_spolki_orlen_doglebna.md` |
| ALLEGRO | ALE.WA | portfolio | allegro.eu | `companies/20260804_analiza_spolki_allegro_doglebna.md` |
| ZABKA | ZAB.WA | portfolio | zabka-group | `companies/20260804_analiza_spolki_zabka_doglebna.md` |
| CYBERFLKS | CBF.WA | portfolio | cyberfolks | `companies/20260804_analiza_spolki_cyberfolks_doglebna.md` |
| PEKAO | PEO.WA | portfolio | bank-pekao | `companies/20260804_analiza_spolki_pekao_doglebna.md` |
| ASSECOPOL | ACP.WA | portfolio | asseco-poland | `companies/20260804_analiza_spolki_asseco_doglebna.md` |
| PASSUS | PAS.WA | portfolio | passus | `companies/20260804_analiza_spolki_passus_doglebna.md` |
| KRUK | KRU.WA | portfolio | kruk-sa | `companies/20260804_analiza_spolki_kruk_doglebna.md` |
| CDPROJEKT | CDR.WA | portfolio | cd-projekt | `companies/20260804_analiza_spolki_cdprojekt_doglebna.md` |
| PKOBP | PKO.WA | portfolio | pko-bp | `companies/20260804_analiza_spolki_pkobp_doglebna.md` |
| ORANGEPL | OPL.WA | portfolio | orange-polska | `companies/20260804_analiza_spolki_orange_doglebna.md` |
| KETY | KTY.WA | watchlist | grupa-kety | `companies/20260804_analiza_spolki_kety_doglebna.md` |
| KGHM | KGH.WA | watchlist | kghm | `companies/20260804_analiza_spolki_kghm_doglebna.md` |
| XTB | XTB.WA | watchlist | xtb | `companies/20260804_analiza_spolki_xtb_doglebna.md` |

Ta tabela jest **jedynym źródłem prawdy** dla seed danych — decompose pisze z niej seed skrypt.

---

## 1. Architektura — co przenosimy, co piszemy od nowa

### 1.1 Przenoszone z `stocks-ui` (kod kopiowany i adaptowany, nie przepisywany)

Wszystko poniżej ma działający, e2e-zweryfikowany kod w `stocks-ui/backend/app/` — kopiujemy pliki i adaptujemy do nowego modelu danych:

| Mechanizm | Pliki źródłowe w `stocks-ui` | Adaptacja w `trading_assist` |
|---|---|---|
| **Mapa semantyczna** (UMAP→2D + KMeans + LLM podsumowania klastrów) | `services/news_map.py`, `services/map_insights.py`, `models/news_map.py`, `routers/map.py` | kopiowane 1:1, dodajemy `NewsMapPoint.scope = "company:{ticker}"` lub `"global"` |
| **Embeddings** | `services/embeddings.py` (OpenRouter text-embedding-3-small, 1536 wym.) | kopiowane 1:1; nowy pipeline step `embed` (sekcja 3.3) |
| **LLM sentiment + klasyfikacja** | `services/sentiment.py` (score_pending_news, batch 10, per-ticker) | kopiowane; **skala zmieniona -1..+1 → -100..+100** (LLM zwraca int w skali -100..+100, brak mnożnika); ai_summary generowane w tym samym wywołaniu LLM (8 pole w JSON) |
| **Pipeline orchestration** | `services/refresh_all.py` (jeden PipelineRun, `_drain()`, MAX_DRAIN_PASSES=20) | kopiowane; dodajemy kroki `embed`, `clean`, `nlp_classic`, `fundamentals`, `company_context` |
| **Source health** | `services/source_health.py` (MIN_RUNS_TO_JUDGE=4, RETRY_AFTER_DAYS=7) | kopiowane 1:1 — wzorzec potwierdzony w produkcji |
| **Scheduler** | `services/scheduler.py` (APScheduler, flaga `scheduler_enabled`) | kopiowane; cron 4×/dzień + 2 dodatkowe (portfolio 07:00, second_brain 07:05) |
| **Ticker lookup, market locale** | `services/ticker_lookup.py`, `services/market_locale.py` | kopiowane; dodajemy mapowanie Dashboard.md → Yahoo ticker (sekcja 0.1) |
| **Editable query templates** | `services/query_templates.py`, `models/query_template.py`, `services/company_queries.py` | kopiowane; seed z polskimi perspektywami |
| **Polskie źródła (szablony)** | `scrapers/tavily_pl.py`, `scrapers/rss_pl.py`, `scrapers/ir.py`, `scrapers/stockwatch_forum.py` | kopiowane jako **wzorzec**; nowe scrapery dla bankier/biznesradar/stockwatch/investing.com budowane na tym samym szkielecie |
| **Data pipelines** | `services/date_parsing.py` (RFC 2822 → ISO, `_plausible_article_date`), `services/extraction.py` (Tavily Extract batch 20, 8000 char cap) | kopiowane; dodajemy krok `clean_text` po ekstrakcji |
| **Insights store** | `services/insights_store.py`, `models/insight.py` | kopiowane — wzorzec historii zapisów (`category_summaries`, `interpretations`) |
| **Prognoza cenowa** (4 modele: naiwna/dryf/ETS/ARIMA) | `services/forecast.py` | kopiowane 1:1; endpoint on-demand (NIE pipeline step) |
| **Frontend map & charts** | `frontend/src/pages/Map.tsx` (scatter + rectangle select), `frontend/src/components/charts/*` | kopiowane; adaptacja do nowego layoutu dashboardu |
| **Pipeline UX** | `frontend/src/pages/Pipeline.tsx`, `frontend/src/hooks/useRefreshAllSources.ts` | kopiowane; dodajemy nowe źródła do listy |

### 1.2 Pisane od nowa (nie istnieje w `stocks-ui`)

| Komponent | Lokalizacja w `trading_assist` | Cel |
|---|---|---|
| **Portfolio MD ingest** | `backend/app/ingest/portfolio_md.py` | Parsowanie `Dashboard.md` (Markdown tabela pozycji) → tabela `holdings`; cron 07:00 + ręczny trigger |
| **5 PL news scrapers** | `backend/app/scrapers/{stooq_news, bankier, biznesradar, stockwatch, investing_pl}.py` | HTML scraping z per-ticker URL templates (sekcja 3.1); **stooq używa strony news-list, NIE CSV** |
| **Text cleaning pipeline** | `backend/app/services/text_cleaning.py` | `raw_text → cleaned_text`: strip HTML/markdown/boilerplate/data-URI/base64, normalizacja whitespace, smart truncate do 8000 chars |
| **TF-IDF classic NLP** | `backend/app/services/nlp_classic.py` | `sklearn.feature_extraction.text.TfidfVectorizer` per ticker; kolumny `News.tfidf_keywords`, `News.tfidf_topic` |
| **Company context (LLM+Tavily)** | `backend/app/services/company_context.py` | Tavily Search (5 perspektyw) → synteza przez LLM → encja `company_context` z wersjonowaniem |
| **Second Brain notes importer** | `backend/app/ingest/second_brain.py` | Cron 07:05 → parsowanie `companies/*.md` → tabela `company_notes`; źródło groundingu dla company_context |
| **Fundamentals scraper + scoring** | `backend/app/scrapers/biznesradar_fundamentals.py`, `backend/app/services/fundamentals.py` | Scraping tabel fundamentalnych z biznesradar.pl + bankier.pl → LLM scoring → `fundamentals` entity |
| **Dashboard widgets API** | `backend/app/routers/dashboard.py` | Jeden agregujący endpoint `/api/dashboard/{ticker}` zwracający wszystkie 11 widgetów (sekcja 6.1) |
| **News panel API** | `backend/app/routers/news_panel.py` | `/api/companies/{ticker}/news-panel` zwracający 9 pól (sekcja 6.2) |
| **Portfolio strona** | `frontend/src/pages/Portfolio.tsx` | Tabela pozycji (z `holdings`) z aktualnym kursem × liczba akcji, P/L, % portfela; import przycisk "Reimport Dashboard.md" |

### 1.3 Odrzucane z `stocks-ui` (nie przenosimy)

- Scrapers: `reddit.py`, `stocktwits.py`, `secedgar.py` (brak polskich spółek), `stooq.py` CSV price fetcher (martwy), `googlenews.py` (słabe pokrycie PL — zastąpione dedykowanymi PL źródłami)
- `routers/companies.py` z AddCompany flow — zastąpione statyczną listą 17 spółek + import z Dashboard.md

---

## 2. Model danych

### 2.1 Encje przenoszone (schemat z `stocks-ui`, ewentualnie rozszerzone)

```
companies               (z stocks-ui, rozszerzone)
  ticker          PK  VARCHAR(20)      -- "DNP.WA" (format Yahoo dla GPW)
  name                VARCHAR(200)
  ir_url              VARCHAR(500) NULL
  kind                VARCHAR(10)       -- NEW: 'portfolio' | 'watchlist'
  sb_note_path        VARCHAR(500) NULL -- NEW: ścieżka do Second Brain/companies/*.md (relatywna)
  sb_note_hash        VARCHAR(64)  NULL -- NEW: SHA256 notatki — wyzwalacz regeneracji kontekstu
  created_at          TIMESTAMP DEFAULT now()

news                    (z stocks-ui, rozszerzone)
  ... (wszystkie kolumny z stocks-ui)
  sentiment_score       INTEGER NULL    -- CHANGED: było Float -1..+1, teraz INT -100..+100
  ai_summary            TEXT NULL       -- CARRIED: jednozdaniowe streszczenie LLM (było w stocks-ui, teraz generowane w tym samym batch co sentiment)
  raw_text              TEXT NULL       -- NEW: surowy HTML/markdown z źródła
  cleaned_text          TEXT NULL       -- NEW: po text_cleaning.py
  tfidf_keywords        JSON NULL       -- NEW: [{term, score}, ...] top-20 TF-IDF
  tfidf_topic           VARCHAR(50) NULL -- NEW: kategoria z TF-IDF (osobna od LLM topic)
  similar_news_ids      JSON NULL       -- NEW: [{news_id, cosine_sim}, ...] top-5 podobne (z pgvector)

holdings                (NOWA)
  id              PK  SERIAL
  ticker          FK  VARCHAR(20) → companies.ticker
  shares              INTEGER NOT NULL
  avg_buy_price       NUMERIC(10,4) NOT NULL  -- PLN
  cost_basis_pln      NUMERIC(12,2) NOT NULL
  source_hash         VARCHAR(64)  -- SHA256 sekcji "Pozycje" z Dashboard.md — wykrywa zmianę
  imported_at         TIMESTAMP DEFAULT now()
  -- UWAGA: current_value_pln, pnl_pln, pnl_pct NIE są przechowywane — wyliczane
  -- w locie przez API (holdings.shares × latest_price.close). Źródło prawdy
  -- dla ceny = tabela prices, nie holdings.

company_notes           (NOWA — Second Brain import)
  id              PK  SERIAL
  ticker          FK  VARCHAR(20) → companies.ticker
  note_path           VARCHAR(500) NOT NULL
  title               VARCHAR(300)
  content_md          TEXT                  -- surowy markdown
  content_cleaned     TEXT                  -- po text_cleaning (bez wikilinków, obrazków, YAML frontmatter)
  content_hash        VARCHAR(64)           -- SHA256(content_md)
  note_date           DATE                  -- parsowane z nazwy pliku (YYYYMMDD prefix)
  imported_at         TIMESTAMP DEFAULT now()

company_context         (NOWA — wygenerowany kontekst spółki)
  id              PK  SERIAL
  ticker          FK  VARCHAR(20) → companies.ticker
  version             INTEGER NOT NULL
  is_current          BOOLEAN DEFAULT TRUE
  founders            JSONB   -- [{name, role, since, source_url}, ...]
  products            JSONB   -- [{name, description, revenue_share_pct}, ...]
  services            JSONB   -- jak products, dla spółek usługowych
  clients             JSONB   -- [{name, type, since}, ...]
  competitors         JSONB   -- [{name, ticker, market_share_note}, ...]
  suppliers           JSONB   -- [{name, category}, ...]
  vendors             JSONB   -- [{name, category}, ...]
  partners            JSONB   -- [{name, type, since}, ...]
  synthesis_md        TEXT
  sources_used        JSONB
  sb_notes_hash       VARCHAR(64)
  tavily_queries_used JSONB
  token_usage         JSONB
  generated_at        TIMESTAMP DEFAULT now()
  generated_by        VARCHAR(50) DEFAULT 'pipeline'

fundamentals            (NOWA — scoring fundamentalny spółki)
  id              PK  SERIAL
  ticker          FK  VARCHAR(20) → companies.ticker
  -- Surowe dane ze scrapingu (biznesradar.pl / bankier.pl)
  pe_ratio            NUMERIC(10,2) NULL   -- P/E (C/Z)
  pbv_ratio           NUMERIC(10,2) NULL   -- P/BV (C/WK)
  roe_pct             NUMERIC(6,2) NULL    -- ROE %
  roa_pct             NUMERIC(6,2) NULL    -- ROA %
  debt_ebitda         NUMERIC(8,2) NULL    -- Dług/EBITDA
  gross_margin_pct    NUMERIC(6,2) NULL    -- Marża brutto %
  net_margin_pct      NUMERIC(6,2) NULL    -- Marża netto %
  revenue_mln         NUMERIC(12,2) NULL   -- Przychody (mln PLN)
  net_profit_mln      NUMERIC(12,2) NULL   -- Zysk netto (mln PLN)
  dividend_yield_pct  NUMERIC(6,2) NULL    -- Stopa dywidendy %
  -- Scoring LLM
  score               INTEGER NULL          -- 0-100, wyliczony przez LLM
  score_text          TEXT NULL             -- LLM interpretacja (1-2 zdania)
  score_components    JSONB NULL            -- {pe_score, roe_score, debt_score, margin_score, growth_score}
  source_url          VARCHAR(500) NULL     -- skąd pobrane
  fetched_at          TIMESTAMP DEFAULT now()
  computed_at         TIMESTAMP NULL        -- kiedy LLM policzył score

pipeline_health         (NOWA — metryki jakości pipeline'u, NIE widget)
  id              PK  SERIAL
  ticker          FK  VARCHAR(20) → companies.ticker
  has_full_text_pct   NUMERIC(5,1)
  has_date_source_pct NUMERIC(5,1)
  has_embedding_pct   NUMERIC(5,1)
  relevant_pct        NUMERIC(5,1)
  news_count_30d      INTEGER
  last_refresh_age_h  NUMERIC(5,1)
  computed_at         TIMESTAMP DEFAULT now()
  -- To jest wewnętrzna tabela observability, NIE jest wystawiana na dashboard
  -- jako widget "ocena danych finansowych". Patrz ADR-0007 D4.
```

### 2.2 Indeksowanie i constraint

- `news.url` UNIQUE (jak w `stocks-ui`)
- `news(ticker, published_at DESC)` INDEX (jak w `stocks-ui`)
- `company_context(ticker, version DESC)` INDEX; UNIQUE(ticker, is_current) WHERE is_current = TRUE (partial)
- `holdings(ticker)` UNIQUE — jedna pozycja per ticker (zgodne z Dashboard.md)
- `company_notes(ticker, note_path)` UNIQUE
- `fundamentals(ticker, fetched_at DESC)` INDEX — historia snapshotów

### 2.3 Migracja z `stocks-ui` (czy kopiujemy dane?)

**Nie kopiujemy bazy.** `trading_assist` startuje z pustą bazą; 17 spółek jest seed'owanych z tabeli w sekcji 0.1. Historia cen — backfill 5 lat z Yahoo (jednorazowy skrypt, ~17 × 1250 = 21k wierszy). Historia newsów — budowana od nowa z 5 PL źródeł.

**Alembic:** wprowadzamy od razu (w `stocks-ui` było to długiem technicznym — każdy ALTER robiony ręcznie na żywej bazie). Nowe repo = okazja do zrobienia tego dobrze od dnia 0.

---

## 3. Pipeline ingestion

### 3.1 Sources — 5 PL news źródeł (per-ticker URL templates)

| Źródło | URL template (per ticker) | Format tickera | Mechanika | Uwagi |
|---|---|---|---|---|
| **stooq.pl** | `https://stooq.pl/q/n/?s={ticker_lower}` | `cdr` (lowercase, bez `.WA`) | HTML scraping listy newsów | **NIE CSV** (`stooq.com/q/d/l/` jest zablokowane JS-challenge); tylko lista newsów z data + tytuł + link |
| **bankier.pl** | `https://www.bankier.pl/gielda/{ticker_gpw},profile.html` → sekcja "Wiadomości" | `CDR` (uppercase GPW) | HTML scraping profile page | może wymagać obsługi paginacji |
| **biznesradar.pl** | `https://www.biznesradar.pl/wiadomosci/{ticker_gpw}` | `CDR` | HTML scraping | czysta lista z datami |
| **stockwatch.pl** | `https://www.stockwatch.pl/gpw/{ticker_lower}/wiadomosci.aspx` | `cdr` | HTML scraping | ASP.NET — może wymagać obsługi `__VIEWSTATE` jeśli paginacja |
| **investing.com (PL)** | `https://pl.investing.com/equities/{slug}` | slug per ticker (np. `cd-projekt`) | HTML scraping | **wymaga ręcznej mapy** ticker→slug (sekcja 0.1); Investing.com ma antybot — używać realnego User-Agent + retry z backoff |

### 3.1b Fundamentals źródła (dla widgetu "ocena danych finansowych")

Widget "ocena danych finansowych spółki" wymaga **fundamentalnych danych finansowych** (P/E, ROE, dług/EBITDA, marże, przychody). Źródła:

| Źródło | URL template | Co daje | Uwagi |
|---|---|---|---|
| **biznesradar.pl** | `https://www.biznesradar.pl/raporty-fundamentalne/{ticker_gpw}` | P/E, P/BV, ROE, ROA, marże, przychody, zysk netto, dług/EBITDA, dywidenda | **Najlepsze pokrycie** — tabela fundamentalna per spółka GPW, czysty HTML |
| **bankier.pl** | `https://www.bankier.pl/gielda/{ticker_gpw},profile.html` → sekcja "Wskaźniki" | P/E, P/BV, ROE, marże, dywidenda | Uzupełniające — część danych dostępna na stronie profilu |

**Pipeline step `fundamentals`:**
1. Scrape biznesradar.pl fundamental table per ticker (raz dziennie, w przebiegu 05:00)
2. Scrape bankier.pl wskaźniki (uzupełniająco, jeśli biznesradar brakuje pól)
3. Upsert do `fundamentals` (nowy wiersz per dzień per ticker — historia snapshotów)
4. LLM scoring: jedno wywołanie per ticker z surowymi danymi → score 0-100 + score_text (1-2 zdania interpretacji) + score_components (JSON z wagami per wskaźnik)
5. LLM scoring tylko gdy surowe dane się zmieniły (hash porównanie) — nie codziennie

### 3.2 Scraper skeleton (wzorzec wspólny)

Każdy z 5 scraperów implementuje ten sam interfejs (wzorzec z `stocks-ui/scrapers/base.py`):

```python
async def fetch_<source>_news(db: Session, company: Company) -> int:
    """Fetch news list for company from <source>. Returns count of new rows."""
```

Wszystkie dzielą wspólne helpery:
- `app/services/date_parsing.py` — parsowanie polskich dat słownych, RFC 2822, ISO
- `app/services/http_client.py` — `httpx.AsyncClient` z retry (tenacity), realnym UA, timeout 30s
- `app/services/scraper_dedup.py` — `seen_urls` w locie + SELECT po URL (wzorzec z `stocks-ui`)

### 3.3 Pipeline steps (kolejność)

Kolejność jest istotna — każdy krok zależy od poprzedniego:

```
1.  fetch_prices       (Yahoo; per ticker; inteligentny zakres 5d/1mo/1y/5y)
2.  fetch_news         (5 PL źródeł, równolegle; pomijane martwe źródła via source_health)
3.  extract            (Tavily Extract batch 20 → raw_text; limit 50/pass, drain loop)
4.  clean              (text_cleaning.py: raw_text → cleaned_text; bez LLM; deterministyczne)
5.  embed              (OpenRouter embeddings; lazy backfill do 200/pass; drain loop)
6.  sentiment          (LLM OpenRouter; batch 10 per ticker; score -100..+100 + topic + relevant + ai_summary)
7.  nlp_classic        (TF-IDF na cleaned_text; keywords + topic; bez LLM; deterministyczne)
8.  aggregate          (sentiment_summary daily/weekly/quarterly)
9.  insights           (category_summaries + interpretations; tylko gdy nowe newsy)
10. map                (UMAP + KMeans + LLM cluster summaries; tylko gdy nowe newsy w scope)
11. fundamentals       (scrape biznesradar + bankier → LLM scoring; raz dziennie w przebiegu 05:00)
12. company_context    (LLM+Tavily; tylko gdy sb_notes_hash zmienił się LUB brak wersji aktualnej)
```

**Uwaga:** Prognoza cenowa (`forecast`) NIE jest pipeline step — jest endpointem on-demand (`GET /forecast?days=N`), liczonym w momencie wywołania API. To celowe: prognoza jest deterministyczna i szybka (~0.11s ARIMA), nie ma sensu jej prekomputować.

**ai_summary:** generowane w kroku `sentiment` (6) — LLM w tym samym batch call co sentiment score zwraca dodatkowe pole `ai_summary` (jedno zdanie). To eliminuje osobny krok i osobne wywołanie LLM. Koszt jest wliczony w budżet sentiment.

**Embeddings:** krok `embed` (5) odpala `ensure_embeddings` z `stocks-ui` — lazy backfill do 200 newsów na przebieg, drain loop do MAX_DRAIN_PASSES=20. Pending queue = `News.embedding IS NULL`. Embedding jest wymagany przez: mapę (krok 10), similar_news_ids (wyliczane w kroku 10), i nlp_classic (krok 7 — TF-IDF nie wymaga embeddingu, ale similar_news_ids tak).

### 3.4 Scheduler — 6 jobów dziennie

```python
# app/services/scheduler.py
# --- Główne przebiegi pipeline'u (4×/dzień) ---
CronTrigger(hour=5,  minute=0, timezone="Europe/Warsaw")   # refresh_all: pełny pipeline
CronTrigger(hour=9,  minute=0, timezone="Europe/Warsaw")   # refresh_all
CronTrigger(hour=13, minute=0, timezone="Europe/Warsaw")   # refresh_all
CronTrigger(hour=17, minute=0, timezone="Europe/Warsaw")   # refresh_all

# --- Ingest (codziennie rano, przed pierwszym refresh_all) ---
CronTrigger(hour=7,  minute=0, timezone="Europe/Warsaw")   # portfolio_md: parsowanie Dashboard.md → holdings
CronTrigger(hour=7,  minute=5, timezone="Europe/Warsaw")   # second_brain: import companies/*.md → company_notes
```

**Uzasadnienie wyboru 05/09/13/17:** okno 05:00–18:00 podzielone na 4 równe sloty co 4h. 05:00 łapie newsy nocne i przygotowuje dane przed otwarciem; 09:00 łapie pre-market i otwarcie; 13:00 łapie środek sesji; 17:00 łapie zamknięcie i komunikaty po sesji.

**Ingest jobs (07:00, 07:05):** portfolio_md i second_brain to ingest joby, nie pipeline steps — działają raz dziennie, przed pierwszym pełnym refreshem. 07:00 bo Mateusz zwykle aktualizuje Dashboard.md wieczorem lub rano; 07:05 żeby portfolio_md zdążył zapisać holdings zanim second_brain zacznie (second_brain nie zależy od holdings, ale porządek jest czytelny).

**Weekendy (Sat/Sun):** scheduler działa, ale:
- `fetch_prices` — pomijany (brak nowych świec; Yahoo zwróci ostatnią sesję, dedup po dacie odrzuci)
- `fetch_news` — działa normalnie (newsy weekendowe istnieją)
- `fundamentals` — pomijany (dane fundamentalne nie zmieniają się w weekend)
- `company_context` — działa normalnie
- Ingest joby (07:00, 07:05) — działają normalnie (Dashboard.md i SB notes mogą być edytowane w weekend)
- **Efekt:** weekendowe przebiegi są ~30% tańsze (brak cen, mniej newsów), ale nie pomijamy ich całkowicie.

**Święta GPW** — nie ma osobnej listy; Yahoo po prostu nie zwróci nowej świecy, dedup ją odrzuci.

### 3.5 LLM token budget — steady state vs regen day

**Steady state** (typowy dzień, bez regeneracji company_context, bez zmian fundamentalnych):

| Krok | Model | Szacunek tokenów/dzień | Koszt/dzień (Gemini 2.5 Flash) |
|---|---|---|---|
| extract (Tavily Extract) | Tavily API | 200 newsy × $0.001/call | ~$0.20 |
| sentiment + ai_summary | gemini-2.5-flash | 200 newsy × 300 tok input + 150 output = 90k | ~$0.03 |
| embed | text-embedding-3-small | 200 newsy × 500 tok = 100k | ~$0.01 |
| insights (category summaries) | gemini-2.5-flash | 17 spółek × 10 kategorii × 2k input = 340k | ~$0.10 |
| map cluster summaries | gemini-2.5-flash | 17 scope × 8 klastrów × 3k input = 408k | ~$0.12 |
| fundamentals (LLM scoring) | gemini-2.5-flash | 17 × 2k input = 34k (tylko gdy dane się zmieniły, ~2×/tydzień) | ~$0.005 (amortyzowane) |
| **Steady state RAZEM** | | ~970k tokenów/dzień | **~$0.47/dzień (~$14/miesiąc)** |

Tavily Search API (steady state): 0 queries/dzień (company_context nie regeneruje się codziennie).

**Regen day** (dzień, w którym company_context regeneruje się dla wszystkich 17 spółek — np. po weekendowym update Second Brain):

| Dodatkowy koszt | Szacunek |
|---|---|
| company_context LLM | 17 × 17k tokenów = 289k → ~$0.09 |
| company_context Tavily Search | 17 × 5 queries × $0.005 = $0.43 |
| **Regen day total** | **~$0.99 (steady $0.47 + regen $0.52)** |

**Miesięczny budżet:** ~$14 (steady) + ~$4 (4 regen days/miesiąc) = **~$18/miesiąc**. Nawet przy codziennym regen wszystkich 17 spółek: ~$30/miesiąc. Akceptowalne dla personal tool.

---

## 4. Company Context — architektura (LLM + Tavily grounded by Second Brain)

### 4.1 Flow

```
Trigger: pipeline step "company_context" (per ticker)
  ↓
1. Sprawdź czy regeneracja potrzebna:
   - Brak wersji aktualnej → TAK
   - sb_notes_hash != company_context.sb_notes_hash → TAK (notatki się zmieniły)
   - Ręczny trigger z UI → TAK
   - Inaczej → SKIP (tanie)
  ↓
2. Zbierz grounding:
   - company_notes (Second Brain) dla tickera → content_cleaned (do 8000 chars)
   - Ostatnie 10 newsów z ai_summary (kontekst bieżący)
  ↓
3. Tavily Search — 5 perspektyw (sekwencyjnie, topic="general", search_depth="advanced"):
   - "{company_name} founders zarząd założyciele historia"
   - "{company_name} products services portfolio oferta"
   - "{company_name} clients customers klienci odbiorcy"
   - "{company_name} competitors konkurencja rynek"
   - "{company_name} suppliers partners vendors dostawcy partnerzy"
   Każde query → max 5 wyników → content (do 2000 chars/wynik)
  ↓
4. LLM synteza (jedno wywołanie, gemini-2.5-flash):
   System prompt: struktura JSON (founders/products/services/clients/competitors/suppliers/vendors/partners)
   User prompt: notatki SB + wyniki Tavily (5 × 5 × 2000 = ~50k chars max, truncate do 32k tokenów)
   Output: JSON + synthesis_md (narrative 200-400 słów)
  ↓
5. Zapisz nową wersję:
   - UPDATE company_context SET is_current=FALSE WHERE ticker=X AND is_current=TRUE
   - INSERT nowa wersja (version = max(version)+1, is_current=TRUE)
   - Zapisz token_usage, tavily_queries_used, sources_used
```

### 4.2 Token/context budget

| Element | Rozmiar |
|---|---|
| Second Brain notes (cleaned) | ~4000-8000 chars (~1-2k tokenów) |
| 5 Tavily queries × 5 wyników × 2000 chars | ~50k chars (~12k tokenów) |
| System prompt + instrukcja JSON | ~1k tokenów |
| **Total input** | **~15k tokenów** |
| Output (JSON + synthesis) | ~2k tokenów |
| **Total per regeneracja** | **~17k tokenów (~$0.005)** |

Regeneracja jest **rzadka** — tylko gdy: (a) notatki SB się zmieniły, (b) ręczny trigger, (c) brak wersji. W steady state (brak zmian w SB) koszt = 0.

### 4.3 Surfacing na dashboardzie

Widget "Company Context" pokazuje:
- **8 tabs:** Founders | Products | Services | Clients | Competitors | Suppliers | Vendors | Partners
- **+ 1 tab:** Synthesis (narrative markdown)
- Każdy tab: lista kart z nazwą, opisem, source_url (link)
- Footer: "Wygenerowano {date} (v{version}) | {token_usage} tokenów | [Regeneruj]"

**Uwaga:** schema ma 8 sekcji JSON (founders, products, services, clients, competitors, suppliers, vendors, partners) + synthesis_md. Wszystkie 8 sekcji mają swój tab. Jeśli sekcja jest pusta ([]), tab pokazuje "Brak danych".

---

## 5. Text cleaning pipeline

### 5.1 Definicja "oczyszczonego tekstu"

`raw_text` (z Tavily Extract lub HTML scraping) → `cleaned_text`:

```
1. Strip HTML tags (BeautifulSoup get_text())
2. Strip markdown syntax (regex: images ![...](...), links [...](...), bold/italic **__*, headers #)
3. Remove base64 data URIs (regex: data:[^;]+;base64,[A-Za-z0-9+/=]+)
4. Remove inline image URLs
5. Remove cookie-bar boilerplate (common PL phrases: "Ta strona używa cookies", "Akceptuję", etc.)
6. Remove social-media embeds (Twitter/FB/IG iframe text)
7. Remove navigation boilerplate ("Strona główna > Wiadomości > ...")
8. Normalize whitespace (multiple spaces/newlines → single)
9. Normalize Polish characters (NFC unicode)
10. Smart truncate to 8000 chars (cut at sentence boundary)
```

Implementacja: `app/services/text_cleaning.py::clean_text(raw: str) -> str` — czysta funkcja, bez I/O, w pełni testowalna jednostkowo.

### 5.2 Kiedy cleaning się odpala

Pipeline step `clean` po `extract`:
- Wszystkie newsy gdzie `raw_text IS NOT NULL AND cleaned_text IS NULL`
- Limit 100/pass (deterministyczne, szybkie — nie potrzebuje drain loop jak extract/sentiment)

---

## 6. API surface

### 6.1 Dashboard widgets — `GET /api/dashboard/{ticker}?days={n}`

Jeden endpoint agregujący wszystkie 11 widgetów. `{n}` walidowane przeciwko whitelist `{1, 3, 7, 30, 90, 180, 360, 720}` (default 30).

Response:
```json
{
  "ticker": "CDR.WA",
  "days": 30,
  "company_name": "CD Projekt S.A.",
  "company_context": { /* z company_context, is_current=TRUE; 8 sekcji + synthesis_md */ },
  "fundamentals": {
    "score": 72,
    "score_text": "CD Projekt: silna marżowość i brak zadłużenia, ale wysoka wycena (P/E ~45) i niepewność co do harmonogramu premier.",
    "score_components": { "pe_score": 40, "roe_score": 85, "debt_score": 95, "margin_score": 80, "growth_score": 60 },
    "pe_ratio": 45.2, "roe_pct": 18.5, "debt_ebitda": 0.1, "net_margin_pct": 28.3, "revenue_mln": 1205.0,
    "fetched_at": "2026-08-12T05:00:12Z"
  },
  "portfolio_holding": { "shares": 3, "avg_buy_price": 262.83, "current_value_pln": 757.50, "pnl_pln": -31.00, "pnl_pct": -3.93 },
  "current_price": { "close": 252.50, "date": "2026-08-12", "change_1d_pct": 1.2 },
  "avg_price_nd": { "avg": 248.30, "days": 30 },
  "technical_indicators": { "rsi_14": 55.2, "macd": {"macd": 1.2, "signal": 0.8, "histogram": 0.4}, "sma_20": 250.1, "sma_50": 245.8, "bollinger": {"upper": 260, "mid": 250, "lower": 240}, "atr_14": 5.2, "volume_ratio": 1.3, "position_52w_pct": 62 },
  "forecast_nd": { "naive": 252.5, "drift": 255.1, "ets": 253.8, "arima": 254.2, "arima_lower": 240.1, "arima_upper": 268.3, "days": 30 },
  "sentiment_of_day": { "text": "Neutralny dzień z lekką przewagą pozytywnych doniesień o Gamescom.", "score": 15, "news_count": 3 },
  "sentiment_by_category": [ { "topic": "product", "text": "...", "score": 25, "news_count": 2 } ],
  "sentiment_of_week": { "text": "Tydzień: sentyment +8, 12 newsów, dominujący temat: product (5 newsów).", "score": 8, "news_count": 12 },
  "sentiment_of_quarter": { "text": "Kwartał: sentyment -5, 45 newsów, dominujący temat: earnings (18 newsów).", "score": -5, "news_count": 45 }
}
```

**Notacja Mateusza:** `{{ }}` = app-generated (wszystkie powyżej poza `ticker`, `days`, `company_name` — te są `{ }` input/static).

**`portfolio_holding` dla watchlist:** gdy `kind='watchlist'` i brak wiersza w `holdings`, pole zwraca `null`. UI pokazuje "Brak pozycji w portfelu" zamiast widgetu.

**`sentiment_of_week` / `sentiment_of_quarter` text:** **deterministyczny template**, nie LLM. Format: `"{Okres}: sentyment {score:+d}, {news_count} newsów, dominujący temat: {topic} ({topic_count} newsów)."` — generowany z agregatów w `sentiment_summary` bez wywołania LLM. Powód: koszt i determinizm. LLM jest używany dla `sentiment_of_day.text` (bo dzienny sentyment ma mało newsów i warto je opisać) i dla `sentiment_by_category[].text` (bo kategorie potrzebują kontekstu). Tygodniowy/kwartalny to agregat — template wystarczy.

### 6.2 News panel — `GET /api/companies/{ticker}/news-panel?days=7&limit=50`

Mapowanie pól Mateusza (9 pól) na JSON response:

| # | Pole Mateusza | Klucz JSON | Źródło | Uwagi |
|---|---|---|---|---|
| 1 | company name | `company_name` | `companies.name` | statyczne |
| 2 | article title | `title` | `news.title` | z scrapera |
| 3 | source URL | `source_url` | `news.url` | link do oryginału |
| 4 | category/subcategories | `category` + `subcategories` | `news.topic` + `news.topics` | LLM classification |
| 5 | similar articles | `similar_articles` | `news.similar_news_ids` → join na news | pgvector cosine sim, top-5 |
| 6 | article date | `published_at` | `news.published_at` | data publikacji (source/llm/fallback) |
| 7 | article summary | `ai_summary` | `news.ai_summary` | LLM, generowane w kroku sentiment |
| 8 | date acquired | `date_acquired` | `news.fetched_at` | kiedy pobrane przez nas |
| 9 | original text | `raw_text` | `news.raw_text` | **domyślnie POMINIĘTE** w response (patrz niżej) |
| 10 | cleaned text | `cleaned_text` | `news.cleaned_text` | po text_cleaning |

**`raw_text` — domyślnie pominięte:** response NIE zawiera `raw_text` domyślnie (payload-size: 50 newsów × ~50k chars raw HTML = ~2.5MB). `raw_text` jest dostępne przez osobny endpoint `GET /api/news/{id}/raw` (on-demand, per news). `cleaned_text` jest w response (max 8000 chars per news, ~400KB przy 50 newsach — akceptowalne).

Response:
```json
{
  "ticker": "CDR.WA",
  "items": [
    {
      "company_name": "CD Projekt S.A.",
      "title": "CD Projekt zapowiada nowy DLC do Cyberpunk 2077",
      "source_url": "https://www.bankier.pl/wiadomosc/...",
      "source": "bankier",
      "category": "product",
      "subcategories": ["guidance"],
      "similar_articles": [ { "news_id": 123, "title": "...", "similarity": 0.87 } ],
      "published_at": "2026-08-11T14:30:00Z",
      "ai_summary": "CD Projekt ogłosił nowy DLC do Cyberpunk 2077 na Gamescom 2026.",
      "date_acquired": "2026-08-12T05:00:12Z",
      "cleaned_text": "CD Projekt ogłosił..."
    }
  ]
}
```

### 6.3 Pozostałe endpointy (przenoszone z `stocks-ui` bez zmian)

| Endpoint | Status |
|---|---|
| `GET /api/companies` | przeniesiony; dodany filtr `kind=portfolio\|watchlist` |
| `GET /api/companies/{ticker}` | przeniesiony |
| `GET /api/companies/{ticker}/prices?range=` | przeniesiony |
| `GET /api/companies/{ticker}/forecast?days=` | przeniesiony; **on-demand, nie pipeline**; days z whitelist |
| `GET /api/companies/{ticker}/forecast-backtest` | przeniesiony |
| `GET /api/companies/{ticker}/indicators` | przeniesiony |
| `GET /api/companies/{ticker}/price-changes` | przeniesiony |
| `GET /api/companies/{ticker}/sentiment-by-category?days=` | przeniesiony; days z whitelist |
| `GET /api/companies/{ticker}/interpretation` | przeniesiony |
| `GET /api/companies/{ticker}/category-summary?topic=&period=` | przeniesiony |
| `GET /api/map/{scope}` | przeniesiony |
| `POST /api/map/{scope}/recluster` | przeniesiony |
| `PATCH /api/news/{id}` | przeniesiony |
| `POST /api/news/bulk-patch` | przeniesiony |
| `GET /api/pipeline/runs` | przeniesiony |
| `POST /api/pipeline/trigger` | przeniesiony; nowe źródła: stooq_news, bankier, biznesradar, stockwatch, investing_pl, portfolio_md, second_brain, company_context, fundamentals |
| `GET /api/analytics` | przeniesiony |
| `GET /api/settings/query-templates` | przeniesiony |
| `PUT /api/settings/query-templates` | przeniesiony |
| **NOWE:** `GET /api/portfolio` | lista holdings z aktualnymi cenami (join na prices) |
| **NOWE:** `POST /api/portfolio/reimport` | trigger parsowania Dashboard.md |
| **NOWE:** `GET /api/companies/{ticker}/context` | company_context (current version) |
| **NOWE:** `POST /api/companies/{ticker}/context/regenerate` | wymuszenie regeneracji |
| **NOWE:** `GET /api/companies/{ticker}/context/history` | lista wersji |
| **NOWE:** `GET /api/companies/{ticker}/fundamentals` | aktualny fundamentals + LLM score |
| **NOWE:** `POST /api/companies/{ticker}/fundamentals/refresh` | wymuszenie scrape + scoring |
| **NOWE:** `GET /api/news/{id}/raw` | raw_text on-demand (nie w news-panel response) |

---

## 7. Test scenarios

### 7.1 Testy jednostkowe (backend, pytest + SQLite in-memory)

| # | Scenariusz | Given | When | Then |
|---|---|---|---|---|
| T1 | Parsowanie Dashboard.md → holdings | Dashboard.md z tabelą 14 pozycji + watchlistą 3 | `parse_dashboard_md(content)` | Zwraca 14 holdings + 3 watchlist; poprawne shares, avg_buy_price, cost_basis |
| T2 | Parsowanie Dashboard.md — zmiana składu | Dashboard.md v1 z 14 pozycjami, potem v2 z 13 | Reimport | Holding sprzedanej spółki ma shares=0 lub jest usunięty; source_hash się zmienił |
| T3 | Text cleaning — HTML | raw_text z tagami `<p>`, `<div>`, `<script>` | `clean_text()` | Brak tagów; tekst zachowany; whitespace znormalizowany |
| T4 | Text cleaning — markdown | raw_text z `![img](url)`, `**bold**`, `[link](url)` | `clean_text()` | Brak markdown syntax; tekst linku zachowany |
| T5 | Text cleaning — base64 | raw_text z `data:image/png;base64,iVBOR...` | `clean_text()` | Base64 usunięty; reszta tekstu zachowana |
| T6 | Text cleaning — truncate | raw_text 12000 chars | `clean_text()` | cleaned_text ≤ 8000 chars, ucięte na granicy zdania |
| T7 | Sentiment scale -100..+100 | LLM zwraca score 42 (int, już w skali -100..+100) | `score_pending_news` | Zapisane jako 42 (int); clamp do [-100, +100]; **brak mnożenia** — LLM prompt zwraca int w tej skali |
| T8 | Sentiment aggregation — day/week/quarter | 10 newsów z score w różnych dniach | `aggregate_sentiment` | Poprawne średnie dla day (date), week (ISO week), quarter (Q1-Q4) |
| T9 | TF-IDF keywords | 50 newsów z cleaned_text | `compute_tfidf` | Top-20 keywords per ticker; polskie słowa poprawnie tokenizowane |
| T10 | TF-IDF topic | Newsy z różnych kategorii | `compute_tfidf_topic` | Kategorie zgodne z PERSPECTIVE_KEYS lub NULL |
| T11 | Fundamentals scoring — LLM score | Surowe dane: P/E=45, ROE=18.5, dług/EBITDA=0.1 | `score_fundamentals` | Score 0-100; score_text niepusty; score_components z 5 wagami |
| T11b | Fundamentals — brak zmian danych | fundamentals z wczoraj, te same surowe dane | Pipeline step | SKIP; brak wywołania LLM |
| T12 | Company context — brak regeneracji | company_context.is_current=TRUE, sb_notes_hash zgodny | Pipeline step | SKIP; brak wywołania Tavily/LLM |
| T13 | Company context — regeneracja po zmianie notatki | sb_notes_hash != company_context.sb_notes_hash | Pipeline step | Nowa wersja (version+1); stara is_current=FALSE |
| T14 | Company context — Tavily queries | Trigger regeneracji | `generate_company_context` | 5 zapytań Tavily z nazwą spółki; wyniki w sources_used |
| T15 | Whitelist {n} dni | Request z days=15 | `GET /api/dashboard/{ticker}?days=15` | 422 Validation Error |
| T16 | Whitelist {n} dni — poprawne | Request z days=30 | `GET /api/dashboard/{ticker}?days=30` | 200; avg_price_nd.days=30 |
| T17 | Weekend — brak cen | Sobota, scheduler 09:00 | `fetch_prices` | Yahoo nie zwraca nowej świecy; dedup odrzuca; brak błędu |
| T18 | Weekend — newsy działają | Sobota, scheduler 09:00 | `fetch_news` | 5 PL źródeł odpytanych normalnie |
| T19 | Stooq news (nie CSV) | Mock HTML stooq news-list | `fetch_stooq_news` | Parsowanie listy; published_at z HTML; brak wywołania CSV endpoint |
| T20 | Investing.com slug mapping | Ticker bez mapowania | `fetch_investing_pl_news` | SKIP z adnotacją w logu; brak błędu |
| T21 | Similar articles | News z embeddingiem, 5 innych z podobnymi | Pipeline step `map` | similar_news_ids wypełnione; cosine_sim > 0.5 |
| T22 | Dead source skipping | Źródło X z 0 wierszy w 4 przebiegach | `refresh_all` | Źródło pominięte z adnotacją; RETRY_AFTER_DAYS=7 respektowane |
| T23 | Drain loop | 120 newsów pending, limit 50/pass | `_drain(extract)` | 3 przebiegi (50+50+20); total=120; hit_cap=False |
| T24 | Drain loop — cap | 1100 newsów pending | `_drain(sentiment)` | 20 przebiegów × 50 = 1000; hit_cap=True; błąd w raporcie |
| T25 | Mapa — nowe newsy trigger rebuild | latest_news_at > saved_marker | `rebuild_pending_maps` | Scope przebudowany; UMAP wywołany raz |
| T26 | Mapa — brak nowych newsów | latest_news_at <= saved_marker | `rebuild_pending_maps` | Scope pominięty; UMAP nie wywołany |
| T27 | Mapa — suwak k | Istniejące punkty | `POST /map/{scope}/recluster` | KMeans przeliczone; UMAP nietknięty (współrzędne identyczne) |
| T28 | Mapa — summary_stale | Zmiana k z 6 na 8 | Recluster | Wszystkie klastry z summary_stale=TRUE |
| T29 | Second Brain import | Plik `20260804_analiza_spolki_pzu_doglebna.md` | `import_second_brain_notes` | company_notes wiersz; note_date=2026-08-04; content_cleaned bez wikilinków |
| T30 | Second Brain — wykrycie zmiany | Ten sam plik, zmieniona treść | Reimport | content_hash zmieniony; sb_note_hash na companies zaktualizowany |
| T31 | Forecast — 4 modele | 1250 sesji | `GET /forecast?days=30` | Wszystkie 4 modele zwracają wartości; ARIMA ma lower/upper |
| T32 | Forecast — za mało danych | 20 sesji | `GET /forecast?days=30` | ARIMA/ETS odmawiają; naive/drift zwracają; UI informuje |
| T33 | Portfolio — P/L wyliczenie | Holding 3 szt @ 262.83, kurs 252.50 w `prices` | `GET /api/portfolio` | pnl_pln=-31.00; pnl_pct=-3.93; current_value wyliczone z prices, nie z holdings |
| T34 | Scheduler — 6 jobów | Mock czasu | `start_scheduler` | 6 jobów: 05:00, 09:00, 13:00, 17:00 (refresh_all) + 07:00 (portfolio_md) + 07:05 (second_brain) |
| T35 | Dashboard endpoint — wszystkie widgety | Ticker z pełnymi danymi | `GET /api/dashboard/{ticker}` | Wszystkie 11 pól obecnych w response |
| T36 | Dashboard — watchlist bez holdings | Ticker kind='watchlist', brak wiersza w holdings | `GET /api/dashboard/{ticker}` | `portfolio_holding: null`; pozostałe widgety normalnie |
| T37 | Embeddings — lazy backfill | 50 newsów bez embeddingu | `_drain(embed)` | ensure_embeddings wywołane; embedding wypełniony; limit 200/pass |
| T38 | Embeddings — drain cap | 5000 newsów bez embeddingu | `_drain(embed)` | 20 przebiegów × 200 = 4000; hit_cap=True; błąd w raporcie |
| T39 | ai_summary w sentiment batch | LLM zwraca score + topic + ai_summary | `score_pending_news` | Wszystkie 3 pola zapisane; ai_summary niepuste |
| T40 | sentiment_of_week text — template | sentiment_summary z 7 dni | Dashboard endpoint | text = "Tydzień: sentyment +8, 12 newsów, dominujący temat: product (5 newsów)." — deterministyczny, bez LLM |

### 7.2 Testy integracyjne (e2e, na żywej bazie docker-compose)

| # | Scenariusz | Kroki | Oczekiwany wynik |
|---|---|---|---|
| E1 | Pełny pipeline dla 1 spółki | Seed CDR.WA → trigger `refresh_all` | Ceny ≥1200 sesji; newsy ≥5 z co najmniej 2 źródeł; sentiment score w [-100,100]; mapa z ≥1 klastrem; dashboard zwraca 200 |
| E2 | Backfill 17 spółek | Seed wszystkich → backfill Yahoo 5y → pełny pipeline | Każda spółka ≥1200 sesji (ZAB.WA ≥450); 0 pustych świec; wszystkie źródła z co najmniej 1 wierszem lub adnotacją "dead source" |
| E3 | Company context e2e | Seed CDR.WA + Second Brain notatka → trigger `company_context` | Wersja 1 zapisana; wszystkie 8 sekcji mają ≥0 wpisów; synthesis_md niepuste; token_usage zapisane |
| E4 | Weekend refresh | Sobota 09:00 → scheduler | fetch_prices pomija; fetch_news działa; fundamentals pomija; raport bez błędów |
| E5 | Stooq news scraping | Ręczny trigger `stooq_news` dla CDR.WA | ≥1 news z datą publikacji; brak wywołania stooq CSV |
| E6 | Dashboard UI | Otwarcie `/dashboard/CDR.WA` w przeglądarce | 11 widgetów renderowanych; dropdown {n} dni działa; sentiment score w skali -100..+100; fundamentals widget pokazuje score + text |
| E7 | News panel UI | Otwarcie `/company/CDR.WA/news` | 9 pól per news (bez raw_text); similar articles klikalne; cleaned_text w rozwijanym panelu |
| E8 | Portfolio UI | Otwarcie `/portfolio` | 14 pozycji; P/L zgodne z Dashboard.md; przycisk "Reimport" działa |
| E9 | Fundamentals e2e | Trigger `fundamentals` dla PZU.WA | fundamentals wiersz z pe_ratio/roe/debt_ebitda; score 0-100; score_text niepusty |

### 7.3 Corner cases

| # | Przypadek | Oczekiwane zachowanie |
|---|---|---|
| C1 | Spółka bez Second Brain notatki | company_context generowany tylko z Tavily; sb_notes_hash=NULL; brak błędu |
| C2 | Tavily API down | company_context SKIP z błędem w logu; pipeline kontynuuje; retry przy następnym przebiegu |
| C3 | OpenRouter API down | sentiment SKIP; extract kontynuuje; pipeline raportuje błąd; retry przy następnym przebiegu |
| C4 | Investing.com antybot 403 | Retry z backoff ×3; potem SKIP z adnotacją; source_health liczy jako fail |
| C5 | Dashboard.md nie istnieje | Portfolio import zwraca błąd 404; UI pokazuje "Brak pliku Dashboard.md"; nie crashuje |
| C6 | Dashboard.md z błędnym formatem | Parser rzuca ValueError z numerem linii; UI pokazuje błąd parsowania; poprzednie holdings zachowane |
| C7 | News bez daty publikacji | date_source='fallback'; published_at=fetched_at; nie wraca do kolejki (terminal state) |
| C8 | LLM zwraca topic=null dla wszystkich newsów | Wiersze oznaczone jako przetworzone (sentiment_score NOT NULL); nie krążą w kolejce |
| C9 | Spółka z <12 newsami z embeddingiem | Mapa pokazuje "Za mało danych (N/12)"; UMAP nie wywołany |
| C10 | UMAP na 0 punktach | Scope pominięty; brak błędu; log "0 embedded news, need 12" |
| C11 | Zmiana k na mapie z <12 punktami | Recluster zwraca 0; UI pokazuje komunikat |
| C12 | Regeneracja company_context w trakcie odczytu | Stara wersja (is_current=TRUE) zwracana do momentu zapisu nowej; brak race condition (transakcja) |
| C13 | Duplicate URL z dwóch źródeł | Pierwszy wstawiony; drugi odrzucony przez UNIQUE constraint; logowany jako dedup |
| C14 | News z sentiment_score=-100 (ekstremum) | Agregacje działają; UI badge czerwony; nie ma overflow |
| C15 | {n}=720 dni (max) | Endpoint zwraca dane; avg_price liczone z 720 sesji; forecast działa |
| C16 | Fundamentals — biznesradar.pl nie ma spółki | SKIP z adnotacją; fundamentals.score=NULL; UI pokazuje "Brak danych fundamentalnych" |
| C17 | Fundamentals — LLM zwraca score poza zakresem | Clamp do [0, 100]; log warning |
| C18 | News panel z 50 newsami × 8k cleaned_text | Response ~400KB; akceptowalne; raw_text nie jest w response |

---

## 8. Production / rollout plan

### 8.1 Local dev setup

```bash
cd C:\Users\mateu\Desktop\experiments\trading_assist
cp .env.example .env
# Uzupełnij: OPENROUTER_API_KEY, TAVILY_API_KEY
docker compose up -d --build
curl http://localhost:8002/health   # Faza 1: porty 8002/5175
```

**Porty — Faza 1 (równoległe działanie):** backend **8002**, frontend **5175**, db **5433** — `trading_assist` działa równolegle z `stocks-ui` (8001/5174/5432). Domyślne porty w `docker-compose.yml` to 8002/5175/5433.

**Cutover — jedna reguła:** po akceptacji Mateusza, zmieniamy porty w `docker-compose.yml` na 8001/5174/5432 i zatrzymujemy `stocks-ui`. Jeden commit, jeden restart.

### 8.2 Data backfill (jednorazowy skrypt)

```bash
docker compose exec backend python -m app.scripts.backfill
```

Skrypt robi:
1. Seed 17 spółek z tabeli w sekcji 0.1 (ticker, name, kind, ir_url, investing_slug, sb_note_path)
2. Import Dashboard.md → holdings (14 pozycji)
3. Import Second Brain notes → company_notes (17 plików)
4. Backfill Yahoo 5y prices → ~21k wierszy
5. Pierwszy `refresh_all` (newsy + ekstrakcja + embed + sentiment + mapa + context + fundamentals)
6. Raport końcowy

**Szacunkowy czas:** ~30-45 minut.

### 8.3 Migration / cutover plan

**Faza 1 — Równoległe działanie (1-2 tygodnie):**
- `stocks-ui` działa na portach 8001/5174 (bez zmian)
- `trading_assist` działa na portach **8002/5175** (domyślne w docker-compose)
- Mateusz porównuje dashboardy; `stocks-ui` pozostaje źródłem prawdy

**Faza 2 — Cutover (jeden commit):**
- `trading_assist/docker-compose.yml`: porty zmienione na 8001/5174/5432
- `stocks-ui`: `docker compose down` (repo i baza zachowane jako archiwum)
- `Second Brain/Projects/stocks-ui/docs/STATE.md` zaktualizowany: "Projekt zastąpiony przez trading_assist (FOC-81)"

**Faza 3 — Cleanup (po 2-4 tygodniach stabilności):**
- `stocks-ui` oznaczone jako archived (README update)
- Docker volume `postgres_data_stocks` zachowany

### 8.4 Rollback

Rollback = `docker compose up -d` w `stocks-ui` (porty 8001/5174 wracają). Żadne dane nie są migrowane z `stocks-ui` do `trading_assist`, więc rollback jest trywialny.

### 8.5 Feature flags

| Flag | Env var | Default | Opis |
|---|---|---|---|
| Scheduler on/off | `SCHEDULER_ENABLED` | `true` | Wyłącza APScheduler (dev z `--reload`) |
| Sentiment on/off | `OPENROUTER_API_KEY` pusty | — | Bez klucza sentiment no-op |
| Tavily on/off | `TAVILY_API_KEY` pusty | — | Bez klucza extract/company_context no-op |
| TF-IDF on/off | `NLP_CLASSIC_ENABLED` | `true` | Wyłącza krok `nlp_classic` |
| Company context on/off | `COMPANY_CONTEXT_ENABLED` | `true` | Wyłącza krok `company_context` |
| Fundamentals on/off | `FUNDAMENTALS_ENABLED` | `true` | Wyłącza krok `fundamentals` |
| Source: investing_pl | `INVESTING_PL_ENABLED` | `true` | Wyłącza scraper investing.com |

---

## 9. Open questions (do Mateusza — nie blokują specu)

1. **Investing.com slug map:** tabela w sekcji 0.1 ma przykładowe slugi — wymagają ręcznej weryfikacji każdego URL-a przed implementacją. Czy zostawić jako task implementacyjny?
2. **Fundamentals scoring prompt:** czy LLM scoring ma używać sztywnych progów (P/E < 15 = dobry, > 30 = zły) czy kontekstowej oceny ("P/E 45 dla growth company jest OK")? Rekomendacja: kontekstowa, bo progowa jest krucha cross-sector.

---

## 10. Załączniki

- ADR: `docs/adr/0007-trading-assist-architecture.md`
- Brief: `planning/briefs/discovery-foc-81-trading-stocks-ui.md`
- Baseline: `Second Brain/Projects/stocks-ui/docs/STATE.md`

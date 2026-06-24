# Fenix — Control Panel UX Design (v2)

> **Status:** v2 · **Target:** Next.js 16 extending `Desktop/experiments/0_linear` · **Audience:** one engineer · **Scope:** control-panel UI only (not agent internals)
>
> **Identity:** Fenix is the orchestrator that builds Mateusz's three managed repos: **Neo** (joint-flows), **AU** (office), **PISI** (gantt-pisi). Fenix itself is not a managed project — it is the tool. This panel is Fenix's cockpit.

---

## 1. Extend vs separate — decision

**Extend `Desktop/experiments/0_linear`.** Add routes under `/agents/*`, a persistent top bar with workspace switcher, and API routes for config read/write and terminal spawning.

1. It already has `@linear/sdk`, `LINEAR_API_KEY`, `OPENROUTER_API_KEY`, SQLite cache, and a working Next.js 16 scaffold — zero setup duplication.
2. Signal views (🔔 needs, 🚧 blocked, etc.) share the existing Linear client and issue cache — no second data layer.
3. One app = one auth, one port, one dev loop, one `.env` — less friction every session.
4. The agent panel is a new nav section, not a separate product; it lives in `/agents/*`.
5. If it grows too large later, extract the panel into a standalone app sharing `lib/` — start unified.

---

## 2. Information architecture

### Global top bar (persistent, all screens)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs  │  Keys  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Fenix** — wordmark, links to `/`.
- **Workspace switcher [JOI ▼]** — dropdown: JOI / PISI. Persisted in `localStorage`. Changes Linear API key, project filter, and agent buttons site-wide.
- **Dashboard** — signal views + existing 0_linear Kanban/Gantt below.
- **Agents** — per-area launch cards with terminal-spawn buttons.
- **Config** — model routing editor, projects/labels/states editors (tabs).
- **Costs** — token/cost dashboard with time filter, table, bar chart, budget alerts.
- **Keys** — secrets entry form. MVP scope.

### Route map

```
/                     → Dashboard (signal views + existing Linear views)
/agents               → Agent launch (5 area cards)
/agents/config        → Agent config (model routing, projects, labels, states)
/agents/costs         → Token/cost dashboard
/agents/keys          → Keys/secrets
```

---

## 3. Screen-by-screen wireframes

### 3a. Dashboard — Signal Views (`/`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs  │  Keys      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌── Signal Views ──────────────────────────────────────────────────────┐    │
│  │                                                                       │    │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌──────┐ │    │
│  │  │ 🔔 My      │ │ 🤖 Agent   │ │ ⚠️ Attention│ │ 🚧 Block │ │ 🧪   │ │    │
│  │  │ Input      │ │ Working    │ │            │ │ ed       │ │ Revw │ │    │
│  │  │ 3          │ │ 2          │ │ 1          │ │ 0        │ │ 4    │ │    │
│  │  └────────────┘ └────────────┘ └────────────┘ └──────────┘ └──────┘ │    │
│  │                                                                       │    │
│  │  Active: 🔔 My Input (3 issues) — needs:* assigned to me             │    │
│  │  ┌───────────────────────────────────────────────────────────────┐   │    │
│  │  │ ● [P1] Fix auth timeout     needs:approval  Neo  2h ago       │   │    │
│  │  │   @flow → Mateusz           [✅ Approve] [🚫 Changes] [🔁]   │   │    │
│  │  │───────────────────────────────────────────────────────────────│   │    │
│  │  │ ● [P2] Add export CSV       needs:answer    AU   30m ago      │   │    │
│  │  │   @flow → Mateusz           [↗ Open in Linear] [Reply inline] │   │    │
│  │  │───────────────────────────────────────────────────────────────│   │    │
│  │  │ ● [P3] Migrate DB schema    needs:decision  Neo  1h ago       │   │    │
│  │  │   @flow → Mateusz           [✅] [🚫] [↗ Open in Linear]     │   │    │
│  │  └───────────────────────────────────────────────────────────────┘   │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ── Existing 0_linear views (Kanban / Gantt / CycleTime) — collapsible ──    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Each signal card shows a live count badge (polled every 30s via `GET /api/issues?filter=<view>`).
- Click card → sets active filter; issue list below refreshes.
- ✅/🚫/🔁 buttons: set emoji reaction on the agent's last comment + remove `needs:*` label in one API call.
- Red top-bar dot on **Costs** tab when any area exceeds 80% weekly budget.

---

### 3b. Agent Launch View (`/agents`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs  │  Keys      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Agent Launchers — JOI workspace                                              │
│                                                                               │
│  ┌── CADENCE  (weekly cron) ────────────────────────────────────────────┐    │
│  │  lead: minimax/minimax-m3 · retro: z-ai/glm-5.2 · pl: deepseek-pro  │    │
│  │  ⏳ Idle · Last run: 2d ago · Next: Mon 06:00                        │    │
│  │  [▶ Open Terminal — CADENCE @ JOI]   [📋 Last run log]              │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌── PLAN  (voice → Linear) ────────────────────────────────────────────┐    │
│  │  lead: claude-opus-4.8 · spec: z-ai/glm-5.2 · discovery: minimax-m3 │    │
│  │  ● Idle · Last: 1d ago                                                │    │
│  │  [▶ Open Terminal — PLAN @ JOI]   [▶ Open Terminal — PLAN @ PISI]  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌── DEV  (task → code) ────────────────────────────────────────────────┐    │
│  │  lead: z-ai/glm-5.2 · recon: minimax-m3 · multifile: kimi-k2.7-code │    │
│  │  🔵 Active — 1 task in progress (Neo: add export CSV)                │    │
│  │  [▶ Open Terminal — DEV @ JOI]   [▶ Open Terminal — DEV @ PISI]   │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌── REVIEW  (code → review) ───────────────────────────────────────────┐    │
│  │  deep: z-ai/glm-5.2 · first_pass: deepseek-pro · security: kimi     │    │
│  │  🔵 Active — 1 task in review (AU: fix auth timeout)                 │    │
│  │  [▶ Open Terminal — REVIEW @ JOI]                                    │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  ┌── TEST  (review → deploy) ───────────────────────────────────────────┐    │
│  │  deploy: deepseek-pro · run: minimax-m3 · terminal: openai/gpt-5.5   │    │
│  │  ⏳ Idle · No tasks queued                                            │    │
│  │  [▶ Open Terminal — TEST @ JOI]                                      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  Terminal spawned: DEV @ JOI — PID 14832  [⊠ dismiss]                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Model line shows only the 2-3 most visible roles; full routing is editable in Config.
- Status derives from Linear: `assignee=@flow AND status=In Progress AND area label`.
- CADENCE: JOI only (no PISI variant). PLAN/DEV: both workspaces. REVIEW/TEST: JOI only.
- After spawn: `POST /api/terminal/spawn` returns `{ pid, title }`. Dismissible toast at bottom.

---

### 3c. Agent Config — Model Routing tab (`/agents/config`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs  │  Keys      │
├──────────────────────────────────────────────────────────────────────────────┤
│  [Model Routing ●] [Projects] [Labels] [States]                               │
│                                                                               │
│  Source: config/models.json   [↺ Reload from disk]   [Reset to defaults]     │
│                                                                               │
│  ┌── CADENCE ──────────────────────────────────────────────────────────┐     │
│  │  default    [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  retro      [z-ai/glm-5.2                ▼]  $1.40/$4.40  82.8%   │     │
│  │  pl         [deepseek/deepseek-v4-pro    ▼]  $0.44/$0.87  80.6%   │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  ┌── PLAN ─────────────────────────────────────────────────────────────┐     │
│  │  discovery  [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  dor_gate   [deepseek/deepseek-v4-flash   ▼]  $0.14/$0.28  79.0%   │     │
│  │  spec        [z-ai/glm-5.2               ▼]  $1.40/$4.40  82.8%   │     │
│  │  spec_review [minimax/minimax-m3          ▼]  $0.30/$1.20  80.5%   │     │
│  │  decompose  [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  enrich     [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  push       [deepseek/deepseek-v4-flash   ▼]  $0.14/$0.28  79.0%   │     │
│  │  pl         [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  ┌── DEV ──────────────────────────────────────────────────────────────┐     │
│  │  recon      [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  implement  [z-ai/glm-5.2                ▼]  $1.40/$4.40  82.8%   │     │
│  │  multifile  [moonshotai/kimi-k2.7-code   ▼]  $0.95/$4.00  MCP81%  │     │
│  │  hard       [deepseek/deepseek-v4-pro    ▼]  $0.44/$0.87  80.6%   │     │
│  │  pl         [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  ┌── REVIEW ───────────────────────────────────────────────────────────┐     │
│  │  first_pass [deepseek/deepseek-v4-pro    ▼]  $0.44/$0.87  80.6%   │     │
│  │  security   [moonshotai/kimi-k2.7-code   ▼]  $0.95/$4.00  MCP81%  │     │
│  │  deep       [z-ai/glm-5.2                ▼]  $1.40/$4.40  82.8%   │     │
│  │  pl         [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  ┌── TEST ─────────────────────────────────────────────────────────────┐     │
│  │  deploy     [deepseek/deepseek-v4-pro    ▼]  $0.44/$0.87  80.6%   │     │
│  │  scenarios  [deepseek/deepseek-v4-flash   ▼]  $0.14/$0.28  79.0%   │     │
│  │  run        [minimax/minimax-m3           ▼]  $0.30/$1.20  80.5%   │     │
│  │  root_cause [z-ai/glm-5.2                ▼]  $1.40/$4.40  82.8%   │     │
│  │  terminal   [openai/gpt-5.5              ▼]  $5.00/$30.00 82.6%   │     │
│  └──────────────────────────────────────────────────────────────────────┘     │
│                                                                               │
│  [+ Add role to area...]                                                      │
│  [Save to config/models.json]   [Discard]   Last saved: 4m ago               │
│                                                                               │
│  ── Model dropdown (expanded, example for DEV › implement) ──────────────    │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  Model ID                          In $/1M   Out $/1M  SWE-bench    │    │
│  │  ────────────────────────────────────────────────────────────────    │    │
│  │  ○ anthropic/claude-opus-4.8       $5.00     $25.00    88.6%        │    │
│  │  ○ anthropic/claude-sonnet-4.6     $3.00     $15.00    79.6%        │    │
│  │  ● z-ai/glm-5.2                    $1.40     $4.40     82.8%        │    │
│  │  ○ minimax/minimax-m3              $0.30     $1.20     80.5%        │    │
│  │  ○ deepseek/deepseek-v4-flash      $0.14     $0.28     79.0%        │    │
│  │  ○ deepseek/deepseek-v4-pro        $0.44     $0.87     80.6%        │    │
│  │  ○ moonshotai/kimi-k2.7-code       $0.95     $4.00     MCP 81.1%   │    │
│  │  ○ openai/gpt-5.5                  $5.00     $30.00    82.6%        │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Model dropdown details:**
- Populated from `config/models.json → ids` map (8 models). Adding a model to `ids` auto-adds it here.
- Columns: model ID (full), input $/1M, output $/1M, benchmark score (SWE-bench Verified %; Kimi shows MCP-Atlas score instead since that's its main differentiator).
- Pricing and benchmark data are static in `models.json`. The UI does not fetch live benchmark data.
- Save writes `routing` section to `config/models.json` with validation (all routing values must be keys in `ids`). Backup created before write. No auto-save — explicit button.

---

### 3c-ii. Agent Config — Projects tab

```
│  [Model Routing] [Projects ●] [Labels] [States]                               │
│                                                                               │
│  Source: config/projects.json   [↺ Reload from disk]                         │
│                                                                               │
│  ┌──────────┬──────────┬──────────────────────────────────────┬──────────┐   │
│  │ Project  │ Workspace│ Local repo path                      │ Deploy   │   │
│  ├──────────┼──────────┼──────────────────────────────────────┼──────────┤   │
│  │ Neo      │ joi      │ C:/Users/mateu/.../joint-flows  [✎]  │ gcp-vm   │   │
│  │ AU       │ joi      │ C:/Users/mateu/.../office       [✎]  │ gcp-vm   │   │
│  │ Fenix    │ joi      │ C:/Users/mateu/.../fenix        [✎]  │ gcp-vm   │   │
│  │ PISI     │ pisi     │ C:/Users/mateu/.../gantt-pisi   [✎]  │ gcp-vm   │   │
│  └──────────┴──────────┴──────────────────────────────────────┴──────────┘   │
│  [+ Add project]   [Save to config/projects.json]   [Discard]                 │
```

Note: "Fenix" row here is the orchestrator repo tracked in Linear — it appears in the table for completeness but agents do not auto-deploy it. That is intentional and documented in the row's tooltip.

---

### 3c-iii. Agent Config — Labels tab

```
│  [Model Routing] [Projects] [Labels ●] [States]                               │
│                                                                               │
│  Source: config/linear/labels.json   [↺ Reload]   [Sync to Linear ↑]         │
│                                                                               │
│  Groups (single-select within group):                                         │
│  ┌─────────┬───────────┬──────────────────────────────────────────────────┐  │
│  │ Group   │ Exclusive │ Labels                                            │  │
│  ├─────────┼───────────┼──────────────────────────────────────────────────┤  │
│  │ type    │ ✓         │ feature, bug, spike, tech                         │  │
│  │ needs   │ ✓         │ answer, approval, decision, access                │  │
│  │ risk    │ ✓         │ high                                              │  │
│  │ ai      │ ✗         │ planned, coded, reviewed                          │  │
│  └─────────┴───────────┴──────────────────────────────────────────────────┘  │
│                                                                               │
│  Flags (boolean, standalone):                                                 │
│  dor-ok · dod-ok · escalated · over-budget · transcript-uncertain ·          │
│  blocked · stage:testing                                                      │
│                                                                               │
│  [+ Add group]   [+ Add label to group]   [Save]   [Discard]                  │
```

---

### 3c-iv. Agent Config — States tab

```
│  [Model Routing] [Projects] [Labels] [States ●]                               │
│                                                                               │
│  Source: Linear API (active workspace) + config/linear/states.json            │
│  [↺ Reload from Linear]   [Sync to Linear ↑]   [↺ Reload from disk]          │
│                                                                               │
│  JOI:  Todo ──▶ In Progress ──▶ In Review ──▶ Done  (+ Canceled)             │
│  PISI: [states loaded from PISI Linear API — may differ from JOI]             │
│        e.g.  Ready · In Progress · Review · Blocked · Done                   │
│                                                                               │
│  JOI mapping (inapplicable in PISI):                                          │
│  • "Ready" is NOT a status — it is the dor-ok flag on a Todo task.            │
│  • "Testing" is NOT a status — it is label stage:testing within In Review.   │
│                                                                               │
│  State list is fetched from the Linear API per workspace — not hardcoded.     │
│  This tab shows the active workspace's actual state list.                     │
│  PISI browse mode: [Save] and [Sync to Linear ↑] are hidden.                 │
│                                                                               │
│  [Edit workflow]   [Save]   [Discard]                                         │
```

---

### 3d. Token/Cost Dashboard (`/agents/costs`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs ●  │  Keys    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  [Last 7 days ▼]   [↺ Refresh]   [Auto-refresh 60s ☑]   Last: 14s ago       │
│                                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ Total    │  │ In Tokens│  │ Out Tokens│  │ Reasoning│  │ Budget /task │   │
│  │ $12.45   │  │ 2.10M    │  │ 1.30M    │  │ 0.18M    │  │ $2.00  ✅    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│                                                                               │
│  Per-model breakdown:                                                         │
│  ┌────────────────────────────────────┬──────┬──────┬──────┬────────┬──────┐ │
│  │ Model                              │InTok │OutTok│Reason│Cost API│Calc  │ │
│  ├────────────────────────────────────┼──────┼──────┼──────┼────────┼──────┤ │
│  │ z-ai/glm-5.2                       │1.20M │0.80M │0.10M │ $5.28  │$5.20 │ │
│  │ minimax/minimax-m3                 │0.50M │0.30M │  —   │ $0.51  │$0.51 │ │
│  │ deepseek/deepseek-v4-pro           │0.25M │0.12M │0.08M │ $0.21  │$0.21 │ │
│  │ anthropic/claude-opus-4.8          │0.08M │0.05M │  —   │ $1.65  │$1.65 │ │
│  │ deepseek/deepseek-v4-flash         │0.04M │0.02M │  —   │ $0.01  │$0.01 │ │
│  │ moonshotai/kimi-k2.7-code          │0.03M │0.01M │  —   │ $0.78  │$0.78 │ │
│  ├────────────────────────────────────┼──────┼──────┼──────┼────────┼──────┤ │
│  │ TOTAL                              │2.10M │1.30M │0.18M │$12.45  │$12.36│ │
│  └────────────────────────────────────┴──────┴──────┴──────┴────────┴──────┘ │
│  ⚠ Cost divergence flagged when |API − calc| > 10% (same logic as CLI tool). │
│                                                                               │
│  Cost by model (bar chart — horizontal, sorted by cost desc):                 │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  glm-5.2      ████████████████████████████████████████  $5.28       │    │
│  │  opus-4-8     ████████████████                          $1.65        │    │
│  │  kimi-k2.7    ████████                                  $0.78        │    │
│  │  minimax-m3   ████                                      $0.51        │    │
│  │  deepseek-pro ██                                        $0.21        │    │
│  │  deepseek-fls ▌                                         $0.01        │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  Budget alerts:                                                               │
│  ⚠ 3 tasks flagged over-budget (> $2.00/task) this period                   │
│    · NEO-142 DEV  $3.41  [↗ Open in Linear]                                  │
│    · NEO-138 DEV  $2.18  [↗ Open in Linear]                                  │
│    · AU-77  PLAN  $2.05  [↗ Open in Linear]                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data flow:** `GET /api/cost-report?since=YYYY-MM-DD` → server shells out `node scripts/cost-report.mjs --json --since=...` → parses stdout JSON → returns to client. Cache 60s server-side (OpenRouter activity API is ~5 min delayed anyway).

**JSON shape from script:** `{ meta: { period, budget_per_task, total_cost, over_budget, delta }, models: { [modelId]: { prompt_tokens, completion_tokens, reasoning_tokens, requests, cost_api, cost_calculated } } }`.

**Cost formula:** `(prompt_tokens / 1M) × pricing[model].input + (completion_tokens / 1M) × pricing[model].output` — same formula as the CLI script, using `config/models.json` pricing as fallback when `cost_api` is unavailable.

**Budget alert logic:** `COST_BUDGET_USD_PER_TASK` env var (default $2). Each task that has `over-budget` label in Linear is listed. The dashboard badge on the nav tab turns red when any `over-budget` label exists in the current workspace.

---

### 3e. Keys / Secrets (`/agents/keys`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Fenix  [JOI ▼]  │  Dashboard  │  Agents  │  Config  │  Costs  │  Keys ●    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌── API Keys (written to .env — gitignored) ───────────────────────────┐    │
│  │                                                                       │    │
│  │  OpenRouter API Key           (OPENROUTER_API_KEY)                    │    │
│  │  [sk-or-v1-••••••••••••••••••••••••••••••••••••]  [👁 Show] [✓ Test] │    │
│  │  ✅ Connected · $12.45 spent this period                              │    │
│  │                                                                       │    │
│  │  Anthropic API Key            (ANTHROPIC_API_KEY)                     │    │
│  │  [sk-ant-••••••••••••••••••••••••••••••••••••••]  [👁 Show] [✓ Test] │    │
│  │  ✅ Connected (direct access — fallback only; OpenRouter is primary)  │    │
│  │                                                                       │    │
│  │  Linear — JOI Workspace       (LINEAR_API_KEY)                        │    │
│  │  [lin-api-•••••••••••••••••••••••••••••••••••••]  [👁 Show] [✓ Test] │    │
│  │  ✅ Connected · 142 issues synced                                     │    │
│  │                                                                       │    │
│  │  Linear — PISI Workspace      (LINEAR_API_KEY_PISI)                   │    │
│  │  [lin-api-•••••••••••••••••••••••••••••••••••••]  [👁 Show] [✓ Test] │    │
│  │  ✅ Connected · 38 issues synced                                      │    │
│  │                                                                       │    │
│  │  Bot OAuth Token @flow        (LINEAR_BOT_OAUTH_TOKEN)                │    │
│  │  [••••••••••••••••••••••••••••••••••••••••••••••]  [👁 Show] [✓ Test] │    │
│  │  ⚠️ Not configured — agent webhook events will not fire               │    │
│  │                                                                       │    │
│  │  [Save all to .env]   [Discard]                                       │    │
│  │                                                                       │    │
│  │  ℹ Keys are stored in .env (gitignored). The API route reads the      │    │
│  │    file, replaces matching lines, writes back atomically. Keys are    │    │
│  │    never returned in full — display shows last 4 chars only.          │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**MVP scope:** Keys screen is MVP — Mateusz enters keys once here before running any agent.

---

### 3f. Workspace Switcher (dropdown detail)

```
  [JOI ▼]
  ┌──────────────────────────────────────────────────────┐
  │  ● JOI   (Neo · AU · Fenix repo)    full automation  │
  │  ○ PISI  (gantt-pisi)               full automation  │
  └──────────────────────────────────────────────────────┘
```

What changes on switch — full table in §5. Workspace differences — §3f-ii.

---

### 3f-ii. Workspace differences

Both JOI and PISI are **full-automation** workspaces. Agents may create issues, move states,
add/remove labels, run cadence crons, push, and deploy in both. The only differences on switch:

| Aspect | JOI (jointhubs) | PISI (Polski Instytut SI) |
|--------|----------------|---------------------------|
| Linear API key env | `LINEAR_API_KEY` | `LINEAR_API_KEY_PISI` |
| All write operations | ✅ permitted | ✅ permitted |
| Applicable squads | CADENCE · PLAN · DEV · REVIEW · TEST | PLAN · DEV (CADENCE/REVIEW/TEST JOI-scoped by project config, not restricted) |
| Workflow state names | Todo / In Progress / In Review / Done | Fetched from PISI Linear API — may differ (e.g. Review / Blocked / Ready observed) |
| Signal view filters | State names resolved from JOI state list | State names resolved from PISI state list |

**Workflow states — adaptive per workspace:** PISI uses different state names than JOI. The UI does **not** hardcode the JOI 4-state model globally. On workspace switch, `GET /api/workspace-states?workspace=<ws>` fetches the team's actual workflow states from the Linear API and stores them in `useWorkspace()` context. All state-name references — signal view filters, status badges, Config › States display — use the fetched list for the active workspace. Status-based signal filters use Linear's `type` enum (`started`, `completed`) rather than literal state names; see §9.

---

## 4. Terminal-spawn UX (Windows)

### What the user sees

Click "▶ Open Terminal — DEV @ JOI" → a new PowerShell window appears titled `DEV @ JOI`, running `claude` immediately inside the agent's isolated config environment. Mateusz sees Claude Code's startup banner and is live.

### What the UI does

1. **`POST /api/terminal/spawn`** body: `{ area: "dev", workspace: "joi" }`.
2. API route reads `.env`, resolves keys, constructs and executes:

```
start "DEV @ JOI" powershell -NoExit -Command "
  $env:ANTHROPIC_BASE_URL  = 'https://openrouter.ai/api/v1';
  $env:ANTHROPIC_AUTH_TOKEN = '<OPENROUTER_API_KEY from .env>';
  $env:ANTHROPIC_API_KEY    = '';
  $env:API_TIMEOUT_MS       = '3000000';
  $env:LINEAR_WORKSPACE     = 'joi';
  $env:LINEAR_API_KEY       = '<LINEAR_API_KEY from .env>';
  $env:CLAUDE_CONFIG_DIR    = 'C:\...\linear-agents\agents\dev';
  $env:ANTHROPIC_MODEL      = 'z-ai/glm-5.2';
  cd 'C:\...\linear-agents';
  .\bin\dev.bat
"
```

3. Keys are passed via environment variables only — not command-line args (which are visible in `tasklist`).
4. API returns `{ pid: 14832, title: "DEV @ JOI" }` immediately (detached, non-blocking).
5. UI shows dismissible toast: `Terminal spawned — DEV @ JOI (PID 14832)`.

### Windows specifics

- `start "title" powershell -NoExit` opens a new OS window; `-NoExit` keeps it open after `dev.bat` exits so Mateusz can inspect output.
- `claude` must be on PATH (confirmed via Claude Code CLI install).
- No programmatic focus from the browser — the PID toast is informational; Mateusz finds the window in the taskbar.
- Each `.bat` file sets `CLAUDE_CONFIG_DIR` to the agent's isolated config dir (`agents/<area>/`), so agent settings, skills, MCP, and credentials are never mixed with each other or with Mateusz's personal Claude config.
- **Future option (Phase 3):** embedded terminal via `xterm.js` + local WebSocket PTY relay. Not recommended for MVP — OS window is simpler and Claude Code's TUI renders correctly there.

---

## 5. Workspace switch flow

| Aspect | JOI | PISI |
|--------|-----|------|
| Linear API key env | `LINEAR_API_KEY` | `LINEAR_API_KEY_PISI` |
| Write access | full automation | full automation |
| Applicable squads | CADENCE · PLAN · DEV · REVIEW · TEST | PLAN · DEV (CADENCE/REVIEW/TEST JOI-scoped by project config) |
| Workflow state model | Todo / In Progress / In Review / Done | fetched from PISI Linear API |
| Projects in signal views | Neo, AU | PISI |
| Terminal env injected | `LINEAR_WORKSPACE=joi` | `LINEAR_WORKSPACE=pisi` |
| Config › Projects tab | joi rows | pisi rows |
| Cost data | OpenRouter shared — same data | same |

**Implementation:**
1. User selects PISI → `useWorkspace()` context sets `workspace: "pisi"`, persisted in `localStorage`.
2. All `GET /api/issues?...` calls pass `?workspace=pisi` → API route picks `LINEAR_API_KEY_PISI`.
3. `lib/linear.ts` creates a new `LinearClient` instance with the correct key on each workspace change (or uses a factory keyed by workspace).
4. Agent card visibility: filtered by `config/projects.json → workspace` field per project.
5. Terminal spawn: API route reads `workspace` param, injects the correct `LINEAR_*` key from `.env`.
6. `GET /api/workspace-states?workspace=pisi` fetches PISI's actual workflow states from the Linear API on switch; stored in context for filter construction and display.

---

## 6. Config-edit flow

### Read path

On tab mount: `GET /api/config/<file>` → API route reads `config/<file>.json` (or `config/linear/<file>.json`), returns parsed JSON. UI renders as structured form fields (not a raw JSON editor).

A **[↺ Reload from disk]** button re-triggers the GET — for when Mateusz edits config files outside the UI.

### Write path

1. User edits fields, clicks **Save**.
2. UI sends `PUT /api/config/<file>` with modified JSON body.
3. API route:
   - Validates against Zod schema (server-side).
   - Creates backup: `config/.backups/<file>-<timestamp>.json`.
   - Writes new content atomically (write temp file → rename).
   - Returns `{ ok: true, backedUp: "config/.backups/models.json-20260623T1430Z.json" }`.
4. UI shows inline success/error with backup path.

### Validation rules

| File | Key rules |
|------|-----------|
| `models.json` | All `routing.*` values must be keys in `ids`. All `ids` values must have a `pricing` entry. No unknown top-level keys. |
| `projects.json` | `workspace` ∈ `{joi, pisi}`. `repo` must be a non-empty string. `deploy.type` ∈ `{gcp-vm, lambda-gpu}`. |
| `labels.json` | Group names match `^[a-z]+$`. Label names match `^[a-z][a-z0-9_-]*$`. No duplicate labels across groups. |
| `states.json` | No duplicate state names. Structure-only validation (each entry must have `name` + `type` fields). Does **not** enforce a fixed state list — JOI and PISI have different state models; hardcoding JOI's 4 states here would break PISI. |

### No auto-watch

The UI does not poll for external file changes. The `[↺ Reload from disk]` button is the explicit escape hatch.

---

## 7. Token dashboard flow

### Data sources

| Source | Provides | Latency | Role |
|--------|---------|---------|------|
| OpenRouter Activity API (`/api/v1/activity`) | Per-model tokens + cost, last 30 days, grouped by model+date | ~5 min | Primary |
| `config/models.json` pricing | Static input/output $/1M per model | Instant | Cost calculation fallback |
| Local SQLite token log (Phase 3) | Per-session usage from spawned terminals | Real-time | Optional granularity |

### Primary flow

1. UI: `GET /api/cost-report?since=2026-06-16` (7 days back by default).
2. API route: `execa('node', ['scripts/cost-report.mjs', '--json', `--since=${since}`])` → captures stdout.
3. Parses JSON (schema matches `printJson()` output in `scripts/cost-report.mjs`).
4. Returns structured response; client renders table + bar chart (recharts, already in 0_linear deps).

### Cost formula (matching the CLI script)

```
cost_calculated = (prompt_tokens / 1_000_000) × pricing[model].input
                + (completion_tokens / 1_000_000) × pricing[model].output
```

When `|cost_api − cost_calculated| > 10%`, the row shows a ⚠ divergence marker (same threshold as CLI).

### Budget alerts

- `COST_BUDGET_USD_PER_TASK` (default $2) is a per-task threshold, not per-area.
- The cost script computes `over_budget: total_cost > budget_per_task` for the aggregated period.
- Per-task alerts: the UI queries Linear for issues with the `over-budget` label and lists them below the chart.
- Nav tab dot turns red when `over_budget` issues exist in the active workspace.
- "Auto-refresh" checkbox: `setInterval` 60s fetch on the client. No WebSocket/SSE for MVP.

---

## 8. Keys / secrets flow

### Storage

- All keys in `.env` at repo root (gitignored; confirmed in `.gitignore`).
- `GET /api/keys` → reads `.env`, returns `{ key_name: "••••abcd" }` (last 4 chars only, never full key).
- `POST /api/keys` → receives full key values, parses current `.env`, replaces matching lines, writes back. Sends all keys at once to avoid partial writes.
- Keys are never stored in React state, localStorage, cookies, or sessionStorage.

### Test button

Each key's **[✓ Test]** button calls a lightweight verification endpoint:
- OpenRouter: `GET https://openrouter.ai/api/v1/auth/key` with the key.
- Anthropic: `GET https://api.anthropic.com/v1/models` (cheapest call).
- Linear JOI/PISI: `viewer { id, name }` GraphQL query on the respective workspace.
- Bot OAuth: `GET https://api.linear.app/api/graphql` with the token, check `actor=app`.

### Injection to spawned terminals

Keys are passed as environment variables to the child PowerShell process (see §4). They are not written to command-line args. The spawned process inherits them for the session duration only — they are not persisted in the new window's environment after the session ends.

---

## 9. Signal-view → Linear filter mapping

| View | Emoji | Linear filter (GraphQL) | UI actions |
|------|-------|------------------------|-----------|
| My Input | 🔔 | `label IN [needs:answer, needs:approval, needs:decision, needs:access]` | ✅ Approve (emoji react + remove needs:), 🚫 Changes, 🔁 Rework, ↗ Open in Linear |
| Agent Working | 🤖 | `assignee = @flow AND state.type IN [started]` — resolves to "In Progress" in JOI; uses PISI's equivalent `started`-type states when on PISI | Read-only. ↗ Open in Linear. |
| Attention | ⚠️ | `label IN [risk:high, escalated, over-budget, transcript-uncertain]` | ↗ Open in Linear. Red badge if count > 0. |
| Blocked | 🚧 | `label = blocked OR relation type IS blocked_by` | Shows blocker relation in row. ↗ Open in Linear. |
| Review / Test | 🧪 | `state.type IN [started] AND label = stage:testing` OR `state.type IN [started]` where state name matches the review-stage state — JOI: "In Review"; PISI: derived from fetched state list | ✅ Approve + move to Done, 🚫 Request changes (both workspaces). ↗ Open in Linear. |

**Implementation:** Each filter is a `@linear/sdk` GraphQL query behind `GET /api/issues?filter=<view_name>&workspace=<joi|pisi>`. Status-based filters (🤖 Agent Working, 🧪 Review/Test) use Linear `WorkflowState.type` (`started` / `completed`) from the fetched state list rather than hardcoded state names — this makes them work correctly for both JOI and PISI state models. The existing `lib/linear.ts` + `lib/issues-cache.ts` handle the SDK calls and 30s TTL cache.

---

## 10. Open questions — resolved where possible

| # | Question | Resolution |
|---|---------|-----------|
| 1 | Terminal: new OS window vs in-browser xterm.js? | **New OS window for MVP.** Simpler, Claude Code TUI renders correctly. Embed xterm.js in Phase 3 only if Mateusz decides to run the panel full-screen and needs in-browser terminal. |
| 2 | Per-session SQLite token log? | **Phase 3.** MVP uses OpenRouter Activity API. Add SQLite log only if per-session granularity becomes necessary (e.g., per-task cost breakdown beyond what OpenRouter provides). |
| 3 | Config backup retention? | **Keep last 20 per file** (simple counter on the API route). No time-based purge — disk cost is negligible. Mateusz can delete manually from `config/.backups/`. |
| 4 | PISI workspace: which squads run? | **PLAN and DEV** (mapped to pisi workspace in `config/projects.json`). CADENCE, REVIEW, TEST are JOI-scoped by project config — not a write restriction, just project scope. Add PISI variants when the PISI project warrants it. |
| 5 | Bot OAuth @flow: manual token or OAuth flow in UI? | **Manual token entry for MVP.** Mateusz generates the OAuth app token in Linear Settings → API → OAuth Apps, pastes it in Keys screen. Full OAuth callback flow is Phase 3. |
| 6 | Budget configuration: .env vs config screen? | **Config screen (Config › Model Routing tab), stored in .env.** `COST_BUDGET_USD_PER_TASK` shown as an editable field at the top of the Config › Model Routing tab. Writing it updates `.env` via the keys API route. |
| 7 | Dark mode? | **Respect system `prefers-color-scheme`** — keep the existing 0_linear toggle. No forced theme. |
| 8 | PISI state names for signal filters | **Use `WorkflowState.type` enum, not state names.** Linear's `type` field (`unstarted` / `started` / `completed` / `canceled`) is stable across workspaces. 🤖 Agent Working = `type=started`; 🧪 Review/Test = `type=started` filtered by review-stage signals (label or position in workflow). No mapping table needed. |

---

## 11. Phasing

### MVP (Phase 1) — build first, ~8 engineer-days

| Feature | Est. | Gate |
|---------|------|------|
| Global top bar + nav routing | 0.5d | Foundation |
| Workspace switcher (JOI/PISI) — localStorage + Linear client factory | 1d | All screens depend on it |
| Keys screen — .env read/write + Test buttons | 1d | Agents can't spawn without keys |
| Signal views — 5 filters + action buttons | 2d | Core HITL value |
| Agent launch cards + terminal spawn | 1.5d | Core agent-control value |
| Config: Model Routing editor — read/write models.json + model dropdown | 2d | Mateusz's #1 config need |

### Phase 2 — next sprint

| Feature | Est. | Notes |
|---------|------|-------|
| Token/cost dashboard | 2d | Depends on OpenRouter Activity API; recharts already in deps |
| Config: Projects editor | 0.5d | Simple table editor for projects.json |
| Config: Labels editor + Sync to Linear | 1.5d | Needs Linear label mutation API |
| Config: States editor + Sync to Linear | 1d | Needs Linear workflow state mutation API |
| Budget alert nav-tab badge | 0.5d | Reads over-budget label from Linear |

### Phase 3 — nice to have

| Feature | Est. | Notes |
|---------|------|-------|
| Embedded xterm.js terminal | 3d | Requires local WebSocket PTY daemon; only if Mateusz goes full-browser |
| Per-session SQLite token log | 1.5d | Spawned process writes usage on exit; cost dashboard reads it |
| Config backup browser (browse/restore .backups/) | 1d | |
| Bot OAuth callback flow in UI | 1.5d | Requires a registered callback URL in Linear OAuth app |
| Auto-refresh signal views with delta highlight | 0.5d | Poll every 30s, highlight newly appeared issues |

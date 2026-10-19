# Fenix dashboard v2 — UX spec (FOC-782)

Status: **draft for Mateusz's review**, 2026-10-11. Release: Fenix 1.0.0 (M8, epic FOC-768).
PRD: `docs/prd/fenix-1.0.0-release-prd.md` §6. Clickable mockups (7 artboards, private link):
https://claude.ai/artifact/RfX9GyqzbyWpSj7hUmEudX

This spec gates FOC-783…788: no v2 screen is built before it and the mockups are approved.

## 1. Principles (from what v1 taught us)

1. **One number, one source.** Every cost on screen is the reconciled value (transcript ground truth,
   FOC-760/761/769). A number that cannot be proven is labelled (`unattributed`, `stale`, `unknown`),
   never shown as if it were fine.
2. **Honest live state.** A child is "running" only when the process is alive *and* its tee grew
   recently. v1 showed a Supervisor running in a repo where none was (2026-09-05).
3. **The human's queue first.** The home screen answers "what needs me?" before anything else.
4. **Fast.** p95 API < 500 ms on the real store; ingest never runs on the request thread (v1 was slow
   because ingest blocked the server's event loop, FOC-547).
5. **Six areas, not twelve screens.** Every v1 screen is kept, merged or dropped with a reason (§3).
6. **Every chart says what it measures** and links to the evidence behind a point (2026-06 feedback:
   sliders and maps without meaning).
7. **Actions that leave the container ask first** — push, PR, gate answers, stopping a child — and are
   logged with who confirmed.

## 2. Information architecture

| area | route | question it answers |
|---|---|---|
| Cockpit (home) | `/` | What needs me, what is running, what is the Supervisor doing? |
| Work | `/work`, `/work/:ticket` | Where is each ticket, what did it cost, what is the evidence, can I push? |
| Team | `/team`, `/team/:squad` | How is the agent team built, and whom does each lead actually pick? |
| Costs & quality | `/costs` | What does a ticket cost (children + Supervisor), how much is rework, how often is it right first time? |
| Insights | `/insights/:group` | Money, Behaviour, Human steering, Flow — curated analyses from the telemetry notebook |
| Settings | `/settings/:section` | Keys, repositories, provider & routing, squads & prompts, retention |
| First run | `/welcome` | Shown until setup is complete (keys, repository, Linear team, models, Supervisor) |

Global chrome: left navigation (stacks on a phone), a **Needs-you** count on Cockpit, and a health
block (Supervisor, provider, telemetry freshness) at the bottom of the navigation.

## 3. v1 → v2 mapping

| v1 screen (lines) | v2 | decision | why |
|---|---|---|---|
| Live (312) | Cockpit › Live children | merge | the useful part is the live list; status must become honest (§5) |
| Manager (945) | **Team** (agent architecture as line-ups); ratings → Insights › Human steering | rebuild | decision 2026-10-11: the tactical board becomes a high-level diagram of the agent team — each lead picks its line-up from its roles, the rest sits on the bench; configuration links to Settings |
| Timeline (308) | Work › ticket detail (stage timeline) | merge | a Gantt of runs answers "what happened to this ticket" better per ticket |
| Runs (306) + RunDetail (323) | Work › ticket detail › evidence | merge | runs matter as evidence of a ticket, not as a list of their own |
| Tasks (639) | Work board + "Start a ticket" | merge | starting work belongs where tickets live |
| Costs (611) | Costs & quality | rebuild | v1 numbers came from registry cost (5× ground truth) and missed resumed turns |
| Analysis (265 + 6 panels) | Insights | keep + curate | asked for explicitly (2026-09-24); panels re-used, SQL console moves under an "Advanced" toggle |
| Flow (585) | Insights › Flow (generated architecture) | merge | the static pipeline config is replaced by generated, fresh architecture pages (FOC-779) |
| SquadConfig (857) | Settings › Provider & routing | keep | model routing per role with price + benchmark worked (ux-improvements verdict) |
| Prompts (417) | Settings › Squads & prompts | keep | prompt editing per role stays; one place for squad configuration |
| Ft (182) | — later (after 1.0, "Lab") | defer | decision 2026-10-11: fine-tuning stays, but after 1.0; the data it needs is kept (retention) |

## 4. Areas

### 4.1 Cockpit
- **Supervisor panel** with two views of the same session: **Chat** (default) and **Terminal**.
  Chat sends a message as a headless turn on the Supervisor session; Terminal attaches read-write.
  Header shows the focus ticket (FOC-769) and the model. Quick prompts: "Start a ticket…", "Status of
  all children", "What is blocked?".
- **Needs you** inbox, newest first: `Push` (ready branch), `Gate` (open gate record), `Decision`
  (STOP report waiting for an answer). Each item: ticket, age, one-line context, primary action, "Open
  evidence".
- **Live children**: id, ticket, squad colour + label, honest status (§5), age, cost so far.
- Header strip: spend today, tickets in flight, landed this week.

### 4.2 Work
- Board columns: Ready → Plan → Dev → Review → Test → Landed. Card: ticket id, title, flag (gate,
  child id, push, pushed), rounds, total cost.
- **Ticket detail** (side panel, `/work/:ticket`): stage timeline with notes, cost split (children,
  Supervisor share, total) with its reconciliation line, evidence links (verdicts, diff, merge verify
  log, child tees), actions: **Push branch…**, **Open PR…** (only when landed and checks green; both
  confirm and log), **Ask Supervisor**.
- **Start a ticket**: pick a Linear issue (filters: milestone, priority) → hands it to the Supervisor
  with the issue text. The Supervisor never picks tickets on its own (D2).

### 4.3 Team
- **Diagram** (high level, the agent architecture): You → Supervisor (coach) → four squad leads
  (PLAN, DEV, REVIEW, TEST, each with its model) → each lead's **line-up**: the roles it actually picks,
  as cards with a share bar, sorted by share; roles under 5 % sit on the **bench** card. Built from
  placed cards and arrows (editable), not one image.
- **Line-up detail** per squad (tabs): lead model, squad cost over 30 days, share of that cost the lead
  spends itself, subagent sessions, a table of roles (model, times picked, share, cost, line-up or
  bench) and one insight line; links to edit prompts, tools and models in Settings.
- **Three scopes** (decision 2026-10-11), same diagram and detail for each:
  - **Overall** — all tickets in a period.
  - **Group (filters)** — repository, milestone, epic, type, size, period; the detail table adds a
    column with the overall share for comparison. Example measured: in `jawnosc-wynagrodzen` the DEV
    lead does 31 % of its squad's work itself vs 77 % overall, implementer 68 % vs 50 %.
  - **Ticket (live)** — the team that actually worked on one ticket: squads that did not run are
    greyed (`not run`, `not started`), leads show their child id and status (`running`, `exited`), the
    numbers update while children run (poll ≤ 5 s or a server push). The Work ticket detail shows the
    same team compactly ("Team on this ticket") with a link here.
- Data: per scope, subagent sessions by role from the children's transcripts (lead + `subagents/`),
  priced per message — the same ground truth as costs (FOC-760/761). First measurement (30 days to
  2026-10-11, telemetry): DEV lead picks implementer 50 % and recon 33 %, refactorer never; REVIEW's
  `general-purpose` is 4 % of picks but $7.61 (more than security + first-pass); leads spend 50–91 %
  of their squad's cost themselves.
- **Status (2026-10-18, FOC-791):** delivered — `/team` (nav "Team", the v1 Manager stays at
  `/manager`), `GET /api/team` on the per-message priced `canonical_usage` turns, the three scopes,
  the Work ticket detail block, plan `docs/plans/foc-791-team-lineups.md`. Group filters today: period
  and repository (`config/projects.json` `ticketPrefix`); milestone, type, epic and size answer
  `filters.unsupported` until FOC-914 wires the Linear state. The ticket scope polls every 5 s (no
  server push); children come from the Supervisor registry (recent runs), costs from the telemetry
  task links.
- **Status (2026-10-19, FOC-914):** all five group filters live — milestone, type (label name), epic
  (the parent issue's identifier) and size (estimate) come from the Work board's Linear states lookup
  (`fetchLinearStates` extended with `parent`/`estimate`; the 60 s cache shared through the same
  seam). `filters.supported` reflects what the installation can really answer (Linear key present,
  lookup answered); offline the four stay `unsupported` with the reason in
  `filters.unsupportedReason` and a passed value narrows nothing — never a guess.

### 4.4 Costs & quality
- Period toggle 7d / 30d / All. KPI tiles: children cost per ticket p50 with p20–p80, all-in average
  per ticket, total spend, Supervisor share.
- Attribution banner while Supervisor attribution < 80 % (until FOC-769): shows the unattributed
  amount as overhead.
- Spend by day: children vs Supervisor, stacked.
- Quality signals with written definitions: first-time-right, rework share of cost, human
  interventions per ticket, landing yield. Headline set is chosen later (PRD §2).
- Most expensive tickets with "why" (the outlier rule that explains it, or "unexplained").

### 4.5 Insights
- Groups: **Money** (Supervisor overhead by week, outlier ledger), **Behaviour** (loop episodes),
  **Human steering** (acts of the human by topic), **Flow** (generated architecture, freshness badge,
  source revision, "Open in draw.io").
- Each panel: definition line, evidence link, data age. Analyses that need a local model (topic
  naming) stay in the notebook.
- **Status (2026-10-19, FOC-787):** the Money group is live on the Analysis screen (`/analysis?tab=`
  `tickets` | `money` | `outliers`) on the derived cache: price of a ticket per era (direct / loaded with
  the Supervisor allocation rule, p20/p50/p80 + bootstrap median CI), where the money goes (squads,
  Supervisor active/adjacent/idle, Gini / Lorenz / top-k) and the outlier ledger (MAD z + Tukey far,
  consensus ≥ 2; isolation forest and MCD stay in the notebook). Definitions ported 1:1 from the
  notebook's `fenix/` package; plan `docs/plans/foc-787-insights-panels.md`. Behaviour (loop episodes),
  Human steering and Flow stay in the notebook — they need text similarity / embeddings.

### 4.6 Settings
- **Keys**: OpenRouter, Linear, GitHub — masked, state, last check, Validate, Rotate.
- **Repositories**: cloned repos with index state, worktrees, HEAD; add by GitHub URL; bind-mount is an
  advanced option in `fenix.yaml`.
- **Provider & routing**: provider select (OpenRouter now; any compatible endpoint), pinned upstreams,
  per-role model table with price and benchmark (from v1), "Test provider". A child's model comes from
  this table only (FOC-762).
- **Squads & prompts**: per squad its roles; edit prompts and tools.
- **Retention**: keep everything (default) or limit to N days; disk usage of transcripts, telemetry and
  free disk; applied to Claude Code's `cleanupPeriodDays` and Fenix logs together.

### 4.7 First run
Five steps after `./fenix up`: keys (already validated in the terminal), repository (clone → index →
architecture pages, with progress), Linear team, models and optional per-ticket cap, Supervisor intro →
Cockpit. A side card repeats what the CLI printed and points to `./fenix doctor`.

## 5. Honest status model (children and Supervisor)

| status | rule (all from the registry, the process table and the tee) |
|---|---|
| running | process alive **and** tee grew within the stall window |
| waiting · gate | an open gate record for the child |
| stalled | process alive, tee silent longer than the stall window |
| exited N | process gone, exit code N recorded |
| unknown | the rule cannot be evaluated (missing process info or tee) — shown as unknown, never as running |

The check time is shown ("process + tee checked 4 s ago").

## 6. Data contracts

Re-used from v1 (cleaned up): `/api/squad-config` (routing), `/api/prompts*`, `/api/analysis/*`
(Insights panels), `/api/linear/queue`, `/api/verdict-evidence`, `/api/telemetry/health`.

New:

| endpoint | returns / does |
|---|---|
| `GET /api/cockpit` | Supervisor state + focus, Needs-you items, live children with §5 status |
| `POST /api/supervisor/message` | one chat turn on the Supervisor session |
| `WS /api/supervisor/terminal` | read-write terminal on the same session |
| `GET /api/work/tickets` | board: stage, flags, rounds, total cost per ticket |
| `GET /api/work/tickets/:id` | stage timeline, cost split + reconciliation line, evidence links |
| `POST /api/work/tickets/:id/start` | hand a Linear issue to the Supervisor |
| `POST /api/work/tickets/:id/push`, `/pr` | push / open PR after a confirm token; logged with who |
| `GET /api/team?scope=overall|group|ticket&…filters` | per squad: active, lead model + child status, squad cost, lead's own share, roles with picks, share, cost, line-up/bench; `group` adds the overall share per role; `ticket` is live (≤ 5 s) |
| `GET /api/costs?period=` | KPI tiles, spend by day, most expensive tickets |
| `GET /api/quality?period=` | the four quality signals with their definitions |
| `GET /api/artifacts` | generated artifacts with source revision and freshness |
| `GET/PUT /api/settings/{keys,repos,routing,retention}` | Settings round-trip; keys are write-only |

## 7. Design system

- **Type**: IBM Plex Sans (UI), IBM Plex Mono (ids, models, terminals, numbers in code).
- **Colour tokens**: ground `#f5f6f8`, surface `#ffffff`, subtle `#eef0f4`, border `#e3e6ec`, text
  `#111827`, secondary text `#4b5563` (4.5:1 on white), navigation `#111827`, accent `#4338ca`
  (active `#312e81`). Status: running `#1e40af` on `#e8efff`, waiting `#92400e` on `#fdf3e1`, ok
  `#065f46` on `#e6f6ee`, danger `#991b1b` on `#fdecec`. Squads (always with a text label): PLAN
  `#8e4b9a`, DEV `#0b67c2`, REVIEW `#b45309`, TEST `#047857`.
- **Shape and space**: radius 8 / 10 / 12, spacing 4 / 8 / 12 / 16 / 20 / 24, touch targets ≥ 44 px
  (36 px for secondary inline buttons).
- **Components**: navigation item, status chip, KPI tile, card button, inbox item, segmented tab group,
  data table in a scroll box, stage timeline, terminal block.
- **Accessibility**: real buttons and links, labelled inputs, `aria-selected` on tabs, charts with
  `role="img"` and a text label, colour never the only signal.

## 8. Performance and freshness

- p95 < 500 ms for every `GET` on the real store; heavy aggregates precomputed by the ingest worker.
- Ingest, reconciliation and artifact generation run in a worker, never on the request thread.
- Every panel shows its data age; older than 5 min → "stale" label.

## 9. Mockup data — what is real

Real (from 2026-10-10/11 measurements): children cost per ticket p20 $0.15 / p50 $0.36 / p80 $1.15,
total $568 over 30 days, Supervisor share 72 %, attribution 12 %, unattributed $362, FOC-403 children
$33.73, ticket ids and titles, models and prices, transcript and telemetry sizes. **Sample** (shape
only): spend-by-day bars, quality signal values, Supervisor shares per ticket, Insights panels,
7d / All periods.

## 10. Decisions (Mateusz, 2026-10-11)

1. Chat is the default view of the Supervisor conversation; Terminal is the second view.
2. The fine-tuning screen stays, but after 1.0 (backlog task).
3. The Manager's tactical board becomes **Team**: a high-level diagram of the agent architecture where
   each lead picks its line-up (§4.3).
4. Light theme only for 1.0; dark theme is a backlog task.

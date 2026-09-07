---
type: spec
status: draft
audience: Mateusz (approval) → GLM (build)
tags: [type/spec, area/ui, topic/manager]
created: 2026-09-06
issue: FOC-225
plan: agents/supervisor/plans/greedy-popping-wilkes.md
rewards: fenix-manager-rewards.md
---

# Fenix Manager — tactical board and agent profiles (build spec)

This document is the build contract for the `/manager` screen: product model, annotated
layouts, states and interaction contracts. The reward system is specified separately in
[fenix-manager-rewards.md](fenix-manager-rewards.md). Source design:
`agents/supervisor/plans/greedy-popping-wilkes.md` (user-approved).

**One rule above all: the board is a view. Moving a card changes pixels, never execution.**

## 0. What already exists (do not rebuild)

| Asset | Where | Use in Manager |
|---|---|---|
| React 18 + Router 6 + Vite 5, no UI/chart libs | `ui/package.json` | same stack, no new deps |
| Theme tokens (light graphite palette, `--sq-*` squad accents) | `ui/src/theme.css` | manager styling derives from these; scoped manager CSS only |
| `getSquadConfig()` → `{squads, pricing, providers}` | `ui/src/api.js` → `/api/squad-config` | squads, lead, roles, configured models, tools |
| `getPromptRole(squad, role)` / `getPromptLead(squad)` | `/api/prompts/role`, `/api/prompts/lead` | inspector Instructions tab (read-only this slice) |
| `getPromptRuns(squad, limit)` | `/api/prompts/runs` | inspector History tab (squad-level runs) |
| Provider catalogue + pricing | inside squad-config payload | model display; no invented model names |
| Existing routes Live/Timeline/Runs/Costs/Tasks/Flow/SquadConfig/Prompts | `ui/src/App.jsx` | preserved untouched; Manager is additive |
| `readAgentConfigs` role shape `{model, tools}` | `scripts/squad-config.mjs:195` | role identity source of truth |

## 1. Product model

- **Squad = team. Role = position. Model = current configured assignment. Prompt/tools = instructions and capabilities. Run = one execution.**
- Role identity is stable: *orchestration installation + squad + role key*. We do NOT invent
  persistent individual-agent identities and we do NOT infer role identity from a shared model name.
- The board shows **configured** state (what the installation will launch next). Observed runtime
  activity (slice 2) is squad-level only, served by a bounded manager-snapshot endpoint; the live
  overlay renders only what the snapshot states, never a fake live status.
- The supervisor is the **coordinator**: rendered as a distinct coordinator card with an honestly
  empty specialist list — not as an invented football position.
- Repository filtering (slice 2) controls observed activity only, never the scope of configuration edits.
- Unattributed activity stays at squad level. Per-role live attribution is explicitly out of v1
  (binding decision: it needs manifest/launcher/store work and separate approval).

## 2. Information architecture

```
Fenix sidebar
├─ Manager  (/manager)          ← NEW, first nav entry
│   ├─ header: squad selector · Setup/Live switch · freshness (config read + live poll) · connectivity · unsaved-edit slot
│   ├─ left rail: squad list + compact roster of selected squad
│   ├─ center: tactical board (role cards) | roster table fallback
│   └─ right: inspector (Profile / Instructions / History / Achievements)
├─ Live        (/)              ← existing, untouched
├─ Timeline    (/timeline)
├─ Runs        (/runs)
├─ Costs       (/costs)
├─ Tasks       (/tasks)
├─ Flow        (/flow)
├─ Konfiguracja (/squad-config) ← advanced tools; remains the editing surface
└─ Prompty     (/prompts)
```

`Setup / Live` is a visible switch from day one: slice 1 shipped Setup (configured view); slice 2
activates Live (squad-level telemetry overlay, §3.6). Live polls a bounded snapshot endpoint and
renders only what it states — never fake live data.

## 3. Screens

### 3.1 Tactical board (center)

```box
┌ Manager — squad: dev ────────────────────────────────────── [Setup|Live] ─┐
│ freshness: config read 14:32:05 · all data read-only this slice           │
├──────────┬──────────────────────────────────────────────┬────────────────┤
│ SQUADS   │  BOARD  [board⇄list]  [reset layout]         │ INSPECTOR      │
│ ▸ dev    │  ┌────────────┐      ┌────────────┐          │ [Profile]      │
│ ▸ plan   │  │ LEAD       │      │ implementer│          │ [Instructions] │
│ ▸ review │  │ model: …   │      │ model: …   │          │ [History]      │
│ ▸ test   │  └────────────┘      └────────────┘          │ [Achievements] │
│ ▸ cadence│  ┌────────────┐      ┌────────────┐          │                │
│ ──────── │  │ recon      │      │ debugger   │          │ (tab content)  │
│ ROSTER   │  └────────────┘      └────────────┘          │                │
│ · lead   │  ⓘ Board positions are presentation only.    │                │
│ · recon  │    They never change execution order,        │                │
│ · …      │    membership, autonomy or permissions.      │                │
└──────────┴──────────────────────────────────────────────┴────────────────┘
```

**Card content (compact, fixed hierarchy):** role key (title) · configured model (mono) ·
tools summary (`3 tools: Edit, Bash, +1`) · explicit state chip. The coordinator card shows the
squad lead and its provider; a squad with no roles renders its empty state, not a placeholder
role.

**State chips (slice 1, configuration-truthful):**

| Chip | Icon + label | Meaning | Never means |
|---|---|---|---|
| `configured` | ✓ configured | role has a model assignment | — |
| `unconfigured` | ○ not configured | `model` is null in config | an error; a role may be prompt-only |
| `unknown` | ? unknown | model string not resolvable in provider catalogue | a invented fallback name |
| `running` (live) | ▶ running | store run unended and the process is not known dead (liveness unknown still renders running — the gap is listed in the snapshot's `missing[]`) | an accepted task; a squad or role attribution |
| `waiting for decision` (live) | ⏸ waiting for decision | a pending supervisor gate record exists | anything inferred from run state — only real pending gate records count |
| `failed` (live) | ✕ failed | run ended with a non-zero exit code | any supervisor verdict |
| `finished · unverified` (live) | ✓ finished · unverified | run ended with exit 0 and no supervisor pass verdict | accepted work |
| `accepted` (live) | ★ accepted | supervisor pass verdict keyed to the task (latest round) | exit 0 alone — exit 0 is never acceptance |
| `unknown` (live) | ? unknown | missing fields or contradicting liveness (unended but process dead) | a guessed state |
| `stale` (live) | ⏱ stale data | no successful fetch within 15 s (the header ages the last success, `lastSuccessAt`); a failed poll is flagged immediately | live truth — the last known board is kept and labelled |

No chip is encoded by color alone: every chip pairs an icon glyph with text. Colors validate
against the dataviz categorical/status palette (see §5).

**Positions are presentation-only.** Initial layout: lead/coordinator top-center, specialists
grouped below — grouping is visual convention, NOT an execution edge. No arrows between cards
in slice 1 (the executable graph view of `config/graph.json` is a different screen concern;
conflating them here is the exact failure the design forbids).

**Repositioning contract:**

1. **Pointer drag** on a card (grab cursor; card lifts with shadow while dragged; no animation loops).
2. **Keyboard**: card is focusable (`Tab`); when focused, `Arrow keys` move by step, `Shift+Arrow`
   moves by large step, `Enter` selects the role (opens the inspector); a visible "Reset layout" button restores defaults.
   Focus never moves the card silently: every move is announced by a visually-hidden live region
   ("recon moved to 34%, 60%").
3. Positions are normalized `{x, y}` percentages clamped to the board bounds; they persist per
   **installation + squad** under a versioned schema (v2) in `localStorage`. Schema migration from
   the unversioned shape and corrupt/unknown-version recovery are tested (see §6).
4. The distinction is stated visibly on the board itself (`ⓘ` note above, always rendered, not a
   tooltip) — because a manager-looking board invites exactly the wrong assumption.
5. Moving a card never triggers a fetch, a config write, or a state change beyond layout.

**Roster fallback:** a `board ⇄ list` toggle plus an automatic narrow-screen breakpoint
(`<900px`): the list is a semantic table (role · model · tools · state) that carries the same
data. The board is decorative layout; the table is the accessible source of truth. Screen-reader
users get the table via the toggle; keyboard users can use either.

### 3.2 Left rail (squads + roster)

- Squad list from the real payload; selected squad highlighted; counts (`dev · 6 roles`).
- Compact roster under the squads list: role keys with state dots (icon+text on hover/focus,
  text always in the table fallback). Clicking a roster entry selects the role and opens the
  inspector — same as clicking a board card.
- Supervisor squad: roster area shows "coordinator only — no specialist roles configured". Honest
  emptiness; no placeholder roles, no invented identities.

### 3.3 Inspector (right)

Tabs: `Profile | Instructions | History | Achievements`. Unsaved-edit protection belongs to the
config-editing increment (slice 1 part 2); this slice is read-only, so there is nothing to lose —
the tab bar still reserves the unsaved indicator slot so the contract does not change shape later.
(Slice 1 part 2 fills that slot: the Instructions tab shows the unsaved dot while a prompt draft
is open.)

| Tab | Slice 1 content | Source |
|---|---|---|
| Profile | role key, squad, configured model (labelled **configured**) with a free-text model editor + suggestions, provider, tools list, staged `from → to` chip, and — explicitly separated — **observed runtime model: not shown in v1 (live state is squad-level only; per-role attribution needs manifest/launcher/store work)** | squad-config |
| Instructions | prompt document edited in place through the guarded MarkdownEditor flow (Anuluj / dry run / Zapisz); a draft shows the unsaved dot and the switch confirm; frontmatter is preserved; PromptContext below for reference | `/api/prompts/file` |
| History | live snapshot for the squad: bounded active + recent runs with derived state chips, pending-gate badge, cost (partial while unended); an empty window renders "no runs in the bounded window for this squad". Since slice 3 a **Rating** column carries the human rating authoring surface: ended runs with a task get a ★-select + optional note + explicit Save (subjective, standalone — never XP); rows without a recorded rating read "not rated", never 0/5; non-rateable rows (active, no task) render `—` | `/api/manager/snapshot` + `/api/manager/rewards` |
| Achievements | rewards aggregates for the squad (slice 3): XP + level, evidence-backed badges, the bounded recent-records table (award/revocation/rating glyphs, points, when, evidence id) and the product-rules note. A squad with no records is the first-class **"awaiting verified evidence"** state — never zeros. Aggregates only: rating authoring lives in the History rows | `/api/manager/rewards` |

The configured-vs-observed split is a hard rule: a card and the Profile tab must never blend
"what is configured" with "what actually ran" into one field.

### 3.4 Loading / error / empty / stale

| Condition | Rendered |
|---|---|
| Loading | skeleton board: real card count is unknown → generic pulse blocks + text "loading squads…"; no spinner-only screens |
| Backend error | full-panel error card with the exact failed endpoint, a Retry button, and the backend start hint (`node scripts/telemetry-server.mjs`); header dot goes red with text "offline" |
| Empty roles | coordinator card + "no specialist roles configured" (supervisor case) |
| Squad unknown in URL | falls back to first squad, selector reflects it |
| Stale data | config data is read-on-demand (freshness shows the read time). Live mode: a failed poll keeps the last known snapshot labelled "live update failed — showing last known from …" with a Retry button; no successful fetch within 15 s (aged from `lastSuccessAt`, the last success — not per-snapshot timestamps) is labelled stale. The board never blanks |
| Rewards | awaiting squad → "awaiting verified evidence" card (never zeros); fetch error → error card with Retry; header chip renders only once records exist |

### 3.5 Visual direction

Graphite and dense: existing light-graphite theme tokens (`--surface-2` panels, `--border`
hairlines, `--sq-*` accents for squads), compact 12–13px type scale, monospace for models/role
keys. Board field: restrained dotted grid (CSS background), no game artwork, no game engine, no
external assets. Motion limited to: selection highlight, drag lift, chip transitions — all
disabled under `prefers-reduced-motion: reduce`. No looping/idle animation of any kind: a card
that looks busy without evidence behind it is a lie.

### 3.6 Live telemetry overlay (slice 2)

The Live side of the switch renders squad-level activity from one read-only endpoint —
`GET /api/manager/snapshot` (paramless in v1) — built by `scripts/manager-snapshot.mjs` on top of
the existing telemetry store/status readers. The query is bounded (active runs ≤ 25, recent ≤ 5
per squad, supervisor scan ≤ 20 dirs, ≤ 10 real liveness checks per snapshot) and served through
a 3 s single-flight TTL cache; `/manager` never calls `/api/runs` or `/api/prompts/runs`.

**Snapshot → UI state mapping (hard rules):**

- `running` = store run unended and the process is NOT known dead. An unended run whose process
  is dead is `unknown`, never "running". Liveness that cannot be determined (no manifest, no
  pid, cap reached, checker failed) does NOT demote the run: it stays `running` and the gap is
  reported in the snapshot's `missing[]` — this matches the shipped client mapping
  (FOC-225 cleanup round C6e).
- `waiting for decision` = a pending supervisor gate record exists. Never inferred.
- `failed` = ended + non-zero exit code. `finished · unverified` = ended + exit 0 (the default).
- `accepted` = a supervisor pass verdict keyed to the task (latest round wins; fail never
  promotes). Exit 0 alone is NEVER acceptance. Verdict records carry no REVIEW/TEST kind marker —
  documented v1 caveat.
- Runs without a squad attribution land under `unknown` and are listed in the snapshot's
  `missing[]`; every absent field (no manifest dir, liveness cap reached, absent manifest,
  no pid, no checker, unreadable record) is documented there, never guessed.

**Rendered surface:** header freshness (live poll time, `(cached)` when served from the TTL
cache, failure/stale warnings + Retry); a squad live strip (state chip + active-run count +
pending-decision badge); live state chips in the squad rail; inspector History live runs with a
non-interactive gate badge (a `<span>` pointing to the supervisor window — no answer controls).

**Polling:** `useLivePoll` ticks every 5 s with ×2 backoff capped at 60 s, skips a tick while a
request is in flight, pauses on `document.hidden` and while Setup is active, resumes on refocus
and on Live entry. Motion exists only on an observed transition between consecutive snapshots
(one-shot pulse, gated behind `prefers-reduced-motion: no-preference`); leaving Live mode (or
losing the snapshot) discards the last-seen states, so re-entry seeds fresh instead of replaying
pulses. Before the first snapshot arrives the strip shows a neutral "awaiting first snapshot…";
an empty store renders honest emptiness — "no activity in the bounded window" — never fake idle
activity.

### 3.7 Rewards and manager ratings (slice 3)

One read endpoint — `GET /api/manager/rewards` (build by `scripts/reward-ingest.mjs`, append-only
ledger `scripts/reward-ledger.mjs` in a dedicated `rewards.sqlite`, never `telemetry.sqlite`) —
plus one authoring endpoint, `POST /api/manager/ratings`. There is deliberately **no XP submitter**:
acceptance credit is derived from supervisor verdicts (ingest on read, 30 s single-flight TTL cache
around the ingest only — squads/ratings/held are read fresh per payload build).

- **Header chip** (next to the squad selector): `★ L{level} · {xp} XP` with the product-rules label
  as `title`. Renders only for a squad with records; digit grouping is non-breaking so the chip
  never wraps mid-number.
- **Achievements tab**: XP + level, badges (evidence-backed distinct verified delivery counts —
  display facts that unlock nothing), bounded recent-records table (★ award / ↩ revocation / ✎
  rating glyphs, points, when, evidence id), squad-level-only + product-rules notes, and the held
  count for unresolvable pass verdicts. Awaiting is the first-class empty state.
- **History Rating column**: the only human-authoring surface. Select seeds from the recorded
  rating; Save is enabled only for a real staged delta; every save is a supersession (new latest
  record). Staging a rating raises the unsaved-work guard (`editingGuardActive` gains an additive
  `ratingDirty` input) and the switch confirm covers a staged rating.
- A rating is subjective and standalone: it never carries XP, is never averaged with the
  acceptance verdict, and "not rated" is never rendered as 0/5. Revocations are verdict-driven
  only and are recorded as audit rows (active flag + negative points), so XP returns to its
  pre-award value.

## 4. Interaction contracts (numbered, testable)

1. Selecting a squad re-renders board, roster and inspector from that squad's real config; URL
   query `?squad=` reflects and restores the selection.
2. Selecting a role (card, roster entry, or table row) opens the inspector for exactly that role;
   `aria-selected` is set on the active tab; focus is managed on tab switch.
3. Dragging/keyboard-moving a card updates only layout state; a network observer (test) confirms
   zero fetches during movement.
4. "Reset layout" restores default positions for the squad and persists the reset.
5. Layout persists across reload per installation+squad; a v1-shaped stored record migrates to v2;
   corrupt records fall back to defaults without throwing.
6. Every status renders icon+text; contrast validates via the dataviz palette validator.
7. Narrow viewport (`<900px`) or manual toggle swaps the board for the accessible table.
8. No control on this screen launches, stops, answers gates or pushes. Writes are `localStorage`
   layout prefs and — since slice 1 part 2 — configuration/prompt edits that stage first and go
   through the shared dry-run preview → explicit apply flow (see §7 pointers removed below);
   nothing starts or stops work.
9. Existing routes render exactly as before (regression: navigation smoke test).

## 5. Palette

- Status: `configured` → existing `--ok` pair; `unconfigured` → neutral `--muted`/`--faint`;
  `unknown` → `--warn` pair. Slice 2 will add running/waiting/failed/stale from the same tokens
  (`--run`, `--warn`, `--danger`) — reserved, not rendered this slice.
- Squad accents reuse `--sq-*`; the coordinator uses `--sq-supervisor`.
- The categorical/status combination is run through the dataviz palette validator before shipping;
  result recorded in the slice hand-off.

## 6. Acceptance criteria (slice 0 + slice 1 part 1)

- [ ] `docs/ui/fenix-manager.md` + `docs/ui/fenix-manager-rewards.md` exist, English, matching this contract.
- [ ] `/manager` route + nav entry added additively in `ui/src/App.jsx`; all eight existing routes still render.
- [ ] Board, roster and inspector render **real** squads/roles/models/tools from `/api/squad-config`; no hardcoded agent identities anywhere in `ui/src/manager/**`.
- [ ] Supervisor renders as coordinator with honest empty role list.
- [ ] Repositioning works by pointer AND keyboard, with reset; movement issues zero network calls; the presentation-only note is visibly rendered on the board.
- [ ] Layout prefs: versioned v2 schema, keyed by installation fingerprint + squad, stored in `localStorage`; v1 migration and corrupt-record recovery covered by tests.
- [ ] Roster table fallback via toggle and `<900px` breakpoint; every status chip icon+text.
- [ ] `prefers-reduced-motion` disables board/chip transitions.
- [ ] Loading, error (with retry + backend hint), empty and rewards-pending states are real — no fake activity, no zeroed achievement records.
- [ ] Tests for identity mapping (squad/role/model/tools from a real-shaped fixture), unknown model/role handling, and layout persistence+migration run under `npm --prefix ui test`; `npm --prefix ui run build` passes.
- [ ] No POST/apply calls existed in manager code in slice 1 part 1 (superseded by part 2 below).

## 6b. Acceptance criteria (slice 1 part 2 — config/prompt editing)

- [ ] Manager stages model assignments into the SAME working copy `/squad-config` uses
      (`ui/src/squadConfig/workingCopy.js` is the single shared writer; `/api/squad-config`
      is the only config endpoint; no second writer, no silent start of work).
- [ ] Every write is visible first: staged count badge, per-role `from → to` chip, edit bar with
      Preview changes / Apply / Discard; apply stays disabled until a dry-run preview succeeded.
- [ ] Preview (dry run) reports file-level before/after and server warnings without writing;
      apply re-reads the config and shows next-launch semantics; discard restores server truth.
- [ ] Failed preview/apply report honestly ("nothing was written"), keep staging, and distinguish
      per-endpoint outcomes — config and prompt saves are separate endpoints, never a claimed
      combined atomic save.
- [ ] Prompt edits go through the guarded MarkdownEditor flow (same as Prompts screen); the
      Instructions tab shows an unsaved dot, the header reports the draft, switching role/squad
      or navigating away with a dirty draft asks for confirmation; scope note distinguishes
      installation-global model changes from repository activity filters (slice 2).
- [ ] `/squad-config` behavior preserved after the workingCopy extraction (its suites pass).
- [ ] Tests for staging, dirty counting, save payloads, error normalization, suggestions, prompt
      paths, guard predicate and role counts run under `npm --prefix ui test`; build passes.

## 6c. Acceptance criteria (slice 2 — live telemetry overlay)

- [ ] `GET /api/manager/snapshot` is read-only, paramless and bounded; the TTL cache is
      single-flight (a caller during recompute gets the previous snapshot as `cached`); build
      errors keep the previous snapshot; no secrets in the payload (tested).
- [ ] `/manager` fetches only `/api/manager/snapshot` for live data — never `/api/runs` or
      `/api/prompts/runs` (network-observer check).
- [ ] State mapping follows §3.6 exactly: contradiction is `unknown`, gates are never inferred,
      exit 0 alone is never `accepted`; squad-less runs are `unknown` + `missing[]` entries.
- [ ] Disconnect keeps the last known board with a failure/stale label and a Retry button; Retry
      restores live updates once the backend returns.
- [ ] An empty store renders "no activity in the bounded window" / "no runs in the bounded
      window" — no chips, no fake running, no motion.
- [ ] Flash animation fires only on an observed transition between consecutive snapshots and is
      gated behind `prefers-reduced-motion: no-preference`; no looping animation exists.
- [ ] Inspector History is snapshot-driven; the gate badge is a non-interactive `<span>`;
      inspector tabs navigate with Arrow keys (roving focus, no wrap, Home/End) — a11y ride-along.
- [ ] `npm --prefix ui test` (50 tests), `npm --prefix ui run build` and
      `node scripts/test-all.mjs telemetry` (10/10 suites) pass; a CDP browser drive on the
      isolated fixture covers setup/live/disconnect/reconnect/reduced-motion/1024-1440px/empty.

## 7. Out of scope (parked, with pointers)

- ~~Config/prompt editing inside Manager~~ — delivered in slice 1 part 2 (shared
  `workingCopy.js` + guarded MarkdownEditor; `ui/src/screens/SquadConfig.jsx` keeps its route).
- ~~Live telemetry overlay, gate visibility~~ — delivered in slice 2 (squad-level; bounded
  `/api/manager/snapshot` + 5 s poll; see §3.6).
- Per-role live attribution — explicitly declined for v1; needs manifest/launcher/store work and
  separate approval.
- ~~Reward ledger, XP, ratings~~ — delivered in slice 3 (append-only ledger + verdict-driven
  ingest + header chip / Achievements / History rating authoring; see §3.7 and
  [fenix-manager-rewards.md](fenix-manager-rewards.md)).
- Launch/stop/gate buttons on the board — rejected by design; `/api/launch` opens standalone
  terminals, which must not be presented as supervised orchestration.

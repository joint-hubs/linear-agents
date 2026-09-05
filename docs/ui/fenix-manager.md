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
  activity arrives in slice 2 via a telemetry adapter; until then cards carry an explicit
  "no live activity shown" contract, never a fake live status.
- The supervisor is the **coordinator**: rendered as a distinct coordinator card with an honestly
  empty specialist list — not as an invented football position.
- Repository filtering (slice 2) controls observed activity only, never the scope of configuration edits.
- Unattributed activity stays at squad level (slice 2 rule, stated now so the UI never assumes otherwise).

## 2. Information architecture

```
Fenix sidebar
├─ Manager  (/manager)          ← NEW, first nav entry
│   ├─ header: squad selector · Setup/Live switch (Setup active in slice 1) · freshness · unsaved-edit slot
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

`Setup / Live` is a visible switch from day one: slice 1 ships Setup (configured view). The Live
side is disabled with a tooltip "live overlay arrives with telemetry integration (slice 2)" —
the switch communicates the planned model without faking live data.

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
| live states (running/waiting/failed/stale) | — | **absent in slice 1** — arrive with slice 2 evidence adapter | — |

No chip is encoded by color alone: every chip pairs an icon glyph with text. Colors validate
against the dataviz categorical/status palette (see §5).

**Positions are presentation-only.** Initial layout: lead/coordinator top-center, specialists
grouped below — grouping is visual convention, NOT an execution edge. No arrows between cards
in slice 1 (the executable graph view of `config/graph.json` is a different screen concern;
conflating them here is the exact failure the design forbids).

**Repositioning contract:**

1. **Pointer drag** on a card (grab cursor; card lifts with shadow while dragged; no animation loops).
2. **Keyboard**: card is focusable (`Tab`); when focused, `Arrow keys` move by step, `Shift+Arrow`
   moves by large step, `Enter`/`Esc` deselects; a visible "Reset layout" button restores defaults.
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

| Tab | Slice 1 content | Source |
|---|---|---|
| Profile | role key, squad, configured model (labelled **configured**), provider, tools list, and — explicitly separated — **observed runtime model: not shown yet (slice 2)** | squad-config |
| Instructions | prompt document for the role, read-only, with "edits happen in Prompty (/prompts) — next-launch semantics apply there" pointer | `/api/prompts/role` |
| History | squad-level recent runs (runId, task, status label, started, cost) — labelled "squad-level; per-role attribution arrives in slice 2" | `/api/prompts/runs` |
| Achievements | "Rewards arrive in a later slice — nothing recorded yet" pending state. **No zeroed fake records.** | — |

The configured-vs-observed split is a hard rule: a card and the Profile tab must never blend
"what is configured" with "what actually ran" into one field.

### 3.4 Loading / error / empty / stale

| Condition | Rendered |
|---|---|
| Loading | skeleton board: real card count is unknown → generic pulse blocks + text "loading squads…"; no spinner-only screens |
| Backend error | full-panel error card with the exact failed endpoint, a Retry button, and the backend start hint (`node scripts/telemetry-server.mjs`); header dot goes red with text "offline" |
| Empty roles | coordinator card + "no specialist roles configured" (supervisor case) |
| Squad unknown in URL | falls back to first squad, selector reflects it |
| Stale data | slice 1 data is read-on-demand; the freshness line shows read time. Stale-warning behavior activates with slice 2 polling |
| Rewards | always "pending — arrives in a later slice" (never zeros) |

### 3.5 Visual direction

Graphite and dense: existing light-graphite theme tokens (`--surface-2` panels, `--border`
hairlines, `--sq-*` accents for squads), compact 12–13px type scale, monospace for models/role
keys. Board field: restrained dotted grid (CSS background), no game artwork, no game engine, no
external assets. Motion limited to: selection highlight, drag lift, chip transitions — all
disabled under `prefers-reduced-motion: reduce`. No looping/idle animation of any kind: a card
that looks busy without evidence behind it is a lie.

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
8. No control on this screen launches, stops, answers gates, pushes, or writes any configuration
   in slice 1. The only writes are to `localStorage` layout prefs.
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
- [ ] No POST/apply calls exist in manager code this slice; `grep` for `post` in `ui/src/manager/**` finds none.

## 7. Out of scope (parked, with pointers)

- Config/prompt editing inside Manager (staged changes, preview/apply, unsaved-edit protection,
  next-launch semantics) → slice 1 part 2, reusing SquadConfig working-copy logic and the guarded
  prompt file-edit flow; `ui/src/screens/SquadConfig.jsx` stays the owner of its route meanwhile.
- Live telemetry overlay, per-role activity, gate visibility → slice 2
  (pure adapter + bounded polling; see plan §2).
- Reward ledger, XP, ratings → [fenix-manager-rewards.md](fenix-manager-rewards.md) (slice 3).
- Launch/stop/gate buttons on the board — rejected by design; `/api/launch` opens standalone
  terminals, which must not be presented as supervised orchestration.

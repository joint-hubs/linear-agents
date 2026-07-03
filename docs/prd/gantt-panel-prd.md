# Gantt & Fast-Linear Panel — PRD (port gantt-pisi features into 0_linear)

**Status:** Draft (for Mateusz approval before delegation)
**Date:** 2026-06-26
**Owner:** Mateusz
**Repos:** `Desktop/experiments/0_linear` (Next.js 16, React 19, Tailwind v4, @linear/sdk, better-sqlite3, recharts, d3) — ALL code lands here.
**Backlog ref:** new Phase G in `docs/BUILD-BACKLOG.md`.
**Source of ported patterns:** `jointhubs-os/gantt-pisi` (Python FastAPI + vanilla JS) — read-only reference; we port patterns/features, not code (different stack).

## 1. Goal

Two problems, one panel:

1. **Slow Linear.** 0_linear re-fetches Linear issues on every load that misses the 5-min
   in-memory cache (`lib/issues-cache.ts`, lost on dev restart). Feels slow. gantt-pisi's
   trick: persist a snapshot to disk, serve the UI from the snapshot, hit Linear only on
   explicit refresh. Port that pattern.
2. **Gantt is read-only.** `components/GanttView.tsx` renders static bars from Linear-native
   timestamps (startedAt/createdAt → completedAt/dueDate). No drag/resize, no dependencies,
   no critical path, no write-back. Port gantt-pisi's interactive planning model on top.

Mateusz's words (2026-06-26): "za każdym razem musi pobierać taski z lineara nie działa to
tak dobrze… drugie repo ma fajne featury można by było te dwa repo połączyć." Decision
(2026-06-26): scope = **fast UI + port gantt-pisi features** (not a literal repo merge — the
stacks differ; we port patterns into 0_linear).

## 2. Decisions (taken, 2026-06-26)

- **All code in 0_linear.** gantt-pisi is a read-only reference for patterns + UX, never a
  runtime dependency. No Python, no shared `linear_api.py` import. Stay Next.js/TS.
- **Snapshot on disk** replaces in-memory-only cache for issues. UI reads snapshot; Linear
  API hit on (a) manual refresh button, (b) optional background refresh. Snapshot survives
  dev restarts — kills the "first load after restart is slow" complaint.
- **Planning layer is local, not Linear-native.** Linear has no start/duration/deps/lock for
  a planned gantt. We add a local per-task planning store keyed by Linear issue id, persisted
  to disk (mirrors gantt-pisi `gantt.json` task fields), merged into the snapshot served to UI.
- **Write-back is explicit and batched** (gantt-pisi's due-date approval flow): user edits the
  gantt, changes accumulate, an "Approve & push to Linear" action batches `updateIssue`
  mutations. No silent writes on every drag.
- **Workspace:** keep 0_linear's current workspace (jointhubs/FEN). Multi-workspace (pisi)
  is explicitly OUT of scope for this PRD (separate decision later).

## 3. Architecture

### 3.1 Issues snapshot — `lib/issues-snapshot.ts` (new)

- `loadSnapshot()` → reads `data/issues-snapshot.json` (issues + states + `_meta:lastRefresh`).
  If missing or stale, falls back to in-memory cache / live fetch.
- `writeSnapshot(data)` → atomic write (`.tmp` + `os.replace`, gantt-pisi pattern) —
  survives crashes.
- `refreshFromLinear()` → `lib/linear.ts:fetchAllIssues` + `fetchAllStates` → build snapshot
  → writeSnapshot → also refresh in-memory cache. Returns fresh data.
- `GET /api/issues` (`app/api/issues/route.ts`): serve from snapshot (fast). `?refresh=1` →
  `refreshFromLinear()` first. Keep existing cache as a hot tier; snapshot is the cold tier.
- New `POST /api/issues/refresh` (or reuse `?refresh=1`) — the "↻ Linear" button target.
- Background refresh: optional `lib/issues-snapshot.ts` refresh-on-interval (env
  `LINEAR_REFRESH_MS`, default off) started in route or a route segment. Phase 2.

Data flow after Phase G1:
```
Linear API --[refresh button / background]--> data/issues-snapshot.json (disk, atomic)
   --[GET /api/issues]--> lib/issues-cache.ts (hot, 5min) --> browser
```

### 3.2 Planning layer — `lib/planning-store.ts` (new)

Local per-task planning state, persisted to `data/planning.json`, keyed by Linear issue id.

```json
{
  "_meta": { "version": 1, "lastSaved": "..." },
  "tasks": {
    "<linearIssueId>": {
      "plannedStart": "2026-07-01",      // overrides derived start
      "plannedDurationDays": 5,           // overrides derived end
      "deps": ["<linearIssueId>", "..."], // finish-to-start predecessors
      "locked": false                     // locked = immune to auto-shift cascade
    }
  }
}
```

- `getPlanning(issueId)`, `setPlanning(issueId, patch)` (atomic write), `allPlanning()`.
- Merge: `GET /api/issues` (or a new `/api/planning` joined view) returns issues enriched
  with their planning record. UI bar dates: `plannedStart ?? derivedStart`,
  `plannedStart + plannedDurationDays ?? derivedEnd`.

### 3.3 Interactive Gantt — `components/GanttView.tsx` (extend)

Current capability (verified): zoom day/week/month, swimlane group-by
(parent/cluster/team/assignee/project), filter, tooltip, today line, legend, localStorage
config. Bars are static SVG `<rect>` from native Linear timestamps.

Ported features (gantt-pisi → GanttView):
- **Drag/resize bars** — pointer-event handlers on bars; drag moves plannedStart; resize
  handle changes plannedDurationDays; writes to planning store (debounced, optimistic).
- **Dependency arrows** — render finish-to-start arrows from `deps[]`; click arrow / handle
  to add/remove in a dependency editor (detail panel).
- **Auto-shift cascade** — topological forward pass: moving a bar shifts successors unless
  `locked`; respects plannedStart vs original (gantt-pisi `app.js:217-236` pattern).
- **Critical path** — backward pass, slack==0 highlight (gantt-pisi `app.js:256-287`).
- **Aggregations panel** — within-gantt rollups by state/assignee/project/priority
  (gantt-pisi `app.js:743-850`), not a separate tab.

### 3.4 Write-back — due-date approval flow (new)

- Detect changed planned dates vs last-pushed snapshot (`data/planning.json:_meta` + a
  pending-changes list). UI shows "N unsaved changes" badge.
- "Approve & push to Linear" → batch `lib/linear.ts:updateIssue(id, {dueDate})` (and
  optionally a Linear custom field for plannedStart if Mateusz wants it persisted in Linear
  too — TBD). Optimistic UI, then reconcile. gantt-pisi `main.py:216-253` pattern.

## 4. Schemas (compact)

- **Issues snapshot** `data/issues-snapshot.json`: `{ _meta:{lastRefresh, issueCount, keyTag},
  issues:[<fetchAllIssues shape>], states:[<fetchAllStates shape>] }`.
- **Planning store** `data/planning.json`: see 3.2.
- **Enriched issue (API output):** existing issue shape + `planning?: {plannedStart,
  plannedDurationDays, deps[], locked}`.

## 5. Task breakdown

**Phase G1 — fast UI (snapshot):**
- **T-G1a** `lib/issues-snapshot.ts` — load/write/refresh + atomic write + self-test.
- **T-G1b** wire `GET /api/issues` to serve snapshot; `?refresh=1` + `POST /api/issues/refresh`
  refresh. Keep hot cache.
- **T-G1c** "↻ Linear" button in Dashboard/Gantt toolbar; last-refresh timestamp shown.
- **T-G1d** verify: restart dev server, first load serves from snapshot (no Linear call),
  refresh button repopulates. Update STATE/BUILD-BACKLOG.

**Phase G2 — planning layer:**
- **T-G2a** `lib/planning-store.ts` (get/set/all, atomic) + `GET/POST /api/planning`.
- **T-G2b** enrich `/api/issues` (or `/api/planning/joined`) with planning records; bar-date
  resolution helper (`plannedStart ?? derivedStart`).
- **T-G2c** verify merge + persistence across restart.

**Phase G3 — interactive gantt:**
- **T-G3a** drag bars (plannedStart) + resize (plannedDurationDays), optimistic + debounced save.
- **T-G3b** dependency arrows + dependency editor (add/remove finish-to-start).
- **T-G3c** auto-shift cascade (topological forward pass, respect `locked`).
- **T-G3d** critical path (backward pass, slack==0 highlight).
- **T-G3e** in-gantt aggregations panel.

**Phase G4 — write-back:**
- **T-G4a** pending-changes tracking + "N unsaved" badge.
- **T-G4b** "Approve & push to Linear" batch updateIssue (dueDate) + reconcile.
- **T-G4c** verify against real Linear (FEN project) — non-destructive: push dueDate only,
  confirm in Linear UI.

## 6. Phasing

- **Phase G1** = the "fast UI" win — smallest, highest impact, unblocks nothing else but
  immediately fixes Mateusz's complaint. Ship first.
- **G2** enables G3 (planning layer is the data model G3 edits).
- **G3** = the visible gantt feature set (drag/dep/critical-path/aggregations).
- **G4** = closing the loop to Linear.
- Background refresh + Linear custom-field persistence + multi-workspace = later, not here.

## 7. Risks

1. **Snapshot staleness.** UI may show stale tasks until refresh. Mitigation: last-refresh
   timestamp visible; manual refresh one click; optional background refresh (G1, off by
   default). Linear status changes from agent runs are covered by the agents-cost panel +
   Kanban, not the gantt snapshot.
2. **Planning/Linear divergence.** Planned dates live only locally unless pushed. Two
   sources of truth. Mitigation: explicit write-back (G4) + clear "local plan" vs "Linear
   dueDate" labels; never silently overwrite Linear.
3. **Write-back to real Linear.** Pushing dueDate changes is a live mutation. Mitigation:
   G4 pushes dueDate only (no destructive archive/state changes), batched, with confirmation;
   verify against FEN project; idempotent reconcile.
4. **Drag/resize + SVG complexity.** GanttView is hand-rolled SVG; adding pointer interactions
   is the riskiest UI work. Mitigation: smallest chunk first (drag only), test, then resize,
   then deps — never bundle. Escalate to Pro/Sonnet if the SVG interaction layer gets gnarly.
5. **Linear has no native start/duration/deps.** Planning layer is purely local — if Mateusz
   later wants plan data in Linear too, that's a Linear custom-field migration (out of scope
   here; flagged in G4).
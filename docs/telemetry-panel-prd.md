# Telemetry & Cost Panel — PRD (Faza E foundation + T-E7)

**Status:** Draft (for Mateusz approval before delegation)
**Date:** 2026-06-25
**Owner:** Mateusz
**Repos:** `linear-agents` (telemetry foundation) + `Desktop/experiments/0_linear` (UI)
**Backlog ref:** `docs/BUILD-BACKLOG.md` Faza E (T-E1..T-E7); this adds the missing telemetry foundation (T-E0) that T-E7 depends on.

## 1. Goal

A control panel where Mateusz can watch the agent squads work in real time and see token
usage (input/output) tied to cost, per agent and per task. This is the "real test" that the
system is actually doing something: visible squads working, tasks changing, code being
produced, tokens accounted in $.

Mateusz's words (2026-06-25): "będę widział user interface, które grupy agentów pracują, że
taski się zmieniają, że kod się produkuje, i powiązać generowane tokeny input/output z kosztem."

## 2. Decisions (taken, 2026-06-25)

- **Where the panel lives:** extend `Desktop/experiments/0_linear` (Next.js 16). It already
  has Linear SDK + Kanban/Gantt/Analytics + a tab-based Dashboard. We add a new tab.
- **Token source:** Claude Code session transcripts (`~/.claude/projects/<hash>/<session>.jsonl`),
  not a stream-json launcher wrapper. Reason: transcripts are written automatically for BOTH
  interactive REPL and `-p` runs, and carry real per-turn `message.usage` + `message.model`.
  Wrapping launchers with `--output-format stream-json` would break the interactive REPL gates.
- **MVP scope:** (a) Cost dashboard per-agent/per-task (T-E7); (b) Live squad/agent runtime
  view. Code-production stream (git/commits) = Phase 2. Task-status changes from Linear are
  already covered by 0_linear's Kanban.

## 3. Architecture

### 3.1 Ledger source — transcript JSONL (verified facts)

Path: `C:/Users/mateu/.claude/projects/C--Users-mateu-Documents-GitHub-linear-agents/<session-id>.jsonl`
(NDJSON, one JSON object per line). Verified by probe:

- Every `assistant` line carries `message.usage` with REAL (non-zero) counts:
  `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `server_tool_use.{web_search_requests,web_fetch_requests}`.
- Every `assistant` line carries `message.model` (the OpenRouter/internal slug, e.g.
  `deepseek-v4-flash`, `glm-5.2`, `claude-sonnet-4-6`) → enables per-model split.
- Every line carries `sessionId`, `cwd`, `gitBranch`, `version`, `entrypoint`.
- **Subagent transcripts** live in `<parent-session>/subagents/agent-*.jsonl` with the SAME
  shape PLUS an `attributionAgent` field (e.g. `"Explore"`, agent type name) → enables
  per-agent-type split. This is the closest we get to "per agent" — see Risks.
- `user` lines carry prompts + tool_results; `attachment`/`queue-operation`/`last-prompt` are
  infrastructure lines. No `summary`/`end` line — totals must be summed from `assistant` lines.

Gaps (must be filled by us, not the transcripts):
1. **No cost field** anywhere — no `total_cost_usd`/`costUSD`/`modelUsage`. We multiply tokens
   by model pricing from `config/models.json` (already used by `cost-report.mjs`).
2. **No link to squad/brief/source** — the transcript doesn't record which launcher or `-p`
   argument spawned it. We infer via a run-manifest written by the launcher (see 3.2) and
   cross-reference on `cwd` + `gitBranch` + timestamp window.

### 3.2 Run manifest (lightweight launcher instrumentation)

Each squad launcher writes a manifest so we can attribute transcript sessions to a squad run.

`.state/runs/<runId>.json`:
```json
{
  "runId": "2026-06-25T13-02-07-plan",
  "squad": "plan",
  "source": "planning/inbox/roast-app.md",
  "brief": null,
  "startedAt": "2026-06-25T13:02:07Z",
  "endedAt": "2026-06-25T13:14:33Z",
  "cwd": "C:/Users/mateu/Documents/GitHub/linear-agents",
  "gitBranch": "feat/phase-a-offline-foundation",
  "native": false,
  "interactive": true
}
```
- Written by a tiny helper `scripts/run-manifest.mjs start|end` called from `bin/_lib.bat`
  (so every squad launcher that sources `_lib.bat` is covered at once — single chokepoint).
- `runId` = ISO timestamp + squad slug. `start` writes the file with `endedAt:null`; `end`
  fills `endedAt` and `exitCode`. Cross-ref to transcripts: match sessions in the same `cwd`
  whose first `assistant` timestamp is within `[startedAt, endedAt]` window (±slack).

### 3.3 `scripts/ledger.mjs` (linear-agents, ESM, zero deps)

- `parseTranscript(path)` → `{ sessionId, cwd, gitBranch, turns: [{ model, attributionAgent,
  inputTokens, outputTokens, cacheCreation, cacheRead, ts }] }` (subagents merged in via
  `subagents/agent-*.jsonl` when present).
- `costTokens(usage, model)` → USD, from `config/models.json` pricing (`pricing[model].input`
  + `.output`, cache-read at read rate where pricing supports it).
- `aggregateRun(manifest)` → loads matching transcript(s), sums per-model + per-attributionAgent
  tokens, computes cost per model and total.
- `scanRuns()` → reads `.state/runs/*.json`, aggregates each, returns `[{runId, squad, source,
  startedAt, endedAt, status, totals:{inputTokens,outputTokens,costUSD}, byModel:{...},
  byAgent:{...}}]`.
- `liveRuns(now)` → runs with `endedAt:null` OR ended within last 10 min (for "what's working now").

### 3.4 Telemetry HTTP API — `scripts/telemetry-server.mjs` (linear-agents, zero deps)

Node http server on `localhost:7331` (env `TELEMETRY_PORT`), reads `.state/runs` + transcripts:
- `GET /api/runs` → `scanRuns()` (list, newest first).
- `GET /api/runs/:runId` → single run detail (by-model, by-agent, turn timeline).
- `GET /api/summary` → aggregates: cost per squad, per model, per day; totals.
- `GET /api/live` → `liveRuns(now)` for the runtime view.

No auth (localhost-only). CORS open to `localhost:3000` (0_linear dev) as fallback; primary
path is a same-origin proxy route (3.5) so the browser never crosses origin.

### 3.5 UI — `0_linear` Agents & Cost tab

- New tab `"agents-cost"` in `components/Dashboard.tsx` (`Tab` union + `TABS` array + JSX branch),
  per the verified convention (union type + const array + `{tab === "x" && <View/>}`).
- New `app/api/agents-cost/route.ts` — server-side proxy that fetches `http://localhost:7331/api/...`
  and returns JSON. This matches 0_linear's existing pattern (frontend only ever calls `/api/...`,
  same-origin; no CORS, no new browser-side cross-origin call).
- New `components/AgentsCostView.tsx` (`'use client'`): run list (squad, source, status, cost,
  duration), click → drill-down (per-model + per-agent token & cost table, recharts bar/line),
  and a "Live" panel showing currently-running squads.

## 4. Schemas (compact)

- **Run manifest:** see 3.2.
- **Ledger turn:** `{ model, attributionAgent, inputTokens, outputTokens, cacheCreation,
  cacheRead, ts }`.
- **Run aggregate (API output):** `{ runId, squad, source, brief, startedAt, endedAt, status,
  totals:{inputTokens,outputTokens,cacheReadTokens,costUSD}, byModel:{<slug>:{inputTokens,
  outputTokens,costUSD}}, byAgent:{<attributionAgent>:{inputTokens,outputTokens,costUSD}} }`.

## 5. Task breakdown

Foundation (linear-agents):
- **T-E0a** `scripts/ledger.mjs` — transcript parser + aggregator + costing + self-tests.
- **T-E0b** `scripts/run-manifest.mjs` + wire into `bin/_lib.bat` (start/end) — single chokepoint.
- **T-E0c** `scripts/telemetry-server.mjs` — HTTP API (4 endpoints) + manual smoke.

UI (0_linear):
- **T-E1d** `app/api/agents-cost/route.ts` proxy + `GET /api/agents-cost/runs|live|summary`.
- **T-E7a** `components/AgentsCostView.tsx` MVP — run list + cost per model/agent + drill-down.
- **T-E7b** `components/AgentsCostView.tsx` Live runtime panel (which squads working now).

Wrap:
- **T-E0d** `docs/STATE.md` + `docs/BUILD-BACKLOG.md` Faza E checkpoint; run a real squad,
  verify end-to-end (manifest → transcript → ledger → API → UI shows real cost).

## 6. Phasing

- **MVP:** T-E0a + T-E0b + T-E0c + T-E1d + T-E7a. End state: run a squad, open 0_linear, see the
  real run with real tokens + cost per model/agent. This is Mateusz's "real test".
- **Phase 2:** T-E7b (live runtime), code-production stream (git), per-task Linear issue link
  (run → brief → Linear parent issue), cost-guard integration (budget bar in the panel).

## 7. Risks

1. **Manifest↔transcript cross-ref is approximate** (timestamp window match). Mitigation:
  tight window + `cwd`+`gitBranch` filter; if multiple sessions match, label as "ambiguous" in UI.
2. **"Per agent" is really per-model / per-attributionAgent-type**, not per named squad role.
  Two agents sharing a model show merged. Acceptable for MVP (PLAN squad roles use distinct
  models: Opus lead, minimax, glm, deepseek). True per-role split = Phase 2 (requires squad to
  emit role metadata, a larger change).
3. **Cost is an estimate** from `config/models.json` pricing, not real billing. OpenRouter
  actuals may differ (rounding, cache tiers). Mitigation: label "$ (est.)" in UI; cross-check
  periodically against `cost-report.mjs` OpenRouter activity.
4. **Two-repo coordination.** linear-agents owns telemetry; 0_linear owns UI. The contract is
  the HTTP API in 3.4. Mitigation: lock the API shape in this PRD before delegating; both sides
  code to it.
5. **Telemetry server must be running** for the UI to show data. Mitigation: document a
  one-line start (`node scripts/telemetry-server.mjs`); consider a `bin/telemetry.bat` later.
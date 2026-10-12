# FOC-795 — edit an agent's persisted records while it works

Date: 2026-10-12. Decisions (Mateusz): scope as wide as possible (C1); edit notices through a separate queue the waker reads (C2); audit always on, originals kept (C3); verdicts read-only with audited annotations (C4); first UI is a Records panel in RunDetail, the v2 dashboard reuses the API. Depends on FOC-800 (writes from the dashboard in Docker).

## Records

Everything lives in a Supervisor run dir (`<LA_SUPERVISOR_STATE_HOME>/<runId>/`). A record is editable only if its path matches the allowlist; everything else is listed read-only or hidden.

| Type | Path in the run dir | What can change | Takes effect |
|---|---|---|---|
| `gate` | `gates/*.json` | while `status` is `pending`: `summary`, `questions`, `facts`, `artifacts`. Answered gates are read-only. | the Supervisor re-reads the gate when it relays or answers it |
| `triage` | `triage.json` | every field except `issue` | next routing / spawn decision |
| `intake` | `intake.json` | every field | next routing decision |
| `brief` | `*.md` at the run-dir root (kickoffs, fix/round prompts, PR body, ticket bodies, answer drafts) | the whole text | the next spawn or follow-up that uses it as `--prompt-file` |
| `child-settings` | `child-settings-*.json` | tighten only: `permissions.deny` may gain entries, never lose them; everything else read-only | the child's next turn |
| `verdict` | `verdicts/*.json` | never; an annotation is appended to `verdicts/<name>.annotations.jsonl` | evidence stays untouched |

Read-only and not offered for editing: `children.json` (the registry is a state machine), `wake-queue.jsonl`, `wake-ack.json`, `waker.json`, `edits.jsonl`, `edits-seen.json`, `children/*.jsonl` (tees), `evidence/`, `guard/`, `.originals/`.

## Library — `scripts/agent-records.mjs`

- `listRecords({ runId? , taskId? })` → `[{ runId, path, type, editable, editableFields, sha256, size, mtime }]`. With `taskId`, every run dir whose `triage.json` `issue` or any registry child's `taskId` matches.
- `readRecord({ runId, path })` → `{ type, content, sha256, editable, editableFields, annotations? }`.
- `writeRecord({ runId, path, baseSha256, content, who })` →
  - path safety: must match the allowlist, resolve inside the run dir, not be a symlink;
  - optimistic concurrency: the file's current sha256 must equal `baseSha256`, else `{ ok: false, conflict: true, sha256, content }` (no write);
  - validation per type: JSON parses; immutable fields unchanged (gate: every field outside the editable four, and `status` must still be `pending`; triage: `issue`; child-settings: deny list is a superset and nothing else changed); size ≤ 256 KB;
  - before the first edit of a file, its original goes to `.originals/<path>` (never overwritten later);
  - atomic write (tmp + rename);
  - one audit + notice row appended to `edits.jsonl`: `{ seq, ts, who, runId, path, type, changes, baseSha256, newSha256 }` where `changes` lists JSON paths with `before`/`after` (values truncated to 500 chars) or, for briefs, `{ field: "text", linesAdded, linesRemoved }`.
- `annotateVerdict({ runId, path, note, who })` → appends `{ ts, who, note }` to `verdicts/<name>.annotations.jsonl` and an `edits.jsonl` row of type `verdict-annotation`.
- `edits.jsonl` has exactly one writer: this library, called by the API (and its CLI for the Supervisor's own use). `seq` = previous max + 1.
- CLI: `node scripts/agent-records.mjs edits --run <id> [--since <seq>]` prints the edit rows (what the Supervisor runs after a wake).

## API (telemetry-server)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/records?task=<ID>` or `?run=<runId>` | list |
| GET | `/api/records/file?run=<runId>&path=<rel>` | content + sha256 + editability + annotations |
| PUT | `/api/records/file` | body `{ run, path, baseSha256, content }`; 200 / 409 conflict / 400 invalid / 403 not editable |
| POST | `/api/records/annotate` | body `{ run, path, note }` — verdicts only |

Writes go through the same guards as every write endpoint: `isLocalOrigin` (loopback, plus the container gateway after FOC-800) and `isAllowedOrigin`. `who` = `"dashboard"`.

## Telling the Supervisor

The Supervisor has its own copy of a record in its context; it must re-read after an edit.

1. **Waker** (`supervisor-wake.mjs`): also reads `edits.jsonl`; rows with `seq` above the lease's new `editsFiredThrough` wake the session: `supervisor-wake: Mateusz edited 2 record(s) in run <id>: gates/gate-dev-1-1.json (facts.branch), triage.json (node) — re-read them before acting: node $LA_ROOT/scripts/agent-records.mjs edits --run <id>`. The wake queue itself keeps its single writer (the watcher).
2. **Next prompt** (`supervisor-edits-hook.mjs`, a new `UserPromptSubmit` hook in `agents/supervisor/settings.json`): the waker stands down when no child is live — exactly when the Supervisor waits on a gate — so the hook prints unseen edit rows of recently active runs as context at Mateusz's next message and records `edits-seen.json` (`seenThrough`) per run.

## UI — RunDetail "Records" panel

For the run's task: records grouped by Supervisor run, each with its type badge, editability and last edit. Selecting one opens an editor (JSON with validation, or plain text for briefs) with only the editable fields unlocked, a diff preview, Save (sends `baseSha256`), a clear conflict state ("changed by the agent since you opened it — reload"), the audit history, and for verdicts an annotation form.

## Acceptance

1. Edit a pending gate's `facts` in the dashboard while the run is live → the file changes, `.originals/` holds the first version, `edits.jsonl` has the row, the Supervisor's next turn names the change.
2. A write with a stale `baseSha256` → 409, nothing written.
3. Non-allowlisted paths, answered gates, verdict files, loosening `permissions.deny` → refused; `../` and symlinks → refused.
4. Linux and Windows suites green; the panel verified in the browser.

## Out of scope

Editing the Supervisor's live context directly (only re-reads); the v2 Work page (FOC-784) — it reuses this API.

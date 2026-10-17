# FOC-906 — `fenix agent-tools allow|ask|deny|remove`: validated edits of an agent's permissions, plus a read-only Agent tools panel in Settings

Parent FOC-898 (P7-H). PRD §6.6, decision Q6. Branch `foc-906-agent-tools-edit` stacked on `agent-tools-cli` (#90).

## Facts (recon 2026-10-16)

- `scripts/agent-tools.mjs` (#90): exports `DENY_BASELINE` (:60), `parseRule` (:86, reasons not-a-string | empty |
  empty-pattern | primary-field | shape), `rulePrefix` (:115), `listAgents` (:158), `showAgent(agent, { agentsDir =
  squadConfigRoot(), mcpPath })` (:251), `diffLists` (:314), `diffAgent` (:332), `checkFindings({ agentsDir,
  supervisorDeny })` (:416 → `{ findings, summary, ok }`), `renderDocs({ agentsDir = REPO_AGENTS_DIR })` (:594),
  `runCli` (:742); root = `--root` else `squadConfigRoot(env)` (`LA_SQUAD_HOME` or `<repo>/agents`); `docs --write`
  renders the repo tree into `docs/agent-tools.md` and the test "the committed docs/agent-tools.md is current" pins
  it (so any new docs prose must come from `renderDocs`). Header comment says the tool "never writes settings — the
  editing verbs live elsewhere" (:4-9) — update it. Test helpers: `makeTemp`, `writeAgent`, `makeAgentsFixture`,
  `capture`, `run(argv, env)` in `agent-tools.test.mjs`.
- Settings API: `scripts/settings-routes.mjs` `handleSettingsRoute(req, res, url, ctx)` (:519, flat if-chain under
  `/api/settings/`), writes guarded by `writeGuards` (loopback + same-origin), GET template `/api/settings/keys`
  (:532-537: method check, `json(res, 200, payload)`, `log`); mounted in `telemetry-server.mjs:949`.
- Settings UI: `ui/src/screens/Settings.jsx` `SECTIONS` map (:17-21, `keys / provider / repos / retention` →
  `{ label, panels }`), route `/settings/:section` (`App.jsx:176`); panels in `ui/src/components/settings/`;
  `ui/src/api.js` `apiFetch('/api/settings/keys', signal)` (:694); pure helpers in `ui/src/settingsModel.js` tested
  by `ui/src/_tests_settings.mjs` (`await test(name, fn)`); `npm run build` is not part of any lane.
- Writer: `atomicWriteJSON` (`scripts/utils.mjs:66`, 2-space indent + trailing LF, matches the committed files);
  `agents/supervisor/settings.json` key order is allow → deny → ask → defaultMode → additionalDirectories (file
  order must be preserved: splice into the existing arrays, never rebuild the object). `config-drift.test.mjs` reads
  `permissions` of every squad file (:108, :122, :282, :409, :427, :442) — run it after any writer change.
- Rules to respect: `SUPERVISOR_DENY` (10 rules on main; FOC-511 adds wildcard forms on `foc-511-deny-gap`) — never
  removable; `agent-records.mjs` tighten-only applies to generated child-settings files only (precedent).
- Lanes on this base: 140 parallel + 35 serial = 175 (`docs/agent-tools.md` + `agent-tools.test.mjs` exist).

## Design

### 1. Edit verbs in `scripts/agent-tools.mjs`

`allow|ask|deny <agent> "<rule>" [--root] [--dry-run] [--json]` and `remove <agent> "<rule>" [--root] [--dry-run]
[--json]`:
- `parseRule` must accept the rule (else exit 1 with the reason); the rule must not already exist in ANY of the three
  lists of that agent (duplicate → exit 1, naming the list); `remove` refuses (exit 1) a rule contained in
  `DENY_BASELINE` or in the live `SUPERVISOR_DENY` export, or whose `rulePrefix` equals one of theirs ("protected
  deny rule — edit SUPERVISOR_DENY in supervisor-lib.mjs with a ticket"); adding to `deny` is always allowed.
- Edit = read the file, splice: append to the end of the target list (no re-sorting — the committed lists are in
  measured order and a sort would churn every line), create a missing list in the canonical position (after `allow`,
  then `deny`, then `ask` — mirror the supervisor file), `remove` deletes the exact string from whichever list holds
  it; write with `atomicWriteJSON`; print `+ <list> <rule>` / `- <list> <rule>` for the agent and the file path;
  `--dry-run` prints the same and writes nothing; adding an existing rule to the same list is a no-op (exit 0, note).
- After a successful write to the REPO tree (`agentsDir === REPO_AGENTS_DIR`), regenerate `docs/agent-tools.md`
  (`renderDocs` + write) and say so; for any other root print `docs: not regenerated (effective root is not the
  repository tree)`. Run `checkFindings` on the edited agent afterwards and print its summary line (errors → exit 1
  even though the write happened? No: validate BEFORE writing by running the check on the would-be settings; refuse
  with the errors and write nothing).
- Header comment and `USAGE` updated; the docs header rendered by `renderDocs` gains one "Editing" paragraph (the four
  verbs, dry-run, protected deny rules, "nothing is committed by the tool").

### 2. Read-only API — `GET /api/settings/agent-tools`

In `settings-routes.mjs`: method check, payload `{ root, agents: [showAgent(a, { agentsDir: root, mcpPath })...],
check: { summary, findings } }` with `root = squadConfigRoot(env)` (the effective root); errors from an unreadable
agent become `{ agent, error }` rows, never a 500; `log`. Mounted automatically through the dispatcher.

### 3. Settings panel (read-only)

- `ui/src/api.js` `getAgentTools(signal)`; `ui/src/settingsModel.js` `agentToolsView(payload)` → `{ root, agents:
  [{ agent, counts: { allow, ask, deny }, lists, mcp: [{ server, reachable, via }], skills, hooks, findings: [{ level,
  list, rule, message }] }], summary }` (pure, tested in `_tests_settings.mjs`).
- `ui/src/components/settings/AgentToolsPanel.jsx`: one card per agent (header: name + counts + finding badges),
  collapsible `allow` / `ask` / `deny` lists (monospace rows), MCP servers with reachable ✓/✗, skills (name · source),
  hooks (event → count); top line: root path + check summary; empty/error states. `SECTIONS` entry `agent-tools`
  → label "Agent tools". CSS next to the other settings panels. No edit controls (FOC-906 keeps the dashboard read-only).

### 4. Docs

`docs/agent-tools.md` regenerated (header paragraph); `docs/supervisor-e2e-checklist.md`: a Settings → Agent tools
bullet (read-only panel, the API) + counts unchanged (no new test file; cases go into `agent-tools.test.mjs`,
`settings-routes.test.mjs` and `_tests_settings.mjs`); this plan.

## Tests

- `agent-tools.test.mjs`: allow/ask/deny add (file order preserved, trailing LF, 2-space), duplicate across lists
  refused, invalid rule refused, no-op on repeat, remove of a protected deny refused (both exact and prefix forms),
  remove of a plain rule, `--dry-run` writes nothing, docs regenerated only for the repo tree (temp copy of the repo
  `agents/` + a temp `docs/` via a `--docs-out` seam or by checking the message), `--json` shape, `config-drift`
  green after a round-trip add+remove on a temp copy.
- `settings-routes.test.mjs`: GET shape over the real spawned server with a temp `LA_SQUAD_HOME`; unknown agent file
  → error row, 200.
- `ui/src/_tests_settings.mjs`: `agentToolsView` cases (counts, finding levels, empty payload).
- Browser check of the panel on an acceptance instance before the PR (repo rule).

## Out of scope

Editing from the dashboard; MCP server registration (`.mcp.json`); re-sorting existing lists.

## Revisions (2026-10-16, Part 1 implementation)

- The per-agent finding logic was extracted from `checkFindings` into `agentFindings(agent, settings)`
  (not exported) so the edit validation runs the exact same rules on the would-be settings object;
  `checkFindings` behavior and messages are unchanged.
- Same-list duplicate resolves to the no-op (exit 0, `= <list> <rule> (already present — no-op)`);
  a rule already in a DIFFERENT list is refused naming that list — per the Tests section
  ("duplicate across lists refused").
- Protected-deny matching is exact string OR `rulePrefix` equality (a rule whose prefix merely
  EXTENDS a protected prefix stays removable); seam `protectedDeny({ supervisorDeny })` for tests.
- Test seams: `--docs-out <path>` (per design) plus an internal (non-CLI) `repoAgentsDir` option on
  `runCli`/`editAgent` so tests can exercise the repo-tree docs regeneration without touching the
  committed tree; refusal text goes to stderr in both text and `--json` mode.
- Writer note: on a CRLF working copy the atomic write emits LF (matching the committed blobs);
  the round-trip test compares CRLF-normalized content.

## Docs draft (UI)

- Settings → Agent tools (read-only, `/settings/agent-tools`): top line shows the effective
  root (`squadConfigRoot`) and the check summary ("E errors, W warnings, I infos").
- One card per agent: name, allow/ask/deny counts, finding badges by level; an unreadable
  agent file renders as an "unreadable" error row with the reason.
- Inside a card: collapsible allow/ask/deny rule lists (monospace), default mode and
  additional directories, MCP servers with reachable ✓/✗ plus `via` (and `deniedBy`),
  skills (`name · source`), hooks (`event → count`), and the agent's check findings.
- Backed by `GET /api/settings/agent-tools`; no edit controls — edits go through
  `fenix agent-tools allow|ask|deny|remove` (FOC-906 keeps the dashboard read-only).

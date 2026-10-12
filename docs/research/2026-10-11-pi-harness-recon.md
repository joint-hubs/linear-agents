# pi as the agent harness — desk recon (FOC-794, phase 1)

Date: 2026-10-11/12. Subject: [earendil-works/pi](https://github.com/earendil-works/pi) at commit `8a9c051` (2026-10-11), packages at 1.1.0. Method: read-only reading of the pi docs and source (four parallel readers, key claims re-checked in source), plus an inventory of what linear-agents uses from Claude Code today. Nothing from pi was installed or run.

## Answer

**Not in 1.0.0. Worth a narrow hands-on spike after the FOC-477 counted runs.** pi covers most of what Fenix needs — several items better than Claude Code does today — but three things Fenix depends on are not in pi's core and would be ours to build and own: per-role sub-agents, the command deny rules, and the hooks. The fourth, the transcript format, is a rewrite of every telemetry reader. None of that belongs in a release whose goal is "portable and easy to start".

What to do now, whatever the later decision: build the **harness boundary** into the cost-truth work (FOC-760/761) — the cost truth reads normalized usage events, not Claude Code JSONL directly. With that in place a harness switch becomes an adapter, not a telemetry rewrite.

## What Fenix uses from Claude Code today

| Dependency | Where | Size |
|---|---|---|
| Headless run + stream-json events | `supervisor-spawn`, `-followup`, `-watch`, `-status`, `-lib`, `stability-campaign` | 7 readers of the event stream |
| `--resume <session>` follow-ups | spawn / followup / lib | 7 files |
| Model per run (`--model`, `ANTHROPIC_MODEL`, OpenRouter through the Anthropic-compatible shim, tier aliases) | `provider-resolve`, `.bat` launchers | 5 files |
| One config dir per squad (`CLAUDE_CONFIG_DIR`) | 8 scripts + 14 `.bat` launchers | 7 squad configs |
| Per-role sub-agents with a pinned model (Task tool) | `agents/*/agents/*.md` | 29 roles in 5 squads (24 × glm-5.3-flash; deepseek-v4 flash/pro, minimax-m3 ×2, glm-5.2) |
| Guard rails: children run `bypassPermissions` + deny rules (`git push`, `rm -rf`, `git worktree remove/prune`, Linear MCP, some tools) | `agents/*/settings.json`, `supervisor-spawn.mjs:695,812` | 8–12 deny rules per squad (allow lists 101–130 apply to interactive use) |
| Hooks | SessionStart: `telemetry-hook` (all squads), `supervisor-status --briefing`; Stop: `supervisor-guard`, `supervisor-wake` (asyncRewake) | 4 hook scripts |
| MCP (CodeGraph) | `.mcp.json`, `--mcp-config`, `mcp-enable.mjs` approvals | 1 server |
| Skills | `agents/_shared/skills`, `.claude/skills` | 11 |
| Transcript JSONL (lead + `subagents/`) | `telemetry-ingest`, `ledger`, `run-manifest`, `telemetry-message-scan`, `-usage-verify`, `agent-behavior`, `backfill-tool-and-delegation`, `telemetry-delegation-recon`, `supervisor-lib` | 9 readers + the analysis notebook + dashboard Team |

## Mapping to pi

| Fenix need | pi | Fit | Effort / risk |
|---|---|---|---|
| Headless run + events | `pi --mode json -p "<prompt>"`: JSONL with a session header, then `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `agent_end`, `compaction_*`, `auto_retry_*` (`docs/json.md:23-196`) | Core | Medium — new parser; there is no `result` event, so the cumulative-`modelUsage` trap (F1, FOC-760) does not exist |
| Resume / follow-up | `--session <id\|path>`, `--session-id`, `-c`; resume appends to the same file (`docs/cli.md:86-107`, `docs/sessions.md:40`) | Core | Low |
| Model + provider per run | `--provider openrouter --model z-ai/glm-5.3-flash`; OpenRouter is a native provider; `models.json` `openRouterRouting` supports `order`, `only`, `allow_fallbacks`, `require_parameters`, `zdr`, `quantizations` (`schemas/models.schema.json:677`, `ai/src/api/openai-completions.ts:988`) | Core, better | Low — removes the Anthropic-compat shim and the tier-alias trap (F2: `sonnet` → flash-lite inherited by sub-agents); the FOC-758 `[wafer, fireworks]` pin becomes config |
| Config dir per squad | `PI_CODING_AGENT_DIR` → `settings.json`, `models.json`, `mcp.json`, `extensions/`, `skills/`, `prompts/`, `SYSTEM.md` / `APPEND_SYSTEM.md` (`docs/configuration.md:7-39`) | Core | Low–medium — port 7 configs; FOC-771 replaces the `.bat` launchers anyway |
| Per-role sub-agents, pinned model | **Not in core** — README: pi "skips features like sub-agents". Official *example* extension `examples/extensions/subagent/` runs `pi --mode json -p --no-session [--model X]` per call, model from the role's frontmatter, usage summed into the parent tool result (`index.ts:300-303,367-377`) | Example only | **High** — we would own a production sub-agent extension; `--no-session` means no child transcript, so it must be changed to keep one session per child (the Team view and cost truth need them) |
| Guard rails (deny `git push`, `rm -rf`, …) | **No permission system** — "it does not ask for approval before every tool call" (`docs/security.md:3`); recommends container isolation. A `tool_call` handler can return `{ block: true, reason }` (`examples/extensions/permission-gate.ts:21-28`); a throwing handler blocks the tool (fail-safe, `docs/extensions.md:260`) | Extension | **High risk** — security-critical code we would own, including compound-command parsing (`cd x && git push`) that Claude Code does for us; the 1.0 container + push only from the dashboard (FOC-788) narrows the blast radius but does not replace it |
| Hooks | `session_start`, `before_agent_start` (inject context / system prompt), `agent_before_settle` / `turn_end` returning `continue: true` (Stop-guard equivalent, `extensions/types.ts:989-996`), wake an idle session with `pi.sendMessage(…, { triggerTurn: true })` (`examples/extensions/file-trigger.ts`) | Extension API | Medium — 4 hooks become one TS extension |
| MCP (CodeGraph) | Built-in MCP extension; `~/.pi/agent/mcp.json` or project `.pi/mcp.json` (project trust required), same `mcpServers` shape — pi does not read `.mcp.json`, the docs say copy the entry (`docs/mcp.md:32-62,110`) | Core | Low — and no per-config-dir approval dance |
| Skills | Agent Skills spec, `SKILL.md` frontmatter compatible; `.pi/skills`, `~/.agents/skills`, `.agents/skills` (`docs/skills.md:7,59-63`) | Core | Low |
| CLAUDE.md / AGENTS.md | Read natively (`AGENTS.md`, `CLAUDE.md`, `AGENTS.override.md`, walking up from cwd — `docs/configuration.md:41-47`) | Core | None |
| Transcript → telemetry | Session JSONL v3, a tree (`id`/`parentId`); assistant messages carry `provider`, `model`, `responseId`, `usage {input, output, cacheRead, cacheWrite, totalTokens, cost{…}}` with cost computed by pi from its catalog (`ai/src/models.ts:1200-1220`) | Core, different schema | High effort (9 readers + notebook), but a cleaner source |
| Telemetry package | `pi-telemetry` is span *contracts* only: no exporter, no AI span schema in this snapshot (`packages/telemetry/README.md:7-13,370`) | — | We still ingest session files or write our own extension |
| Cockpit chat (dashboard) | `--mode rpc`: JSONL commands on stdin, events on stdout, `get_state`, `switch_session`, `fork` (`docs/rpc-commands.md`). `pi-server` / `pi-protocol` are experimental, Unix-socket only, no auth | Core (RPC) | Medium — RPC is a good fit for a web chat bridge; skip the experimental server |
| Durable runtime | `pi-durable`: crash-safe resume, task checkpoints — "Experimental. The API changes without notice" and not used by the coding agent | — | Not a basis for 1.x |

## pi usage accounting vs our ground truth

The ground truth today: transcripts (lead + `subagents/`), assistant messages deduplicated by `message.id`, priced with `pricingSnapshot()` + `calculateCost()`.

In pi the equivalent source is the session file: one `message` entry per assistant response, unique entry `id`, `usage` per response, cost already computed. Traps a naive consumer must avoid (`docs/json.md:55-95`, `docs/message-types.md:72-177`):

- `message_update.usage` is cumulative for the in-flight response — count `message_end` only (or the persisted entry).
- The same final message appears in `message_end`, `turn_end.message` and `agent_end.messages` — count one event type.
- Session totals also include tool-result nested usage, `usage` entries and compaction / branch-summary generation — summing assistant messages only undercounts (pi's own attribution: `src/core/usage-totals.ts:61-97`).
- `reasoning` is inside `output`, `cacheWrite1h` inside `cacheWrite`, `totalTokens` is the sum — never add them again.
- Sessions are trees; abandoned branches stay in the file. Walk entries once, not per path.
- pi prices with its own catalog, refreshed from pi.dev. Keep pricing on our side (`pricingSnapshot()`), so both harnesses are priced the same way.

pi avoids F1 by construction (no cumulative `result` events). The F3 class of bug — resumed turns dropped by dedup on (run, source, offset) — is about our ingest, not the harness, and would recur unless the boundary below dedups by message id.

## Harness boundary (build now, in FOC-760/761)

One normalized usage event, written by a per-harness adapter, read by everything downstream (cost truth, ledger, dashboard Costs and Team, the notebook):

```
{ harness, session_id, parent_session_id, message_id,   // dedup key: (harness, message_id)
  run_id, ticket, squad, role, model, provider,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  ts, source_path }
```

Cost is computed downstream from `pricingSnapshot()`, never taken from the harness. The Claude Code adapter is today's ground-truth method (assistant messages by `message.id`, lead + `subagents/`). A pi adapter would read persisted assistant `message` entries plus tool-result and compaction usage.

## Other facts that matter

- Maturity: 114k stars, MIT, lockstep versions, 5 releases between 2026-10-03 and 2026-10-07; a minor bump may break (`.pi/skills/release.md:10`). Pin an exact version, as we do for Claude Code.
- Node ≥ 22.19 — the Fenix image ships 22.23.3, so a spike fits the same image.
- Outbound calls besides the provider: a version check and a model-catalog refresh from pi.dev; turn both off in the container with `PI_OFFLINE=1` / `PI_SKIP_VERSION_CHECK=1`.
- Windows works (Git Bash), but 1.0 runs in Linux containers anyway.
- Compaction is automatic and configurable per model (`compaction.reserveTokens`, `keepRecentTokens`, `modelOverrides`).

## Phase 2 — spike plan (only after FOC-477's counted runs)

- **Scope**: the TEST squad (6 roles, all glm-5.3-flash, deny rules only), inside the Fenix image, pi version pinned.
- **Build**: (1) sub-agent extension keeping one session per child; (2) deny-rule extension ported from `agents/test/settings.json` with compound-command parsing and a test table taken from the current deny rules; (3) spawn adapter for `pi --mode json`; (4) pi usage adapter for the boundary above.
- **Measure**: 3–5 real tickets on both harnesses, same model and OpenRouter pin; cost (boundary events), wall time, first-time-right, guard-rail violations (target 0), lead self-spend share.
- **Cost estimate**: model spend roughly $10–30 (5 tickets × 2 harnesses at today's child cost range); the build is the larger cost, several agent-days for the four pieces.
- **Exit**: go if pi is not worse on quality and violations and at least 20% cheaper or faster; otherwise stay on Claude Code and keep only the boundary.

## Decisions for Mateusz

1. Accept "not in 1.0.0" and the harness boundary as part of FOC-760/761?
2. Phase 2 squad: TEST (recommended — smallest blast radius) or another?
3. Accept an extension-based deny list + the container as the guard rail for a pi squad, for the spike only?
4. Budget for phase 2 (model spend ~$10–30 plus build time)?

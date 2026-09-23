# CodeGraph — Code Intelligence

Structural code navigation starts at the graph, not grep: one query returns the relevant symbols' verbatim source, the call paths between them (including dynamic-dispatch hops grep cannot follow), and the blast radius of a change.

## Always Do

- **Ask the graph before you grep.** `codegraph_explore` — the MCP tool is the guarded default — answers "how does X work", "how does X reach Y", or surveying an area in one call. Name a file or symbol in the query to get its current line-numbered source.
- **Run an impact check before editing a shared symbol.** `codegraph_impact` (CLI: `node $LA_ROOT/scripts/code-intel.mjs impact <symbol> --depth 2 --project-root <target-root>`) gives the blast radius. Report it before you touch a function with many callers, and say so plainly when the radius is wide.
- **Before committing, check what your change reaches.** `node $LA_ROOT/scripts/code-intel.mjs affected <changed files> --project-root <target-root>` lists the test files a change touches — run those, not the whole suite, when the suite is slow.
- **Query the right project.** The wrapper lives in the tooling checkout, so `$LA_ROOT` names the scripts, not the graph target: `node $LA_ROOT/scripts/code-intel.mjs <verb> ... --project-root <target-root>`. Code written from now on defaults `--project-root` to the caller's working repo. Never let the tooling checkout's index answer for a task worktree.
- **Query directly; do not delegate exploration to a file-reading subagent.** A subagent without these tools will read files regardless, and CodeGraph becomes pure overhead. If you need a subagent, hand it the answer, not the question.

## Freshness and fallback

- The target worktree's index is provisioned once at launch readiness — initialization is per missing index, not per question, and never ad hoc for projects outside the owned launch scope.
- The MCP tools and the CLI wrapper enforce the same freshness guard: target identity and index staleness are checked before every query, and relevant pending changes are synced incrementally before the answer is served. An unchanged tree skips synchronization — there is no full rebuild per query.
- If the index is missing or freshness cannot be proven, the result is **UNKNOWN**: fall back explicitly to reading the files directly and say so. A "not found" from the graph is never proof of absence.

## Never Do

- **NEVER treat a "not found" as proof of absence** when the index is missing, stale, or a file is flagged pending. `scripts/code-intel.mjs` exits 3 rather than answering in that state; exit 3 means UNKNOWN — confirm with Grep before reporting anything as gone.
- **NEVER ignore a `⚠️` staleness banner** on a tool response. It names a file edited within the debounce window; read that file directly instead of trusting the indexed copy.
- **NEVER commit `.codegraph/`.** It is a local index, gitignored, and rebuildable with one command.

## Squads

The MCP server is declared once in the repo's **`.mcp.json`** (project scope), which applies whatever `CLAUDE_CONFIG_DIR` a child runs under. It is **not** in `agents/*/settings.json` — Claude Code does not read `mcpServers` from settings files. A project-scoped server stays `Pending approval` until each config dir approves it; children run headless, so approval is scripted:

```bash
node scripts/mcp-enable.mjs --verify   # once per machine; asks Claude Code whether it worked
```

CLI fallback — works with no MCP wiring, from scripts, every verb:

```bash
node scripts/code-intel.mjs <explore|symbol|impact|callers|callees|find|files|affected|status> [--project-root <target-root>]
```

## What CodeGraph does not do

Stated so nobody goes looking: there is **no circular-import check** and **no symbol-aware rename**. The previous index (GitNexus) had both; `code-intel.mjs` refuses those verbs by name rather than mapping them onto something adjacent, because "cycles: none found" from a tool that checked nothing is worse than no answer.
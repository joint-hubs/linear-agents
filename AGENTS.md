# CodeGraph — Code Intelligence

This project is indexed by **CodeGraph** (`.codegraph/`, auto-syncing). Ask the graph before you grep: one call returns the relevant symbols' verbatim source, the call paths between them, and the blast radius of a change.

> No `.codegraph/` yet? `codegraph init` from the project root (install: `npm i -g @colbymchenry/codegraph`, then `codegraph install` to wire the MCP server into your agent). The index keeps itself in sync via a file watcher — there is nothing to re-run after an edit.

## Always Do

- **Reach for `codegraph_explore` first**, for almost anything: "how does X work", "how does X reach Y", or surveying an area. One call returns source grouped by file plus the call paths — including dynamic-dispatch hops grep cannot follow. Name a file or symbol in the query to get its current line-numbered source.
- **Run an impact check before editing a shared symbol.** `codegraph_impact` (or `codegraph impact <symbol> --depth 2`) gives the blast radius; `codegraph_explore` already includes a blast-radius summary. Report it before you touch a function with many callers, and say so plainly when the radius is wide.
- **Before committing, check what your change reaches.** `codegraph affected <changed files>` lists the test files a change touches — run those, not the whole suite, when the suite is slow.
- **Query directly; do not delegate exploration to a file-reading subagent.** A subagent without these tools will read files regardless, and CodeGraph becomes pure overhead. If you need a subagent, hand it the answer, not the question.

## Never Do

- **NEVER treat a "not found" as proof of absence** when the index is missing or a file is flagged pending. `scripts/code-intel.mjs` exits 3 rather than answering in that state; if you hit it, that means UNKNOWN — confirm with Grep before reporting anything as gone.
- **NEVER ignore a `⚠️` staleness banner** on a tool response. It names a file edited within the debounce window; read that file directly instead of trusting the indexed copy.
- **NEVER commit `.codegraph/`.** It is a local index, gitignored, and rebuildable with one command.

## Squads

The MCP server is declared once in the repo's **`.mcp.json`** (project scope), which applies whatever `CLAUDE_CONFIG_DIR` a child runs under. It is **not** in `agents/*/settings.json` — Claude Code does not read `mcpServers` from settings files, and this repo carried a dead `mcpServers.linear` there for a while to prove it.

A project-scoped server starts as `Pending approval` and stays inert until each config dir approves it. Children run headless, where no trust dialog can appear, so approval is scripted:

```bash
node scripts/mcp-enable.mjs --verify   # once per machine; asks Claude Code whether it worked
```

Squads also have the CLI wrapper:

```bash
node scripts/code-intel.mjs <explore|symbol|impact|callers|callees|find|files|affected|status>
```

The wrapper is the floor, not the ceiling: it works with no MCP wiring, from scripts, and exposes every verb. When the MCP tools are available, `codegraph_explore` is one call and returns source — prefer it.

## What CodeGraph does not do

Stated so nobody goes looking: there is **no circular-import check** and **no symbol-aware rename**. The previous index (GitNexus) had both; `code-intel.mjs` refuses those verbs by name rather than mapping them onto something adjacent, because "cycles: none found" from a tool that checked nothing is worse than no answer.

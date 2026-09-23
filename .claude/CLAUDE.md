<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `node $LA_ROOT/scripts/code-intel.mjs explore "<symbol names or question>" --project-root <target-root>` prints the same output, freshness-guarded — the raw `codegraph` binary is not.

No index is not a skip signal. Every query is freshness-guarded — target identity and index staleness are checked first, and relevant pending changes sync incrementally before the answer. A missing, stale, or unprovable index yields UNKNOWN: fall back to reading the files directly and say so — a graph "not found" is never proof of absence. Index provisioning belongs to launch readiness, not ad-hoc mid-task init.
<!-- CODEGRAPH_END -->

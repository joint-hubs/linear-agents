# Bash output distribution — measurement for the output cap (FOC-1072)

Date: 2026-11-05. Source: `scripts/bash-output-distribution.mjs --days 30`
against the production telemetry store (3.47 GB,
`C:\Users\mateu\AppData\Local\linear-agents\telemetry\telemetry.sqlite`),
opened **read-only** per `docs/TELEMETRY-EXPLAINED.md`.

## STEP 0 — what was verified about `BASH_MAX_OUTPUT_LENGTH`

Verified against the **installed** Claude Code 2.1.317 binary
(`~/.local/share/claude/versions/2.1.317`, minified JS — strings and code
extracted with `grep -a` / byte-window dumps, not from docs):

1. The variable **exists** (exported env name, referenced in the settings
   schema and in the Bash tool's result assembly).
2. It is **characters**, not tokens: the settings schema
   (`bashOutputMaxChars`) reads *"How many characters of a successful Bash or
   PowerShell command's output Claude receives inline (default 30000; values
   clamp to 4000-128000)."*
3. Resolution order (verbatim from the binary): the settings key
   `bashOutputMaxChars` wins (clamped to 4000–128000); otherwise the env var
   resolves through `nJt(...)` with **default 30000 and a hard ceiling of
   150000** — an env value above 150000 is silently capped to 150000
   (`status: "capped"`). Invalid or non-positive values fall back to the
   default with a warning.
4. Truncation behaviour (verbatim): when the result is persisted, the inline
   result is built by `p5n(head, tail)` as `head + marker + tail`, where
   `head ≤ limit − marker − tail` and the marker is the literal string
   `\n[… output cut here; the full output was saved to a file …]\n`, with a
   ~1500-char tail kept. So the harness **middle-truncates with its own
   notice** — and, beyond the kickoff's assumption, the full output is
   natively saved to a file whose path rides the tool result
   (`persistedOutputPath`). The "full output at <path>" wish from the issue is
   therefore partially met by the harness itself; the hook-based wrapper the
   ticket floats stays OUT OF SCOPE (hooks are Mateusz's layer, and a
   PostToolUse hook cannot shrink what the model already received).

## The measurement (30-day window: since 2026-10-06T04:28Z)

Query: `tool_facts` rows with `tool_name_canon = 'bash'` (canon is lowercase —
`config/tool-norm.json` maps raw `Bash`/`PowerShell`/… onto `bash`), joined to
`runs` on `run_id`, filtered to `runs.started_at >= cutoff`, driven off
`idx_tool_facts_canon` and streamed (`StatementSync.iterate()`). Rows with
`tool_result_bytes IS NULL` (unknown, pre-FOC-220) are **excluded**; byte 0
(present but empty) is a real measurement and stays. Runtime: ~0.8 s.

Role split: the store's own split (`agent_key = '_lead'` → lead, anything else
→ subagent — the same rule `agent-behavior.mjs` uses for the delegation
share). The cap is per-process, so lead/subagent is the axis that matters.

| role     | n     | p20  | p50  | p80    | p95   | >2 KB calls | >2 KB bytes | >8 KB calls | >8 KB bytes | >32 KB |
|----------|-------|------|------|--------|-------|-------------|-------------|-------------|-------------|--------|
| lead     | 60223 | 123  | 499  | 2099   | 6615  | 20.5 %      | 73.5 %      | 3.2 %       | 29.5 %      | 0      |
| subagent | 29359 | 120  | 535  | 2000   | 6553  | 19.6 %      | 72.0 %      | 3.5 %       | 30.5 %      | 0      |
| all      | 89582 | 122  | 512  | 2069   | 6594  | 20.2 %      | 73.0 %      | 3.3 %       | 29.8 %      | 0      |

Total Bash bytes in the window: 136.0 MB (lead 92.0 MB, subagent 44.0 MB).

Verbatim CLI output (`--days 30`):

```
Bash tool-result size distribution (window: since 2026-10-06T04:28:21.401Z)
  lead       n=  60223  p20=0.1 KB p50=0.5 KB p80=2.0 KB p95=6.5 KB
             >2KB: 20.5% of calls / 73.5% of bytes  >8KB: 3.2% / 29.5%  >32KB: 0.0% / 0.0%
             total Bash bytes: 87.8 MB
  subagent   n=  29359  p20=0.1 KB p50=0.5 KB p80=2.0 KB p95=6.4 KB
             >2KB: 19.6% of calls / 72.0% of bytes  >8KB: 3.5% / 30.5%  >32KB: 0.0% / 0.0%
             total Bash bytes: 41.9 MB
  all        n=  89582  p20=0.1 KB p50=0.5 KB p80=2.0 KB p95=6.4 KB
             >2KB: 20.2% of calls / 73.0% of bytes  >8KB: 3.3% / 29.8%  >32KB: 0.0% / 0.0%
             total Bash bytes: 129.7 MB
```

## The cap choice

**Recommended overlay value: `bashOutputCapChars: 8192`.**

Reasoning, in Mateusz's p20–p80 reading:

- p50 is **512 B** and p80 is **~2.07 KB** — half of all Bash results are
  half a kilobyte; a cap anywhere near the median would fight every other
  command. The cap must sit well above p80.
- p95 is **6594 B**. A cap of **8192 chars** sits just above p95: ~96.7 % of
  calls pass through completely untouched, and only the ~3.3 % of calls that
  carry ~29.8 % of the bytes get middle-truncated (with the full output saved
  to a file by the harness itself).
- 32 KB would be a no-op in this window (zero rows above it) — it would not
  change anything until some future workload grows past it.
- Units caveat: the store measures **bytes**, the cap counts **chars**. For
  ASCII-heavy shell output they coincide; for multibyte output chars ≤ bytes,
  so a byte-derived cap truncates slightly less than the same number in
  bytes would — the conservative direction.

The overlay stays **unset by default** (harness default 30000, no env var
injected); 8192 is the measured recommendation, not a silent default.

## Trade-off recorded (per the kickoff)

- Truncation is the harness's middle-truncation with its own notice
  (`[… output cut here; the full output was saved to a file …]`); children
  can Read the persisted file or re-run the command.
- No "full output at <path>" wrapper: unnecessary given the harness already
  persists the full output, and a PostToolUse hook could not shrink what the
  model already received anyway.
- Env values above 150000 are silently capped by the harness, so the overlay
  checker's upper bound is 150000 (not the 2 000 000 the kickoff sketched) —
  a value the harness would clamp should be refused at the settings layer
  instead.

## Item 3 — before/after is NOT measurable in this ticket

The cap has shipped to zero tickets at the time of this measurement, so the
before/after comparison cannot exist yet. Follow-up: re-run the same script
(`node scripts/bash-output-distribution.mjs --days 30`) after ~10 tickets
have landed under the cap; the FOC-1072 Done-when (cache-read share of Bash
output below 5 %) needs that post-cap data — no projection is faked here.

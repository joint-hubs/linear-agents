# The role set, for quality (FOC-1179)

> The one table the AC asked for: role, model source, what it must produce, what it must not do.
> The quality-first reshape of plan §4 (accepted 2026-11-02): REVIEW is one strong pass, TEST has
> CI parity, DEV is one context for one change. The loop contracts live in `agents/<squad>/CLAUDE.md`
> (the single source of truth per each file's precedence header); this table is the cross-squad
> summary. Model slugs themselves live in `config/models.json` / the settings overlay — never here.

## Supervisor — the operator's agent, above the squads

| role | model source | must produce | must not do |
|------|--------------|--------------|-------------|
| lead (you) | settings overlay `routing.supervisor.lead` (set on this host; FOC-1171 mechanism); routing table fallback per `child-model.mjs` | the relay to Mateusz (gate records, status blocks), the verdicts and delivery records delivery reads, child resumes through `supervisor-followup.mjs`, the review-loop round control (max 2 dev↔review cycles; delivery verdicts count as rounds) | must not write product code — the implementation is the DEV lead's own (FOC-1179); must not push, open a PR or merge without an answered gate; must not let a child reach Linear or the human directly |

## REVIEW — one strong pass

| role | model source | must produce | must not do |
|------|--------------|--------------|-------------|
| lead (you) | settings overlay `routing.review.lead` (FOC-1171); routing table fallback per `child-model.mjs` | the round file (Conventional Comments, file:line findings), the AC↔evidence mapping, the lint row, the scanner row, ≥1 `--ran` citation, `--red-first` for red-first claims, the verdict via `supervisor-verdict.mjs` | must not delegate the pass (`first-pass`/`security`/`deep` are folded in); must not record a security row without running the deterministic step (`security-scan.mjs` + `security-scan.test.mjs` + egress screen); must not re-run the full suite (TEST's job); must not push, edit product code, or touch Linear outside the verdict path |
| worker | `config/models.json` `routing.review.worker` | bounded context extraction: file summaries, inventories | read-only — no review pass, no verdict, no code write |
| flash | `config/models.json` `routing.review.flash` | finding formatting / dedup tables in the lead's schema | read-only — zero code judgment, no verdict |

Retired as LLM roles (folded into the lead, FOC-1179): `first-pass`, `security`, `deep` — role files
kept under `agents/review/agents/` for standalone runs; their `routing.review` keys remain in
`config/models.json` until the cost pass.

## TEST — CI parity

| role | model source | must produce | must not do |
|------|--------------|--------------|-------------|
| lead (you) | `config/models.json` `routing.test.terminal` | the PASS/FAIL verdict with observed acceptance checks, the lint row, the container row: `--container-run '{"cmd","exit","outputRef"}'` — or `--container-unavailable "<why>"` when docker is not available (`containerRun: "unavailable: <why>"`); a pass without it is refused (`test-pass-without-container-run`) | must not record a pass without the Fenix-container run (`docker/test-in-container.sh`, as CI runs it) plus the full suite once on the host; must not invent a deploy URL, cloud requirement or cloud rollback for a CLI repo; must not blind-retry a flaky check |
| runner | `config/models.json` `routing.test.run` | pass/fail table per check with retained output paths | read-only on product code — no deploy, no fix, no write |
| root-cause | `config/models.json` `routing.test.root_cause` | the failure diagnosis naming the real cause and how to re-verify | read-only on product code — must not hide or downgrade a failure |
| worker / flash | `config/models.json` `routing.test.worker` / `routing.test.flash` | log summaries, pass/fail tables | read-only — no verdict |

Not part of the CLI-repo flow (role files kept, FOC-1179): `deployer` (`routing.test.deploy`),
`scenario-gen` (`routing.test.scenarios`) — they remain for service projects and standalone runs.

## DEV — one context for one change

| role | model source | must produce | must not do |
|------|--------------|--------------|-------------|
| lead (you) | settings overlay `routing.dev.lead` or `config/models.json` `routing.dev` fallback per `child-model.mjs` | the edit, the red-first test (named pre-fix failure, post-fix greens), the journal `docs/state/<ID>.md`, the hand-off with verify commands + lint gate result, the commit on the squad branch | must not delegate the implementation (`implementer`/`refactorer`/`debugger` are retired from the flow); must not push; must not sweep unrelated changes into a commit; must not record Linear writes directly under a Supervisor |
| recon | `config/models.json` `routing.dev.recon` | the context packet: key files, patterns, risks — summaries only | read-only — zero raw source dumps, no code write |
| worker / flash | `config/models.json` `routing.dev.worker` / `routing.dev.flash` | bounded lookups; verbose command runs ("run X, return ≤10 lines") | read-only — never a code, test or journal write |

The round limit stays: max 2 dev↔review cycles, then `escalated` — and delivery verdicts
(FOC-1169) count as rounds (`config/graph.json`, review node failure + `review-to-human-escalate`).

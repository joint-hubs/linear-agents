# Egress secret screen — local first (FOC-450)

Nothing that looks like a secret reaches Linear or GitHub. The check is local
and offline: the candidate text never leaves the process to be checked, because
checking by sending is itself the leak (design decision 2026-09-21 — no
classifier sees outbound text). AC3 (Jev, `egress.contains_secret`, masking,
second opinion) is deliberately NOT built.

## Where it is wired

`scripts/egress-screen.mjs` is a zero-dependency, synchronous module. Every
outbound-text chokepoint calls `assertEgressClean(text, label)` before anything
else happens — before the dry-run echo and before the first network call:

| Chokepoint | Screened text | Notes |
|---|---|---|
| `linear-ops.mjs comment` | body | Screened before `resolveIssueWithTeam`; also before the `--dry-run` echo (a dry-run echo into logs is still an egress-shaped leak). |
| `linear-ops.mjs comment-replace` | body | Via `readBodyArg`. |
| `linear-ops.mjs update-description` | body | Via `readBodyArg`. |
| `linear-ops.mjs create-child` | body AND title | Title screened separately; body via `readBodyArg`. |
| `publish-linear-comment.mjs` | composed run-summary body | Screens its own `--dry-run` path (which never reaches linear-ops) and the composition inputs (`--summary`, `--next`, `--body-file`). linear-ops re-screens at the chokepoint. |
| `linear-push.mjs createIssue` | title AND description | One funnel for parent + subtask creation. Screened BEFORE the try block: the catch dumps the full input to stderr, and the refusal must not hand it the secret it just found. |

Wiring at the chokepoints (not at call sites) is what covers future callers:
anything that posts a comment or a child issue through `linear-ops.mjs` —
including `supervisor-verdict.mjs runLinearOps`, which spawns it as a child —
is screened transitively.

**GitHub PR bodies — design answer.** There is no scripted PR-body poster to
hook: `gh pr create` is allow-listed for the Supervisor *agent* (`agents/
supervisor/CLAUDE.md`), which composes the body itself. A code-level chokepoint
does not exist there. The honest design is the reusable local guard:

```bash
node scripts/egress-screen.mjs check --body-file <path>   # exit 0 clean · 1 blocked · 2 usage
```

The Supervisor's pre-PR step runs this on the composed PR body before
`gh pr create`. It is the same detector, same fail-closed semantics.

## Detection families — secretlint vs local detector

The screen implements ALL families locally. secretlint (the `security-scan.mjs`
file-scan path) covers some of the same ground for FILES on disk — it is the
complement, not the engine, for three reasons:

1. `linear-ops.mjs` promises "No npm install required" — a screen gated on
   devDependencies would be unavailable exactly on fresh clones and worktrees,
   i.e. warn-and-continue by construction, which the contract forbids.
2. A verdict that depends on `node_modules` being present is
   non-deterministic: the same text would pass on a bare worktree and block on
   a dev machine.
3. secretlint rule messages embed the matched secret value (the reason
   `security-scan.mjs` never echoes them); reusing them here would put the
   secret into the screen's own refusal text unless every message were remapped
   to shape-only anyway.

| Family | Covered by | Detector | Evidence |
|---|---|---|---|
| (a) known key prefixes (`sk-or-`, `sk-`, `ghp_`, `AKIA`, `xoxb-`, …) | local detector | Public-prefix regex, longest-first alternation; shape names the public prefix + charset + length. | secretlint's preset covers ghp_/AKIA/xoxb in its file scan, but not `sk-`/`sk-or-`; and reasons 1–3 above make it unusable as the egress engine. |
| (b) PEM private-key blocks | local detector | Full `BEGIN … PRIVATE KEY … END` blocks (multi-line, line count reported) plus a truncated `BEGIN` without `END`. | secretlint has a privatekey rule for the file path; same local-first reasons. |
| (c) env-style `KEY=value` / `KEY: value` with secret-bearing names | local detector | Line-anchored name gate (`*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD`, `API_KEY`, …) with a value gate (placeholders, `$VAR` indirection and `# comments` are not literals). | secretlint has no generic env-assignment rule for arbitrary names; this family is inherently local. |
| (d) JWT | local detector | Three dot-separated base64url segments with an `eyJ…` header. | Not covered by the secretlint preset. |
| (e) high-entropy tokens | local detector | 20+ char base62/base64url runs, ≥3 char classes, Shannon entropy ≥4.3 bits/char (≥3.9 at 32+ chars). Excludes pure-hex runs (digests/SHAs — this repo's comments cite them constantly), UUIDs, data-URI payloads, public PEM blocks, and ISO-date-like slugs. | No generic entropy rule exists in the preset. |

**Known blind spot (documented, accepted):** an UNPREFIXED hex-shaped key is not
flagged by family (e) — pure-hex runs are excluded because they are
overwhelmingly digests/SHAs here, and blocking every cited commit SHA would be
warn-fatigue that trains people to bypass the screen. The prefixed families
(a) and (c) still catch such a key when it carries a prefix or a config name.

## Fail-closed refusal

A hit throws `EgressBlockedError` (`error.code === "EGRESS_BLOCKED"`). The CLI
prints to stderr and exits 1; nothing is posted, no network call is made with
the text. The message names hits by SHAPE only — family, line, column, and
public-format facts (prefix, charset class, length, line count) that the
detector pattern already defines. It never echoes the value. The LAST stderr
line is self-describing on purpose: `supervisor-verdict.mjs:328` surfaces the
child's last stderr line as the failure detail, so "asks Mateusz" carries the
shape verbatim:

```text
Error: [egress-blocked] outbound text refused (comment body) — 2 secret-shaped hit(s); nothing was posted
  line 3 col 1: <PEM private-key block, 5 lines>
  line 6 col 1: <env-style assignment to secret-bearing name OPENROUTER_API_KEY>
Blocked (first hit): <PEM private-key block, 5 lines> — remove the secret from the text and retry; the mutation was never issued.
```

(Shapes above are the screen's own placeholders, not a real hit.)

## Labelled evaluation (AC4)

Run: `node scripts/egress-eval.mjs`. Set: **66 texts — 37 labelled `secret`,
29 labelled `clean`.**

- **Synthetic: 66 texts (committed).** `scripts/fixtures/egress-eval-synthetic.mjs`
  — every secret-shaped string is assembled at runtime from split literals
  (none is a real credential; the file carries a FAKE-CONSTRUCTION banner; the
  splitting also keeps the repo-wide secretlint scan green, same convention as
  `security-scan.test.mjs`).
- **Real: 0 texts at recording time.** The population lives at
  `.state/egress-eval-real.json` (gitignored — the repo is public). The loader
  skips gracefully when the file is absent, so the committed suite passes on a
  clean clone with zero real data. **No real comment text is committed
  anywhere.** To measure real-world performance: hand-label past comments into
  that file (`{ id, text, label: "secret"|"clean", family? }`), labels
  INDEPENDENT of the detector, and re-run the scorer.

**Recorded result (synthetic-only, clean clone):**

| Metric | Value |
|---|---|
| Precision | **100.0%** (TP 37 · FP 0) |
| Recall | **100.0%** (FN 0) |
| key-prefix | 10 labelled → 10 caught by that family |
| pem | 5 → 5 |
| env-assignment | 10 → 10 |
| jwt | 5 → 5 |
| high-entropy | 7 → 7 |

Honesty note: the synthetic labels are authored against the written family
contract, so synthetic precision measures **contract-conformance**, not
real-world precision — the real population (absent at recording time) is what
would measure real-world performance. Both numbers are pinned as floors in
`egress-screen.test.mjs` (recall ≥ 0.95, precision ≥ 0.9, set ≥ 50) so a
detector regression fails the suite.

## Offline guarantee

The detector is pure synchronous regex/string arithmetic — it has no network
capability. `egress-screen.test.mjs` pins it cheaply: `globalThis.fetch` is
stubbed to throw and the scan still completes over the whole labelled set. The
chokepoint wiring runs the screen BEFORE the first `graphql` call in each
handler, so a blocked text produces no network traffic of any kind, and the
spawn tests prove blocking with `LA_LINEAR_NO_ENV_FILE=1` +
`LINEAR_API_KEY=""` (graphql's key check precedes its fetch — no request, not
even a failed one).

## Test surface

`node scripts/egress-screen.test.mjs` — 75 assertions: five-family detection
with no value fragments in shapes, multi-line and truncated PEM, clean
hard-negatives, typed refusal, offline stub, eval floors, real-file loader,
and live `linear-ops.mjs` spawn cases (blocked before mutation; clean body
passes and fails later, offline, at the missing key).

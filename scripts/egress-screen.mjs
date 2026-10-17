#!/usr/bin/env node
/**
 * scripts/egress-screen.mjs — local, offline screen for outbound text (FOC-450).
 *
 * The repo is public. The rule (2026-09-21 design decision) is that no secret
 * may reach Linear or GitHub, and that checking whether a text contains a
 * secret must happen LOCALLY — asking an external model is itself the leak.
 * This module is that local check: pure regex/string analysis, no network, no
 * subprocess, no dependencies. A hit BLOCKS the post (fail closed) and names
 * the hit by SHAPE only — never by value, and never by a prefix+length that
 * would let a reader reconstruct the real value.
 *
 * Wired at every outbound-text chokepoint:
 *   - linear-ops.mjs: comment / comment-replace / update-description /
 *     create-child (body AND title) — screened before BOTH the dry-run echo
 *     and the mutation (a dry-run echo into logs is still an egress-shaped
 *     leak), and before any network call.
 *   - publish-linear-comment.mjs: the composed run-summary body (its --dry-run
 *     path prints without ever reaching linear-ops, so it screens too).
 *   - linear-push.mjs: createIssue() funnels parent + subtask titles and
 *     descriptions (and its error path dumps input to stderr — so the screen
 *     must throw BEFORE that try block).
 *   - PR bodies have no scripted poster (the Supervisor agent runs `gh pr
 *     create` itself), so this module's CLI is the local guard that workflow
 *     invokes before posting:
 *         node scripts/egress-screen.mjs check --body-file <path>
 *
 * Why local detectors instead of reusing secretlint (which covers some of the
 * same families in the FILE-scan path of security-scan.mjs):
 *   1. linear-ops.mjs promises "No npm install required" — a screen gated on
 *      devDependencies would be unavailable exactly on fresh clones and
 *      worktrees, i.e. warn-and-continue by construction, which this contract
 *      forbids.
 *   2. A screen whose verdict depends on node_modules being present is
 *      non-deterministic: the same text would pass on a bare worktree and
 *      block on a dev machine.
 *   3. secretlint rule messages embed the matched secret value (the reason
 *      security-scan.mjs never echoes them); reusing them here would put the
 *      secret into this screen's own refusal text unless every message were
 *      remapped to shape-only anyway.
 *
 * Shape families (see docs/egress-screen.md for the labelled eval):
 *   key-prefix      known public token prefixes (sk-or-, sk-, ghp_, AKIA, xoxb-, ...)
 *   pem             PEM private-key blocks, multi-line, including a truncated BEGIN-only paste
 *   env-assignment  KEY=value / KEY: value lines whose KEY name looks secret-bearing
 *   jwt             three dot-separated base64url segments with an eyJ… header
 *   high-entropy    long mixed-class runs with high Shannon entropy (hex/UUID/data-URI excluded;
 *                   Linear issue-URL slug segments exempt, FOC-733; managed spawn refs
 *                   exempt, FOC-788)
 *
 * Usage (library): scanEgress(text) -> hits; assertEgressClean(text, label) throws.
 * Usage (CLI):     node scripts/egress-screen.mjs check (--body <text> | --body-file <path>)
 * Exit (CLI): 0 clean, 1 blocked, 2 usage.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Family A — known key prefixes
// ---------------------------------------------------------------------------

// Public prefixes only. Order matters: specific prefixes must precede the
// generic `sk-` spec, or sk-or-v1-… / sk-ant-… would be swallowed by it and
// reported as the wrong shape. \b before each prefix keeps prose like "task-…"
// from matching.
const KEY_PREFIX_RE = new RegExp(
  [
    String.raw`\bsk-or-[A-Za-z0-9_-]{20,}`, // OpenRouter
    String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`, // Anthropic
    String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}`, // OpenAI (generic)
    String.raw`\bsk_live_[A-Za-z0-9]{16,}`, // Stripe secret
    String.raw`\bsk_test_[A-Za-z0-9]{16,}`, // Stripe test-mode secret (shape fail-closed)
    String.raw`\brk_live_[A-Za-z0-9]{16,}`, // Stripe restricted
    String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`, // GitHub classic PAT
    String.raw`\bgithub_pat_[A-Za-z0-9_]{40,}`, // GitHub fine-grained PAT
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
    String.raw`\bxapp-[A-Za-z0-9_-]{20,}`, // Slack app-level token
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key id (exactly 16 after prefix)
    String.raw`\bnpm_[A-Za-z0-9]{30,}`, // npm
    String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, // Google API key
    String.raw`\bglpat-[A-Za-z0-9_-]{15,}`, // GitLab PAT
    String.raw`\bshpat_[A-Za-z0-9]{30,}`, // Shopify
  ].join("|"),
  "g",
);

// Longest-first so startsWith resolves the PUBLIC prefix actually matched
// (github_pat_ before github, sk-or- before sk-, …).
const KNOWN_PREFIXES = [
  "github_pat_",
  "sk-or-",
  "sk-ant-",
  "sk-proj-",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "xoxb-",
  "xoxa-",
  "xoxp-",
  "xoxr-",
  "xoxs-",
  "xapp-",
  "AKIA",
  "ASIA",
  "npm_",
  "AIza",
  "glpat-",
  "shpat_",
  "sk-",
];

// ---------------------------------------------------------------------------
// Family B — PEM private-key blocks
// ---------------------------------------------------------------------------

const PEM_HEADER = String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
const PEM_FULL_RE = new RegExp(`${PEM_HEADER}[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`, "g");
const PEM_BEGIN_RE = new RegExp(PEM_HEADER, "g");

// Any delimited PEM region — CERTIFICATE, PUBLIC KEY, CSR, … Private-key
// variants are family B's job; every OTHER delimited block is public material,
// and its base64 body lines are high-entropy by construction. Family E skips
// these regions or every posted certificate would read as a leak.
const PEM_ANY_BLOCK_RE = /-----BEGIN [^-]*-----[\s\S]*?-----END [^-]*-----/g;

// ---------------------------------------------------------------------------
// Family C — env-style assignment to a secret-bearing name
// ---------------------------------------------------------------------------

// Line-anchored on purpose: `| NAME | value |` markdown tables are prose, not
// assignments. An optional leading bullet keeps "- NAME=value" lists covered.
const ENV_LINE_RE = /^[ \t]*(?:[-*][ \t]+)?(?:export[ \t]+|set[ \t]+)?([A-Za-z_][A-Za-z0-9_]{2,})[ \t]*[:=][ \t]*(.*)$/;

// (?:^|_) + (?:_|$) framing: GITHUB_TOKEN, OPENROUTER_API_KEY, DB_PASSWORD match;
// AUTHOR_NAME (AUTH inside AUTHOR) and KEYSTONE (KEY at KEYSTONE's front) do not.
// PASSWORDS?/PASS(?:WD)? cover PASSWORD/PASSWD/PASS; SESSION and COOKIE are
// credential-ish on purpose (fail closed). CERT is deliberately absent — a
// certificate is public, and private keys are family B's job.
const SECRET_NAME_RE = /(?:^|_)(?:TOKENS?|SECRETS?|PASSWORDS?|PASS(?:WD)?|PASSPHRASE|API_?KEYS?|KEYS?|CREDENTIALS?|PRIVATE_?(?:KEY|TOKEN)|ACCESS_?(?:TOKEN|KEY|SECRET)|AUTH(?:_TOKEN|_KEY|_SECRET)?|BEARER|SALT|COOKIE(?:_SECRET)?|SESSION(?:_ID|_SECRET|_KEY)?|SIGNING_(?:KEY|SECRET)|ENCRYPTION_(?:KEY|SECRET))(?:_|$)/i;

// Values that mean "no literal secret here": empty, quoted-empty, <placeholder>,
// [redacted], ***, xxxx…, true/false, a $VAR or ${VAR} indirection, "…".
const NON_VALUE_RE = /^(<[^>]*>|\[[^\]]*\]|\*{3,}|x{4,}|X{4,}|null|none|n\/a|redacted|true|false|undefined|\.{3,}|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/i;

// ---------------------------------------------------------------------------
// Family D — JWT shape
// ---------------------------------------------------------------------------

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// ---------------------------------------------------------------------------
// Family E — high-entropy tokens
// ---------------------------------------------------------------------------

// Candidate runs of token-ish characters, 20+ long. The charset is
// deliberately base62/base64url ONLY (no `.`, `/`, `+`, `=`): dots and slashes
// belong to URLs, filenames and version strings (releases, timestamps, paths)
// and `=` glues NAME=value onto one run — all everyday comment content, all
// low-value as secret signals. Standard-base64 runs usually appear inside PEM
// blocks (family B) or data URIs (excluded below). Lookarounds (not \b) so the
// run edges are exact: a `-`/`_`-terminated run does not swallow the neighbour.
const ENTROPY_RUN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,4096}(?![A-Za-z0-9_-])/g;

// Pure-hex runs are digests/SHAs far more often than unprefixed keys — and
// this repo's comments cite commit SHAs constantly, so blocking them would be
// warn-fatigue that trains people to bypass the screen. Documented trade-off:
// an UNPREFIXED hex-shaped key is this screen's known blind spot (the prefixed
// and env-name families still catch it when it carries a prefix or a name).
const HEX_RUN_RE = /^(?:[0-9a-f]+|[0-9A-F]+)$/;

const ENTROPY_MIN_LEN = 20;
const ENTROPY_MIN_CLASSES = 3; // of {lower, upper, digit, symbol}
const ENTROPY_THRESHOLD_PRIMARY = 4.3; // bits/char, len >= 20
const ENTROPY_THRESHOLD_RELAXED = 3.9; // bits/char, len >= 32
const BASE64_PAYLOAD_WINDOW = 64; // chars before a run to look for ";base64,"

// A run containing an ISO-date-like segment (…-2026-09-23-…) is a filename,
// release or timestamp slug — comment authors paste those constantly, and a
// random token essentially never contains a digit-dash-digit-dash group.
const ISO_DATE_LIKE_RE = /\d{4}-\d{2}-\d{2}/;

// FOC-733: the slug segment of a Linear issue URL (…/issue/FOC-733/<slug>) is
// a human-written kebab-case title, not a secret — lowercase + digits + hyphen
// is exactly 3 char classes, and real titles measure 3.9-4.2 bits/char, i.e.
// the relaxed branch's shape. The exemption is deliberately narrow: host
// exactly linear.app, https only, the segment IMMEDIATELY after /issue/<KEY>/
// (KEY = Linear key shape: uppercase + digits, hyphen, digits), and a COMPLETE
// path segment. The captured group's span is what detectHighEntropy skips; a
// key-shaped run in any other position — query values, other hosts, bare prose
// — stays screened.
//
// Terminators (Q1-B, extended by FOC-512): a segment ends at end of input, a
// URL-structural character (`/`, `?`, `#`), or a closing/punctuating character
// (`)`, `]`, `}`, `>`, `"`, `'`, backtick — Q1-B's seven closing delimiters —
// plus, from FOC-512 (PR prose, not just one-line JSON): end of line (`\r` and
// `\n` — `\r\n` closes via the `\r`) and the trailing punctuation `,`, `.`,
// `:`, `;`. Whitespace is deliberately NOT a terminator: a slug followed by
// unescaped whitespace is not a complete path segment, so the narrow exemption
// does not apply there and the segment stays screened (asserted in the tests).
const LINEAR_ISSUE_SLUG_RE = /https:\/\/linear\.app\/[A-Za-z0-9][A-Za-z0-9_-]*\/issue\/[A-Z][A-Z0-9]*-[0-9]+\/([A-Za-z0-9_-]+)(?=$|[\r\n/?#,.:;)}>\]"'\x60])/g;

// Q2-B (Mateusz, 2026-10-09): the exemption fires ONLY for a segment that has
// the shape of a Linear issue-title slug — tokens of [a-z0-9] joined by SINGLE
// hyphens, a purely alphabetic token at most 20 chars, and a token containing a
// digit at most 8 chars. Anything else in that position falls back to the
// ordinary family E rules: the grant is this one exception, never a general
// loosening.
//
// ACCEPTED RESIDUAL, documented on purpose (Mateusz, 2026-10-09): a secret
// spelled out of short kebab-case words ("correct-horse-battery-staple" shape)
// does satisfy this profile and is therefore not caught here. Closing it would
// need a lookup against Linear, which would break this screen's contract as a
// pure text function — that option was put to Mateusz and rejected (Q2-C).
const SLUG_TOKEN_RE = /^[a-z0-9]+$/;
const SLUG_TOKEN_MAX_ALPHA = 20;
const SLUG_TOKEN_MAX_ALNUM = 8;

/** True when `segment` has the shape of a Linear issue-title slug (Q2-B). */
function isLinearIssueSlug(segment) {
  if (!segment) return false;
  for (const token of segment.split("-")) {
    if (!SLUG_TOKEN_RE.test(token)) return false;
    const max = /[0-9]/.test(token) ? SLUG_TOKEN_MAX_ALNUM : SLUG_TOKEN_MAX_ALPHA;
    if (token.length > max) return false;
  }
  return true;
}

// FOC-788 (Mateusz, 2026-10-15: "tak w komentarzu linear podaj tez nazwe
// galezi"): posted text may name the managed spawn ref it published — the
// publish audit comment carries the branch, not just the head sha. A managed
// ref is machine-made, not hand-written: `buildBranchName` (dev-branch.mjs)
// emits `<teamKey>-<number>-<slug>` — team key letters-lowercased, number
// digits, slug sanitized to [a-z0-9] tokens joined by single hyphens — and
// supervisor-spawn.mjs appends `-<hash12>`, a 12-hex slice of
// sha256(runId:childId). The full shape is an identifier, not a secret.
//
// The exemption is deliberately narrower than "anything kebab-shaped", and the
// narrowing is the interlock with Q2-B (2026-10-09): a Linear issue-TITLE slug
// has NO trailing 12-hex attempt hash, so it does NOT match here and stays
// screened in bare prose — the corpus pins in egress-screen.test.mjs §7 (which
// are old-style `foc-N-slug` names) remain blocked exactly as Q2-B decided.
// The attempt hash is what separates a machine-generated ref from a human
// title; without it this gate would have re-opened what Q2-B closed.
//
// Reach: family E only (same as the FOC-733 spans) — key-prefix, pem,
// env-assignment and jwt still fire on anything shaped like their families,
// managed-ref-looking or not. Position-independent: the shape itself is the
// anchor (unlike the FOC-733 slug, which needs its /issue/<KEY>/ position),
// because `foc-123-…-<hash12>` is not a natural-language construct.
//
// ACCEPTED RESIDUAL, documented on purpose (same class as FOC-733's Q2-B
// residual, and closed by the same non-option — Q2-C rejected any lookup-based
// check): a passphrase spelled `<letters>-<digits>-<kebab…>-<12 hex>` sails
// through this gate. A secret that starts with a team-key + issue-number and
// ends with an exact 12-hex token is not a plausible token format — the
// prefixed (ghp_, sk-, …) and env-name families cover the real ones — and a
// gate for the spawn-managed shape is exactly the grant Mateusz gave, never a
// general loosening. A ref that does NOT fit the shape (renamed branches,
// legacy pre-attempt-hash names like `foc-143-r5-…-stack`) falls back to the
// ordinary family E rules: it is refused, not silently waved through.
const MANAGED_GIT_REF_RE = /^[a-z]{1,8}-[0-9]{1,8}(?:-[a-z0-9]{1,40}){1,32}-[0-9a-f]{12}$/;

/** True when `run` has the shape of a spawn-managed ref (FOC-788). */
function isManagedGitRef(run) {
  return MANAGED_GIT_REF_RE.test(run);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shannon entropy of `s` in bits per character. */
function shannonBitsPerChar(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 1-based line/column of a string index (column counts from the line start). */
function lineColOf(text, index) {
  const upto = text.slice(0, index);
  const line = (upto.match(/\n/g) || []).length + 1;
  const lastNl = upto.lastIndexOf("\n");
  return { line, column: index - lastNl };
}

/** Charset name for a shape description — public info about the token's FORM. */
function charsetName(s) {
  if (/^[0-9a-f]+$/.test(s) || /^[0-9A-F]+$/.test(s)) return "hex";
  if (/[+/=]/.test(s)) return "base64";
  if (/[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) return "base62";
  if (/[-_]/.test(s)) return "base64url";
  if (/^[A-Za-z0-9]+$/.test(s)) return "alnum";
  return "mixed";
}

function charClassCount(s) {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[+/=._-]/.test(s)) n++;
  return n;
}

/** The public prefix a matched token starts with, longest-first. */
function publicPrefixOf(token) {
  for (const p of KNOWN_PREFIXES) {
    if (token.startsWith(p)) return p;
  }
  return "unknown";
}

/** A hit describes the SHAPE of a match. It never carries the matched value. */
function makeHit(family, shape, line, column) {
  return { family, shape, line, column };
}

/**
 * Family A hits: a known public prefix followed by a token body.
 * Shape example: `<48-char base62 token, prefix sk-or->`.
 */
function detectKeyPrefixes(text, spans) {
  const hits = [];
  KEY_PREFIX_RE.lastIndex = 0;
  let m;
  while ((m = KEY_PREFIX_RE.exec(text)) !== null) {
    const token = m[0];
    const { line, column } = lineColOf(text, m.index);
    const prefix = publicPrefixOf(token);
    hits.push(
      makeHit(
        "key-prefix",
        `<${token.length}-char ${charsetName(token)} token, prefix ${prefix}>`,
        line,
        column,
      ),
    );
    spans.push([m.index, m.index + token.length]);
  }
  return hits;
}

/**
 * Family B hits: PEM private-key material. A full block reports the line
 * count; a BEGIN without END (a truncated paste) is still egress material and
 * is reported as its own shape.
 */
function detectPem(text, spans) {
  const hits = [];
  const beginOnly = [];
  PEM_FULL_RE.lastIndex = 0;
  let m;
  while ((m = PEM_FULL_RE.exec(text)) !== null) {
    const { line, column } = lineColOf(text, m.index);
    const lines = (m[0].match(/\n/g) || []).length + 1;
    hits.push(makeHit("pem", `<PEM private-key block, ${lines} lines>`, line, column));
    spans.push([m.index, m.index + m[0].length]);
    beginOnly.push(m.index);
  }
  // A BEGIN marker already inside a full block is the same secret, not a second hit.
  PEM_BEGIN_RE.lastIndex = 0;
  while ((m = PEM_BEGIN_RE.exec(text)) !== null) {
    if (beginOnly.includes(m.index)) continue;
    const { line, column } = lineColOf(text, m.index);
    hits.push(makeHit("pem", `<PEM private-key header (BEGIN without END)>`, line, column));
    spans.push([m.index, m.index + m[0].length]);
  }
  return hits;
}

/**
 * Extract the VALUE side of an env-style line: a quoted string wins, otherwise
 * the first whitespace-delimited token after stripping a trailing `# comment`.
 * Everything-after-`=` would swallow prose a comment author appended after the
 * value ("KEY=value — see runbook"), and the prose alone is not a secret.
 */
function envValueOf(rawValue) {
  const t = rawValue.trim();
  const quote = t[0];
  if (quote === '"' || quote === "'") {
    const end = t.indexOf(quote, 1);
    return end > 0 ? t.slice(1, end) : t.slice(1);
  }
  const noComment = t.split(/\s+#/)[0].trim();
  const sp = noComment.search(/\s/);
  return sp > 0 ? noComment.slice(0, sp) : noComment;
}

/**
 * Family C hits: env-style lines whose NAME looks secret-bearing and whose
 * value is a literal (placeholders and $VAR indirections are not values).
 * The NAME is reported — a config name is not a secret value.
 */
function detectEnvAssignments(text, spans) {
  const hits = [];
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ENV_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const [, name, rawValue] = m;
    if (!SECRET_NAME_RE.test(name)) continue;
    const value = envValueOf(rawValue);
    if (!value || NON_VALUE_RE.test(value)) continue;
    const { line, column } = lineColOf(text, offsets[i] + m.index);
    hits.push(makeHit("env-assignment", `<env-style assignment to secret-bearing name ${name}>`, line, column));
    spans.push([offsets[i] + m.index, offsets[i] + lines[i].length]);
  }
  return hits;
}

/** Family D hits: three dot-separated base64url segments with an eyJ… header. */
function detectJwt(text, spans) {
  const hits = [];
  JWT_RE.lastIndex = 0;
  let m;
  while ((m = JWT_RE.exec(text)) !== null) {
    const { line, column } = lineColOf(text, m.index);
    hits.push(
      makeHit("jwt", `<JWT-shaped token (3 base64url segments, ${m[0].length} chars)>`, line, column),
    );
    spans.push([m.index, m.index + m[0].length]);
  }
  return hits;
}

/**
 * Family E hits: long mixed-class runs with high Shannon entropy. Runs already
 * reported by families A–D are skipped (same secret, not a second shape).
 * Pure-hex runs, data-URI payloads, and low-class runs are excluded — see
 * HEX_RUN_RE above for the why. Linear issue-URL slug segments (FOC-733,
 * via extraSpans) are exempt, as are managed spawn refs (FOC-788).
 */
function detectHighEntropy(text, spans, extraSpans = []) {
  const hits = [];
  const excluded = spans.concat(extraSpans);
  ENTROPY_RUN_RE.lastIndex = 0;
  let m;
  while ((m = ENTROPY_RUN_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = excluded.some(([s, e]) => start < e && end > s);
    if (overlaps) continue;
    const run = m[0];
    if (HEX_RUN_RE.test(run)) continue;
    if (ISO_DATE_LIKE_RE.test(run)) continue;
    if (/;base64,$/.test(text.slice(Math.max(0, start - BASE64_PAYLOAD_WINDOW), start))) continue;
    if (charClassCount(run) < ENTROPY_MIN_CLASSES) continue;
    const h = shannonBitsPerChar(run);
    const flagged =
      (run.length >= ENTROPY_MIN_LEN && h >= ENTROPY_THRESHOLD_PRIMARY) ||
      (run.length >= 32 && h >= ENTROPY_THRESHOLD_RELAXED);
    if (!flagged) continue;
    const { line, column } = lineColOf(text, start);
    hits.push(
      makeHit(
        "high-entropy",
        `<${run.length}-char high-entropy ${charsetName(run)} token (${charClassCount(run)} classes, ${h.toFixed(1)} bits/char)>`,
        line,
        column,
      ),
    );
    spans.push([start, end]);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Typed-refusal marker: `error.code === "EGRESS_BLOCKED"` distinguishes the screen. */
export const EGRESS_BLOCKED = "EGRESS_BLOCKED";

/**
 * Scan candidate outbound text for secret-shaped material.
 * Pure, synchronous, offline: regex and string arithmetic only — no network
 * capability exists in this function, and egress-screen.test.mjs pins that
 * (fetch stubbed to throw, scan still completes).
 *
 * @param {string} text  The text that is about to leave the process.
 * @returns {{ family: string, shape: string, line: number, column: number }[]}
 *   Sorted by position. Empty = clean. Hits describe shape, never value.
 */
export function scanEgress(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const spans = [];
  const hits = [
    ...detectKeyPrefixes(text, spans),
    ...detectPem(text, spans),
    ...detectEnvAssignments(text, spans),
    ...detectJwt(text, spans),
    ...detectHighEntropy(text, spans, publicBlockSpans(text).concat(linearIssueSlugSpans(text), managedGitRefSpans(text))),
  ];
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Spans of ANY delimited PEM-style region (certificates, public keys, …) —
 * public material whose base64 body must not read as a high-entropy hit. */
function publicBlockSpans(text) {
  const spans = [];
  PEM_ANY_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = PEM_ANY_BLOCK_RE.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** Spans of Linear issue-URL slug segments (FOC-733) — natural-language
 * kebab-case titles the relaxed entropy branch misreads as secrets. The match
 * anchors the segment IMMEDIATELY after /issue/<KEY>/ and requires a COMPLETE
 * path segment (see LINEAR_ISSUE_SLUG_RE), and Q2-B additionally requires the
 * segment to LOOK like a Linear title slug (isLinearIssueSlug). So only that
 * exact segment is exempt: a Linear URL elsewhere in the text never shields a
 * neighbouring run, the same slug outside such a URL is still screened, and a
 * secret-shaped value sitting in the slug position falls back to the ordinary
 * family E rules. */
function linearIssueSlugSpans(text) {
  const spans = [];
  LINEAR_ISSUE_SLUG_RE.lastIndex = 0;
  let m;
  while ((m = LINEAR_ISSUE_SLUG_RE.exec(text)) !== null) {
    const segment = m[1];
    if (!isLinearIssueSlug(segment)) continue;
    const start = m.index + m[0].length - segment.length;
    spans.push([start, start + segment.length]);
  }
  return spans;
}

/** Spans of managed spawn refs (FOC-788) — the exact candidate runs family E
 * would consider (same ENTROPY_RUN_RE boundaries), kept only when the whole
 * run has the managed-ref shape (isManagedGitRef). A run the shape does not
 * fit — a renamed or legacy ref, or an unrelated token glued to one — is not
 * spanned and falls back to the ordinary family E rules. */
function managedGitRefSpans(text) {
  const spans = [];
  ENTROPY_RUN_RE.lastIndex = 0;
  let m;
  while ((m = ENTROPY_RUN_RE.exec(text)) !== null) {
    if (!isManagedGitRef(m[0])) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** CLI-facing refusal message. The LAST line is self-describing on purpose:
 * supervisor-verdict.mjs surfaces the child's last stderr line as the failure
 * detail, so that line must name the shape on its own. */
function cliMessage(hits, label) {
  const lines = [
    `Error: [egress-blocked] outbound text refused (${label}) — ${hits.length} secret-shaped hit(s); nothing was posted`,
  ];
  const shown = hits.slice(0, 10);
  for (const h of shown) {
    lines.push(`  line ${h.line} col ${h.column}: ${h.shape}`);
  }
  if (hits.length > shown.length) {
    lines.push(`  … +${hits.length - shown.length} more hit(s) omitted`);
  }
  lines.push(
    `Blocked (first hit): ${shown[0].shape} — remove the secret from the text and retry; the mutation was never issued.`,
  );
  return lines.join("\n");
}

/** The typed error callers catch to recognise a screen refusal. */
export class EgressBlockedError extends Error {
  /**
   * @param {{ family: string, shape: string, line: number, column: number }[]} hits
   * @param {string} label  Short caller context, e.g. "comment body".
   */
  constructor(hits, label) {
    super(cliMessage(hits, label));
    this.name = "EgressBlockedError";
    this.code = EGRESS_BLOCKED;
    this.hits = hits;
    this.label = label;
  }
}

/**
 * Screen `text` and throw EgressBlockedError on any hit. Call this on every
 * string that is about to leave the process toward Linear or GitHub.
 * @param {string} text
 * @param {string} label  Short caller context for the refusal message.
 * @returns {void}  Returns silently when the text is clean.
 * @throws {EgressBlockedError} When any secret-shaped hit is found — fail closed.
 */
export function assertEgressClean(text, label) {
  const hits = scanEgress(text);
  if (hits.length > 0) throw new EgressBlockedError(hits, label);
}

// ---------------------------------------------------------------------------
// Raw-leaf extraction for the egress checkpoint
// ---------------------------------------------------------------------------

// FOC-643/FOC-646: the raw string leaves an egress checkpoint screens, as
// [label, text] pairs — ONE extractor shared by both callers so the screened
// leaf sets cannot drift. Decision seam shape ({state, questions}): the state
// verbatim; per question the id and, at the QUESTION_SCHEMA shape (type,
// instructions, criteria), each field's string value and — for an object field
// like criteria — each label and text. Shadow-run replay shapes (FOC-646):
// extraction {text}; refinement {prompt, features} — the prompt and every
// feature's name and size. Fixed depth, no recursion: deeper shapes are
// schema-rejected before the provider, so they are never sent and need no
// screening. Raw text only: the screen runs on exactly the strings a caller
// puts into the provider input, never on a serialization — the env-assignment
// detector is line-anchored and a compact-JSON serialization would blind it
// (FOC-643 review round 1).
export function egressLeaves(input) {
  const leaves = [];
  // Decision seam ({state, questions}) — the FOC-643 screened set, unchanged.
  if (typeof input?.state === "string") leaves.push(["state", input.state]);
  const questions = input?.questions;
  if (questions && typeof questions === "object") {
    for (const [qid, q] of Object.entries(questions)) {
      leaves.push([`questions.${qid}`, qid]);
      if (!q || typeof q !== "object") continue;
      for (const [field, value] of Object.entries(q)) {
        if (typeof value === "string") {
          leaves.push([`questions.${qid}.${field}`, value]);
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [k, v] of Object.entries(value)) {
            leaves.push([`questions.${qid}.${field}.${k}`, k]);
            if (typeof v === "string") leaves.push([`questions.${qid}.${field}.${k}`, v]);
          }
        }
      }
    }
  }
  // Shadow-run replay shapes (FOC-646): extraction {text}; refinement
  // {prompt, features:[{name,size},...]}. Disjoint from the seam shape in
  // practice — the seam input is schema-locked to {state, questions}.
  if (typeof input?.text === "string") leaves.push(["text", input.text]);
  if (typeof input?.prompt === "string") leaves.push(["prompt", input.prompt]);
  const features = input?.features;
  if (Array.isArray(features)) {
    for (const [i, f] of features.entries()) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.name === "string") leaves.push([`features.${i}.name`, f.name]);
      if (typeof f.size === "string") leaves.push([`features.${i}.size`, f.size]);
    }
  }
  return leaves;
}

// ---------------------------------------------------------------------------
// CLI — the local guard for text composed outside a chokepoint (PR bodies,
// ad-hoc posts): node scripts/egress-screen.mjs check (--body <t> | --body-file <p>)
// ---------------------------------------------------------------------------

function printUsage(stream) {
  stream("Usage: node scripts/egress-screen.mjs check (--body <text> | --body-file <path>)");
  stream("  Local, offline screen for text about to be posted to Linear or GitHub.");
  stream("  Exit: 0 clean, 1 blocked (secret-shaped hit), 2 usage.");
}

function runCli(argv) {
  let body = null;
  let bodyFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage(console.log);
      process.exit(0);
    } else if (a === "--body" && i + 1 < argv.length) {
      body = argv[++i];
    } else if (a === "--body-file" && i + 1 < argv.length) {
      bodyFile = argv[++i];
    } else if (a === "check") {
      // accepted subcommand; flags carry the text
    } else {
      console.error(`Error: unknown argument "${a}"`);
      printUsage(console.error);
      process.exit(2);
    }
  }
  if (body !== null && bodyFile) {
    console.error("Error: provide --body OR --body-file, not both");
    process.exit(2);
  }
  if (bodyFile) {
    try {
      body = readFileSync(bodyFile, "utf8");
    } catch (err) {
      console.error(`Error reading --body-file "${bodyFile}": ${err.message}`);
      process.exit(2);
    }
  }
  if (body === null) {
    printUsage(console.error);
    process.exit(2);
  }
  const hits = scanEgress(body);
  if (hits.length > 0) {
    console.error(cliMessage(hits, "checked text"));
    process.exit(1);
  }
  console.log(`OK: no secret-shaped hits (${body.length} chars scanned)`);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2));
}

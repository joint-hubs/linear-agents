// scripts/mcp/scrub.mjs — the ONE scrubber for provider-originated text that
// enters an error path (FOC-417; the two rules were extracted from the local
// helper decision-call.mjs carried since FOC-411).
//
// Defense in depth, and nothing else: the fail-closed contract in envelope.mjs
// is unchanged. scrub() only REMOVES or MASKS characters — it never adds text,
// never re-routes an error, and never changes a code. Two jobs, in this order:
//
//   1. mask key-shaped material — header values, tokenized URL query params,
//      sk-style API keys, and the long opaque runs the FOC-411 lesson caught.
//      Key-shaped patterns only: the target is credentials and the URLs that
//      carry them, not a keyword blacklist that would have to be maintained.
//   2. truncate at MAX_ERROR_TEXT — one documented cap for every
//      provider-originated message, so an error path cannot be used to ferry
//      an unbounded blob back to the caller.
//
// Masking runs BEFORE truncation on purpose: a cap applied first could split a
// key in half and leave its readable prefix in the message.

// One cap, one place (R2/AC-2). 120 is the value the JSON-RPC parse detail
// already used inline, folded in here rather than kept as a second constant.
export const MAX_ERROR_TEXT = 120;

const REDACTED = "[REDACTED]";

// Most specific first, generic last. Every pattern below matches a value only
// a credential (or a URL carrying one) produces.
const KEY_PATTERNS = [
  // Authorization: Bearer/Basic/Token <value> — header line or prose.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // An Authorization header written as a field: `Authorization: <value>`.
  [/\b(authorization)\s*[:=]\s*[^\s,;]+/gi, `$1: ${REDACTED}`],
  // Tokenized URL query params and JSON fields — token=, key=, api_key=,
  // apikey=, access_token=. The value run stops at the delimiters that end a
  // query parameter or a JSON string.
  [/\b(access_token|refresh_token|api[_-]?key|apikey|token|key)("?\s*[=:]\s*"?)([^"&\s,;]+)/gi, `$1$2${REDACTED}`],
  // sk-style API keys (sk-…, sk-or-v1-…).
  [/\bsk-[A-Za-z0-9._-]{8,}/g, REDACTED],
  // Any long opaque run — the FOC-411 length heuristic, kept last so the named
  // patterns above win and the mask stays readable.
  [/[A-Za-z0-9_-]{32,}/g, REDACTED],
];

/**
 * Mask key-shaped material in `text`, then truncate it to MAX_ERROR_TEXT.
 * Accepts anything; a non-string is stringified, undefined/null become "".
 */
export function scrub(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of KEY_PATTERNS) out = out.replace(pattern, replacement);
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT - 3)}...` : out;
}
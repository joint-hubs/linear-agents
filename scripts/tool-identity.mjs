// tool-identity.mjs — content identity for tool inputs and results (FOC-220).
//
// tool_facts stores WHAT a call was, never WHAT IT CONTAINED: the input preview
// is truncated at 1000 chars and the result is not stored at all. Both need a
// stable identity that survives those limits without leaking content:
//
//   input identity   HMAC-SHA256(salt, canonical-input-JSON) — computed over the
//                    COMPLETE input before any display truncation, with object
//                    keys sorted at every depth, so key order and a shared
//                    1000-char prefix cannot change it.
//   result digest    HMAC-SHA256(salt, result-text) — equality evidence for
//                    repeat classification ("did the poll see the same output"),
//                    never the content itself.
//
// The salt is a random per-database value (store_settings in telemetry-store.mjs,
// never hardcoded, never logged). A bare unsalted digest of a short argument —
// a file path, a token — is a trivially invertible confirmation oracle: hash a
// guess, compare. Keying the digest with a store-local salt removes that oracle
// for anyone who sees only the digests (exports, reports, dashboards). It is NOT
// protection against someone holding the whole database: the salt sits next to
// the digests by design, because that same database already holds the previews.

import { createHmac } from "node:crypto";

/**
 * Deterministic JSON serialization with object keys sorted at every depth.
 *
 * Accepts a value or a JSON string (parsed first). Arrays keep their order —
 * element order is semantic in tool arguments. Returns null when the value
 * cannot be serialized (cycles) or the string cannot be parsed; callers treat
 * null as "identity unknown", never as a digest of a partial input.
 *
 * @param {unknown} valueOrJsonString
 * @returns {string|null}
 */
export function canonicalInputJson(valueOrJsonString) {
  let value = valueOrJsonString;
  if (typeof valueOrJsonString === "string") {
    try {
      value = JSON.parse(valueOrJsonString);
    } catch {
      return null;
    }
  }
  try {
    return serializeCanonical(value, new Set());
  } catch {
    return null;
  }
}

function serializeCanonical(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") throw new TypeError("bigint is not JSON-serializable");
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (seen.has(value)) throw new TypeError("circular structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => {
        const serialized = serializeCanonical(item, seen);
        return serialized === undefined ? "null" : serialized;
      }).join(",")}]`;
    }
    if (value instanceof Map) {
      return serializeCanonical(Object.fromEntries(value), seen);
    }
    if (value instanceof Set) {
      return serializeCanonical([...value], seen);
    }
    const keys = Object.keys(value).sort();
    const pairs = [];
    for (const key of keys) {
      const serialized = serializeCanonical(value[key], seen);
      if (serialized === undefined) continue;
      pairs.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${pairs.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Identity of a COMPLETE tool input: HMAC-SHA256 over its canonical JSON.
 *
 * Equivalent argument maps (same keys and values at every depth, any key order)
 * produce the same digest. Returns null when the input cannot be canonicalized.
 *
 * @param {unknown} valueOrJsonString  The full input (or its JSON serialization)
 * @param {string} saltHex             Per-store salt (hex string from store_settings)
 * @returns {string|null}              64-char hex digest, or null if unknown
 */
export function inputIdentity(valueOrJsonString, saltHex) {
  if (!saltHex) throw new Error("inputIdentity requires a per-store salt — refusing an unsalted digest");
  const canonical = canonicalInputJson(valueOrJsonString);
  if (canonical === null) return null;
  return createHmac("sha256", saltHex).update(canonical).digest("hex");
}

/**
 * Digest of tool-result TEXT (not JSON — results are prose, file bodies, logs).
 * Equality evidence only: same digest means byte-identical result text.
 *
 * @param {string} text
 * @param {string} saltHex
 * @returns {string|null} 64-char hex digest, or null when text is not a string
 */
export function contentDigest(text, saltHex) {
  if (!saltHex) throw new Error("contentDigest requires a per-store salt — refusing an unsalted digest");
  if (typeof text !== "string") return null;
  return createHmac("sha256", saltHex).update(text).digest("hex");
}

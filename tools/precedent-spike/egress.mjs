/**
 * tools/precedent-spike/egress.mjs - fail-closed outbound-text sanitiser shared by embed.mjs and jev_pilot.mjs.
 * Uses the repo's own detector (scripts/egress-screen.mjs). Never sends, never logs a value: only family/shape.
 */
import { scanEgress } from "../../scripts/egress-screen.mjs";

/**
 * Fail-closed sanitiser. Any non-"high-entropy" family (key prefix, PEM, env assignment, JWT) blocks the
 * item outright. High-entropy runs — in engineering tickets mostly long hyphenated slugs and branch
 * names — are replaced by <token> and the text is re-screened; still dirty after 4 passes => blocked.
 * The screen therefore always runs on the exact string that is sent, and a flagged span is never sent.
 */
export function sanitize(text) {
  let t = text, masked = 0;
  for (let pass = 0; pass < 4; pass++) {
    const hits = scanEgress(t);
    if (!hits.length) return { text: t, masked, blocked: null };
    const bad = hits.filter((h) => h.family !== "high-entropy");
    if (bad.length) return { text: t, masked, blocked: bad.slice(0, 5).map((h) => ({ family: h.family, shape: h.shape })) };
    const lines = t.split("\n");
    for (const h of [...hits].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const L = lines[h.line - 1] ?? "";
      const s = h.column - 1;
      let e = s;
      while (e < L.length && /[A-Za-z0-9_-]/.test(L[e])) e++;
      if (e === s) return { text: t, masked, blocked: [{ family: h.family, shape: h.shape }] };
      lines[h.line - 1] = L.slice(0, s) + "<token>" + L.slice(e);
      masked++;
    }
    t = lines.join("\n");
  }
  const left = scanEgress(t);
  return left.length ? { text: t, masked, blocked: left.slice(0, 5).map((h) => ({ family: h.family, shape: h.shape })) } : { text: t, masked, blocked: null };
}

// Query-string builder for the /api/analysis panels — pure JS, no React and
// no import.meta.env, so plain node can import it in _tests_analysis.mjs.
// Every panel GET takes from/to/squad/model/era/eraBoundary; empty values are
// omitted so the server applies its own defaults (era defaults to "post",
// eraBoundary to the server's FOC-397 graph-v2 boundary).

const KEYS = ['from', 'to', 'squad', 'model', 'era', 'eraBoundary'];

export function buildAnalysisQuery(filters = {}) {
  const parts = [];
  for (const key of KEYS) {
    const v = filters?.[key];
    if (v == null || v === '') continue;
    parts.push(key + '=' + encodeURIComponent(v));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

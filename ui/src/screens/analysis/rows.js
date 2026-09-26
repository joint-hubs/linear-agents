// Pure row-shape adapter for the SQL console (FOC-397 analysis dashboard).
// The SQL endpoint (scripts/analysis-sql.mjs) answers with POSITIONAL rows —
// { columns: string[], rows: any[][] } — while every table on this screen
// (DataTable, and the CSV/JSON exports that hang off it) works on objects
// keyed by column name. This is the single place that knows both shapes, so
// the mapping rule lives in exactly one module and can be unit-tested under
// plain node (no JSX, no framework).

/**
 * Convert a positional SQL result into DataTable-ready objects.
 *
 * Duplicate column names (e.g. `SELECT a.id, b.id` — SQLite names both
 * columns "id") would silently overwrite each other as object keys, so every
 * duplicate gets a unique key: id, id_2, id_3… The header shows the unique
 * key, which also keeps sorting and the exported CSV unambiguous.
 *
 * Null cells are preserved as null (not dropped): the key still exists on
 * the row, so the header and CSV keep the column and DataTable renders the
 * em dash it renders for any genuine SQL NULL.
 *
 * Degrades safely: non-array columns/rows become empty, so a malformed
 * response renders "No rows." instead of crashing the console.
 */
export function rowsToObjects(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];

  // First occurrence keeps its name; each later duplicate takes _2, _3… —
  // and if the synthesized key itself already exists as a real column name,
  // keep bumping the suffix so the mapping stays injective.
  const seen = new Set();
  const keys = cols.map((c, i) => {
    // A missing/unnamed column must still get a stable key: an empty-string
    // key would render an invisible header and vanish from the CSV header.
    const base = typeof c === 'string' && c ? c : `col_${i + 1}`;
    if (!seen.has(base)) {
      seen.add(base);
      return base;
    }
    let n = 2;
    while (seen.has(`${base}_${n}`)) n++;
    const key = `${base}_${n}`;
    seen.add(key);
    return key;
  });

  return {
    columns: keys,
    rows: list.map((row) =>
      // row == null (a hole in the rows array) maps to undefined cells rather
      // than throwing — keys stay present so the header never lies.
      Object.fromEntries(keys.map((k, i) => [k, row == null ? undefined : row[i]]))
    ),
  };
}

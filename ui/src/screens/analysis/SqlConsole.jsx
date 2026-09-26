import { useMemo, useState } from 'react';
import { postAnalysisSql } from '../../api';
import { DataTable } from './common.jsx';
import { rowsToObjects } from './rows.js';

// SQL console over the analysis backend. POST /api/analysis/sql with target:
// 'cache' = canonical views, fast; 'store' = raw tables, read-only. Results
// are positional (rows as arrays) and go through rowsToObjects before the
// shared DataTable (sort + CSV/JSON export) — see rows.js for why. Errors
// render with their server code. Runs on Ctrl/Cmd+Enter or the Run button.
// An Examples select loads (not runs) a canned query — every example states
// the target it is valid against, and loading one selects that target too.

const STARTER_SQL =
  'SELECT squad, COUNT(*) calls, ROUND(SUM(cost_usd),2) usd FROM canonical_usage GROUP BY 1 ORDER BY usd DESC';

const TARGETS = [
  { key: 'cache', label: 'cache — canonical views, fast' },
  { key: 'store', label: 'store — raw tables, read-only' },
];

// One-line relation inventory per target, so nobody has to guess table names.
// cache: COPY_RELATIONS (analysis-cache.mjs) + the decision tables the server
// attaches as TEMP tables on every query (decision-analytics.mjs).
// store: raw fact tables + the same decision tables; canonical views exist
// there too but are slow (they re-evaluate their windows per query).
const RELATIONS_HINT = {
  cache: 'relations: canonical_usage · canonical_tool_facts · runs · delegation_links · data_quality_issues · decision_events · decision_labels',
  store: 'raw tables: usage_facts, tool_facts, runs, events, cost_facts, … + decision tables (decision_events, decision_labels) — canonical views are slow here',
};

// Canned queries, each valid for its stated target. Column names verified
// against: canonical_usage (telemetry-store.mjs CANONICAL_USAGE_SQL), runs /
// data_quality_issues (store schema), decision tables (decision-analytics.mjs
// EVENT_COLUMNS/LABEL_COLUMNS). canonical_tool_facts has no repeat-category
// column, so that example is deliberately absent.
const EXAMPLES = [
  {
    label: 'spend by squad × ISO week (cache)',
    target: 'cache',
    sql: "SELECT squad, strftime('%G-W%V', observed_at) AS iso_week, ROUND(SUM(cost_usd), 2) AS usd, COUNT(*) AS lines\nFROM canonical_usage\nWHERE observed_at IS NOT NULL\nGROUP BY 1, 2 ORDER BY 1, 2",
  },
  {
    label: 'top 20 most expensive runs (cache)',
    target: 'cache',
    sql: "SELECT r.run_id, r.squad, r.started_at, r.status, ROUND(SUM(u.cost_usd), 2) AS usd\nFROM runs r JOIN canonical_usage u ON u.run_id = r.run_id\nGROUP BY r.run_id ORDER BY usd DESC LIMIT 20",
  },
  {
    label: 'tool error rate by model (cache)',
    target: 'cache',
    sql: "SELECT model, COUNT(*) AS calls, SUM(tool_has_error) AS errors,\n       ROUND(AVG(tool_has_error) * 100, 1) AS error_pct\nFROM canonical_tool_facts\nGROUP BY 1 ORDER BY calls DESC",
  },
  {
    label: 'decision events joined to their labels (cache)',
    target: 'cache',
    sql: "SELECT e.decisionId, COUNT(*) AS compared, SUM(e.answer = l.outcome) AS matched,\n       ROUND(AVG(e.answer = l.outcome) * 100, 1) AS agreement_pct\nFROM decision_events e JOIN decision_labels l ON l.eventId = e.eventId\nWHERE e.answer IS NOT NULL\nGROUP BY 1 ORDER BY compared DESC",
  },
  {
    label: 'open data-quality issues by type (cache)',
    target: 'cache',
    sql: "SELECT issue_type, severity, COUNT(*) AS n, MIN(opened_at) AS earliest\nFROM data_quality_issues\nWHERE resolved_at IS NULL\nGROUP BY 1, 2 ORDER BY n DESC",
  },
  {
    label: 'raw usage lines by model (store)',
    target: 'store',
    sql: "SELECT model, COUNT(*) AS lines, SUM(input_tokens + output_tokens) AS tokens,\n       SUM(cache_read_tokens) AS cache_read\nFROM usage_facts\nGROUP BY 1 ORDER BY lines DESC",
  },
];

export default function SqlConsole() {
  const [sql, setSql] = useState(STARTER_SQL);
  const [target, setTarget] = useState('cache');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { columns, rows, rowCount, truncated, elapsedMs }
  const [error, setError] = useState(null);

  // The endpoint answers with positional rows (arrays); DataTable and its
  // CSV/JSON export expect objects keyed by column. Converted once per result
  // — not per keystroke — so a 5,000-row answer is not remapped on every
  // render of the editor. Duplicate column names get unique keys here.
  const table = useMemo(() => rowsToObjects(result?.columns, result?.rows), [result]);

  async function run() {
    if (running || !sql.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const r = await postAnalysisSql(sql, target);
      setResult(r);
    } catch (err) {
      setResult(null);
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  }

  function loadExample(e) {
    const ex = EXAMPLES.find((x) => x.label === e.target.value);
    if (!ex) return;
    setSql(ex.sql);
    setTarget(ex.target); // the example is only valid for its target — select it
    setError(null);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          rows={5}
          style={{
            flex: 1,
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            lineHeight: 1.5,
            padding: '8px 10px',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-sm, 6px)',
            background: 'var(--surface)',
            color: 'var(--text)',
            resize: 'vertical',
          }}
        />
      </div>
      <div className="filter-row" style={{ marginBottom: 4 }}>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="cache = canonical views, fast · store = raw tables, read-only"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        >
          {TARGETS.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
        <select
          onChange={loadExample}
          value=""
          title="load an example query into the editor (does not run it)"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)', maxWidth: '36ch' }}
        >
          <option value="">Examples…</option>
          {EXAMPLES.map((ex) => (
            <option key={ex.label} value={ex.label}>{ex.label}</option>
          ))}
        </select>
        <button className="zbtn on" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>Ctrl/Cmd+Enter</span>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
        {RELATIONS_HINT[target]}
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 16 }}>
          <span style={{ color: 'var(--danger, #b42318)', fontWeight: 600 }}>error</span>{' '}
          {String(error.message || error)}
          {error.code && <span className="muted"> · code: {error.code}</span>}
          {error.status && <span className="muted"> · HTTP {error.status}</span>}
        </div>
      )}

      {result && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span>{result.rowCount != null ? `${result.rowCount.toLocaleString('en-US')} row${result.rowCount === 1 ? '' : 's'}` : `${(result.rows || []).length} rows`}</span>
            {result.elapsedMs != null && <span>{result.elapsedMs.toLocaleString('en-US')} ms</span>}
            {result.truncated && (
              <span style={{ color: 'var(--warn, #b54708)', fontWeight: 600 }}>truncated at 5,000 rows</span>
            )}
          </div>
          <DataTable
            title="result"
            rows={table.rows}
            columns={table.columns}
            exportName="sql"
          />
        </>
      )}
    </div>
  );
}

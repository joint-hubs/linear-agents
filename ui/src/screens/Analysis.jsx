import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getAnalysisMeta, getAnalysisCache, postAnalysisCacheRebuild } from '../api';
import CostPanel from './analysis/CostPanel.jsx';
import ToolsPanel from './analysis/ToolsPanel.jsx';
import DecisionsPanel from './analysis/DecisionsPanel.jsx';
import HandoffsPanel from './analysis/HandoffsPanel.jsx';
import QualityPanel from './analysis/QualityPanel.jsx';
import SqlConsole from './analysis/SqlConsole.jsx';

// Analysis screen (FOC-397 analysis dashboard) — skeleton pass.
// Layout: cache status bar → filter bar → section tabs. Filter state and the
// selected tab live in the URL search params, so any view is linkable.
// Defaults applied client-side: era=post, from = 30 days ago.
// After a cache rebuild finishes, reloadKey bumps so the visible panel
// refetches against the fresh cache.

const TABS = [
  { key: 'cost', label: 'Cost', comp: CostPanel },
  { key: 'tools', label: 'Tools', comp: ToolsPanel },
  { key: 'decisions', label: 'Decisions', comp: DecisionsPanel },
  { key: 'handoffs', label: 'Handoffs', comp: HandoffsPanel },
  { key: 'quality', label: 'Quality', comp: QualityPanel },
  { key: 'sql', label: 'SQL console', comp: SqlConsole },
];

const ERAS = [
  { key: 'post', label: 'post' },
  { key: 'pre', label: 'pre' },
  { key: 'all', label: 'all' },
];

// Default from: 30 days ago, as a YYYY-MM-DD date-input value.
function defaultFrom() {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Human age of an ISO timestamp ("3 min ago", "2 h ago", "4 d ago").
function fmtAge(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' h ago';
  return Math.floor(h / 24) + ' d ago';
}

export default function Analysis() {
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [cache, setCache] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Filters read from the URL with client-side defaults (era=post, from=30d).
  // eraBoundary stays empty until overridden — the empty value means "use the
  // server's own boundary" (meta.data.eraBoundary), shown in the date input.
  const filters = useMemo(() => ({
    from: params.get('from') || defaultFrom(),
    to: params.get('to') || '',
    squad: params.get('squad') || '',
    model: params.get('model') || '',
    era: params.get('era') || 'post',
    eraBoundary: params.get('eraBoundary') || '',
  }), [params]);

  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'cost';

  // Update ONE param, keeping the rest — a filter change must not drop the tab
  // and vice versa. Empty values are removed so the URL stays clean.
  const setParam = useCallback((key, value) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => {
    let active = true;
    getAnalysisMeta()
      .then((m) => { if (active) setMeta(m?.data ?? m); })
      .catch(() => { if (active) setMeta(null); });
    return () => { active = false; };
  }, []);

  const refreshCache = useCallback(() => {
    getAnalysisCache().then(setCache).catch(() => {});
  }, []);

  useEffect(() => { refreshCache(); }, [refreshCache]);

  // Poll cache status every 3 s while a build is in flight; when it flips to
  // done, bump reloadKey so the visible panel refetches the fresh cache.
  const building = !!cache?.building;
  useEffect(() => {
    if (!building) return;
    const id = setInterval(() => {
      getAnalysisCache().then((c) => {
        setCache(c);
        if (!c?.building) setReloadKey((k) => k + 1);
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [building]);

  async function rebuild() {
    try {
      await postAnalysisCacheRebuild();
    } catch (err) {
      // 409 build_in_progress: a build is already running — the poll below
      // takes over. Anything else is surfaced by the status line.
      if (err?.code !== 'build_in_progress') { setCache(null); }
    }
    refreshCache();
  }

  const Active = TABS.find((t) => t.key === tab).comp;
  // Era boundary: the server's value is the default; the URL param overrides
  // it. Empty override -> show (and query with) the server's boundary.
  const metaBoundary = meta?.eraBoundary ? meta.eraBoundary.slice(0, 10) : null;
  const eraBoundary = filters.eraBoundary || metaBoundary || '';
  const boundaryOverridden = !!filters.eraBoundary;

  // One-line echo of the active filters (PRD §4: a panel screenshot must be
  // self-describing). SQL console ignores filters, so it gets no line.
  const activeFilterLine = tab === 'sql' ? null : (
    `era ${filters.era} (boundary ${eraBoundary || '—'})`
    + ` · ${filters.from} → ${filters.to || 'now'}`
    + ` · squad ${filters.squad || 'all'}`
    + ` · model ${filters.model || 'all'}`
    + ' · dates are UTC'
    + (tab === 'decisions' && (filters.squad || filters.model)
      ? ' — squad/model do not apply to decisions'
      : '')
  );

  return (
    <div className="page">
      <div className="page-title">Analysis</div>
      <div className="page-sub">Canonical-view analytics · cost, tools, decisions, handoffs, quality</div>

      {/* Cache status bar */}
      <div className="filter-row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {cache == null ? (
            'cache status unavailable'
          ) : building ? (
            <span style={{ color: 'var(--run, #175cd3)', fontWeight: 600 }}>building…</span>
          ) : cache.exists ? (
            <>
              cache built {fmtAge(cache.builtAt) || 'at ' + cache.builtAt}
              {cache.buildMs != null && <> · {(cache.buildMs / 1000).toFixed(1)} s</>}
              {cache.stale && (
                <span style={{ color: 'var(--warn, #b54708)', fontWeight: 600 }}> · stale</span>
              )}
              {!cache.current && <span className="muted"> · store unreadable</span>}
            </>
          ) : (
            'no analysis cache yet'
          )}
        </span>
        <button className="zbtn" onClick={rebuild}>Refresh cache</button>
      </div>

      {/* Filter bar — state in the URL, so a view is linkable */}
      <div className="filter-row">
        <input
          type="date"
          value={filters.from}
          onChange={(e) => setParam('from', e.target.value)}
          title="from (ISO date)"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        />
        <span className="muted">→</span>
        <input
          type="date"
          value={filters.to}
          onChange={(e) => setParam('to', e.target.value)}
          title="to (ISO date)"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        />
        <select
          value={filters.squad}
          onChange={(e) => setParam('squad', e.target.value)}
          title="squad"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        >
          <option value="">all squads</option>
          {(meta?.squads || []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filters.model}
          onChange={(e) => setParam('model', e.target.value)}
          title="model"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)', maxWidth: 260 }}
        >
          <option value="">all models</option>
          {(meta?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          value={filters.era}
          onChange={(e) => setParam('era', e.target.value)}
          title="era — which side of the graph-v2 boundary"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        >
          {ERAS.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>era boundary</span>
        <input
          type="date"
          value={eraBoundary}
          onChange={(e) => {
            // Back to the server default -> drop the param entirely.
            setParam('eraBoundary', e.target.value === (metaBoundary || '') ? null : e.target.value);
          }}
          title="era boundary — the FOC-397 graph-v2 judgement; empty uses the server's value"
          style={{ font: 'inherit', fontSize: 12.5, padding: '6px 8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--surface)' }}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          (FOC-397 graph v2)
          {boundaryOverridden && (
            <>
              {' · '}
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); setParam('eraBoundary', null); }}
                style={{ color: 'inherit' }}
              >
                reset
              </a>
            </>
          )}
        </span>
      </div>

      {/* Section tabs — the selected tab is a URL param too */}
      <div className="tl-controls" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={'zbtn' + (tab === t.key ? ' on' : '')}
            onClick={() => setParam('tab', t.key === 'cost' ? null : t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active-filter echo (PRD §4) — above the panel, not the SQL console. */}
      {activeFilterLine && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{activeFilterLine}</div>
      )}

      {/* Only the active panel is rendered; SQL console ignores filters. */}
      {tab === 'sql' ? <SqlConsole /> : <Active filters={filters} reloadKey={reloadKey} />}
    </div>
  );
}

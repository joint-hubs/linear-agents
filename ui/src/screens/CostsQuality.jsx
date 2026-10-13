// Costs & quality (FOC-785, dashboard-v2-spec §4.4) — what a ticket costs and
// how often it is right first time. Polls /api/costs and /api/quality in
// parallel every 60 s (Promise.allSettled): one endpoint failing costs its
// banner, never the page — the last data stays mounted and renders "unknown",
// never a fake zero (plan, shared decisions). Every number comes from
// costsModel.js, the pure helpers the node tests pin. Each section sits in its
// own PanelBoundary so one bad payload shape blanks a panel, not the screen.

import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import './costs.css';
import { getCosts, getQuality } from '../api';
import { usePoll } from '../hooks/usePoll';
import PanelBoundary from '../components/cockpit/PanelBoundary';
import {
  PERIODS,
  kpiTiles,
  attributionBanner,
  byDayBars,
  modelMixRows,
  expensiveRows,
  qualityCards,
} from '../costsModel';
import { staleLabel } from '../workModel';

// The quality cards' labels (spec §4.4 wording). The payload carries the key
// and the written definition; the label is presentation, so it lives here.
const SIGNAL_LABELS = {
  firstTimeRight: 'First-time right',
  reworkShare: 'Rework share of cost',
  interventionsPerTicket: 'Human interventions per ticket',
  landingYield: 'Landing yield',
};

const errorMessage = (err) => (err && err.message ? err.message : String(err));

// '2026-10-12' -> '10-12' for the axis labels; anything else passes through.
const shortDay = (day) => (typeof day === 'string' && day.length === 10 ? day.slice(5) : day || '');

export default function CostsQuality() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('period');
  const period = PERIODS.some((p) => p.key === raw) ? raw : '7d';

  const setPeriod = (key) => {
    setSearchParams({ period: key }, { replace: true });
  };

  // Both endpoints in parallel; allSettled means one failure resolves with the
  // other's data — the screen never blanks because /api/quality is down.
  const fetcher = useCallback(
    async (signal) => {
      const [costs, quality] = await Promise.allSettled([
        getCosts(period, signal),
        getQuality(period, signal),
      ]);
      const pick = (r) =>
        r.status === 'fulfilled' ? { data: r.value, error: null } : { data: null, error: r.reason };
      return { costs: pick(costs), quality: pick(quality) };
    },
    [period],
  );
  const { data, error, loading, refresh } = usePoll(fetcher, 60000, [period]);

  const costsRes = data?.costs || { data: null, error: null };
  const qualityRes = data?.quality || { data: null, error: null };
  const costs = costsRes.data;
  const quality = qualityRes.data;

  // Data age (spec §8): the costs snapshot's computedAt/stale/state; the
  // quality payload is the fallback when costs has nothing to say.
  const age = staleLabel(costs || quality);

  const banner = attributionBanner(costs);
  const bars = byDayBars(costs?.byDay);
  const mix = modelMixRows(costs?.byModel);
  const expensive = expensiveRows(costs?.mostExpensive);
  const cards = qualityCards(quality);

  // The evidence links need the ticket ids, which qualityCards counts but does
  // not carry — read them off the raw payload, keyed by signal.
  const evidenceBySignal = useMemo(() => {
    const out = {};
    for (const s of (quality && quality.signals) || []) {
      if (s && s.key) out[s.key] = Array.isArray(s.evidence) ? s.evidence : [];
    }
    return out;
  }, [quality]);

  const firstLoading = loading && !costs && !quality;

  return (
    <div className="costs-q">
      <div className="cq-head">
        <h2 className="section-h" style={{ marginBottom: 2 }}>Costs &amp; quality</h2>
        <span className="muted" style={{ fontSize: 12 }}>{age}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={refresh}>
          Refresh
        </button>
      </div>

      {(costsRes.error || qualityRes.error || error) && (
        <div className="banner banner-warn" style={{ marginTop: 10 }}>
          {costsRes.error && <div>Costs unavailable: {errorMessage(costsRes.error)} — showing the last data.</div>}
          {qualityRes.error && <div>Quality unavailable: {errorMessage(qualityRes.error)} — showing the last data.</div>}
          {error && <div>Refresh failed: {errorMessage(error)} — showing the last data.</div>}
        </div>
      )}

      <div className="cq-periods" role="tablist" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            role="tab"
            aria-selected={p.key === period}
            className={p.key === period ? 'cq-period cq-period-active' : 'cq-period'}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {firstLoading && <p className="muted" style={{ fontSize: 12.5 }}>Loading…</p>}

      {banner && (
        <PanelBoundary label="Attribution">
          <div className="banner banner-warn">
            <div>{banner.text}</div>
            <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>{banner.definition}</div>
          </div>
        </PanelBoundary>
      )}

      <PanelBoundary label="KPIs">
        <div className="cq-kpis">
          {kpiTiles(costs).map((t) => (
            <div className="cq-kpi" key={t.key}>
              <div className="cq-kpi-label">{t.label}</div>
              <div className="cq-kpi-value" title={t.definition}>{t.value}</div>
              {t.sub && <div className="cq-kpi-sub">{t.sub}</div>}
              <details className="cq-def">
                <summary>What is this?</summary>
                <p>{t.definition}</p>
              </details>
            </div>
          ))}
        </div>
      </PanelBoundary>

      <PanelBoundary label="Spend by day">
        <div className="cq-section">
          <h3 className="cq-section-h">Spend by day</h3>
          {bars.bars.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>{bars.summary}</p>
          ) : (
            <>
              <div className="cq-bars" role="img" aria-label={bars.summary}>
                {bars.bars.map((b, i) => {
                  // Labels on a long axis repeat every Nth day so 30+ days
                  // still fit; the summary line carries the full story.
                  const every = Math.ceil(bars.bars.length / 16);
                  return (
                    <div className="cq-bar-col" key={b.day || i}>
                      <div className="cq-bar-stack">
                        <div
                          className="cq-bar-seg cq-bar-children"
                          style={{ height: (bars.max > 0 ? (b.children / bars.max) * 100 : 0) + '%' }}
                        />
                        <div
                          className="cq-bar-seg cq-bar-supervisor"
                          style={{ height: (bars.max > 0 ? (b.supervisor / bars.max) * 100 : 0) + '%' }}
                        />
                      </div>
                      <div className="cq-bar-day">{i % every === 0 ? shortDay(b.day) : ''}</div>
                    </div>
                  );
                })}
              </div>
              <div className="cq-legend">
                <span className="cq-legend-item"><span className="cq-swatch cq-swatch-children" />Children</span>
                <span className="cq-legend-item"><span className="cq-swatch cq-swatch-supervisor" />Supervisor (incl. overhead and unattributed)</span>
              </div>
              <p className="cq-bars-summary">{bars.summary}</p>
            </>
          )}
        </div>
      </PanelBoundary>

      <PanelBoundary label="Model mix">
        <div className="cq-section">
          <h3 className="cq-section-h">Model mix</h3>
          {mix.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>No model spend recorded in this period.</p>
          ) : (
            <div className="cq-tablewrap">
              <table className="cq-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Cost</th>
                    <th>Share</th>
                    <th>Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {mix.map((m) => (
                    <tr key={m.model}>
                      <td className="cq-mono">{m.model}</td>
                      <td className="cq-num">{m.cost}</td>
                      <td className="cq-num">{m.share}</td>
                      <td className="cq-num">{m.messages == null ? '—' : m.messages}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </PanelBoundary>

      <PanelBoundary label="Quality signals">
        <div className="cq-section">
          <h3 className="cq-section-h">Quality signals</h3>
          {cards.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>No quality signals in this period.</p>
          ) : (
            <div className="cq-signals">
              {cards.map((c) => {
                const evidence = evidenceBySignal[c.key] || [];
                const first = evidence[0] || null;
                return (
                  <div className="cq-signal" key={c.key}>
                    <div className="cq-kpi-label">{SIGNAL_LABELS[c.key] || c.key}</div>
                    <div className="cq-kpi-value">{c.value}</div>
                    {c.definition && <p className="cq-signal-def">{c.definition}</p>}
                    {c.evidenceCount > 0 && (
                      <Link
                        className="cq-evidence"
                        to={first ? '/work/' + encodeURIComponent(first) : '/work'}
                      >
                        evidence: {c.evidenceCount} ticket{c.evidenceCount === 1 ? '' : 's'}
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PanelBoundary>

      <PanelBoundary label="Most expensive tickets">
        <div className="cq-section">
          <h3 className="cq-section-h">Most expensive tickets</h3>
          {expensive.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5 }}>No tickets priced in this period.</p>
          ) : (
            <div className="cq-tablewrap">
              <table className="cq-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Total</th>
                    <th>Children</th>
                    <th>Supervisor</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {expensive.map((t, i) => (
                    <tr key={t.taskId || i}>
                      <td>
                        {t.taskId ? (
                          <Link className="cq-mono" to={'/work/' + encodeURIComponent(t.taskId)}>
                            {t.taskId}
                          </Link>
                        ) : (
                          <span className="cq-mono">unknown</span>
                        )}
                      </td>
                      <td className="cq-num">{t.total}</td>
                      <td className="cq-num">{t.children}</td>
                      <td className="cq-num">{t.supervisor}</td>
                      <td className="cq-why">{t.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </PanelBoundary>
    </div>
  );
}

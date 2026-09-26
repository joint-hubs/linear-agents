import { useAnalysisPanel } from './useAnalysisPanel.js';
import { Caveats, PanelState, DataTable } from './common.jsx';
import { KpiTiles, Histogram, ShareBar } from './charts.jsx';
import { fmtInt, fmtPct, fmtMs, fmtUsd } from './format';

// Decisions panel — tailored pass (FOC-449 decision-quality). One KPI row
// from totals, one dense card per decisionId (volume, ok rate, agreement,
// confidence spread + histogram, latency, cost, models), and a collapsible
// flat table of everything for sorting/export. Small-sample decisions carry a
// visible warning badge — their rates are noise, never a verdict.
// Props: { filters, reloadKey } — both stable; filters -> query params,
// reloadKey bumped by the screen after a cache rebuild.

// Histogram bucket edges as strings, matching the server's buckets[] order
// ([0,.2) [.2,.4) [.4,.6) [.6,.8) [.8,1] — decision-analytics.mjs bucketOf).
const CONF_EDGES = ['[0,.2)', '[.2,.4)', '[.4,.6)', '[.6,.8)', '[.8,1]'];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// One label/value line in a decision card. Label fixed-width muted, value
// dense to its right — the card reads as a spec sheet, not a form.
function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, lineHeight: 1.55 }}>
      <span className="muted" style={{ flex: '0 0 92px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}>{children}</span>
    </div>
  );
}

// Agreement text: "matched/compared = rate", or "no labels yet" when nothing
// was compared — a null rate must never render as "0%". A null agreement
// object means the answers→outcome mapping is not proven; say so, don't guess.
function AgreementText({ agreement }) {
  if (agreement == null) {
    return <span className="muted">not computed (no proven answers→outcome mapping)</span>;
  }
  if (!isNum(agreement.compared) || agreement.compared === 0) {
    return <span className="muted">no labels yet</span>;
  }
  const matched = isNum(agreement.matched) ? agreement.matched : 0;
  return (
    <span>
      {fmtInt(matched)}/{fmtInt(agreement.compared)} = {fmtPct(agreement.rate, { fraction: true })}
    </span>
  );
}

function DecisionCard({ d }) {
  const conf = d && d.confidence;
  const dur = d && d.durationMs;
  const cost = d && d.costUsd;
  return (
    <div
      className="card"
      style={{
        margin: 0,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderLeft: d && d.smallSample ? '3px solid var(--warn, #b54708)' : undefined,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 13, fontWeight: 650, wordBreak: 'break-all' }}>
          {d && d.decisionId != null ? d.decisionId : '—'}
        </span>
        {d && d.smallSample && (
          <span
            style={{
              fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
              background: 'var(--warn-bg, rgba(181, 71, 8, 0.12))',
              color: 'var(--warn, #b54708)',
            }}
          >
            small sample (n &lt; 30) — rates are noise
          </span>
        )}
      </div>
      <Row label="events">{fmtInt(d && d.n)}</Row>
      <Row label="ok rate">
        {isNum(d && d.okRate) ? (
          <>
            <ShareBar value={d.okRate} /> {fmtPct(d.okRate, { fraction: true })}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
      <Row label="errors">{fmtInt(d && d.errorCount)}</Row>
      <Row label="labelled">{fmtInt(d && d.labelled)}</Row>
      <Row label="agreement">
        <AgreementText agreement={d && d.agreement} />
      </Row>
      <Row label="confidence">
        {conf ? (
          <>
            <span style={{ display: 'inline-block', minWidth: 92 }}>
              p50 {fmtPct(conf.p50, { fraction: true })}{' '}
              <span className="muted" style={{ fontSize: 11 }}>
                ({fmtPct(conf.min, { fraction: true })}–{fmtPct(conf.max, { fraction: true })})
              </span>
            </span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
        <div style={{ marginTop: 2 }}>
          {conf ? <Histogram buckets={conf.buckets} edges={CONF_EDGES} /> : <span className="muted" style={{ fontSize: 12 }}>no confidence values</span>}
        </div>
      </Row>
      <Row label="latency">
        {dur ? (
          <>
            p50 {fmtMs(dur.p50)} · p90 {fmtMs(dur.p90)}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
      <Row label="cost">
        {cost ? (
          <>
            {fmtUsd(cost.total)} · {fmtUsd(cost.perEvent)}<span className="muted" style={{ fontSize: 11 }}> per event</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
      <Row label="models">
        {d && Array.isArray(d.models) && d.models.length > 0 ? (
          <span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11.5, wordBreak: 'break-all' }}>
            {d.models.join(', ')}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </Row>
    </div>
  );
}

// Flat, scalar-only projection of the decisions list — the <details> table and
// its CSV/JSON export carry every column, un-nested (agreement/confidence/
// duration/cost objects become one column per leaf).
function flattenDecisions(list) {
  return (Array.isArray(list) ? list : []).map((d) => ({
    decisionId: d?.decisionId ?? null,
    n: d?.n ?? null,
    okRate: d?.okRate ?? null,
    errorCount: d?.errorCount ?? null,
    labelled: d?.labelled ?? null,
    agreementMatched: d?.agreement?.matched ?? null,
    agreementCompared: d?.agreement?.compared ?? null,
    agreementRate: d?.agreement?.rate ?? null,
    confidenceMin: d?.confidence?.min ?? null,
    confidenceP50: d?.confidence?.p50 ?? null,
    confidenceMax: d?.confidence?.max ?? null,
    confidenceBuckets: d?.confidence ? (d.confidence.buckets || []).join('|') : null,
    latencyP50Ms: d?.durationMs?.p50 ?? null,
    latencyP90Ms: d?.durationMs?.p90 ?? null,
    costTotalUsd: d?.costUsd?.total ?? null,
    costPerEventUsd: d?.costUsd?.perEvent ?? null,
    models: Array.isArray(d?.models) ? d.models.join(',') : null,
    smallSample: d?.smallSample ? 1 : 0,
  }));
}

export default function DecisionsPanel({ filters, reloadKey }) {
  const p = useAnalysisPanel('decisions', filters, reloadKey);
  const totals = (p.data && p.data.totals) || {};
  const decisions = (p.data && p.data.decisions) || [];
  const sorted = [...decisions].sort((a, b) => (b?.n ?? 0) - (a?.n ?? 0));
  const labelledShare = isNum(totals.labelled) && isNum(totals.events) && totals.events > 0
    ? fmtPct(totals.labelled / totals.events, { fraction: true })
    : null;

  return (
    <div>
      <PanelState loading={p.loading} error={p.error} />
      {!p.loading && !p.error && (
        <>
          <KpiTiles
            items={[
              { label: 'Decision events', value: fmtInt(totals.events) },
              { label: 'Labelled', value: fmtInt(totals.labelled), hint: labelledShare ? `${labelledShare} of events` : null },
              { label: 'Decisions', value: fmtInt(totals.decisions) },
              { label: 'Parse errors', value: fmtInt(totals.parseErrors), status: totals.parseErrors > 0 ? 'warn' : null },
              { label: 'Legacy lines skipped', value: fmtInt(totals.legacyLinesSkipped) },
            ]}
          />
          <Caveats caveats={p.caveats} />
          {sorted.length === 0 ? (
            <div className="empty">No decision events in range.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
              {sorted.map((d) => (
                <DecisionCard key={d?.decisionId ?? Math.random()} d={d} />
              ))}
            </div>
          )}
          <details style={{ marginTop: 16 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
              all decisions ({sorted.length}) — flat table
            </summary>
            <DataTable title="decisions" rows={flattenDecisions(decisions)} exportName="decisions" />
          </details>
        </>
      )}
    </div>
  );
}

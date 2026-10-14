// Routing table (FOC-786, spec §4.6) — the lead model per squad (including
// the Supervisor row). A child's model comes from this table only (FOC-762):
// the draft lead is applied per row, and an empty draft (or the × button)
// sends null — back to the models.json routing. Price text is the Work
// board's money rule; an unpriced lead stays allowed, labelled "unpriced".
// The Benchmark column rides in on the row data (the recorded AA intelligence
// index); an unrecorded model reads "—", never a guessed number.

import { useEffect, useState } from 'react';
import { getSettingsRouting, putSettingsRouting } from '../../api';
import { routingRows } from '../../settingsModel';

export default function RoutingPanel() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [edits, setEdits] = useState({}); // squad -> draft lead ('' = back to default)
  const [saving, setSaving] = useState({}); // squad -> true while applying
  const [rowErrors, setRowErrors] = useState({}); // squad -> the failure text

  useEffect(() => {
    const ctrl = new AbortController();
    getSettingsRouting(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setLoadError(e);
      });
    return () => ctrl.abort();
  }, []);

  const apply = async (squad) => {
    const lead = (edits[squad] || '').trim() || null;
    setSaving((s) => ({ ...s, [squad]: true }));
    setRowErrors((r) => ({ ...r, [squad]: null }));
    try {
      const next = await putSettingsRouting(squad, lead);
      if (next && next.rows) setData(next);
      setEdits((e) => {
        const n = { ...e };
        delete n[squad];
        return n;
      });
    } catch (e) {
      setRowErrors((r) => ({
        ...r,
        [squad]: (e.data && (e.data.error || (e.data.errors || []).join('; '))) || e.message,
      }));
    } finally {
      setSaving((s) => ({ ...s, [squad]: false }));
    }
  };

  if (loadError) {
    return (
      <div className="banner banner-warn">
        Routing unavailable: {(loadError.data && loadError.data.error) || loadError.message}
      </div>
    );
  }
  if (!data) return <div className="muted" style={{ padding: '12px 0' }}>Loading routing…</div>;

  const rows = routingRows(data.rows);
  const models = Array.isArray(data.models) ? data.models : [];

  return (
    <div>
      <div className="section-h" style={{ marginBottom: 6 }}>
        Lead model per squad <span className="muted">(provider: {data.provider || 'unknown'})</span>
      </div>
      <table className="st-table">
        <thead>
          <tr>
            <th>Squad</th>
            <th>Lead model</th>
            <th>Source</th>
            <th>Price</th>
            <th
              title="Artificial Analysis Intelligence Index; recorded snapshot, not live"
            >
              Benchmark
            </th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const draft = edits[r.squad];
            const changed = draft !== undefined && draft !== (r.lead || '');
            return (
              <tr key={r.squad}>
                <td>
                  <span className="st-label">{r.squad}</span>
                  {r.squad === 'supervisor' && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      the Supervisor model on its next fresh session
                    </div>
                  )}
                </td>
                <td>
                  <input
                    className="st-input"
                    type="text"
                    list="st-models"
                    value={draft !== undefined ? draft : r.lead || ''}
                    onChange={(e) => setEdits((x) => ({ ...x, [r.squad]: e.target.value }))}
                    aria-label={`Lead model for ${r.squad}`}
                  />
                  {r.squad in rowErrors && rowErrors[r.squad] && (
                    <div className="st-tone-danger" style={{ marginTop: 4, fontSize: 11.5 }}>
                      {rowErrors[r.squad]}
                    </div>
                  )}
                </td>
                <td className="muted">{r.sourceText}</td>
                <td className={r.price === 'unpriced' ? 'muted' : 'st-mono'}>{r.price}</td>
                <td className={Number.isFinite(r.benchmark) ? 'st-mono' : 'muted'}>
                  {Number.isFinite(r.benchmark) ? r.benchmark : '—'}
                </td>
                <td className="st-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => apply(r.squad)}
                    disabled={saving[r.squad] || !changed}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => apply(r.squad)}
                    disabled={saving[r.squad] || r.lead == null}
                    title="Back to the models.json routing"
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="st-models">
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.benchmark ? `benchmark ${m.benchmark}` : ''}
          </option>
        ))}
      </datalist>
      <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
        Empty the field (or ×) to return a squad to the models.json routing. A change is
        effective for the next child; the Supervisor on its next fresh session.
      </div>
    </div>
  );
}

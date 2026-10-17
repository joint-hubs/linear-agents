// Artifacts panel (FOC-779, plan step 5) — the read-only generated-artifact
// registry: what exists, how fresh each artifact is against its sources, and
// where the refresh happens. Stale and missing rows keep their word + tone
// badge and the server's reason line — a stale artifact is never shown as
// current. One fetch on mount, like the retention panel; an unmount aborts it.

import { useEffect, useState } from 'react';
import { getArtifacts } from '../../api';
import { artifactsView } from '../../settingsModel';

// tone -> the existing st-* tone class (settings.css has ok / danger / muted).
// "warn" has no tone class yet — the chip's word "stale" carries the signal
// (spec §7: colour is never the only signal).
function stateToneClass(tone) {
  if (tone === 'ok') return 'st-tone-ok';
  if (tone === 'danger') return 'st-tone-danger';
  if (tone === 'muted') return 'st-tone-muted';
  return '';
}

export default function ArtifactsPanel() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getArtifacts(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setView(artifactsView(d));
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setError(e);
      });
    return () => ctrl.abort();
  }, []);

  if (error) {
    return (
      <div className="banner banner-warn">
        Artifacts unavailable: {(error.data && error.data.error) || error.message}
      </div>
    );
  }
  if (!view) return <div className="muted" style={{ padding: '12px 0' }}>Loading artifacts…</div>;

  return (
    <div className="st-form">
      {view.rows.length === 0 && <div className="muted">No artifacts registered.</div>}
      {view.rows.length > 0 && (
        <table className="st-table">
          <thead>
            <tr>
              <th scope="col">Artifact</th>
              <th scope="col">Output</th>
              <th scope="col">State</th>
              <th scope="col">Age</th>
              <th scope="col">Source revision</th>
              <th scope="col">Generated</th>
              <th scope="col">Refresh</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.id || r.output || r.title}>
                <th scope="row">{r.title}</th>
                <td className="st-mono">{r.output || '—'}</td>
                <td>
                  <span className={('st-chip ' + stateToneClass(r.tone)).trim()}>
                    {r.stateLabel}
                  </span>
                  {r.reason && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {r.reason}
                    </div>
                  )}
                </td>
                <td>{r.ageText}</td>
                <td className="st-mono">{r.revisionText}</td>
                <td>{r.generatedAtText ? new Date(r.generatedAtText).toLocaleString() : '—'}</td>
                <td>{r.refreshText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted" style={{ fontSize: 11.5 }}>
        {view.note}
        {view.computedAtText ? ` · computed ${new Date(view.computedAtText).toLocaleString()}` : ''}
        {view.headShort ? ` · repo head ${view.headShort}` : ''}
      </div>
    </div>
  );
}

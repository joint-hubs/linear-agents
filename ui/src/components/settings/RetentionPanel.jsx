// Retention panel (FOC-786, spec §4.6) — read-only: the policy in force, the
// disk usage of transcripts / telemetry / workspaces / run state, free disk,
// and the note that FOC-780 owns this setting (it is not edited here).

import { useEffect, useState } from 'react';
import { getSettingsRetention } from '../../api';
import { retentionView } from '../../settingsModel';

export default function RetentionPanel() {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getSettingsRetention(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setView(retentionView(d));
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setError(e);
      });
    return () => ctrl.abort();
  }, []);

  if (error) {
    return (
      <div className="banner banner-warn">
        Retention unavailable: {(error.data && error.data.error) || error.message}
      </div>
    );
  }
  if (!view) return <div className="muted" style={{ padding: '12px 0' }}>Loading retention…</div>;

  return (
    <div className="st-form">
      <div>
        Policy in force: <span className="st-label">{view.policyText}</span>
      </div>
      <table className="st-table">
        <tbody>
          {view.usageRows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td className="st-mono">{r.text}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Free disk</th>
            <td className="st-mono">{view.freeDiskText.replace('free disk: ', '')}</td>
          </tr>
        </tbody>
      </table>
      {view.partialText && <div className="banner banner-warn">{view.partialText}</div>}
      <div className="muted" style={{ fontSize: 11.5 }}>
        {view.note}
        {view.computedAt ? ` · computed ${new Date(view.computedAt).toLocaleString()}` : ''}
      </div>
    </div>
  );
}

// Retention panel (FOC-780, design §6) — the policy in force, the disk usage
// of transcripts / telemetry / workspaces / run state, free disk, and the
// form that now owns the setting here: "keep everything" (the default —
// cleanupPeriodDays 36500) or a days limit, plus the doctor's warn-below
// threshold. A save writes the overlay and applies cleanupPeriodDays to
// every squad at once; nothing is deleted by the save itself — runs older
// than the limit go only when `fenix retention prune` runs (the estimate
// line below the form).

import { useEffect, useState } from 'react';
import { getSettingsRetention, putSettingsRetention } from '../../api';
import { retentionView, retentionFormState, validateRetentionForm } from '../../settingsModel';

export default function RetentionPanel() {
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ keepAll: true, keepDays: '', minFreeGiB: '' });
  const [saveText, setSaveText] = useState(null); // { tone, text }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    getSettingsRetention(ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        const v = retentionView(d);
        setView(v);
        setForm(retentionFormState(v));
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setLoadError(e);
      });
    return () => ctrl.abort();
  }, []);

  if (loadError) {
    return (
      <div className="banner banner-warn">
        Retention unavailable: {(loadError.data && loadError.data.error) || loadError.message}
      </div>
    );
  }
  if (!view) return <div className="muted" style={{ padding: '12px 0' }}>Loading retention…</div>;

  const setField = (k, val) => setForm((f) => ({ ...f, [k]: val }));
  const formCheck = validateRetentionForm(form);

  const save = async () => {
    const check = validateRetentionForm(form);
    if (!check.ok) return;
    setBusy(true);
    setSaveText(null);
    try {
      const saved = await putSettingsRetention(check.payload);
      const v = retentionView(saved);
      setView(v);
      setForm(retentionFormState(v));
      setSaveText({ tone: 'ok', text: 'saved — cleanupPeriodDays applied to the squads' });
    } catch (e) {
      const d = e.data || {};
      setSaveText({
        tone: 'danger',
        text: 'refused — ' + (d.detail || d.error || e.message || 'saving failed'),
      });
    } finally {
      setBusy(false);
    }
  };

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

      <div className="st-row">
        <label className="st-check">
          <input
            type="checkbox"
            checked={form.keepAll}
            onChange={(e) => setField('keepAll', e.target.checked)}
          />
          keep everything (default)
        </label>
        <label>
          Keep for N days
          <input
            type="number"
            min={1}
            max={36500}
            step={1}
            autoComplete="off"
            value={form.keepDays}
            disabled={busy || form.keepAll}
            onChange={(e) => setField('keepDays', e.target.value)}
          />
        </label>
        <label>
          Warn below N GiB free
          <input
            type="number"
            min={0.5}
            step={0.5}
            autoComplete="off"
            value={form.minFreeGiB}
            disabled={busy}
            onChange={(e) => setField('minFreeGiB', e.target.value)}
          />
        </label>
      </div>
      {formCheck.errors.length > 0 && (
        <ul className="st-errors">
          {formCheck.errors.map((t) => (
            <li key={t} className="st-tone-danger">
              {t}
            </li>
          ))}
        </ul>
      )}

      <div className="st-actions">
        <button
          type="button"
          className="launch-btn"
          onClick={save}
          disabled={busy || !formCheck.ok}
        >
          Save
        </button>
      </div>
      {saveText && <div className={`st-result st-tone-${saveText.tone}`}>{saveText.text}</div>}

      {view.appliedText && (
        <div>
          Applied policy: <span className="st-label">{view.appliedText}</span>
        </div>
      )}
      {view.prunable && view.prunable.runs > 0 && (
        <div>
          {view.prunable.runs} runs · {view.prunable.bytesText} older than the limit — run{' '}
          <code>fenix retention prune</code> to remove them
        </div>
      )}
      {view.prunable && view.prunable.refused && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {view.prunable.refused}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5 }}>
        {view.note}
        {view.computedAt ? ` · computed ${new Date(view.computedAt).toLocaleString()}` : ''}
      </div>
    </div>
  );
}

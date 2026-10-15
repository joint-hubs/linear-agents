// Keys panel (FOC-786, spec §4.6) — one row per key: the state text (the
// model's words), Validate and Rotate. Rotation opens the small form: the
// value lives only in an uncontrolled password input and is cleared on
// submit, cancel and unmount — it never reaches React state, the URL,
// localStorage, the console or a log (the plan's leak rule). When the server
// says writable: false the panel says so instead of offering a form that
// cannot save.

import { useEffect, useRef, useState } from 'react';
import { getSettingsKeys, validateSettingsKey, putSettingsKey } from '../../api';
import { keyRows, keyFormModel, checkText, writableNote } from '../../settingsModel';
import Modal from '../Modal';

// The Rotate form. The value is typed into an uncontrolled input (never
// state) and dropped the moment the request settles — resolve or reject.
function RotateForm({ keyName, label, isLinear, onClose, onSaved }) {
  const valueRef = useRef(null);
  const teamRef = useRef(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const clearInputs = () => {
    if (valueRef.current) valueRef.current.value = '';
    if (teamRef.current) teamRef.current.value = '';
  };

  // Unmount (cancel, Esc, close): wipe whatever was typed.
  useEffect(() => () => clearInputs(), []);

  const submit = async (e) => {
    e.preventDefault();
    const value = valueRef.current ? valueRef.current.value : '';
    if (!value) return;
    const teamKey = isLinear && teamRef.current ? teamRef.current.value : '';
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const r = await putSettingsKey(keyName, value, isLinear ? teamKey : undefined);
      setResult(r);
      onSaved(); // the row's state text comes from a fresh GET
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err);
    } finally {
      clearInputs(); // the value does not outlive the request
      setSending(false);
    }
  };

  const m = keyFormModel({ sending, result, error });
  return (
    <Modal open onClose={onClose} title={'Rotate ' + label} width="min(420px, 92vw)">
      <form className="st-form" onSubmit={submit}>
        <label>
          New key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            ref={valueRef}
            disabled={sending}
          />
        </label>
        {isLinear && (
          <label>
            Linear team key (optional — checked together with the key)
            <input type="text" autoComplete="off" spellCheck={false} ref={teamRef} disabled={sending} />
          </label>
        )}
        <div className="st-actions">
          <button type="submit" className="launch-btn" disabled={m.disabled || sending}>
            Save
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {m.disabledReason && <span className="muted">{m.disabledReason}</span>}
        </div>
        {m.resultText && <div className={`st-result st-tone-${m.resultTone}`}>{m.resultText}</div>}
      </form>
    </Modal>
  );
}

export default function KeysPanel() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [rotating, setRotating] = useState(null); // the key name with the form open
  const [checks, setChecks] = useState({}); // name -> the validate result text

  useEffect(() => {
    const ctrl = new AbortController();
    getSettingsKeys(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) {
          setData(d);
          setLoadError(null);
        }
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setLoadError(e);
      });
    return () => ctrl.abort();
  }, []);

  const reload = () => {
    const ctrl = new AbortController();
    getSettingsKeys(ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch(() => {
        /* the last data stays — the banner already says what failed */
      });
    return () => ctrl.abort();
  };

  const validate = async (name) => {
    setChecks((c) => ({ ...c, [name]: 'checking…' }));
    try {
      const r = await validateSettingsKey(name);
      setChecks((c) => ({ ...c, [name]: checkText(r.check) || 'no verdict' }));
    } catch (e) {
      setChecks((c) => ({
        ...c,
        [name]: 'check failed: ' + ((e.data && e.data.error) || e.message),
      }));
    }
  };

  if (loadError) {
    return (
      <div className="banner banner-warn">
        Keys unavailable: {(loadError.data && loadError.data.error) || loadError.message}
      </div>
    );
  }
  if (!data) return <div className="muted" style={{ padding: '12px 0' }}>Loading keys…</div>;

  const rows = keyRows(data.keys);
  const note = writableNote(data.writable);

  return (
    <div>
      {note && <div className="banner banner-warn" style={{ marginBottom: 10 }}>{note}</div>}
      <table className="st-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>State</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name || r.label}>
              <td>
                <span className="st-label">{r.label}</span>{' '}
                <code className="st-mono">{r.name}</code>
              </td>
              <td>
                <span className={`st-chip st-tone-${r.tone}`}>{r.state}</span>
                {checks[r.name] && <div className="muted" style={{ marginTop: 4 }}>{checks[r.name]}</div>}
              </td>
              <td className="st-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => validate(r.name)}
                  disabled={!r.present || checks[r.name] === 'checking…'}
                >
                  Validate
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setRotating(r.name)}
                  disabled={data.writable === false}
                >
                  Rotate
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.note && <div className="muted" style={{ marginTop: 8 }}>{data.note}</div>}
      {rotating && (
        <RotateForm
          keyName={rotating}
          label={rows.find((r) => r.name === rotating)?.label || rotating}
          isLinear={rotating === 'linear_api_key'}
          onClose={() => setRotating(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

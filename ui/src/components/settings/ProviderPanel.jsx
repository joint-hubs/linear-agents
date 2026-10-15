// Provider panel (FOC-786, spec §4.6) — pick the active provider, edit the
// custom endpoint (validated client-side with the server's own rules, so the
// form says what the API would), test it live, save. A save runs the server's
// live test first: a failed check is refused with the reason, nothing is
// written. The key field is OPTIONAL: an empty field saves with the stored
// key, a typed value travels as the PUT's key candidate (validated against
// the new provider, then saved server-side) so a fresh provider can be set
// up without the Keys screen first. The value lives only in an uncontrolled
// password input and is cleared on submit and unmount — never React state,
// the URL, localStorage, the console or a log. The change is effective for
// the next child; the Supervisor picks it up on its next fresh session (the
// note below the form).

import { useEffect, useRef, useState } from 'react';
import { getSettingsProvider, putSettingsProvider, testSettingsProvider } from '../../api';
import { providerView, providerDraft, validateCustomProvider, checkText } from '../../settingsModel';

const AUTH_STYLES = [
  { value: 'token', label: 'token (ANTHROPIC_AUTH_TOKEN)' },
  { value: 'apikey', label: 'apikey (ANTHROPIC_API_KEY)' },
];

export default function ProviderPanel() {
  const [view, setView] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [active, setActive] = useState(null);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState(null);
  const [testText, setTestText] = useState(null);
  const [saveText, setSaveText] = useState(null); // { tone, text }
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(null);

  const clearKeyInput = () => {
    if (keyRef.current) keyRef.current.value = '';
  };

  // Unmount: wipe whatever was typed.
  useEffect(() => () => clearKeyInput(), []);

  useEffect(() => {
    const ctrl = new AbortController();
    getSettingsProvider(ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        const v = providerView(d);
        setView(v);
        // The draft's custom mode mirrors the ACTIVE selection, not the mere
        // presence of a stored custom block: a built-in active with a saved
        // custom config opens in built-in mode (the config stays loaded for a
        // later deliberate switch — see providerDraft).
        const dr = providerDraft(v);
        setActive(dr.active);
        setShowCustom(dr.showCustom);
        setCustom(dr.custom);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setLoadError(e);
      });
    return () => ctrl.abort();
  }, []);

  if (loadError) {
    return (
      <div className="banner banner-warn">
        Provider settings unavailable:{' '}
        {(loadError.data && loadError.data.error) || loadError.message}
      </div>
    );
  }
  if (!view) return <div className="muted" style={{ padding: '12px 0' }}>Loading provider settings…</div>;

  const setField = (k, val) => setCustom((c) => ({ ...c, [k]: val }));
  const formErrors = showCustom ? validateCustomProvider(custom) : [];

  const save = async () => {
    setBusy(true);
    setSaveText(null);
    // Read the candidate, then wipe the input at once — the value does not
    // outlive the submit, whatever the request answers.
    const keyValue = keyRef.current ? keyRef.current.value : '';
    clearKeyInput();
    try {
      const body = { active: active || null };
      if (showCustom) body.custom = custom;
      if (keyValue.trim() !== '') body.key = { value: keyValue };
      const saved = await putSettingsProvider(body);
      const v = providerView(saved);
      const dr = providerDraft(v);
      setView(v);
      setActive(dr.active);
      setShowCustom(dr.showCustom);
      setCustom(dr.custom);
      setSaveText({ tone: 'ok', text: 'saved — ' + (checkText(saved.check) || 'provider set') });
    } catch (e) {
      const d = e.data || {};
      if (d.error === 'provider-check-failed') {
        setSaveText({ tone: 'danger', text: 'refused — ' + (checkText(d.check) || 'check failed') });
      } else if (d.error === 'invalid' && Array.isArray(d.errors)) {
        setSaveText({ tone: 'danger', text: 'refused — ' + d.errors.join('; ') });
      } else if (d.error === 'empty') {
        setSaveText({ tone: 'danger', text: 'refused — the key is empty' });
      } else if (d.error === 'secrets-not-writable') {
        setSaveText({ tone: 'danger', text: 'secrets are not writable from the dashboard — run ./fenix keys <name>' });
      } else {
        setSaveText({ tone: 'danger', text: d.error || e.message || 'saving failed' });
      }
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTestText('testing…');
    try {
      const body = { active: active || null };
      if (showCustom) body.custom = custom;
      const r = await testSettingsProvider(body);
      setTestText(checkText(r.check) || 'no verdict');
    } catch (e) {
      const d = e.data || {};
      setTestText(
        'check failed: ' + ((d.check && d.check.reason) || d.error || e.message),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-form">
      <div className="st-row">
        <label>
          Active provider
          <select value={active || ''} onChange={(e) => setActive(e.target.value || null)}>
            {view.options.map((o) => (
              <option key={o.name} value={o.name}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="st-check">
          <input
            type="checkbox"
            checked={showCustom}
            onChange={(e) => setShowCustom(e.target.checked)}
          />
          use a custom endpoint
        </label>
      </div>

      <div className="muted">active from: {view.sourceText}</div>

      {showCustom && (
        <div className="st-box">
          <label>
            Base URL (https, or plain http for a local endpoint)
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={custom.baseUrl}
              onChange={(e) => setField('baseUrl', e.target.value)}
            />
          </label>
          <div className="st-row">
            <label>
              Auth style
              <select value={custom.authStyle} onChange={(e) => setField('authStyle', e.target.value)}>
                {AUTH_STYLES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Key env name
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={custom.keyName}
                onChange={(e) => setField('keyName', e.target.value)}
              />
            </label>
            <label>
              Default model
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={custom.defaultModel}
                onChange={(e) => setField('defaultModel', e.target.value)}
              />
            </label>
          </div>
          {formErrors.length > 0 && (
            <ul className="st-errors">
              {formErrors.map((t) => (
                <li key={t} className="st-tone-danger">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label>
        API key (optional — leave empty to keep the stored key)
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          ref={keyRef}
          disabled={busy}
        />
      </label>

      <div className="st-actions">
        <button type="button" className="btn-secondary" onClick={runTest} disabled={busy}>
          Test provider
        </button>
        <button
          type="button"
          className="launch-btn"
          onClick={save}
          disabled={busy || (showCustom && formErrors.length > 0)}
        >
          Save
        </button>
        {testText && <span className="muted">{testText}</span>}
      </div>
      {saveText && <div className={`st-result st-tone-${saveText.tone}`}>{saveText.text}</div>}
      <div className="muted" style={{ fontSize: 11.5 }}>{view.noteText}</div>
    </div>
  );
}

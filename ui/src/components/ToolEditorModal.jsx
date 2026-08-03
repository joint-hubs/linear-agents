// Per-role tool grant editor: pick which tools a subagent may use, preview the
// file changes, then write them.
//
// Extracted from screens/SquadConfig.jsx (code-review-2026-08-03 §6). Its whole
// state cluster — catalog, selection, preview, error, saving, success — lives
// here now; the screen only says which {squad, role} to edit.
//
// The catalog is fetched once on first open and kept: this component stays
// mounted while the modal is closed, so reopening it costs nothing.

import { useState, useEffect } from 'react';
import { getTools, postSquadConfig } from '../api';
import Modal from './Modal';

export default function ToolEditorModal({ target, onClose, onSaved }) {
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // Reset the working selection whenever a different role is opened.
  useEffect(() => {
    if (!target) return;
    setSelected([...(target.tools || [])]);
    setPreview(null);
    setError(null);
    setSuccess(false);
  }, [target]);

  // Lazy-load the catalog on first open.
  useEffect(() => {
    if (!target || catalog) return;
    let alive = true;
    getTools()
      .then((c) => alive && setCatalog(c))
      .catch(() => alive && setError('Nie udało się załadować katalogu narzędzi.'));
    return () => { alive = false; };
  }, [target, catalog]);

  const toggle = (toolName) => {
    setSelected((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
    setPreview(null);
    setSuccess(false);
  };

  /** Shared by preview and save — the only difference is dryRun. */
  const submit = async (dryRun) => {
    if (!target) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await postSquadConfig({
        squads: {
          [target.squad]: {
            agents: { [target.role]: { tools: selected } },
          },
        },
        dryRun,
      });
      if (dryRun) {
        setPreview(result);
      } else {
        setSuccess(true);
        setPreview(null);
        if (onSaved) await onSaved();
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const tools = catalog?.tools || {};
  const riskLevels = catalog?.riskLevels || {};
  const toolNames = Object.keys(tools).sort();
  const hasTask = selected.includes('Task');

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target ? `Narzędzia — ${target.squad} / ${target.role}` : 'Narzędzia'}
    >
      {target && (
        <>
          {error && <div className="banner banner-warn">Błąd: {error}</div>}

          {success && (
            <div
              className="banner"
              style={{
                background: 'var(--ok-soft)',
                borderColor: '#a3d5b3',
                color: 'var(--ok)',
              }}
            >
              ✓ Narzędzia zapisane. Zmiana obowiązuje od następnego uruchomienia.
            </div>
          )}

          {hasTask && (
            <div
              className="banner banner-warn"
              style={{ borderColor: '#f4cf9e', fontWeight: 600 }}
            >
              ⚠ Uwaga: przyznajesz narzędzie <code>Task</code>. Dziś żadna rola go nie ma —
              hierarchia jest celowo płaska (lead → subagent). Nadanie <code>Task</code> zmienia
              architekturę na zagnieżdżoną delegację. Upewnij się, że to zamierzone.
            </div>
          )}

          <table className="table">
            <thead>
              <tr className="th">
                <th style={{ width: 36, textAlign: 'center' }}>✓</th>
                <th>Narzędzie</th>
                <th>Co robi</th>
                <th>Ryzyko</th>
              </tr>
            </thead>
            <tbody>
              {toolNames.length === 0 && (
                <tr>
                  <td className="td muted" colSpan={4} style={{ textAlign: 'center' }}>
                    Brak danych o narzędziach
                  </td>
                </tr>
              )}
              {toolNames.map((name) => {
                const t = tools[name];
                const risk = t.risk || '';
                const riskInfo = riskLevels[risk];
                const isHighRisk = risk === 'writes-code' || risk === 'writes-system';
                const checked = selected.includes(name);

                return (
                  <tr
                    key={name}
                    style={isHighRisk ? { background: 'var(--warn-soft)' } : undefined}
                  >
                    <td className="td" style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(name)}
                        aria-label={`Narzędzie ${name}`}
                      />
                    </td>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600 }}>
                      {name}
                    </td>
                    <td className="td" style={{ fontSize: 12.5 }}>
                      {t.description || '—'}
                    </td>
                    <td className="td" style={{ fontSize: 12 }}>
                      {riskInfo ? (
                        <span
                          style={{
                            color: isHighRisk ? 'var(--warn)' : 'var(--text-2)',
                            fontWeight: isHighRisk ? 600 : 400,
                          }}
                          title={riskInfo.hint || ''}
                        >
                          {riskInfo.label || risk}
                          {isHighRisk ? ' ⚠' : ''}
                        </span>
                      ) : (
                        <span className="muted">{risk || '—'}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {preview && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                Podgląd zmian {preview.dryRun && <span className="muted">(dry run)</span>}
              </div>
              {preview.changed && preview.changed.length === 0 && (
                <div className="empty" style={{ padding: '12px 16px', fontSize: 12 }}>
                  Brak zmian.
                </div>
              )}
              {preview.changed && preview.changed.length > 0 && (
                <table className="table">
                  <thead>
                    <tr className="th">
                      <th>Plik</th>
                      <th>Przed</th>
                      <th>Po</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changed.map((c) => (
                      <tr key={c.file}>
                        <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                          {c.file}
                        </td>
                        <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--danger)' }}>
                          {c.before}
                        </td>
                        <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ok)' }}>
                          {c.after}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="modal-foot">
            <button className="btn-secondary" onClick={onClose}>
              Anuluj
            </button>
            <button className="btn-secondary" onClick={() => submit(true)} disabled={saving}>
              {saving ? 'Wysyłanie…' : 'Podgląd zmian'}
            </button>
            <button className="launch-btn" onClick={() => submit(false)} disabled={saving}>
              {saving ? 'Zapisywanie…' : 'Zapisz'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

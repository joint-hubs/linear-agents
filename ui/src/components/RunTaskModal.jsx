import { useState, useEffect } from 'react';
import Modal from './Modal';
import { getRunTask, postRunTask } from '../api';
import { fmtCost, fmtUSD, costValue } from '../utils';
import { linearUrl } from '../config';

const SOURCE_LABEL = {
  launch: 'uruchomienie z dashboardu',
  agent_pick: 'wybór agenta',
  kickoff: 'z promptu startowego',
  branch: 'zgadnięte z nazwy brancha',
  manual: 'ręcznie',
};

function sourceLabel(src) {
  return SOURCE_LABEL[src] || src || '—';
}

function confidenceLabel(c) {
  if (c == null) return '';
  return c === 1 ? 'pewne' : 'niepewne';
}

const TASK_RE = /^[A-Z]+-\d+$/;

export default function RunTaskModal({ runId, runCostUSD, runStatus, currentTaskId, onClose, onSaved }) {
  const [taskData, setTaskData] = useState(null);   // { current, history }
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const [newTaskId, setNewTaskId] = useState('');
  const [scope, setScope] = useState('run');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveOk, setSaveOk] = useState(null);

  // Delete confirmation
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFetchError(null);
    getRunTask(runId)
      .then((data) => {
        setTaskData(data);
        setLoading(false);
      })
      .catch((err) => {
        setFetchError(err.message || String(err));
        setLoading(false);
      });
  }, [runId]);

  const current = taskData?.current;
  const history = taskData?.history || [];

  const taskValid = !newTaskId || TASK_RE.test(newTaskId);
  const canSave = newTaskId && taskValid && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const result = await postRunTask({ runId, taskId: newTaskId, scope });
      setSaveOk(result);
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    setDeleteConfirm(false);
    try {
      const result = await postRunTask({ runId, taskId: null, scope });
      setSaveOk(result);
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saveOk) onSaved?.();
    onClose();
  };

  // ---- preview text ----
  const oldLabel = currentTaskId || 'bez zadania';
  const newLabel = newTaskId || 'bez zadania';
  const costStr = runCostUSD != null ? fmtUSD(runCostUSD) : '?';
  const effectText =
    scope === 'now'
      ? `Przeniesie tylko przyszłe zużycie z „${oldLabel}” na „${newLabel}” (dotychczasowy koszt zostaje).`
      : `Przeniesie ${costStr} z „${oldLabel}” na „${newLabel}”.`;

  const isRunning = runStatus === 'running';

  return (
    <Modal open onClose={handleClose} title="Zmień zadanie przebiegu">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Loading */}
        {loading && <div className="muted">Ładowanie…</div>}

        {/* Fetch error */}
        {fetchError && (
          <div className="banner banner-warn">
            <strong>Błąd pobierania przypisania:</strong> {fetchError}
          </div>
        )}

        {/* Current assignment */}
        {!loading && current && (
          <div
            style={{
              background: 'var(--surface-2)',
              borderRadius: 8,
              padding: '10px 14px',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Obecne przypisanie</div>
            <div>
              Zadanie:{' '}
              {current.taskId ? (
                <>
                  <strong>{current.taskId}</strong>
                  {linearUrl(current.taskId) && (
                    <>
                      {' '}
                      <a
                        className="link"
                        href={linearUrl(current.taskId)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        ↗
                      </a>
                    </>
                  )}
                </>
              ) : (
                <span className="muted">(brak)</span>
              )}
            </div>
            <div>
              Źródło: <strong>{sourceLabel(current.source)}</strong>
              {current.confidence != null && (
                <span
                  style={{
                    marginLeft: 6,
                    color: current.confidence === 1 ? 'var(--ok)' : 'var(--warn)',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  ({confidenceLabel(current.confidence)})
                </span>
              )}
            </div>
          </div>
        )}

        {!loading && !current && !fetchError && (
          <div className="muted" style={{ fontSize: 13 }}>
            Brak obecnego przypisania.
          </div>
        )}

        {/* Task ID input */}
        <div>
          <label
            style={{
              display: 'block',
              fontSize: 12.5,
              fontWeight: 600,
              marginBottom: 4,
              color: 'var(--text)',
            }}
          >
            Nowe zadanie (np. FEN-123)
          </label>
          <input
            className="filter-search"
            style={{ width: '100%', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}
            value={newTaskId}
            onChange={(e) => {
              setNewTaskId(e.target.value.toUpperCase());
              setSaveError(null);
              setSaveOk(null);
            }}
            placeholder="FEN-123"
            aria-label="Nowe zadanie"
            autoFocus
          />
          {newTaskId && !taskValid && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>
              Nieprawidłowy format — wpisz prefiks i numer, np. FEN-123
            </div>
          )}
        </div>

        {/* Scope */}
        <div>
          <label
            style={{
              display: 'block',
              fontSize: 12.5,
              fontWeight: 600,
              marginBottom: 4,
              color: 'var(--text)',
            }}
          >
            Zakres
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <label style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="radio"
                name="scope"
                value="run"
                checked={scope === 'run'}
                onChange={() => setScope('run')}
              />
              cały przebieg
            </label>
            {isRunning && (
              <label style={{ fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  name="scope"
                  value="now"
                  checked={scope === 'now'}
                  onChange={() => setScope('now')}
                />
                od teraz
              </label>
            )}
          </div>
        </div>

        {/* Effect preview */}
        {newTaskId && taskValid && (
          <div
            className="banner"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border-strong)',
              fontSize: 13,
            }}
          >
            {effectText}
          </div>
        )}

        {/* Delete assignment */}
        {currentTaskId && (
          <div>
            {!deleteConfirm ? (
              <button
                className="btn-secondary"
                style={{ color: 'var(--danger)', borderColor: 'var(--danger)', fontSize: 12 }}
                onClick={() => setDeleteConfirm(true)}
              >
                Usuń przypisanie
              </button>
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--warn-soft)',
                  fontSize: 13,
                }}
              >
                <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                  Na pewno usunąć przypisanie? Koszt wróci do „untagged".
                </span>
                <button
                  className="btn-secondary"
                  style={{ fontSize: 11, padding: '3px 10px' }}
                  onClick={() => setDeleteConfirm(false)}
                >
                  Anuluj
                </button>
                <button
                  className="launch-btn"
                  style={{ fontSize: 11, padding: '3px 10px', background: 'var(--danger)' }}
                  onClick={handleDelete}
                  disabled={saving}
                >
                  {saving ? '…' : 'Usuń'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <details style={{ fontSize: 12.5 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text-2)' }}>
              Historia przypisań ({history.length})
            </summary>
            <div style={{ marginTop: 6 }}>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr className="th">
                    <td>Zadanie</td>
                    <td>Źródło</td>
                    <td>Pewność</td>
                    <td>Od</td>
                    <td>Do</td>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i} className="row">
                      <td className="td">
                        {h.taskId || <span className="muted">(brak)</span>}
                      </td>
                      <td className="td">{sourceLabel(h.source)}</td>
                      <td className="td">{confidenceLabel(h.confidence)}</td>
                      <td className="td">{h.validFrom ? new Date(h.validFrom).toLocaleString('pl-PL') : '—'}</td>
                      <td className="td">{h.validTo ? new Date(h.validTo).toLocaleString('pl-PL') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* Save error */}
        {saveError && (
          <div className="banner banner-warn">
            <strong>Błąd zapisu:</strong> {saveError}
          </div>
        )}

        {/* Save success */}
        {saveOk && (
          <div
            className="banner"
            style={{
              background: 'var(--ok-soft)',
              borderColor: '#a3d5b3',
              color: 'var(--ok)',
            }}
          >
            <div style={{ fontWeight: 600 }}>
              ✓ Zadanie zmienione
              {saveOk.movedCostUSD != null && (
                <span> — przeniesiono {fmtUSD(saveOk.movedCostUSD)}</span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="modal-foot">
          <button className="btn-secondary" onClick={handleClose}>
            {saveOk ? 'Zamknij' : 'Anuluj'}
          </button>
          {!saveOk && (
            <button
              className="launch-btn"
              onClick={handleSave}
              disabled={!canSave}
            >
              {saving ? 'Zapisywanie…' : 'Zapisz'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

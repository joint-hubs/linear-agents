import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getPrompts,
  getPromptRole,
  getPromptLead,
  getPromptRuns,
  postLaunch,
  postKickoff,
} from '../api';
import { LogDrawer } from './Flow.jsx';
import Modal from '../components/Modal';
import { fmtTime, fmtUSD, fmtCost, costValue, statusLabel } from '../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASK_RE = /^[A-Z]+-\d+$/;

function taskValid(id) {
  return !id || TASK_RE.test(id);
}

/** Join kickoff lines with ' | ' — mirrors server-side kickoffPrompt. */
function joinKickoff(lines) {
  if (!lines || lines.length === 0) return '';
  return lines.join(' | ');
}

/** Substitute {taskId} in every line, then join. */
function renderKickoff(lines, taskId) {
  const sub = taskId || '{taskId}';
  return joinKickoff((lines || []).map((l) => l.replace(/\{taskId\}/g, sub)));
}

// ---------------------------------------------------------------------------
// Tree node button — accessible, focus-visible
// ---------------------------------------------------------------------------

function TreeButton({ active, children, onClick, style = {}, indent = 0 }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: active ? 'var(--surface-2)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius)',
        padding: '7px 10px',
        paddingLeft: 10 + indent * 16,
        fontSize: 13,
        color: active ? 'var(--text)' : 'var(--text-2)',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Right panel: Squad leaf
// ---------------------------------------------------------------------------

function SquadLeaf({ squad, data, taskId, setTaskId, onLaunchResult, onOpenLog }) {
  const [dryRun, setDryRun] = useState(null);
  const [dryErr, setDryErr] = useState(null);
  const [dryLoading, setDryLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [leadBody, setLeadBody] = useState(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [runs, setRuns] = useState(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  // Prompt editor modal
  const [editOpen, setEditOpen] = useState(false);
  const [editLines, setEditLines] = useState('');
  const [editPreview, setEditPreview] = useState(null);
  const [editErr, setEditErr] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editSuccess, setEditSuccess] = useState(false);

  const kickoff = data.kickoff || [];
  const promptOneLine = renderKickoff(kickoff, taskId);

  // Fetch lead body lazily when <details> opens.
  useEffect(() => {
    if (!leadOpen || leadBody) return;
    let alive = true;
    getPromptLead(squad)
      .then((d) => alive && setLeadBody(d.body))
      .catch(() => alive && setLeadBody('(błąd ładowania)'));
    return () => { alive = false; };
  }, [leadOpen, leadBody, squad]);

  // Fetch recent runs.
  useEffect(() => {
    let alive = true;
    getPromptRuns(squad, 10)
      .then((d) => alive && setRuns(d))
      .catch(() => {});
    return () => { alive = false; };
  }, [squad]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(promptOneLine);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silent no-op
    }
  };

  const handleDryRun = async () => {
    setDryLoading(true);
    setDryErr(null);
    setDryRun(null);
    try {
      const res = await postLaunch({ squad, taskId: taskId || '{taskId}', dryRun: true });
      setDryRun(res);
    } catch (e) {
      setDryErr(e.message || String(e));
    } finally {
      setDryLoading(false);
    }
  };

  const handleLaunch = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setLaunching(true);
    try {
      await postLaunch({ squad, taskId: taskId || '{taskId}', dryRun: false });
      onLaunchResult({ ok: true, squad, taskId });
      setConfirm(false);
    } catch (e) {
      onLaunchResult({ ok: false, error: e.message });
    } finally {
      setLaunching(false);
    }
  };

  const cancelConfirm = () => setConfirm(false);

  const lead = data.lead || {};

  return (
    <div>
      {/* Task ID */}
      <div style={{ marginBottom: 16 }}>
        <label
          style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}
        >
          Zadanie
        </label>
        <input
          className="filter-search"
          style={{ width: 180, fontFamily: 'var(--mono)', fontSize: 13 }}
          value={taskId}
          onChange={(e) => setTaskId(e.target.value.toUpperCase())}
          placeholder="np. JOI-53"
          aria-label="Numer zadania Linear"
        />
        {taskId && !taskValid(taskId) && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--warn)' }}>
            Format: PROJEKT-NUMER (np. JOI-53)
          </span>
        )}
      </div>

      {/* Kickoff prompt */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
          Prompt do wklejenia
        </div>
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 10,
            fontFamily: 'var(--mono)',
            fontSize: 12,
            lineHeight: 1.7,
            maxHeight: 200,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {kickoff.map((line, i) => (
            <div key={i}>{line.replace(/\{taskId\}/g, taskId || '{taskId}')}</div>
          ))}
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn-secondary" onClick={handleCopy} style={{ fontSize: 12 }}>
            {copied ? '✓ Skopiowano' : 'Kopiuj'}
          </button>
          <button
            className="btn-secondary"
            style={{ fontSize: 12 }}
            onClick={() => {
              setEditLines((data.kickoff || []).join('\n'));
              setEditPreview(null);
              setEditErr(null);
              setEditSuccess(false);
              setEditOpen(true);
            }}
          >
            Edytuj prompt
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
            Kopiuje jako jedną linię (linie łączone &quot; | &quot;)
          </span>
        </div>
      </div>

      {/* Launch buttons */}
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn-secondary"
          onClick={handleDryRun}
          disabled={dryLoading}
        >
          {dryLoading ? 'Ładowanie…' : 'Podgląd uruchomienia'}
        </button>

        {!confirm ? (
          <button className="launch-btn" onClick={handleLaunch} disabled={launching}>
            Uruchom
          </button>
        ) : (
          <>
            <button className="launch-btn" onClick={handleLaunch} disabled={launching} style={{ background: 'var(--warn)' }}>
              {launching ? 'Uruchamianie…' : 'Tak, otwórz okno agenta'}
            </button>
            <button className="btn-secondary" onClick={cancelConfirm} disabled={launching}>
              Anuluj
            </button>
          </>
        )}
      </div>

      {/* Dry run result */}
      {dryErr && (
        <div className="banner banner-warn" style={{ marginBottom: 12 }}>Błąd podglądu: {dryErr}</div>
      )}
      {dryRun && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
            Podgląd — prompt
          </div>
          <pre
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: 10,
              fontSize: 11.5,
              fontFamily: 'var(--mono)',
              maxHeight: 160,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {dryRun.kickoffPrompt || '(brak promptu)'}
          </pre>
          {dryRun.batPreview && (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, margin: '8px 0 4px', color: 'var(--text-2)' }}>
                Podgląd — plik .bat
              </div>
              <pre
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: 10,
                  fontSize: 11.5,
                  fontFamily: 'var(--mono)',
                  maxHeight: 160,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {dryRun.batPreview}
              </pre>
            </>
          )}
        </div>
      )}

      {/* Entry condition */}
      {data.entryCondition && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
            Warunek wejścia
          </div>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '8px 12px',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {data.entryCondition}
          </div>
        </div>
      )}

      {/* Squad composition */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
          Skład
        </div>
        <div
          style={{
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius)',
            padding: '8px 12px',
            fontSize: 13,
            lineHeight: 1.8,
          }}
        >
          <div>
            <strong>Lead:</strong>{' '}
            <code style={{ background: 'none', padding: 0 }}>{lead.model || '—'}</code>
          </div>
          {(data.roles || []).map((r) => (
            <div key={r.role}>
              <strong>{r.role}:</strong>{' '}
              <code style={{ background: 'none', padding: 0 }}>{r.model || '—'}</code>
            </div>
          ))}
        </div>
      </div>

      {/* Lead instruction (lazy) */}
      <details
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '10px 14px',
          marginBottom: 16,
          fontSize: 13,
        }}
        open={leadOpen}
        onToggle={(e) => setLeadOpen(e.target.open)}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
          Instrukcja leada
        </summary>
        {leadBody === null && leadOpen && (
          <div className="muted" style={{ padding: '8px 0' }}>Ładowanie…</div>
        )}
        {leadBody && (
          <pre
            style={{
              marginTop: 8,
              fontFamily: 'var(--mono)',
              fontSize: 11.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 300,
              overflow: 'auto',
              background: 'var(--surface-2)',
              padding: 10,
              borderRadius: 'var(--radius)',
            }}
          >
            {leadBody}
          </pre>
        )}
      </details>

      {/* Recent runs */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
          Ostatnie przebiegi
        </div>
        {!runs && <div className="muted" style={{ fontSize: 12 }}>Ładowanie…</div>}
        {runs && runs.length === 0 && (
          <div className="empty" style={{ fontSize: 12 }}>Brak przebiegów dla tego składu.</div>
        )}
        {runs && runs.length > 0 && (
          <table className="table">
            <thead>
              <tr className="th">
                <td>Czas</td>
                <td>Zadanie</td>
                <td>Status</td>
                <td style={{ textAlign: 'right' }}>Koszt</td>
                <td></td>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId}>
                  <td className="td" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                    {r.startedAt ? fmtTime(r.startedAt) : '—'}
                  </td>
                  <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {r.taskId || '—'}
                  </td>
                  <td className="td">
                    <span
                      className={
                        'badge ' +
                        (statusLabel(r) === 'failed'
                          ? 'badge-fail'
                          : statusLabel(r) === 'running'
                            ? 'badge-run'
                            : 'badge-ok')
                      }
                    >
                      {statusLabel(r)}
                    </span>
                  </td>
                  <td className="td" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtCost(r)}
                  </td>
                  <td className="td" style={{ textAlign: 'right' }}>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => onOpenLog(r)}
                    >
                      log
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Prompt editor modal */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edytuj prompt — ${squad}`}
      >
        {(() => {
          const lines = editLines.split('\n');
          const hasTaskId = editLines.includes('{taskId}');
          const previewText = renderKickoff(lines, taskId);

          const handlePreview = async () => {
            setEditSaving(true);
            setEditErr(null);
            setEditPreview(null);
            try {
              const res = await postKickoff({ squad, lines, dryRun: true });
              setEditPreview(res);
            } catch (e) {
              setEditErr(e.message || String(e));
            } finally {
              setEditSaving(false);
            }
          };

          const handleSave = async () => {
            setEditSaving(true);
            setEditErr(null);
            setEditSuccess(false);
            try {
              await postKickoff({ squad, lines, dryRun: false });
              setEditSuccess(true);
              setEditPreview(null);
            } catch (e) {
              setEditErr(e.message || String(e));
            } finally {
              setEditSaving(false);
            }
          };

          return (
            <>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                  Linie szablonu (jedna linia = jedna linia tekstu)
                </div>
                <textarea
                  className="filter-search"
                  style={{
                    width: '100%',
                    minHeight: 160,
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    resize: 'vertical',
                  }}
                  value={editLines}
                  onChange={(e) => {
                    setEditLines(e.target.value);
                    setEditSuccess(false);
                    setEditPreview(null);
                  }}
                  aria-label="Linie szablonu promptu"
                />
              </div>

              {!hasTaskId && (
                <div className="banner banner-warn">
                  ⚠ W treści brak <code>{'{taskId}'}</code> — prompt nie będzie zawierał numeru zadania.
                </div>
              )}

              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                  Podgląd (linie łączone &quot; | &quot;)
                </div>
                <pre
                  style={{
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 10,
                    fontFamily: 'var(--mono)',
                    fontSize: 11.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 120,
                    overflow: 'auto',
                  }}
                >
                  {previewText || '(pusty prompt)'}
                </pre>
              </div>

              {editErr && (
                <div className="banner banner-warn">Błąd: {editErr}</div>
              )}

              {editSuccess && (
                <div
                  className="banner"
                  style={{
                    background: 'var(--ok-soft)',
                    borderColor: '#a3d5b3',
                    color: 'var(--ok)',
                  }}
                >
                  ✓ Prompt zapisany. Zmiana obowiązuje od następnego uruchomienia.
                </div>
              )}

              {editPreview && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
                    Podgląd zmian {editPreview.dryRun && <span className="muted">(dry run)</span>}
                  </div>
                  {editPreview.changed && editPreview.changed.length === 0 && (
                    <div className="empty" style={{ padding: '12px 16px', fontSize: 12 }}>
                      Brak zmian.
                    </div>
                  )}
                  {editPreview.changed && editPreview.changed.length > 0 && (
                    <table className="table">
                      <thead>
                        <tr className="th">
                          <th>Plik</th>
                          <th>Przed</th>
                          <th>Po</th>
                        </tr>
                      </thead>
                      <tbody>
                        {editPreview.changed.map((c) => (
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
                <button className="btn-secondary" onClick={() => setEditOpen(false)}>
                  Anuluj
                </button>
                <button
                  className="btn-secondary"
                  onClick={handlePreview}
                  disabled={editSaving}
                >
                  {editSaving ? 'Wysyłanie…' : 'Podgląd zmian'}
                </button>
                <button
                  className="launch-btn"
                  onClick={handleSave}
                  disabled={editSaving}
                >
                  {editSaving ? 'Zapisywanie…' : 'Zapisz'}
                </button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel: Role leaf
// ---------------------------------------------------------------------------

function RoleLeaf({ squad, role, data }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const cmd = 'bin\\agent.bat ' + squad + ' ' + role;
  const hasWrite = (data.tools || []).some(
    (t) => t === 'Bash' || t === 'Edit' || t === 'Write'
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div>
      {/* Command */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
          Komenda
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '6px 10px',
              fontSize: 12.5,
              fontFamily: 'var(--mono)',
            }}
          >
            {cmd}
          </code>
          <button className="btn-secondary" onClick={handleCopy} style={{ fontSize: 12 }}>
            {copied ? '✓ Skopiowano' : 'Kopiuj'}
          </button>
        </div>
      </div>

      {/* Model + tools */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
          Model i uprawnienia
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span
            style={{
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius)',
              padding: '4px 10px',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {data.model || '—'}
          </span>
          {hasWrite ? (
            <span className="badge badge-warn" style={{ fontSize: 11 }}>
              może zmieniać kod
            </span>
          ) : (
            <span className="badge badge-ok" style={{ fontSize: 11 }}>
              tylko do odczytu
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(data.tools || []).map((t) => (
            <span
              key={t}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '2px 8px',
                fontSize: 11,
                fontFamily: 'var(--mono)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Role instruction */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
          Instrukcja roli
        </div>
        <pre
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 12,
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 400,
            overflow: 'auto',
          }}
        >
          {data.body || '(brak instrukcji)'}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      className={toast.ok ? 'toast toast-ok' : 'toast toast-fail'}
      style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}
    >
      {toast.ok
        ? `Uruchomiono ${toast.squad} dla ${toast.taskId} — okno agenta otwarte. Przebieg pojawi się w Live.`
        : `Błąd uruchamiania: ${toast.error}`}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function Prompts() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Tree selection
  const [selIntent, setSelIntent] = useState(null); // intent id
  const [selSquad, setSelSquad] = useState(null); // squad key (only for 'single' path)
  const [selRole, setSelRole] = useState(null); // role key (only for 'single' path)

  // Right panel state
  const [taskId, setTaskId] = useState('');
  const [roleData, setRoleData] = useState(null); // fetched role/lead data
  const [roleLoading, setRoleLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // Log drawer
  const [logRun, setLogRun] = useState(null);

  // Fetch prompts tree on mount.
  useEffect(() => {
    let alive = true;
    getPrompts()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [toast]);

  // Fetch role data when a role leaf is selected.
  useEffect(() => {
    if (!selRole || !selSquad) {
      setRoleData(null);
      return;
    }
    let alive = true;
    setRoleLoading(true);
    getPromptRole(selSquad, selRole)
      .then((d) => alive && setRoleData(d))
      .catch(() => alive && setRoleData(null))
      .finally(() => alive && setRoleLoading(false));
    return () => { alive = false; };
  }, [selRole, selSquad]);

  // Reset dependent selections when navigating up the tree.
  const selectIntent = useCallback((id) => {
    setSelIntent(id);
    setSelSquad(null);
    setSelRole(null);
    setRoleData(null);
  }, []);

  const selectSquad = useCallback((s) => {
    setSelSquad(s);
    setSelRole(null);
    setRoleData(null);
  }, []);

  const selectRole = useCallback((r) => {
    setSelRole(r);
  }, []);

  const handleLaunchResult = useCallback((res) => {
    setToast(res);
  }, []);

  // --- Loading / error states ---
  if (loading) {
    return (
      <div className="page">
        <div className="empty">Ładowanie…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="api-banner">{error}</div>
      </div>
    );
  }

  const intents = data?.intents || [];
  const squads = data?.squads || {};
  const squadKeys = Object.keys(squads).sort();

  // Determine what to show in the right panel.
  const isSinglePath = selIntent === 'single';
  const activeSquad = isSinglePath ? selSquad : selIntent;
  const squadData = activeSquad ? squads[activeSquad] : null;

  // Breadcrumb for right panel.
  let breadcrumb = null;
  if (isSinglePath && selRole && selSquad) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola → <strong>{selSquad}</strong> → <strong>{selRole}</strong>
      </span>
    );
  } else if (isSinglePath && selSquad) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola → <strong>{selSquad}</strong> (wybierz rolę)
      </span>
    );
  } else if (isSinglePath) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola (wybierz skład)
      </span>
    );
  } else if (selIntent && squadData) {
    const intentLabel = (intents.find((i) => i.id === selIntent) || {}).label || selIntent;
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        <strong>{intentLabel}</strong>
      </span>
    );
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <div className="page-title">Prompty</div>
          <div className="page-sub">
            Interaktywne drzewo decyzyjne · wybierz co chcesz zrobić, system przygotuje prompt
          </div>
        </div>
      </div>

      {/* Help */}
      <details
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '14px 18px',
          marginBottom: 24,
          fontSize: 13,
          color: 'var(--text-2)',
          lineHeight: 1.7,
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          Jak to działa?
        </summary>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Co robisz Ty:</strong> wybierasz w drzewie po lewej, co chcesz zrobić, wpisujesz
          numer zadania Linear (np. JOI-53) i klikasz <em>Kopiuj</em> (dostajesz prompt do schowka)
          albo <em>Uruchom</em> (system otwiera nowe okno konsoli z agentem).
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Co robi system:</strong> sprawdza poprawność składu i numeru zadania, składa prompt
          z szablonu, zapisuje tymczasowy plik <code>.bat</code>, otwiera NOWE okno konsoli na tym
          komputerze i uruchamia w nim skład. Nadaje przebiegowi identyfikator, dzięki czemu widać go
          w Live, Runs i Flow.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Czego system NIE robi:</strong> nie hostuje agenta (agent działa w Twoim terminalu),
          nie odpowiada za Ciebie na pytania agenta (bramki GATE obsługujesz sam), nie działa zdalnie
          — tylko lokalnie.
        </p>
      </details>

      {/* Two-column layout */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* ---- LEFT: Decision tree ---- */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '12px 0',
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: '0 14px 10px',
              borderBottom: '1px solid var(--border)',
              marginBottom: 6,
            }}
          >
            Co chcesz zrobić?
          </div>

          {intents.map((intent) => {
            const isActive = selIntent === intent.id;
            const hasChildren = intent.id === 'single';
            const isSquadIntent = intent.squad != null;

            return (
              <div key={intent.id}>
                <TreeButton
                  active={isActive}
                  onClick={() => selectIntent(intent.id)}
                >
                  {intent.label}
                </TreeButton>

                {/* Expand squads under "single" */}
                {hasChildren && isActive && (
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 2, paddingTop: 2 }}>
                    {squadKeys.map((sk) => {
                      const isSquadActive = selSquad === sk;
                      return (
                        <div key={sk}>
                          <TreeButton
                            active={isSquadActive}
                            indent={1}
                            onClick={() => selectSquad(sk)}
                          >
                            {sk}
                          </TreeButton>
                          {/* Expand roles under selected squad */}
                          {isSquadActive && squads[sk] && (
                            <div>
                              {(squads[sk].roles || []).map((r) => {
                                const isRoleActive = selRole === r.role;
                                return (
                                  <TreeButton
                                    key={r.role}
                                    active={isRoleActive}
                                    indent={2}
                                    onClick={() => selectRole(r.role)}
                                  >
                                    {r.role}
                                  </TreeButton>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- RIGHT: Leaf content ---- */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 18,
          }}
        >
          {!selIntent && (
            <div className="empty">Wybierz opcję z drzewa po lewej, żeby zobaczyć szczegóły.</div>
          )}

          {/* Squad leaf (direct intent or squad selected under "single") */}
          {selIntent && !isSinglePath && squadData && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              <SquadLeaf
                squad={selIntent}
                data={squadData}
                taskId={taskId}
                setTaskId={setTaskId}
                onLaunchResult={handleLaunchResult}
                onOpenLog={setLogRun}
              />
            </>
          )}

          {/* Squad leaf under "single" path (squad selected, no role yet) */}
          {isSinglePath && selSquad && !selRole && squadData && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              <SquadLeaf
                squad={selSquad}
                data={squadData}
                taskId={taskId}
                setTaskId={setTaskId}
                onLaunchResult={handleLaunchResult}
                onOpenLog={setLogRun}
              />
            </>
          )}

          {/* Role leaf under "single" path */}
          {isSinglePath && selRole && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              {roleLoading && <div className="muted">Ładowanie instrukcji roli…</div>}
              {!roleLoading && !roleData && (
                <div className="banner banner-warn">Nie udało się załadować instrukcji roli.</div>
              )}
              {roleData && (
                <RoleLeaf squad={selSquad} role={selRole} data={roleData} />
              )}
            </>
          )}

          {/* Intent selected but no squad data (shouldn't happen) */}
          {selIntent && !isSinglePath && !squadData && (
            <div className="banner banner-warn">Brak danych dla tego składu.</div>
          )}
        </div>
      </div>

      {/* Toast */}
      <Toast toast={toast} />

      {/* Log drawer */}
      {logRun && (
        <LogDrawer
          squad={{ label: logRun.squad || '—' }}
          node={{ key: '_lead', label: 'Lead' }}
          run={logRun}
          onClose={() => setLogRun(null)}
        />
      )}
    </div>
  );
}

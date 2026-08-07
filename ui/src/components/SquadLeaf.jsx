// Right panel of the Prompts screen when a squad (not a single role) is
// selected: kickoff prompt + launch + prompt editor + recent runs.
// Extracted from screens/Prompts.jsx (code-audit-2026-07-30 §4) — the file had
// grown past 1100 lines with this one component alone accounting for ~560.

import { useState, useEffect, useRef } from 'react';
import { getPromptLead, getPromptRuns, postLaunch, postKickoff } from '../api';
import PromptContext from './PromptContext';
import MarkdownEditor from './MarkdownEditor';
import Modal from './Modal';
import { fmtTime, fmtCost, statusLabel } from '../utils';

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

export default function SquadLeaf({ squad, data, taskId, setTaskId, onLaunchResult, onOpenLog }) {
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
          <div style={{ marginTop: 8 }}>
            <MarkdownEditor path={`agents/${squad}/CLAUDE.md`} />
          </div>
        )}
      </details>

      {/* Context files pulled in by this squad's prompt chain */}
      <PromptContext squad={squad} />

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

// "Records" panel in RunDetail (FOC-795) — what the agents wrote for the run's
// ticket, listed read/editable, with an inline editor for editable records and
// an annotation form for verdicts. Contract: docs/plans/foc-795-editable-agent-records.md
//
// Save sends the sha256 loaded with the record (optimistic concurrency): the
// server answers 409 when the agent changed the file since it was opened.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  getRecords,
  getRecordFile,
  putRecordFile,
  postRecordAnnotate,
} from '../api';
import { fmtDateTime } from '../utils';

// JSON record types get pretty-printing + live parse validation; briefs are
// plain text. "other" is anything the allowlist doesn't name.
const JSON_TYPES = new Set(['gate', 'triage', 'intake', 'child-settings']);

const TYPE_BADGE = {
  gate: 'badge-run',
  triage: 'badge-run',
  intake: 'badge-run',
  brief: 'badge-ok',
  'child-settings': 'badge-warn',
  verdict: 'badge-fail',
};

// A <textarea> always hands back LF; the server may store CRLF. Compare and
// diff-detect in LF space so a no-op edit isn't reported dirty (same rule the
// prompt editors live by).
const toLF = (s) => (s || '').replace(/\r\n/g, '\n');

// Pretty-print a JSON record for the editor; fall back to the raw content when
// it does not parse (the API should only ever return valid JSON for these).
function displayContent(d) {
  if (!JSON_TYPES.has(d.type)) return d.content || '';
  try {
    return JSON.stringify(JSON.parse(d.content), null, 2);
  } catch {
    return d.content || '';
  }
}

function jsonParseError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e.message;
  }
}

function TypeBadge({ type }) {
  const cls = TYPE_BADGE[type];
  if (!cls) return <span className="chip">{type || 'other'}</span>;
  return <span className={`badge ${cls}`}>{type}</span>;
}

export default function RecordsPanel({ taskId }) {
  const [records, setRecords] = useState(null);
  const [listError, setListError] = useState(null);

  // Selected record: sel identifies it, detail holds the loaded body.
  const [sel, setSel] = useState(null); // { runId, path }
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [draft, setDraft] = useState('');

  // Save / conflict / annotation state.
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null); // { sha256, content } on 409
  const [note, setNote] = useState('');
  const [annotating, setAnnotating] = useState(false);
  const [status, setStatus] = useState(null); // { kind: 'ok'|'warn'|'err', text }

  // The 15 s list poll pauses while the editor holds unsaved changes — a
  // ref (not state) so the interval callback sees the current value without
  // re-subscribing.
  const dirtyRef = useRef(false);

  const fetchList = useCallback(() => {
    getRecords(taskId)
      .then((d) => {
        setRecords(d.records || []);
        setListError(null);
      })
      .catch((e) => setListError(e.message || String(e)));
  }, [taskId]);

  useEffect(() => {
    fetchList();
    const t = setInterval(() => {
      if (!dirtyRef.current) fetchList();
    }, 15000);
    return () => clearInterval(t);
  }, [fetchList]);

  const loadRecord = useCallback((runId, path) => {
    setSel({ runId, path });
    setDetail(null);
    setDetailError(null);
    setConflict(null);
    setStatus(null);
    setNote('');
    getRecordFile(runId, path)
      .then((d) => {
        setDetail(d);
        setDraft(displayContent(d));
      })
      .catch((e) => setDetailError(e.message || String(e)));
  }, []);

  const isJson = detail ? JSON_TYPES.has(detail.type) : false;
  const readOnly = detail ? !detail.editable : false;
  const dirty = detail != null && !readOnly && toLF(draft) !== toLF(displayContent(detail));
  const parseError = isJson && !readOnly ? jsonParseError(draft) : null;

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const save = async () => {
    if (!sel || !detail || saving) return;
    setSaving(true);
    setStatus(null);
    setConflict(null);
    try {
      const res = await putRecordFile({
        run: sel.runId,
        path: sel.path,
        baseSha256: detail.sha256,
        content: draft,
      });
      setStatus({ kind: 'ok', text: `Saved (edit #${res.seq}) — the Supervisor will re-read it` });
      const d = await getRecordFile(sel.runId, sel.path);
      setDetail(d);
      setDraft(displayContent(d));
      fetchList();
    } catch (e) {
      if (e.status === 409 && e.data?.conflict) {
        setConflict({ sha256: e.data.sha256, content: e.data.content });
        // The local text stays visible until the user discards it.
        setStatus({ kind: 'warn', text: 'Changed by the agent since you opened it.' });
      } else {
        setStatus({ kind: 'err', text: e.data?.reason || e.data?.error || e.message });
      }
    } finally {
      setSaving(false);
    }
  };

  // "Reload theirs" — discard the local draft and take the agent's version.
  const reloadTheirs = async () => {
    if (!sel) return;
    setConflict(null);
    setStatus(null);
    loadRecord(sel.runId, sel.path);
  };

  const annotate = async () => {
    if (!sel || !note.trim() || annotating) return;
    setAnnotating(true);
    setStatus(null);
    try {
      await postRecordAnnotate({ run: sel.runId, path: sel.path, note: note.trim() });
      setNote('');
      setStatus({ kind: 'ok', text: 'Note added' });
      const d = await getRecordFile(sel.runId, sel.path);
      setDetail(d);
      setDraft(displayContent(d));
    } catch (e) {
      setStatus({ kind: 'err', text: e.data?.reason || e.data?.error || e.message });
    } finally {
      setAnnotating(false);
    }
  };

  // Group by run, newest record first inside each group.
  const groups = useMemo(() => {
    const byRun = new Map();
    for (const r of records || []) {
      if (!byRun.has(r.runId)) byRun.set(r.runId, []);
      byRun.get(r.runId).push(r);
    }
    return [...byRun.entries()].map(([runId, rows]) => ({
      runId,
      rows: rows.slice().sort((a, b) => new Date(b.mtime) - new Date(a.mtime)),
    }));
  }, [records]);

  const statusClass = status
    ? status.kind === 'ok'
      ? 'banner banner-ok'
      : 'banner banner-warn'
    : null;

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div className="section-h" style={{ marginBottom: 2 }}>
          Records
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={fetchList}
        >
          Refresh
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        What the agents wrote for this ticket. Edits are kept with the original and the Supervisor
        is told to re-read them.
      </div>

      <div aria-live="polite">
        {status && <div className={statusClass}>{status.text}</div>}
        {conflict && (
          <div className="banner banner-warn" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1 }}>
              Changed by the agent since you opened it. Your text is still in the editor.
            </span>
            <button type="button" className="btn-secondary" onClick={reloadTheirs}>
              Reload theirs
            </button>
          </div>
        )}
      </div>

      {listError && <div className="banner banner-warn">Error: {listError}</div>}

      {!listError && !records && <div className="muted">Loading…</div>}

      {records && records.length === 0 && (
        <div className="empty" style={{ padding: '18px 20px' }}>
          No records for this task yet.
        </div>
      )}

      {records && records.length > 0 && (
        <div className="card" style={{ padding: '8px 16px' }}>
          {groups.map((g) => (
            <div key={g.runId} style={{ marginBottom: 6 }}>
              <div
                className="muted"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  padding: '8px 4px 2px',
                  wordBreak: 'break-all',
                }}
              >
                {g.runId}
              </div>
              {g.rows.map((r) => {
                const active = sel && sel.runId === r.runId && sel.path === r.path;
                return (
                  <button
                    key={r.runId + ':' + r.path}
                    type="button"
                    className={'records-row' + (active ? ' active' : '')}
                    onClick={() => loadRecord(r.runId, r.path)}
                  >
                    <TypeBadge type={r.type} />
                    <code className="records-path">{r.path}</code>
                    <span className="chip">{r.editable ? 'editable' : 'read-only'}</span>
                    <span style={{ flex: 1 }} />
                    <span className="muted" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
                      {fmtDateTime(r.mtime)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {sel && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <TypeBadge type={detail?.type} />
            <code className="records-path">{sel.path}</code>
            <span style={{ flex: 1 }} />
            {detail && <span className="muted" style={{ fontSize: 10.5 }}>in {sel.runId}</span>}
          </div>

          {detailError && <div className="banner banner-warn" style={{ marginTop: 10 }}>Error: {detailError}</div>}

          {!detail && !detailError && (
            <div className="muted" style={{ padding: '10px 0' }}>Loading…</div>
          )}

          {detail && (
            <>
              {isJson && !readOnly && detail.editableFields?.length > 0 && (
                <div className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>
                  You can change: {detail.editableFields.join(', ')}
                </div>
              )}
              {!isJson && !readOnly && (
                <div className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>
                  You can change: the whole text
                </div>
              )}

              <textarea
                className="filter-search"
                style={{
                  width: '100%',
                  minHeight: 280,
                  marginTop: 6,
                  fontFamily: 'var(--mono)',
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  resize: 'vertical',
                }}
                value={draft}
                readOnly={readOnly}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setStatus(null);
                }}
                aria-label={`Record content: ${sel.path}`}
                spellCheck={false}
              />

              {parseError && (
                <div className="banner banner-warn" style={{ marginTop: 8 }}>
                  Invalid JSON: {parseError}
                </div>
              )}

              {!readOnly && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={saving || !dirty}
                    onClick={() => {
                      setDraft(displayContent(detail));
                      setStatus(null);
                      setConflict(null);
                    }}
                  >
                    Revert
                  </button>
                  <button
                    type="button"
                    className="launch-btn"
                    disabled={saving || !dirty || parseError}
                    onClick={save}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}

              {detail.type === 'verdict' && (
                <div style={{ marginTop: 16 }}>
                  <div className="section-h" style={{ marginBottom: 8 }}>Annotations</div>
                  {(detail.annotations || []).length === 0 && (
                    <div className="muted" style={{ fontSize: 12 }}>No notes yet.</div>
                  )}
                  {(detail.annotations || []).map((a, i) => (
                    <div
                      key={i}
                      style={{
                        borderBottom: '1px solid var(--border)',
                        padding: '6px 0',
                        fontSize: 12,
                      }}
                    >
                      <span className="muted" style={{ fontSize: 10.5 }}>
                        {fmtDateTime(a.ts)} · {a.who || '—'}
                      </span>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{a.note}</div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
                    <textarea
                      className="filter-search"
                      style={{ flex: 1, minHeight: 60, fontFamily: 'var(--mono)', fontSize: 11.5, resize: 'vertical' }}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      aria-label="Annotation note"
                      placeholder="Add a note to this verdict…"
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={annotating || !note.trim()}
                      onClick={annotate}
                    >
                      {annotating ? 'Adding…' : 'Add note'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

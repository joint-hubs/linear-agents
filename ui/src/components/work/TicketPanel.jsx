// Ticket detail side panel (FOC-784, spec §4.2) — the stage timeline, the cost
// split with its reconciliation line, the evidence links and the children
// table for one ticket. Open when /work/:ticket is set; close returns to /work
// with the board filters kept. Start is offered only in the Ready stage; the
// confirm dialog (StartDialog) shows the exact text before anything is sent —
// nothing is ever started without the human pressing the button.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getWorkTicket, getPublishPreview } from '../../api';
import {
  STAGES,
  formatMoney,
  timelineRows,
  evidenceRows,
  reconciliationText,
  panelCostLabel,
  ticketLabels,
} from '../../workModel';
import StartDialog from './StartDialog';
import PublishDialog from './PublishDialog';
import LabelChip from './LabelChip';

// The payload's timeline is chronological; a defensive sort by `at` (missing
// timestamps last) keeps it that way even when an entry arrives late.
function orderedTimeline(detail) {
  return timelineRows(detail)
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ta = a.row.at ? Date.parse(a.row.at) : Infinity;
      const tb = b.row.at ? Date.parse(b.row.at) : Infinity;
      return ta === tb ? a.i - b.i : ta - tb;
    })
    .map(({ row }) => row);
}

function formatAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

// A path without an href renders as copyable mono text — copy button plus the
// selectable text itself, so a failed clipboard still leaves the path usable.
function CopyablePath({ path }) {
  const [copied, setCopied] = useState(false);
  // The "Copied" flash timer is cleared on unmount — no setState after the
  // row is gone.
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the path stays selectable text.
    }
  };
  return (
    <span className="wk-copy">
      <code className="wk-mono">{path}</code>
      <button type="button" className="btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function EvidenceRow({ row }) {
  if (row.href) {
    const internal = row.href.startsWith('/');
    return (
      <li className="wk-ev-row">
        <span className="wk-ev-label">{row.label}</span>{' '}
        {internal ? (
          <Link className="link" to={row.href}>
            open
          </Link>
        ) : (
          <a className="link" href={row.href} target="_blank" rel="noreferrer">
            open
          </a>
        )}
      </li>
    );
  }
  if (row.copyable) {
    return (
      <li className="wk-ev-row">
        <span className="wk-ev-label">{row.label}</span> <CopyablePath path={row.path} />
      </li>
    );
  }
  return (
    <li className="wk-ev-row">
      <span className="wk-ev-label">{row.label}</span>
    </li>
  );
}

export default function TicketPanel({ id, taskKey, onClose, onAskSupervisor }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [startOpen, setStartOpen] = useState(false);
  const [publishPreview, setPublishPreview] = useState(null);
  const [publishAction, setPublishAction] = useState(null);
  const closeRef = useRef(null);

  // One fetch per opened ticket (the board refresh keeps the panel as is; a
  // Refresh of the panel comes from reopening it). The request is cancellable
  // and a failure shows an error card, never a blank panel.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    getWorkTicket(id, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setDetail(d);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setError(e);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [id]);

  // The publish actions (FOC-788) render only when a checkout is discoverable
  // for this ticket — publish-preview answers with one, and a 404
  // no-checkout means there is nothing to click. Failures stay silent here:
  // the panel is not the place to explain publishing, the confirm dialog is.
  useEffect(() => {
    const ctrl = new AbortController();
    setPublishPreview(null);
    getPublishPreview(id, 'push', ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPublishPreview(p);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setPublishPreview(null);
      });
    return () => ctrl.abort();
  }, [id]);

  // On open (and on switching tickets) focus goes to the Close button, so
  // keyboard users land in the dialog instead of the page behind it.
  useEffect(() => {
    if (closeRef.current) closeRef.current.focus();
  }, [id]);

  // Escape closes the panel — unless the Start or a publish dialog is open on
  // top of it; the dialog's own Esc handler (Modal) closes that one first.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !startOpen && !publishAction) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, startOpen, publishAction]);

  const ticket = detail?.ticket || null;
  const stage = ticket?.stage || null;
  const stageLabel = STAGES.find((s) => s.key === stage)?.label || stage;
  const cost = detail?.cost || null;
  const costText = detail ? panelCostLabel(detail) : null;
  const children = Array.isArray(detail?.children) ? detail.children : [];
  const rows = orderedTimeline(detail);
  const evidence = evidenceRows(detail);
  const issue = detail?.issue || null;
  const linearUrl = issue?.url || ticket?.url || null;
  const labels = ticketLabels(ticket?.labels);

  return (
    <aside className="wk-panel" role="dialog" aria-labelledby="wk-panel-heading">
      <div className="wk-panel-head">
        <code className="wk-card-id" id="wk-panel-heading">{id}</code>
        {stageLabel && <span className="ck-chip ck-tone-neutral">{stageLabel}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          ref={closeRef}
          className="btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={onClose}
        >
          Close
        </button>
      </div>

      {labels.length > 0 && (
        <div className="wk-labels" aria-label="Linear labels">
          {labels.map((l) => (
            <LabelChip key={l.id || l.name} label={l} />
          ))}
        </div>
      )}

      {issue?.title && <div className="wk-panel-title">{issue.title}</div>}
      {linearUrl && (
        <a className="link" href={linearUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
          Open in Linear
        </a>
      )}

      {loading && <div className="muted" style={{ marginTop: 14 }}>Loading ticket…</div>}

      {error && (
        <div className="banner banner-warn" style={{ marginTop: 14 }}>
          Ticket unavailable: {error.data?.error || error.message}
        </div>
      )}

      {detail && (
        <>
          <div className="wk-section">
            <div className="wk-section-h">Cost (children + Supervisor share)</div>
            {costText === 'no cost yet' ? (
              <div className="muted" style={{ fontSize: 12.5 }}>No cost yet — nothing has been priced for this ticket.</div>
            ) : (
              <>
                <div className="wk-cost-line">
                  Children <span className="wk-cost-total">{formatMoney(cost?.childrenUsd)}</span>
                </div>
                <div className="wk-cost-line">
                  Supervisor share <span className="wk-cost-total">{formatMoney(cost?.supervisorUsd)}</span>
                </div>
                <div className="wk-cost-line">
                  Total <span className="wk-cost-total">{formatMoney(cost?.totalUsd)}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                  {reconciliationText(cost?.reconciliation)}
                </div>
              </>
            )}
          </div>

          <div className="wk-section">
            <div className="wk-section-h">Timeline</div>
            {rows.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>No events yet.</div>
            ) : (
              <ul className="wk-timeline">
                {rows.map((r, i) => (
                  <li key={i} className="wk-tl-row">
                    <span className="wk-tl-at">{formatAt(r.at) || '—'}</span>
                    <span>
                      <span className="wk-tl-kind">{r.kind}</span> {r.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="wk-section">
            <div className="wk-section-h">Evidence</div>
            {evidence.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>No evidence recorded yet.</div>
            ) : (
              <ul className="wk-evidence">
                {evidence.map((e, i) => (
                  <EvidenceRow key={i} row={e} />
                ))}
              </ul>
            )}
          </div>

          <div className="wk-section">
            <div className="wk-section-h">Children</div>
            {children.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>No children yet.</div>
            ) : (
              <div className="wk-scroll">
                <table className="wk-table">
                  <thead>
                    <tr>
                      <th>child</th>
                      <th>squad</th>
                      <th>status</th>
                      <th>turns</th>
                      <th>cost</th>
                      <th>source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {children.map((c, i) => (
                      <tr key={c.childId || c.runId || i}>
                        <td className="wk-mono">{c.childId || '—'}</td>
                        <td>{c.squad || '—'}</td>
                        <td>{c.status || 'unknown'}</td>
                        <td className="wk-num">{Array.isArray(c.turns) ? c.turns.length : '—'}</td>
                        <td className="wk-num">{formatMoney(c.costUsd)}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{c.costSource || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="wk-actions">
            {stage === 'ready' && (
              <button type="button" className="launch-btn" onClick={() => setStartOpen(true)}>
                Start
              </button>
            )}
            {/* Publish (FOC-788): only with a discoverable checkout — a ticket
                without one offers nothing to click. Both open the confirm
                dialog; nothing is ever published without it. */}
            {publishPreview?.checkout && (
              <>
                <button type="button" className="btn-secondary" onClick={() => setPublishAction('push')}>
                  Push branch
                </button>
                <button type="button" className="btn-secondary" onClick={() => setPublishAction('pr')}>
                  Open PR
                </button>
              </>
            )}
            {/* Task cockpit (task workspaces, PRD §3): only with a canonical
                key from the payload — an identifier is never promoted into a
                cockpit link. No key → the Start / resolve flow above covers
                the ticket. */}
            {taskKey && (
              <Link
                className="btn-secondary"
                style={{ textDecoration: 'none' }}
                to={`/work/${encodeURIComponent(taskKey)}/cockpit`}
              >
                Open cockpit
              </Link>
            )}
            <button type="button" className="btn-secondary" onClick={() => onAskSupervisor(id)}>
              Ask the Supervisor
            </button>
          </div>
        </>
      )}

      {startOpen && <StartDialog id={id} onClose={() => setStartOpen(false)} />}
      {publishAction && (
        <PublishDialog id={id} action={publishAction} onClose={() => setPublishAction(null)} />
      )}
    </aside>
  );
}
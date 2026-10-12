// Needs-you inbox (FOC-783) — the human's queue first (spec principle 3).
// Newest first; each item: category chip, ticket, age, summary, the questions
// / facts / options, the primary action (inboxPrimaryAction) and "Open
// evidence" linking to the run detail with the Records panel.
//
// Answering records through /api/gates/answer or /api/holds/answer (answered
// once — a 409 means the Supervisor answered it in the meantime) and tells the
// Supervisor. When the notice did not go through the UI says so plainly and
// offers "Tell the Supervisor".

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { postGateAnswer, postHoldAnswer, postGateNotify } from '../../api';
import { inboxPrimaryAction, formatAge } from '../../cockpitModel';

const CATEGORY_TONE = {
  gate: 'waiting',
  approval: 'running',
  hold: 'waiting',
  problem: 'danger',
};

// Non-pending states are said in words, never only in colour.
const STATE_TEXT = {
  unreadable: 'unreadable — shown until it can be read',
  'awaiting-delivery': 'answered — waiting for delivery',
  open: 'open',
};

function AnswerResult({ result, item, onTold }) {
  const [telling, setTelling] = useState(false);
  const [tellError, setTellError] = useState(null);
  if (!result) return null;
  const tell = async () => {
    setTelling(true);
    setTellError(null);
    try {
      await postGateNotify({ runId: item.runId, gateId: item.gateId, holdId: item.holdId });
      onTold({ ...result, notified: true });
    } catch (e) {
      setTellError(e.data?.error || e.message || String(e));
    } finally {
      setTelling(false);
    }
  };
  return (
    <div className={result.notified ? 'banner banner-ok' : 'banner banner-warn'} style={{ marginTop: 8 }}>
      <div>{result.notified ? 'Recorded — the Supervisor was told' : 'Recorded — the Supervisor has NOT been told yet'}</div>
      {!result.notified && (
        <div style={{ marginTop: 6 }}>
          <button type="button" className="btn-secondary" disabled={telling} onClick={tell}>
            {telling ? 'Sending…' : 'Tell the Supervisor'}
          </button>
          {tellError && <span className="muted" style={{ marginLeft: 8 }}>Error: {tellError}</span>}
        </div>
      )}
    </div>
  );
}

function NeedsYouItem({ item, onAskSupervisor }) {
  const [answerText, setAnswerText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { recorded, notified }

  const action = inboxPrimaryAction(item);

  // Gates go through the gate library (text + optional note); holds through the
  // hold library (option label or free text, no separate note field).
  const answer = async (text, noteArg) => {
    setBusy(true);
    setError(null);
    try {
      const body = item.category === 'hold'
        ? { runId: item.runId, holdId: item.holdId, text }
        : { runId: item.runId, gateId: item.gateId, text, note: noteArg || undefined };
      const res = item.category === 'hold' ? await postHoldAnswer(body) : await postGateAnswer(body);
      setResult({ recorded: !!res.recorded, notified: !!res.notified });
      setAnswerText('');
      setNote('');
    } catch (e) {
      setError(e.data?.error || e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const askText = `What happened with ${item.childId || 'the child'} on ${item.taskId || 'the ticket'} (${item.kind || item.category})?`;

  return (
    <div className="ck-inbox-item">
      <div className="ck-inbox-head">
        <span className={`ck-chip ck-tone-${CATEGORY_TONE[item.category] || 'neutral'}`}>
          {item.category || 'unknown'}
        </span>
        <code className="ck-mono">{item.taskId || 'untagged'}</code>
        {item.childId && <span className="muted ck-mono-small">{item.childId}</span>}
        <span style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 11 }}>{formatAge(item.ageMs)}</span>
      </div>

      {item.kind && <div className="muted" style={{ fontSize: 11 }}>kind: {item.kind}</div>}
      {STATE_TEXT[item.state] && item.state !== 'pending' && (
        <div className="muted" style={{ fontSize: 11 }}>{STATE_TEXT[item.state]}</div>
      )}

      {item.summary && <div className="ck-inbox-summary">{item.summary}</div>}

      {(item.questions || []).length > 0 && (
        <ul className="ck-inbox-list">
          {item.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      )}
      {(item.facts || []).length > 0 && (
        <ul className="ck-inbox-list ck-inbox-facts">
          {item.facts.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}

      {action.kind === 'text' && (
        <div className="ck-inbox-actions">
          <textarea
            className="filter-search"
            style={{ flex: 1, minHeight: 56, fontFamily: 'var(--mono)', fontSize: 11.5, resize: 'vertical' }}
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="Your answer, sent verbatim…"
            aria-label={`Answer for ${item.taskId || 'item'} ${item.gateId || item.holdId || ''}`}
            disabled={busy || !!result}
          />
          <button
            type="button"
            className="launch-btn"
            disabled={busy || !!result || !answerText.trim()}
            onClick={() => answer(answerText.trim())}
          >
            {busy ? 'Recording…' : action.label || 'Answer'}
          </button>
        </div>
      )}

      {action.kind === 'yesno' && (
        <div className="ck-inbox-actions">
          <input
            type="text"
            className="filter-search"
            style={{ flex: 1 }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            aria-label="Optional note for the approval"
            disabled={busy || !!result}
          />
          <button
            type="button"
            className="launch-btn"
            disabled={busy || !!result}
            onClick={() => answer('yes', note.trim())}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !!result}
            onClick={() => answer('no', note.trim())}
          >
            Reject
          </button>
        </div>
      )}

      {action.kind === 'option' && (
        <div className="ck-inbox-options">
          {(item.options || []).map((o, i) => {
            const recommended = item.recommendation != null && o.label === item.recommendation;
            return (
              <button
                key={i}
                type="button"
                className={recommended ? 'launch-btn ck-option' : 'btn-secondary ck-option'}
                disabled={busy || !!result}
                onClick={() => answer(o.label)}
                title={[o.model, o.costUsd != null ? '$' + o.costUsd : null].filter(Boolean).join(' · ')}
              >
                {recommended ? '★ ' : ''}
                {o.label}
                {o.model && <span className="ck-option-meta">{o.model}</span>}
                {o.costUsd != null && <span className="ck-option-meta">${o.costUsd}</span>}
              </button>
            );
          })}
          {(item.options || []).length === 0 && (
            <span className="muted" style={{ fontSize: 12 }}>No options listed — answer in text below the item or in the Terminal.</span>
          )}
        </div>
      )}

      {action.kind === 'ask' && (
        <div className="ck-inbox-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onAskSupervisor(askText)}
          >
            {action.label || 'Ask the Supervisor'}
          </button>
        </div>
      )}

      {action.kind === 'notify' && (
        <div className="ck-inbox-actions">
          <NotifyButton item={item} onTold={setResult} existing={result} />
        </div>
      )}

      {action.kind === 'none' && !result && (
        <div className="muted" style={{ fontSize: 12 }}>Nothing to answer here — read-only.</div>
      )}

      <AnswerResult result={result} item={item} onTold={setResult} />
      {error && <div className="banner banner-warn" style={{ marginTop: 8 }}>Error: {error}</div>}

      {item.runId && (
        <Link className="link" to={`/runs/${item.runId}`} style={{ fontSize: 12 }}>
          Open evidence
        </Link>
      )}
    </div>
  );
}

// "Tell the Supervisor" for awaiting-delivery items — same notice re-send, but
// these items have no recorded answer of their own on screen.
function NotifyButton({ item, onTold, existing }) {
  const [telling, setTelling] = useState(false);
  const [error, setError] = useState(null);
  const told = existing?.notified;
  const tell = async () => {
    setTelling(true);
    setError(null);
    try {
      await postGateNotify({ runId: item.runId, gateId: item.gateId, holdId: item.holdId });
      onTold({ recorded: true, notified: true });
    } catch (e) {
      setError(e.data?.error || e.message || String(e));
    } finally {
      setTelling(false);
    }
  };
  if (told) return null;
  return (
    <>
      <button type="button" className="launch-btn" disabled={telling} onClick={tell}>
        {telling ? 'Sending…' : 'Tell the Supervisor'}
      </button>
      {error && <span className="muted" style={{ marginLeft: 8 }}>Error: {error}</span>}
    </>
  );
}

export default function NeedsYouInbox({ items, onAskSupervisor }) {
  // Newest first regardless of the order the API sent (createdAt desc).
  const sorted = [...(items || [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (
    <div className="section">
      <div className="section-h">Needs you</div>
      {sorted.length === 0 ? (
        <div className="empty">Nothing needs you right now.</div>
      ) : (
        <div className="ck-inbox-list-wrap">
          {sorted.map((item) => (
            <NeedsYouItem key={item.id} item={item} onAskSupervisor={onAskSupervisor} />
          ))}
        </div>
      )}
    </div>
  );
}

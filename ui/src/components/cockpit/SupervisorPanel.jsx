// Supervisor panel (FOC-783) — header (state chip, focus ticket, model), the
// Chat | Terminal tabs over the same session, quick prompts that pre-fill the
// composer, the wake-backlog call to action and a confirmed "New session".
//
// Chat is the default view (spec decision 1). Both views run in Docker; chat
// is additionally disabled while the Supervisor waits on an ask or a dialog
// (needs-input) — the AskCard / DialogCard above the tabs answers it from the
// dashboard (FOC-810), so only host problems disable the terminal
// (terminalDisabledReason).

import { useEffect, useRef, useState } from 'react';
import { postSupervisorAsk, postSupervisorDialog, postSupervisorSession, postSupervisorWake } from '../../api';
import { chatDisabledReason, terminalDisabledReason, answerResultText, wakeBanner } from '../../cockpitModel';
import AskCard from './AskCard';
import DialogCard from './DialogCard';
import ChatView from './ChatView';
import TerminalView from './TerminalView';

const QUICK_PROMPTS = ['Start a ticket…', 'Status of all children', 'What is blocked?'];

// useSupervisorAnswers({ onRefresh, identity }) — the one submit path for the
// Supervisor's asks and dialogs (FOC-810), shared by the Supervisor panel and
// the Needs-you inbox (which imports it from here). Wraps POST
// /api/supervisor/ask and /api/supervisor/dialog: busy/error/sent state plus
// the host's success body (`result`, so the banner can be honest — see
// answerResultText), a 409 (ask-changed / dialog-changed) becomes the fixed
// "changed — refreshed" sentence — or, when the host says partial: true
// (keys already went through before the drift), the honest partial sentence —
// and triggers the snapshot refresh, and every success refreshes too (the
// next snapshot drops the answered card). onRefresh is optional — the
// Cockpit's own 5 s poll refreshes regardless. `identity` is what the answer
// state is about (the ask's toolUseId or the dialog's id, prefixed); when a
// DIFFERENT one appears the state resets — a stale "Answer sent." must not
// sit under the next dialog or question. Nothing shown (identity null)
// keeps the banner: it is the record of the last answer once its card is
// gone.
export function useSupervisorAnswers({ onRefresh, identity } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [result, setResult] = useState(null); // the host's success body

  const shownRef = useRef(identity);
  useEffect(() => {
    const prev = shownRef.current;
    shownRef.current = identity;
    if (identity != null && identity !== prev) {
      setError(null);
      setSent(false);
      setResult(null);
    }
  }, [identity]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    setSent(false);
    setResult(null);
    try {
      const res = await fn();
      setResult(res);
      setSent(true);
      if (onRefresh) onRefresh();
      return res;
    } catch (e) {
      if (e.status === 409) {
        setError(
          e.data?.error === 'dialog-changed' && e.data?.partial
            ? 'The dialog changed while answering — some answers may be applied; check the Terminal.'
            : 'The dialog changed — refreshed.',
        );
        if (onRefresh) onRefresh();
      } else {
        setError(e.data?.error || e.message || String(e));
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitAsk = (toolUseId, answers) => run(() => postSupervisorAsk({ toolUseId, answers }));
  const submitDialog = (id, choice, note) => run(() => postSupervisorDialog({ id, choice, note }));
  return { busy, error, sent, result, submitAsk, submitDialog };
}

// The success banner for an answer: honest about what actually happened —
// a green "Answer sent." only when the host really closed it cleanly
// (FOC-810); a caveat (still on screen, some answers already applied) is
// a warning banner, not a green one.
export function AnswerSentBanner({ result }) {
  const text = answerResultText(result);
  const ok = text === 'Answer sent.' || text.startsWith('Sent —');
  return (
    <div className={ok ? 'banner banner-ok' : 'banner banner-warn'} style={{ marginTop: 8 }}>
      {text}
    </div>
  );
}

// Supervisor state → chip tone. idle ok, busy running, needs-input waiting,
// everything else (ended/absent/unknown/null) neutral.
const STATE_CHIP = {
  idle: { label: 'idle', tone: 'ok' },
  busy: { label: 'busy', tone: 'running' },
  'needs-input': { label: 'needs input', tone: 'waiting' },
  ended: { label: 'ended', tone: 'neutral' },
  absent: { label: 'absent', tone: 'neutral' },
  unknown: { label: 'unknown', tone: 'neutral' },
};

export default function SupervisorPanel({ supervisor, tab, onTabChange, draft, onDraftChange, onRefresh }) {
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeStatus, setWakeStatus] = useState(null); // { kind, text }
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionStatus, setSessionStatus] = useState(null);

  const sup = supervisor || {};
  const chip = STATE_CHIP[sup.state] || STATE_CHIP.unknown;
  const disabledReason = chatDisabledReason(sup);
  const terminalReason = terminalDisabledReason(sup);
  const wakeInfo = wakeBanner(sup);
  // The ask card wins when both are present (the ask is what blocks the
  // session); ask/ask-review dialogs are shown in the inbox, not here.
  const dialogForCard =
    sup.dialog && sup.dialog.kind !== 'ask' && sup.dialog.kind !== 'ask-review' ? sup.dialog : null;
  // What the shared answer state is about — the pending ask's toolUseId or
  // the dialog's id. useSupervisorAnswers resets its banner/error when a
  // different one appears.
  const answerIdentity = sup.pendingAsk
    ? 'ask:' + sup.pendingAsk.toolUseId
    : dialogForCard
      ? 'dialog:' + dialogForCard.id
      : null;
  const answers = useSupervisorAnswers({ onRefresh, identity: answerIdentity });

  const wake = async () => {
    setWakeBusy(true);
    setWakeStatus(null);
    try {
      await postSupervisorWake();
      setWakeStatus({ kind: 'ok', text: 'Wake sent' });
    } catch (e) {
      setWakeStatus({ kind: 'err', text: e.data?.error || e.message || String(e) });
    } finally {
      setWakeBusy(false);
    }
  };

  const newSession = async () => {
    // Destructive-ish and deliberate — never starts without the confirm.
    if (!window.confirm('Start a fresh Supervisor session? The current conversation ends.')) return;
    setSessionBusy(true);
    setSessionStatus(null);
    try {
      await postSupervisorSession();
      setSessionStatus({ kind: 'ok', text: 'New session starting' });
    } catch (e) {
      setSessionStatus({ kind: 'err', text: e.data?.error || e.message || String(e) });
    } finally {
      setSessionBusy(false);
    }
  };

  return (
    <div className="section ck-supervisor">
      <div className="ck-sup-head">
        <div className="section-h" style={{ marginBottom: 0 }}>Supervisor</div>
        <span className={`ck-chip ck-tone-${chip.tone}`}>{chip.label}</span>
        {sup.focus?.taskId && (
          <span className="muted" style={{ fontSize: 12 }}>
            focus <code className="ck-mono">{sup.focus.taskId}</code>
          </span>
        )}
        {sup.model && <span className="chip ck-mono-small">{sup.model}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-secondary"
          style={{ fontSize: 11, padding: '3px 10px' }}
          disabled={sessionBusy}
          onClick={newSession}
          title="Kill and start a fresh Supervisor session"
        >
          New session
        </button>
      </div>

      {(wakeStatus || sessionStatus) && (
        <div
          className={(wakeStatus || sessionStatus).kind === 'ok' ? 'banner banner-ok' : 'banner banner-warn'}
          style={{ marginTop: 8 }}
        >
          {(wakeStatus || sessionStatus).text}
        </div>
      )}

      {wakeInfo && (
        <div
          className={wakeInfo.wakerAlive ? 'banner banner-ok' : 'banner banner-warn'}
          style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}
        >
          <span style={{ flex: 1 }}>
            <strong>{wakeInfo.text}</strong> {wakeInfo.detail}
          </span>
          {wakeInfo.canWake && (
            <button type="button" className="btn-secondary" disabled={wakeBusy} onClick={wake}>
              {wakeBusy ? 'Waking…' : 'Wake'}
            </button>
          )}
        </div>
      )}

      {answers.sent && <AnswerSentBanner result={answers.result} />}

      {sup.pendingAsk ? (
        <AskCard
          key={sup.pendingAsk.toolUseId}
          ask={sup.pendingAsk}
          busy={answers.busy}
          error={answers.error}
          onSubmit={(ans) => answers.submitAsk(sup.pendingAsk.toolUseId, ans)}
        />
      ) : (
        dialogForCard && (
          <DialogCard
            key={dialogForCard.id}
            dialog={dialogForCard}
            busy={answers.busy}
            error={answers.error}
            onChoose={(choice, note) => answers.submitDialog(dialogForCard.id, choice, note)}
            onOpenTerminal={() => onTabChange('terminal')}
          />
        )
      )}

      <div className="ck-tabs" role="tablist" aria-label="Supervisor views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          className={tab === 'chat' ? 'ck-tab ck-tab-active' : 'ck-tab'}
          onClick={() => onTabChange('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'terminal'}
          className={tab === 'terminal' ? 'ck-tab ck-tab-active' : 'ck-tab'}
          onClick={() => onTabChange('terminal')}
        >
          Terminal
        </button>
      </div>

      {tab === 'terminal' ? (
        terminalReason ? (
          <div className="banner banner-warn" style={{ marginTop: 10 }}>{terminalReason}</div>
        ) : (
          <TerminalView />
        )
      ) : (
        <>
          <div className="ck-quick">
            <span className="muted" style={{ fontSize: 11 }}>Quick:</span>
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                className="btn-secondary"
                style={{ fontSize: 11, padding: '3px 10px' }}
                disabled={!!disabledReason}
                onClick={() => onDraftChange(q)}
              >
                {q}
              </button>
            ))}
          </div>
          <ChatView
            supervisor={sup}
            draft={draft}
            onDraftChange={onDraftChange}
            onOpenTerminal={() => onTabChange('terminal')}
          />
        </>
      )}
    </div>
  );
}

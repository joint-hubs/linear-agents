// Supervisor panel (FOC-783) — header (state chip, focus ticket, model), the
// Chat | Terminal tabs over the same session, quick prompts that pre-fill the
// composer, the wake-backlog call to action and a confirmed "New session".
//
// Chat is the default view (spec decision 1). Both views run in Docker; chat
// is additionally disabled while a dialog is open (needs-input) — the terminal
// is exactly what answers it, so only host problems disable the terminal
// (terminalDisabledReason).

import { useState } from 'react';
import { postSupervisorSession, postSupervisorWake } from '../../api';
import { chatDisabledReason, terminalDisabledReason } from '../../cockpitModel';
import ChatView from './ChatView';
import TerminalView from './TerminalView';

const QUICK_PROMPTS = ['Start a ticket…', 'Status of all children', 'What is blocked?'];

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

export default function SupervisorPanel({ supervisor, tab, onTabChange, draft, onDraftChange }) {
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeStatus, setWakeStatus] = useState(null); // { kind, text }
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionStatus, setSessionStatus] = useState(null);

  const sup = supervisor || {};
  const chip = STATE_CHIP[sup.state] || STATE_CHIP.unknown;
  const disabledReason = chatDisabledReason(sup);
  const terminalReason = terminalDisabledReason(sup);
  const showWake = sup.wakeBacklog > 0 && sup.state === 'idle';

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

      {showWake && (
        <div className="banner banner-warn" style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>{sup.wakeBacklog} event{sup.wakeBacklog === 1 ? '' : 's'} waiting</span>
          <button type="button" className="btn-secondary" disabled={wakeBusy} onClick={wake}>
            {wakeBusy ? 'Waking…' : 'Wake'}
          </button>
        </div>
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

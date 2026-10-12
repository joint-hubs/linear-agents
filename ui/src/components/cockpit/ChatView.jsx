// Chat view of the Supervisor session (FOC-783) — the default tab. Polls the
// transcript every 2 s while mounted: the first request is tail mode (no
// `after` — the last page, transcripts can be tens of MB), every later tick
// pages forward from the previous offset (mergeConversation dedupes; reset
// switches to the new session). A full forward page (a burst) is followed
// immediately, capped per tick. Sends through /api/supervisor/message and
// shows per-message queued/unconfirmed state.
//
// Enter sends, Shift+Enter is a newline. When the Supervisor shows a dialog
// (409 needs-input) chat refuses and points at the Terminal — keystrokes must
// never answer a permission prompt (plan §1).

import { useEffect, useRef, useState } from 'react';
import { getConversation, postSupervisorMessage } from '../../api';
import {
  buildConversationQuery,
  chatDisabledReason,
  CONVERSATION_LIMIT,
  mergeConversation,
  shouldFollowBurst,
} from '../../cockpitModel';

// Quick prompts live in SupervisorPanel (they pre-fill this composer).

function Entry({ entry }) {
  if (entry.role === 'tool') {
    const t = entry.tool || {};
    return (
      <div className="ck-chat-line ck-chat-tool">
        {t.name || 'tool'}
        {t.summary ? ': ' + t.summary : ''}
      </div>
    );
  }
  if (entry.role === 'user') {
    return (
      <div className="ck-chat-line ck-chat-user">
        <span className="ck-chat-who">You</span>
        <div className="ck-chat-text">{entry.text}</div>
      </div>
    );
  }
  return (
    <div className="ck-chat-line ck-chat-assistant">
      <span className="ck-chat-who">Supervisor</span>
      {/* Assistant text is preformatted but wrapped — the transcript keeps its
          own line breaks; long unbroken lines (ids, paths) must not overflow. */}
      <div className="ck-chat-text ck-chat-pre">{entry.text}</div>
    </div>
  );
}

export default function ChatView({ supervisor, draft, onDraftChange, onOpenTerminal }) {
  const [entries, setEntries] = useState([]);
  const [convError, setConvError] = useState(null);
  const [loaded, setLoaded] = useState(false); // first page has arrived
  const [truncated, setTruncated] = useState(false); // older history exists
  const [pending, setPending] = useState([]); // [{ id, text, state: sent|queued }]
  const [sendError, setSendError] = useState(null); // { text, notification? }
  const [busy, setBusy] = useState(false);

  const offsetRef = useRef(0);
  const loadedRef = useRef(false);
  const truncatedRef = useRef(false);
  const scrollRef = useRef(null);
  const disabledReason = chatDisabledReason(supervisor);

  // Transcript poll — 2 s while mounted, paused while the tab is hidden. The
  // offset lives in a ref so the interval callback always sends the freshest
  // value without re-arming the timer. The first request is tail mode (no
  // `after`): the server returns the last page plus the end offset, so a huge
  // transcript never pages from its beginning. Later ticks go forward from
  // that offset; a page that came back full (a burst) is followed immediately,
  // at most CONVERSATION_MAX_PAGES_PER_TICK pages per tick. A reset page (new
  // session / shrank file) replaces the entries and paging continues from its
  // offset.
  useEffect(() => {
    let inFlight = false;
    // One AbortController per effect run: unmounting (tab switch) aborts the
    // in-flight request — and any queued burst pages — so nothing here touches
    // state after the component is gone.
    const controller = new AbortController();
    const { signal } = controller;
    const tick = async () => {
      if (document.hidden || inFlight || signal.aborted) return;
      inFlight = true;
      try {
        let pagesFetched = 0;
        while (!signal.aborted) {
          const forward = loadedRef.current;
          const page = await getConversation(
            buildConversationQuery({
              started: forward,
              offset: offsetRef.current,
              limit: CONVERSATION_LIMIT,
            }),
            signal,
          );
          // The request resolved, but the component unmounted meanwhile —
          // drop the page instead of setting state on an unmounted tree.
          if (signal.aborted) break;
          pagesFetched++;
          loadedRef.current = true;
          setLoaded(true);
          // Only a tail-mode page (the first load, or a fallback after the
          // file shrank) knows whether older history exists.
          if (!forward || page.reset) {
            truncatedRef.current = !!page.truncated;
            setTruncated(truncatedRef.current);
          }
          offsetRef.current = page.offset;
          setEntries((prev) => mergeConversation(prev, page, { reset: page.reset }));
          setConvError(null);
          if (!shouldFollowBurst(page, { forward, limit: CONVERSATION_LIMIT, pagesFetched })) break;
        }
      } catch (e) {
        if (e?.name !== 'AbortError') setConvError(e.message || String(e));
      } finally {
        inFlight = false;
      }
    };
    // The hidden pause must not skip the FIRST load: when the tab mounts
    // hidden, fetch the first page as soon as the document becomes visible
    // (the interval keeps the later ticks going either way).
    const onVisibility = () => {
      if (!document.hidden && !loadedRef.current) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // A sent message drops off the pending list once the transcript shows the
  // user line (same text) — until then it keeps its status label.
  useEffect(() => {
    setPending((ps) =>
      ps.filter((p) => !entries.some((en) => en.role === 'user' && en.text === p.text)),
    );
  }, [entries]);

  // Keep the newest entries in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, pending]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || disabledReason) return;
    setBusy(true);
    setSendError(null);
    const id = Date.now() + ':' + Math.random();
    setPending((ps) => [...ps, { id, text, state: 'sent' }]);
    onDraftChange('');
    try {
      const res = await postSupervisorMessage(text);
      const state = res.queued ? 'queued' : 'sent';
      setPending((ps) => ps.map((p) => (p.id === id ? { ...p, state } : p)));
    } catch (e) {
      // The failed message stays in the composer so nothing typed is lost.
      onDraftChange(text);
      setPending((ps) => ps.filter((p) => p.id !== id));
      setSendError({
        text: e.data?.error || e.message || String(e),
        status: e.status,
        notification: e.data?.notification || null,
      });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="ck-chat">
      <div className="ck-chat-scroll" ref={scrollRef}>
        {convError && <div className="banner banner-warn">Conversation error: {convError}</div>}
        {!loaded && !convError && (
          <div className="muted" style={{ padding: '12px 4px', fontSize: 12 }}>
            Loading the conversation…
          </div>
        )}
        {loaded && entries.length === 0 && !convError && (
          <div className="muted" style={{ padding: '12px 4px', fontSize: 12 }}>
            No conversation yet — say hello or pick a quick prompt below.
          </div>
        )}
        {loaded && truncated && (
          <div className="muted" style={{ padding: '6px 4px', fontSize: 11 }}>
            Older messages are in the Terminal (scrollback) and the transcript.
          </div>
        )}
        {entries.map((entry) => (
          <Entry key={entry.uuid} entry={entry} />
        ))}
        {pending.map((p) => (
          <div key={p.id} className="ck-chat-line ck-chat-user ck-chat-pending">
            <span className="ck-chat-who">You</span>
            <div className="ck-chat-text">{p.text}</div>
            <span className="chip">
              {p.state === 'queued' ? 'queued — after the current turn' : 'sent — not confirmed yet'}
            </span>
          </div>
        ))}
      </div>

      {sendError && (
        <div className="banner banner-warn" style={{ marginTop: 8 }}>
          <div>
            {sendError.status === 409
              ? 'The Supervisor is showing a dialog — answer it in the Terminal.'
              : sendError.status === 400
                ? 'Refused: slash commands go through the Terminal.'
                : 'Could not send: ' + sendError.text}
          </div>
          {sendError.notification?.message && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {sendError.notification.message}
            </div>
          )}
          {sendError.status === 409 && (
            <button type="button" className="btn-secondary" style={{ marginTop: 6 }} onClick={onOpenTerminal}>
              Open Terminal
            </button>
          )}
        </div>
      )}

      {disabledReason && (
        <div className="banner banner-warn">
          <div>{disabledReason}</div>
          {supervisor?.state === 'needs-input' && (
            <button type="button" className="btn-secondary" style={{ marginTop: 6 }} onClick={onOpenTerminal}>
              Open Terminal
            </button>
          )}
        </div>
      )}

      <div className="ck-composer">
        <textarea
          className="filter-search"
          style={{ flex: 1, minHeight: 64, maxHeight: 160, fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabledReason ? 'Chat is unavailable' : 'Message the Supervisor… (Enter sends, Shift+Enter newline)'}
          aria-label="Message the Supervisor"
          disabled={!!disabledReason || busy}
        />
        <button
          type="button"
          className="launch-btn"
          disabled={!!disabledReason || busy || !draft.trim()}
          onClick={send}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

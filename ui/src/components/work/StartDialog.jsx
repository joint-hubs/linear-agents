// Start dialog (FOC-784 + task workspaces, PRD §3–5) — the confirm step
// before a Ready ticket is handed to the Supervisor. On open it fetches the
// start-preview and shows the exact text the Supervisor will receive in a
// read-only textarea. The primary button follows the delivery:
// - "cockpit" (native, no session host): opens the legacy Cockpit overview
//   with the text prefilled via /cockpit?prompt= — the human still presses
//   Send there.
// - "supervisor": posts /start with that text. The response carries the
//   server's landing ({ session, taskKey, delivery, cockpitUrl }) — queued
//   (202) is a SUCCESS: the dialog navigates straight to the task cockpit,
//   which shows the session lifecycle and polls; no ready text is guaranteed
//   immediately (PRD-approved UX). Without a cockpitUrl in the response the
//   legacy result banner stays.
// Nothing is ever sent automatically. Errors are shown verbatim.
//
// The dialog portals to document.body: rendered inside the side panel's
// stacking context (aside.wk-panel, z-index 40) its overlay sat below the app
// sidebar and the dialog's left part was covered. The wrapper div carries the
// z-index lift (work.css) — Modal's Esc/focus behaviour is unchanged.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import Modal from '../Modal';
import { getStartPreview, postStartTicket } from '../../api';
import { startDialogModel } from '../../workModel';

export default function StartDialog({ id, onClose }) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setError(null);
    getStartPreview(id, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPreview(p);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setPreviewError(e);
      });
    return () => ctrl.abort();
  }, [id]);

  const m = startDialogModel(preview, { sending, result, error, loading: !preview && !previewError });

  const primary = async () => {
    if (m.disabled || !preview) return;
    if (preview.delivery === 'cockpit') {
      // Native mode: hand the text to the legacy Cockpit composer (never sent
      // there — the human still presses Send).
      navigate('/cockpit?prompt=' + encodeURIComponent(preview.text));
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await postStartTicket(id, preview.text);
      // The server names the landing: a queued (202) start navigates to the
      // task cockpit immediately — it renders the lifecycle (queued →
      // starting → running) and polls; nothing here waits for ready text.
      if (res && typeof res.cockpitUrl === 'string' && res.cockpitUrl.startsWith('/')) {
        onClose();
        navigate(res.cockpitUrl);
        return;
      }
      setResult(res);
    } catch (e) {
      setError(e.data?.error || e.message || String(e));
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="wk-start-portal">
      <Modal open onClose={onClose} title={m.title} width="min(640px, 92vw)">
      {previewError && (
        <div className="banner banner-warn" style={{ marginTop: 8 }}>
          Preview unavailable: {previewError.data?.error || previewError.message}
        </div>
      )}

      {!previewError && m.text == null && (
        <div className="muted" style={{ marginTop: 8 }}>
          Loading preview…
        </div>
      )}

      {m.text != null && (
        <>
          <div className="muted" style={{ margin: '10px 0 6px', fontSize: 12 }}>
            The Supervisor will receive exactly this text:
          </div>
          <textarea
            readOnly
            value={m.text}
            rows={10}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'var(--mono)',
              fontSize: 11.5,
              resize: 'vertical',
            }}
            aria-label="Hand-off text for the Supervisor"
          />
        </>
      )}

      {m.resultText && (
        <div className={error ? 'banner banner-warn' : 'banner banner-ok'} style={{ marginTop: 10 }}>
          {m.resultText}
        </div>
      )}

      <div className="wk-actions" style={{ marginTop: 12 }}>
        {m.primaryLabel && (
          <button type="button" className="launch-btn" disabled={m.disabled} onClick={primary}>
            {m.primaryLabel}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
        {m.disabled && m.disabledReason && !m.resultText && (
          <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
            {m.disabledReason}
          </span>
        )}
      </div>
    </Modal>
    </div>,
    document.body,
  );
}
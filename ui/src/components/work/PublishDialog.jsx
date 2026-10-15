// Publish dialog (FOC-788) — the explicit confirm before Push branch / Open
// PR. On open it fetches the publish-preview for its action and shows what
// the human is confirming: the checks state FIRST and prominently when
// anything failed (AC-2 — shown, never hard-blocking), the diff summary, the
// target and the actor ("You"). The primary button posts the preview's own
// confirmToken with actor "human"; a checkout that moved answers
// 409 stale-preview and the dialog offers a fresh preview instead of acting.
// Nothing is ever published automatically. Errors are spelled out by name.
//
// Like StartDialog it portals to document.body — inside the side panel's
// stacking context (aside.wk-panel, z-index 40) the overlay would sit below
// the app sidebar. Modal's Esc/focus behaviour is unchanged.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from '../Modal';
import { getPublishPreview, postPublish } from '../../api';
import { publishDialogModel } from '../../workModel';

export default function PublishDialog({ id, action, onClose }) {
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const loadPreview = () => {
    const ctrl = new AbortController();
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setError(null);
    getPublishPreview(id, action, ctrl.signal)
      .then((p) => {
        if (!ctrl.signal.aborted) setPreview(p);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted && e?.name !== 'AbortError') setPreviewError(e);
      });
    return () => ctrl.abort();
  };
  useEffect(loadPreview, [id, action]);

  const m = publishDialogModel(preview, action, {
    sending,
    result,
    error,
    loading: !preview && !previewError,
  });

  const confirm = async () => {
    if (m.disabled || !preview) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await postPublish(id, action, preview.confirmToken));
    } catch (e) {
      setError(e.data?.error ? e : e.message || String(e));
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

      {!previewError && m.branchText == null && (
        <div className="muted" style={{ marginTop: 8 }}>
          {m.disabledReason || 'Loading preview…'}
        </div>
      )}

      {m.branchText && (
        <>
          {/* AC-2: when any check failed its state comes FIRST and
              prominent — the human sees it before anything else. It never
              disables the button: the AC says shown, not blocked. */}
          {m.checksFailed && (
            <div className="banner banner-warn" style={{ marginTop: 8 }} role="alert">
              <strong>Checks: {m.checksLines.length} failing round(s)</strong> — {m.checksLines.join(', ')}.
              Publishing anyway is your call.
            </div>
          )}

          <div className="muted" style={{ margin: '10px 0 6px', fontSize: 12 }}>
            {m.title} <code className="wk-mono">{m.branchText}</code>
            {action === 'pr' ? ' into ' : ' to '}<code className="wk-mono">{m.targetText}</code>
            {action === 'push' && preview?.checkout?.remoteUrl ? (
              <span> ({preview.checkout.remoteUrl})</span>
            ) : null}
            {m.checksFailed ? '' : ` — checks: ${m.checksLatest || 'unknown'}`}
          </div>
          <div style={{ fontSize: 12.5, marginBottom: 4 }}>{m.diffText}</div>
          <div className="muted" style={{ fontSize: 12 }}>Confirmed by: {m.actorText}</div>
        </>
      )}

      {m.resultText && (
        <div className={error ? 'banner banner-warn' : 'banner banner-ok'} style={{ marginTop: 10 }}>
          {m.resultText}
        </div>
      )}

      <div className="wk-actions" style={{ marginTop: 12 }}>
        {m.primaryLabel && (
          <button type="button" className="launch-btn" disabled={m.disabled} onClick={confirm}>
            {m.primaryLabel}
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onClose}>
          {result?.ok ? 'Close' : 'Cancel'}
        </button>
        {m.stale && (
          <button type="button" className="btn-secondary" onClick={loadPreview}>
            Preview again
          </button>
        )}
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

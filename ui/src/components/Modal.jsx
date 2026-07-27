import { useEffect, useRef } from 'react';

/**
 * Shared modal dialog — used by prompt editor (Prompts.jsx) and tool editor
 * (SquadConfig.jsx). Accessibility: role="dialog", aria-modal, Esc close,
 * click-outside close, focus trap, body scroll lock. Zero dependencies.
 *
 * Props:
 *   open       — boolean
 *   onClose    — () => void
 *   title      — string (used as aria-label fallback)
 *   children   — modal body
 *   width      — optional CSS width (default: min(680px, 92vw))
 */
export default function Modal({ open, onClose, title, children, width }) {
  const overlayRef = useRef(null);
  const prevFocusRef = useRef(null);

  // Body scroll lock
  useEffect(() => {
    if (open) {
      prevFocusRef.current = document.activeElement;
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Esc key
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap + restore
  useEffect(() => {
    if (!open) {
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === 'function') {
        prevFocusRef.current.focus();
      }
      return;
    }
    // Focus first focusable element inside the modal
    const el = overlayRef.current;
    if (!el) return;
    const tid = setTimeout(() => {
      const focusable = el.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable) focusable.focus();
    }, 50);
    return () => clearTimeout(tid);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="modal"
        style={width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-h">{title}</div>
        {children}
      </div>
    </div>
  );
}

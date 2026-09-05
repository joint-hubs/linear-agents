// Role card for the Manager tactical board (FOC-225). Presentation only:
// a card carries configured facts and layout position — never execution
// semantics. All states render icon + text, never color alone.

import { COORDINATOR_KEY } from '../../manager/identity.js';

export const STATE_META = {
  configured: { cls: 'mgr-chip-ok', glyph: '✓', label: 'configured' },
  unconfigured: { cls: 'mgr-chip-neutral', glyph: '○', label: 'not configured' },
  unknown: { cls: 'mgr-chip-warn', glyph: '?', label: 'unknown model' },
};

export function StateChip({ state }) {
  const meta = STATE_META[state] || STATE_META.unknown;
  return (
    <span className={`mgr-chip ${meta.cls}`}>
      <span aria-hidden="true">{meta.glyph}</span> {meta.label}
    </span>
  );
}

export default function RoleCard({
  card,
  isCoordinator = false,
  selected = false,
  dragging = false,
  position,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
}) {
  const roleKey = card.key === COORDINATOR_KEY ? 'lead' : card.key;
  return (
    <div
      className={[
        'mgr-card',
        isCoordinator ? 'mgr-card-coordinator' : '',
        selected ? 'mgr-card-selected' : '',
        dragging ? 'mgr-card-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ left: `${position.x}%`, top: `${position.y}%` }}
      tabIndex={0}
      role="button"
      aria-label={`${isCoordinator ? 'coordinator' : 'role'} ${roleKey}, model ${
        card.model || 'not configured'
      }. Arrow keys move the card; Enter selects.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <div className="mgr-card-head">
        <span className="mgr-card-role">
          {roleKey}
          {isCoordinator && <span className="mgr-coord-tag">coordinator</span>}
        </span>
        <StateChip state={card.modelState} />
      </div>
      <div className="mgr-card-model">
        {card.model || <span className="mgr-card-nomodel">no model assigned</span>}
      </div>
      <div className="mgr-card-tools">{card.toolSummary.label}</div>
    </div>
  );
}

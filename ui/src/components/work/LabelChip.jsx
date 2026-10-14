// Linear label chip (Work board): the colour dot (only a validated hex colour
// is applied — ticketLabels already normalizes, this is belt and braces) plus
// the label name as text. A long name overflows into an ellipsis; its full
// text stays accessible through the title tooltip AND the visually-hidden
// span — the tooltip alone is not reachable by keyboard or assistive tech.
// No labels at all is the normal case: the caller simply renders nothing.

import { ticketLabels } from '../../workModel';
import './work-labels.css';

export default function LabelChip({ label }) {
  const l = ticketLabels([label])[0];
  if (!l) return null;
  return (
    <span className="wk-label-chip" title={l.name}>
      <span
        aria-hidden="true"
        className="wk-label-dot"
        style={l.color ? { background: l.color } : undefined}
      />
      <span className="wk-label-name" aria-hidden="true">
        {l.name}
      </span>
      <span className="wk-label-full">{l.name}</span>
    </span>
  );
}
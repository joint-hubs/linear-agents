// Inline-SVG chart primitives for the Analysis screen (FOC-397).
// Style contract, matching common.jsx and Ft.jsx's LossChart idiom:
// - no decoration, no animation, one scale per chart (never dual axis);
// - labels as text next to the marks, tabular numerals on every number;
// - colours come from CSS variables (hard-coded hex only as the fallback
//   inside var(--x, #hex)); status colour (warn/crit) is separate from
//   series colour and always paired with a text label;
// - responsive: charts measure their container (ResizeObserver) and draw
//   SVG at real pixel size, so text never scales/stretches;
// - empty / zero input renders a muted "no data" line; null values never
//   throw.

import { useEffect, useRef, useState } from 'react';
import { topN, fmtCompact, fmtInt } from './format';

// Series palette — categorical colours already defined by the theme (accent
// plus the squad colours). Index by position; a part keeps its colour even
// when the legend lists it.
const SERIES = [
  'var(--accent, #4f46e5)',
  'var(--run, #175cd3)',
  'var(--ok, #067647)',
  'var(--sq-plan, #a25bac)',
  'var(--sq-dev, #0b76d9)',
  'var(--sq-review, #bf5902)',
  'var(--sq-test, #067500)',
  'var(--sq-supervisor, #920858)',
];

const STATUS = {
  warn: { label: 'warning', color: 'var(--warn, #b54708)' },
  crit: { label: 'critical', color: 'var(--danger, #b42318)' },
};

// --- shared bits -----------------------------------------------------------

// Measure container width so SVG text renders at true pixel size and stays
// legible at any panel width (viewBox scaling would shrink glyphs).
function useWidth(fallback = 600) {
  const ref = useRef(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0] && entries[0].contentRect.width;
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function NoData() {
  return (
    <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
      no data
    </div>
  );
}

const TAB = { fontVariantNumeric: 'tabular-nums' };

function truncate(s, maxChars) {
  const str = String(s);
  return str.length > maxChars ? `${str.slice(0, Math.max(1, maxChars - 1))}…` : str;
}

// Rough per-char advance at fontSize 11 — only used to size label columns.
const CH = 6.2;

const validNum = (v) => typeof v === 'number' && Number.isFinite(v);

// --- HBarChart -------------------------------------------------------------

export function HBarChart({ rows, labelKey = 'label', valueKey, format, maxBars = 15, secondaryText }) {
  const [ref, w] = useWidth();
  const list = topN(Array.isArray(rows) ? rows : [], valueKey, maxBars, labelKey)
    .filter((r) => r && r[labelKey] != null && validNum(r[valueKey]));
  if (list.length === 0) return <NoData />;

  const fmt = format || fmtCompact;
  const fontSize = 11;
  const rowH = 20;
  const barH = 12;
  const padV = 6;
  const longest = Math.max(...list.map((r) => String(r[labelKey]).length));
  const labelW = Math.min(200, Math.max(90, Math.round(longest * CH) + 12));
  // Reserve room right of the longest possible bar for the value text
  // (placed just past the bar end, per "value right of the bar").
  const reserve = secondaryText ? 150 : 75;
  const trackL = labelW + 8;
  const trackW = Math.max(10, w - trackL - reserve);
  const max = Math.max(...list.map((r) => r[valueKey]));
  const h = list.length * rowH + padV * 2;

  return (
    <div ref={ref}>
      <svg width={w} height={h} role="img" aria-label="horizontal bar chart">
        {list.map((r, i) => {
          const v = r[valueKey];
          const bw = max > 0 ? Math.max(v / max, 0) * trackW : 0;
          const y = padV + i * rowH;
          const by = y + (rowH - barH) / 2;
          const label = truncate(r[labelKey], Math.floor(labelW / CH) - 1);
          const vx = trackL + bw + 6;
          const secondary = secondaryText ? secondaryText(r) : null;
          return (
            <g key={i}>
              <text x={labelW} y={y + rowH / 2 + fontSize / 2 - 1.5} textAnchor="end" fontSize={fontSize} fill="var(--text-2, #475467)" style={{ fontFamily: 'var(--mono, monospace)', fontSize: 10.5 }}>
                {label}
              </text>
              {v > 0 && (
                <rect x={trackL} y={by} width={bw} height={barH} rx="2" fill="var(--accent, #4f46e5)" />
              )}
              <text x={vx} y={y + rowH / 2 + fontSize / 2 - 1.5} fontSize={fontSize} fill="var(--text-2, #475467)" style={TAB}>
                {fmt(v)}
              </text>
              {secondary != null && (
                <text x={vx + 4 + String(fmt(v)).length * CH} y={y + rowH / 2 + fontSize / 2 - 2} fontSize={10} fill="var(--muted, #667085)">
                  {secondary}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// --- ColumnChart -----------------------------------------------------------

export function ColumnChart({ rows, labelKey = 'label', valueKey, format, height = 160 }) {
  const [ref, w] = useWidth();
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r[labelKey] != null && validNum(r[valueKey]),
  );
  if (list.length === 0) return <NoData />;

  const fmt = format || fmtCompact;
  const padL = 8;
  const padB = 18;
  const padT = 14;
  const n = list.length;
  const max = Math.max(...list.map((r) => r[valueKey]));
  const innerW = Math.max(10, w - padL * 2);
  const innerH = Math.max(10, height - padB - padT);
  const slot = innerW / n;
  const barW = Math.min(slot * 0.7, 28);
  const baseY = padT + innerH;
  // Thin x labels when the slot would be narrower than the text.
  const labelStep = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 64))));

  return (
    <div ref={ref}>
      <svg width={w} height={height} role="img" aria-label="column chart">
        {/* baseline + y max label only — one scale, no grid noise */}
        <line x1={padL} y1={baseY} x2={w - padL} y2={baseY} stroke="var(--border, #e7eaf0)" />
        <text x={4} y={padT - 3} fontSize="10" fill="var(--muted, #667085)" style={TAB}>
          {fmt(max)}
        </text>
        {list.map((r, i) => {
          const v = r[valueKey];
          const bh = max > 0 ? (v / max) * innerH : 0;
          const cx = padL + slot * i + slot / 2;
          return (
            <g key={i}>
              {v > 0 && (
                <rect x={cx - barW / 2} y={baseY - bh} width={barW} height={bh} rx="2" fill="var(--accent, #4f46e5)" />
              )}
              {i % labelStep === 0 && (
                <text x={cx} y={baseY + 12} textAnchor="middle" fontSize="10" fill="var(--muted, #667085)">
                  {truncate(r[labelKey], Math.floor(slot / CH))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// --- StackedBar ------------------------------------------------------------

// One 100% bar, segments in series colours; parts wide enough get "label
// share%" inline, the rest are named in the legend line below. No axes —
// the shares are the only scale.
export function StackedBar({ parts, format }) {
  const [ref, w] = useWidth();
  const list = (Array.isArray(parts) ? parts : []).filter(
    (p) => p && p.label != null && validNum(p.value),
  );
  const total = list.reduce((s, p) => s + p.value, 0);
  if (list.length === 0 || total <= 0) return <NoData />;

  const fmtPctLocal = (v) => {
    let s = ((v / total) * 100).toFixed(1);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return `${s}%`;
  };
  const fmt = format || fmtPctLocal;
  const h = 24;
  const legend = [];
  let x = 0;
  const segs = list.map((p, i) => {
    const segW = (p.value / total) * w;
    const text = `${p.label} ${fmtPctLocal(p.value)}`;
    const fits = segW >= text.length * CH + 12;
    const seg = { ...p, x, w: segW, color: SERIES[i % SERIES.length], text, fits };
    if (!fits) legend.push(seg);
    x += segW;
    return seg;
  });

  return (
    <div ref={ref}>
      <svg width={w} height={h} role="img" aria-label="100% stacked bar">
        {segs.map((s, i) => (
          <g key={i}>
            <rect x={s.x} y={0} width={Math.max(s.w, 0)} height={h} fill={s.color} />
            {s.fits && (
              <text x={s.x + s.w / 2} y={h / 2 + 4} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="var(--accent-contrast, #ffffff)">
                {s.text}
              </text>
            )}
          </g>
        ))}
      </svg>
      {legend.length > 0 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, color: 'var(--muted, #667085)' }}>
          {legend.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span style={TAB}>{s.text}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Histogram -------------------------------------------------------------

// buckets[i] counts the bin whose bounds are edges[i]..edges[i+1] (as
// strings, e.g. "[0,.2)"). Fixed small bars, count above, edge label below.
export function Histogram({ buckets, edges }) {
  const [ref, w] = useWidth();
  const counts = (Array.isArray(buckets) ? buckets : []).map((v) => (validNum(v) ? v : 0));
  const total = counts.reduce((s, v) => s + v, 0);
  if (counts.length === 0 || total === 0) return <NoData />;

  const labels = Array.isArray(edges) ? edges.map(String) : [];
  const h = 110;
  const padB = 16;
  const padT = 14;
  const innerH = h - padB - padT;
  const n = counts.length;
  const slot = w / n;
  const barW = Math.min(slot * 0.7, 40);
  const max = Math.max(...counts);
  const edgeStep = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(w / 56))));

  return (
    <div ref={ref}>
      <svg width={w} height={h} role="img" aria-label="histogram">
        <line x1={0} y1={h - padB} x2={w} y2={h - padB} stroke="var(--border, #e7eaf0)" />
        {counts.map((c, i) => {
          const bh = max > 0 ? (c / max) * innerH : 0;
          const cx = slot * i + slot / 2;
          return (
            <g key={i}>
              {c > 0 && (
                <rect x={cx - barW / 2} y={h - padB - bh} width={barW} height={bh} rx="2" fill="var(--accent, #4f46e5)" />
              )}
              <text x={cx} y={h - padB - bh - 4} textAnchor="middle" fontSize="10" fill="var(--text-2, #475467)" style={TAB}>
                {fmtInt(c)}
              </text>
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % edgeStep === 0 || i === labels.length - 1 ? (
            <text key={i} x={Math.min(Math.max(slot * i, 12), w - 12)} y={h - 3} textAnchor="middle" fontSize="9.5" fill="var(--muted, #667085)" style={{ fontFamily: 'var(--mono, monospace)' }}>
              {l}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// --- KpiTiles --------------------------------------------------------------

// Compact tile row. A status colours the LEFT BORDER only and always pairs
// with its text label ("warning" / "critical") — never colour alone.
export function KpiTiles({ items }) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (list.length === 0) return <NoData />;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {list.map((it, i) => {
        const st = STATUS[it && it.status] || null;
        return (
          <div
            key={i}
            style={{
              flex: '1 1 140px',
              minWidth: 140,
              background: 'var(--surface, #ffffff)',
              border: '1px solid var(--border, #e7eaf0)',
              borderLeft: st ? `3px solid ${st.color}` : undefined,
              borderRadius: 8,
              padding: '10px 12px',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted, #667085)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {it.label != null ? it.label : '—'}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: 20, fontWeight: 650, lineHeight: 1.2, color: st ? st.color : 'var(--text, #101828)', ...TAB }}>
                {it.value != null ? it.value : '—'}
              </span>
              {st && (
                <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: st.color }}>
                  {st.label}
                </span>
              )}
            </div>
            {it.hint != null && (
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {it.hint}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- ShareBar --------------------------------------------------------------

// Tiny 0–1 inline bar for table cells. Null / non-finite renders as a muted
// dash, matching DataTable's unpriced em dash.
export function ShareBar({ value }) {
  if (!validNum(value)) return <span className="muted">—</span>;
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      width="72"
      height="8"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
      role="img"
      aria-label={`${Math.round(v * 100)}%`}
    >
      <rect x="0" y="0" width="100" height="8" rx="2" fill="var(--surface-2, #f1f3f6)" />
      {v > 0 && <rect x="0" y="0" width={v * 100} height="8" rx="2" fill="var(--accent, #4f46e5)" />}
    </svg>
  );
}

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRuns } from '../api';
import { linearUrl } from '../config';
import { fmtUSD, elapsed, statusLabel, modelMix } from '../utils';

const POLL_MS = 5000;

// Fixed squad palette (ux-design-v3 §3.2).
const SQCOLOR = {
  plan: '#5e5ce6',
  dev: '#0071e3',
  review: '#ff9500',
  test: '#34c759',
  cadence: '#6e6e73',
};
const SQUADS = ['plan', 'dev', 'review', 'test', 'cadence'];
const ZOOMS = [
  { h: 24, label: 'Day' },
  { h: 72, label: '3d' },
  { h: 168, label: 'Week' },
];
const PAN_FRAC = 0.2; // pan shifts the window by 20% of its span

function topModel(run) {
  const mix = modelMix(run.byModel || {});
  return mix.length ? mix[0].slug : '—';
}

function ErrorBanner({ message }) {
  return (
    <div className="api-banner" role="alert">
      <span>⚠ Telemetry server unreachable: {message}. Retrying…</span>
    </div>
  );
}

function TaskLink({ taskId }) {
  if (!taskId) return <span className="chip">(untagged)</span>;
  const url = linearUrl(taskId);
  if (url)
    return (
      <a className="link" href={url} target="_blank" rel="noopener noreferrer">
        {taskId} ↗
      </a>
    );
  return <span>{taskId}</span>;
}

export default function Timeline() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(new Date());
  const [zoomH, setZoomH] = useState(72); // default 3-day window
  const [panMs, setPanMs] = useState(0); // 0 → window auto-positions to end at now
  const [squads, setSquads] = useState(() =>
    Object.fromEntries(SQUADS.map((s) => [s, true]))
  );
  const [hover, setHover] = useState(null); // { run, x, y }
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const tick = () =>
      getRuns()
        .then((d) => {
          if (!alive) return;
          setRuns(d);
          setError(null);
          setLastUpdated(new Date());
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message || String(e));
        });
    tick();
    const id = setInterval(() => {
      setNow(new Date());
      tick();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const winMs = zoomH * 3600e3;
  const nowTs = now.getTime();
  const end = nowTs + winMs * 0.04 + panMs;
  const start = end - winMs;
  const span = end - start || 1;
  const pct = (t) => ((t - start) / span) * 100;

  const onZoom = (h) => {
    setZoomH(h);
    setPanMs(0); // zoom reset re-centers on now
  };

  // Group visible runs by taskId; null → '(untagged)' row pinned to the bottom.
  const visible = runs.filter((r) => squads[r.squad]);
  const groups = {};
  for (const r of visible) {
    const k = r.taskId || '(untagged)';
    (groups[k] = groups[k] || []).push(r);
  }
  const recent = (list) =>
    Math.max(...list.map((r) => new Date(r.endedAt || nowTs).getTime()));
  const rows = Object.entries(groups)
    .filter(([k]) => k !== '(untagged)')
    .sort((a, b) => recent(b[1]) - recent(a[1]));
  if (groups['(untagged)']) rows.push(['(untagged)', groups['(untagged)']]);

  // Axis ticks: per 6 h on a Day window, per day otherwise.
  const stepMs = zoomH <= 24 ? 6 * 3600e3 : 24 * 3600e3;
  const ticks = [];
  for (let t = Math.ceil(start / stepMs) * stepMs; t < end; t += stepMs) {
    const d = new Date(t);
    const label =
      zoomH <= 24
        ? String(d.getHours()).padStart(2, '0') + ':00'
        : d.getMonth() + 1 + '/' + d.getDate();
    ticks.push({ t, label });
  }

  const nowPct = pct(nowTs);
  const nowVisible = nowPct >= 0 && nowPct <= 100;

  const barFor = (r) => {
    const s = new Date(r.startedAt).getTime();
    const e = new Date(r.endedAt || nowTs).getTime();
    if (e <= start || s >= end) return null; // no intersection with window
    const left = Math.max(0, pct(s));
    const right = Math.min(100, pct(e));
    const width = Math.max(0.5, right - left);
    const st = statusLabel(r);
    return { left, width, st, run: r };
  };

  return (
    <div className="page">
      <div className="page-title">Timeline</div>
      <div className="page-sub">Agent activity per task · bars = runs, color = squad</div>

      {error && !(runs && runs.length > 0) && (
        <div className="card api-down">
          <div className="card-h">Telemetry server unreachable</div>
          <div>
            Start it: <code>node scripts/telemetry-server.mjs</code>
          </div>
        </div>
      )}

      {(!error || (runs && runs.length > 0)) && (
        <>
          {error && <ErrorBanner message={error} />}
          <div className="tl-controls">
            {ZOOMS.map((z) => (
              <button
                key={z.h}
                className={'zbtn' + (zoomH === z.h ? ' on' : '')}
                onClick={() => onZoom(z.h)}
              >
                {z.label}
              </button>
            ))}
            <button className="zbtn" onClick={() => setPanMs((p) => p - winMs * PAN_FRAC)} title="pan earlier">
              ◀
            </button>
            <button className="zbtn" onClick={() => setPanMs((p) => p + winMs * PAN_FRAC)} title="pan later">
              ▶
            </button>
            {panMs !== 0 && (
              <button className="zbtn" onClick={() => setPanMs(0)} title="recenter on now">
                ↻ now
              </button>
            )}
            <div className="sqf">
              {SQUADS.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    checked={!!squads[s]}
                    onChange={() => setSquads((prev) => ({ ...prev, [s]: !prev[s] }))}
                  />
                  <span className="swatch" style={{ background: SQCOLOR[s] }} />
                  {s}
                </label>
              ))}
            </div>
          </div>

          {rows.length === 0 && <div className="empty">No runs in window.</div>}

          {rows.length > 0 && (
            <div className="tl">
              <div className="tl-axis">
                <div className="tl-label">task</div>
                <div className="tl-track">
                  {ticks.map((tk) => (
                    <div className="tl-tick" key={tk.t} style={{ left: pct(tk.t) + '%' }}>
                      {tk.label}
                    </div>
                  ))}
                  {nowVisible && <div className="nowline" style={{ left: nowPct + '%' }} />}
                </div>
              </div>

              {rows.map(([task, list]) => {
                const anyEnded = list.some((r) => r.endedAt);
                const total = list.reduce((s, r) => s + (r.totals?.costUSD || 0), 0);
                const repos = [...new Set(list.map((r) => r.repo).filter(Boolean))];
                const bars = list
                  .map(barFor)
                  .filter(Boolean);
                return (
                  <div className="tl-row" key={task}>
                    <div className="tl-rowlabel">
                      <TaskLink taskId={task === '(untagged)' ? null : task} />
                      <div className="cost">
                        {anyEnded ? fmtUSD(total) : '…'}
                        {repos.map((rp) => (
                          <span className="chip" key={rp} style={{ marginLeft: 6 }}>
                            {rp}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="tl-track">
                      {bars.map((b) => (
                        <div
                          key={b.run.runId}
                          className={
                            'bar' +
                            (b.st === 'running' ? ' live' : '') +
                            (b.st === 'failed' ? ' fail' : '')
                          }
                          style={{
                            left: b.left + '%',
                            width: b.width + '%',
                            minWidth: 4,
                            background: SQCOLOR[b.run.squad] || '#6e6e73',
                          }}
                          onMouseMove={(e) =>
                            setHover({ run: b.run, x: e.clientX, y: e.clientY })
                          }
                          onMouseLeave={() => setHover(null)}
                          onClick={() => navigate('/runs/' + b.run.runId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate('/runs/' + b.run.runId);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`${b.run.taskId || 'untagged'} — ${fmtUSD(b.run.totals?.costUSD || 0)} — ${b.run.squad || '—'}`}
                        />
                      ))}
                      {nowVisible && <div className="nowline" style={{ left: nowPct + '%' }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="legend">
            {SQUADS.map((s) => (
              <span key={s}>
                <span className="swatch" style={{ background: SQCOLOR[s] }} /> {s}
              </span>
            ))}
            <span>▮ pulsing = running</span>
            <span style={{ color: 'var(--danger)' }}>▏red edge = failed</span>
          </div>

          <div className="muted" style={{ marginTop: 16 }}>
            updated {lastUpdated ? lastUpdated.toLocaleTimeString('en-US', { hour12: false }) : '—'}
          </div>
        </>
      )}

      {hover && (
        <div
          className="tl-tip"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <div className="tl-tip-id">{hover.run.runId}</div>
          <div>
            {hover.run.squad || '—'} · {elapsed(hover.run.startedAt, hover.run.endedAt)} · {statusLabel(hover.run)}
          </div>
          <div>
            {fmtUSD(hover.run.totals?.costUSD || 0)} · {topModel(hover.run)}
          </div>
        </div>
      )}
    </div>
  );
}

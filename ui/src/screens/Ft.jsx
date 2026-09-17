import { useState, useEffect, useCallback, useRef } from 'react';
import { getFtDatasets, getFtRuns, getFtRun, postFtTrain, postFtStop } from '../api';
import { fmtDateTime } from '../utils';
import './ft.css';

const DEFAULTS = {
  baseModel: 'Qwen/Qwen3-1.7B', epochs: 3, lr: 0.0002, batchSize: 2, gradAccum: 4,
  seqLen: 4096, loraR: 16, loraAlpha: 32, warmupRatio: 0.03, seed: 3407,
};

const NUM = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Minimal inline SVG loss curve — no chart lib.
function LossChart({ metrics }) {
  if (!metrics || metrics.length === 0) return <div className="ft-empty">No metrics yet.</div>;
  const w = 600, h = 160, pad = 28;
  const losses = metrics.map((m) => m.loss).filter((x) => x != null);
  if (losses.length === 0) return <div className="ft-empty">No loss points yet.</div>;
  const xs = metrics.map((m) => m.step).filter((s) => s != null);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...losses), yMax = Math.max(...losses);
  const sx = (x) => pad + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - 2 * pad);
  const sy = (y) => h - pad - ((y - yMin) / Math.max(0.001, yMax - yMin)) * (h - 2 * pad);
  const pts = metrics.filter((m) => m.loss != null && m.step != null)
    .map((m) => `${sx(m.step).toFixed(1)},${sy(m.loss).toFixed(1)}`).join(' ');
  const evalPts = metrics.filter((m) => m.eval_loss != null && m.step != null);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="var(--border)" />
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--border)" />
      <text x={4} y={pad + 4} fontSize="10" fill="var(--muted)">{yMax.toFixed(2)}</text>
      <text x={4} y={h - pad} fontSize="10" fill="var(--muted)">{yMin.toFixed(2)}</text>
      <text x={pad} y={h - 6} fontSize="10" fill="var(--muted)">{xMin}</text>
      <text x={w - pad - 14} y={h - 6} fontSize="10" fill="var(--muted)">{xMax}</text>
      <polyline points={pts} fill="none" stroke="#2d6a4f" strokeWidth="1.5" />
      {evalPts.map((m, i) => <circle key={i} cx={sx(m.step)} cy={sy(m.eval_loss)} r="2.5" fill="#b5651d" />)}
    </svg>
  );
}

export default function Ft() {
  const [datasets, setDatasets] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const logRef = useRef(null);

  const refreshDatasets = useCallback(() => {
    getFtDatasets().then(setDatasets).catch((e) => setMsg({ kind: 'err', text: String(e.message || e) }));
  }, []);

  const refreshRuns = useCallback(() => {
    getFtRuns().then((r) => { setRuns(r); }).catch(() => {});
  }, []);

  useEffect(() => {
    refreshDatasets(); refreshRuns();
    const id = setInterval(refreshRuns, 5000);
    return () => clearInterval(id);
  }, [refreshDatasets, refreshRuns]);

  // Poll detail when a run is selected (and while it's running).
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true;
    const poll = () => getFtRun(selected).then((d) => { if (active) { setDetail(d); if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; } }).catch(() => {});
    poll();
    const id = setInterval(poll, 4000);
    return () => { active = false; clearInterval(id); };
  }, [selected]);

  const launch = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await postFtTrain(form);
      setMsg({ kind: 'ok', text: `Launched ${r.id} (pid ${r.pid})` });
      setSelected(r.id);
      refreshRuns();
    } catch (e) { setMsg({ kind: 'err', text: e.message || String(e) }); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    if (!selected) return;
    try { await postFtStop(selected); setMsg({ kind: 'ok', text: 'Stop signal sent.' }); refreshRuns(); }
    catch (e) { setMsg({ kind: 'err', text: e.message || String(e) }); }
  };

  const train = datasets && datasets.find((d) => d.name === 'train.jsonl');
  const liveRun = runs.find((r) => r.id === selected && r.alive);

  return (
    <div className="page ft">
      <div className="page-title">Fine-tune</div>
      <div className="page-sub">Verdict-parser pilot · FOC-359 · Qwen3-1.7B QLoRA</div>

      {msg && <div className={msg.kind === 'ok' ? 'badge badge-ok' : 'badge badge-fail'} style={{ alignSelf: 'flex-start' }}>{msg.text}</div>}

      <div className="ft-cols">
        {/* LEFT: datasets + launch form */}
        <div className="ft-section">
          <div className="ft-section-title">Datasets</div>
          {!datasets && <div className="ft-empty">Loading…</div>}
          {datasets && datasets.length === 0 && <div className="ft-empty">No datasets. Run <code>node ft/verdict-parse/export-dataset.mjs</code>.</div>}
          {datasets && datasets.map((d) => (
            <div className="ft-ds" key={d.name}>
              <div className="ft-ds-name">{d.name}</div>
              <div className="ft-ds-meta">{d.pairs} pairs · pass {d.dist.pass} / fail {d.dist.fail} · {Math.round(d.bytes / 1024)} KB · {fmtDateTime(d.mtime)}</div>
              {d.sample && (
                <div className="ft-ds-sample">
                  <div>input: {String(d.sample.inputHead).slice(0, 300)}…</div>
                  <div className="out">output: {JSON.stringify(d.sample.output).slice(0, 200)}…</div>
                </div>
              )}
            </div>
          ))}

          <div className="ft-section-title" style={{ marginTop: 16 }}>Launch training</div>
          <div className="ft-form ft-ds">
            <div className="ft-field"><label>Base model</label><input value={form.baseModel} onChange={(e) => setForm({ ...form, baseModel: e.target.value })} /></div>
            <div className="ft-field"><label>Epochs</label><input type="number" step="0.5" value={form.epochs} onChange={(e) => setForm({ ...form, epochs: NUM(e.target.value, 3) })} /></div>
            <div className="ft-field"><label>Learning rate</label><input type="number" step="0.00001" value={form.lr} onChange={(e) => setForm({ ...form, lr: NUM(e.target.value, 2e-4) })} /></div>
            <div className="ft-field"><label>Batch size</label><input type="number" value={form.batchSize} onChange={(e) => setForm({ ...form, batchSize: NUM(e.target.value, 2) })} /></div>
            <div className="ft-field"><label>Grad accum</label><input type="number" value={form.gradAccum} onChange={(e) => setForm({ ...form, gradAccum: NUM(e.target.value, 4) })} /></div>
            <div className="ft-field"><label>Seq length</label><input type="number" step="256" value={form.seqLen} onChange={(e) => setForm({ ...form, seqLen: NUM(e.target.value, 4096) })} /></div>
            <div className="ft-field"><label>LoRA r</label><input type="number" value={form.loraR} onChange={(e) => setForm({ ...form, loraR: NUM(e.target.value, 16) })} /></div>
            <div className="ft-field"><label>LoRA alpha</label><input type="number" value={form.loraAlpha} onChange={(e) => setForm({ ...form, loraAlpha: NUM(e.target.value, 32) })} /></div>
          </div>
          <div className="ft-actions">
            <button className="ft-btn ft-btn-primary" disabled={busy || !train} onClick={launch}>{busy ? 'Launching…' : 'Launch'}</button>
            {!train && <span className="muted" style={{ fontSize: 12 }}>train.jsonl missing</span>}
          </div>
        </div>

        {/* RIGHT: runs list + detail */}
        <div className="ft-section">
          <div className="ft-section-title">Runs</div>
          {runs.length === 0 && <div className="ft-empty">No training runs yet.</div>}
          {runs.length > 0 && (
            <table className="table">
              <thead><tr className="th"><td>Started</td><td>Status</td><td>Loss</td><td>Step</td></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={'row td ft-run-row' + (r.id === selected ? ' sel' : '')} onClick={() => setSelected(r.id)}>
                    <td className="td">{fmtDateTime(new Date(r.startedAt * 1000).toISOString())}</td>
                    <td className="td"><span className={'badge ' + (r.alive ? 'badge-run' : (r.status === 'done' ? 'badge-ok' : (r.status === 'failed' ? 'badge-fail' : 'badge-warn')))}>{r.alive ? 'running' : r.status}</span></td>
                    <td className="td">{r.lastLoss != null ? r.lastLoss.toFixed(3) : '—'}</td>
                    <td className="td">{r.lastStep ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail && (
            <div className="ft-section">
              <div className="ft-section-title" style={{ marginTop: 8 }}>Detail · {detail.id}</div>
              <div className="ft-ds">
                <div className="ft-ds-meta">
                  {detail.config && <>base {detail.config.base_model} · {detail.config.epochs}ep · lr {detail.config.lr} · bs {detail.config.batch_size}×{detail.config.grad_accum}</>}
                  {' · '}<span className={'badge ' + (detail.alive ? 'badge-run' : (detail.status === 'done' ? 'badge-ok' : 'badge-fail'))}>{detail.alive ? 'running' : detail.status}</span>
                  {detail.hasAdapter && ' · adapter saved'}
                </div>
                <div className="ft-loss"><LossChart metrics={detail.metrics || []} /></div>
                <div className="ft-actions">
                  {liveRun && <button className="ft-btn" onClick={stop}>Stop</button>}
                  {detail.hasAdapter && <span className="muted" style={{ fontSize: 12 }}>adapter at ft/verdict-parse/runs/{detail.id}/adapter/</span>}
                </div>
              </div>
              <div className="ft-section-title" style={{ marginTop: 8 }}>Log (tail)</div>
              <div className="ft-log" ref={logRef}>{detail.logTail || '(empty)'}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// scripts/ft.mjs — fine-tuning control-plane logic (no HTTP; testable).
//
// Lists datasets and training runs, spawns training (detached python train.py),
// tails logs, and stops a run. All state lives on disk under ft/verdict-parse/
// (runs/<id>/{config.json, metrics.jsonl, train.log, adapter/, status.json}),
// so a server restart loses nothing — it re-reads the files.
//
// Spawned training is a DETACHED process that survives the server: we write
// the PID into status.json (train.py does this), and liveness is re-checked
// via terminals.mjs isProcessAlive on each read.
import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, stopByPid } from './terminals.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, '..');
export const FT_ROOT = join(REPO, 'ft', 'verdict-parse');
export const DATA_DIR = join(FT_ROOT, 'data');
export const RUNS_DIR = join(FT_ROOT, 'runs');
export const TRAIN_PY = join(FT_ROOT, 'train.py');

// ---------- datasets ----------
export async function listDatasets() {
  const out = [];
  if (!existsSync(DATA_DIR)) return out;
  for (const name of (await readdir(DATA_DIR)).filter((n) => n.endsWith('.jsonl')).sort()) {
    const p = join(DATA_DIR, name);
    const st = await stat(p);
    const lines = (await readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
    let first = null, sample = null;
    if (lines.length) {
      try {
        first = JSON.parse(lines[0]);
        sample = { inputHead: String(first.input || '').slice(0, 400), output: first.output, _src: first._src, _verdict: first._verdict };
      } catch { /* malformed */ }
    }
    const dist = { pass: 0, fail: 0 };
    for (const l of lines) { try { const j = JSON.parse(l); if (j._verdict) dist[j._verdict]++; } catch {} }
    out.push({ name, path: p, bytes: st.size, pairs: lines.length, dist, mtime: st.mtime.toISOString(), sample });
  }
  return out;
}

// ---------- runs ----------
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

export async function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  const out = [];
  for (const name of (await readdir(RUNS_DIR))) {
    const dir = join(RUNS_DIR, name);
    let st; try { st = await stat(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const status = await readJson(join(dir, 'status.json'));
    const config = await readJson(join(dir, 'config.json'));
    let metricsTail = [];
    try { const m = (await readFile(join(dir, 'metrics.jsonl'), 'utf8')).trim().split('\n').filter(Boolean); metricsTail = m.slice(-3).map((l) => JSON.parse(l)); } catch {}
    let lastLoss = null, lastStep = null;
    if (metricsTail.length) { lastLoss = metricsTail[metricsTail.length - 1].loss; lastStep = metricsTail[metricsTail.length - 1].step; }
    let alive = false;
    if (status && status.status === 'running' && status.pid) alive = isProcessAlive(status.pid);
    out.push({
      id: name, status: status ? status.status : 'unknown', alive,
      pid: status && status.pid, startedAt: status && status.startedAt,
      finishedAt: status && status.finishedAt, elapsedSec: status && status.elapsedSec,
      message: status && status.message, baseModel: config && config.base_model,
      epochs: config && config.epochs, lr: config && config.lr,
      lastLoss, lastStep, mtime: st.mtime.toISOString(),
    });
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function getRun(id) {
  const dir = join(RUNS_DIR, id);
  if (!existsSync(dir)) return { error: 'run not found' };
  const status = await readJson(join(dir, 'status.json'));
  const config = await readJson(join(dir, 'config.json'));
  let metrics = [];
  try { metrics = (await readFile(join(dir, 'metrics.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  let logTail = '';
  try { logTail = (await readFile(join(dir, 'train.log'), 'utf8')).slice(-8000); } catch {}
  let alive = false;
  if (status && status.status === 'running' && status.pid) alive = isProcessAlive(status.pid);
  const hasAdapter = existsSync(join(dir, 'adapter', 'adapter_model.safetensors'));
  return { id, status: status ? status.status : 'unknown', alive, config, metrics, logTail, hasAdapter, ...status };
}

// ---------- launch ----------
const DEFAULTS = {
  baseModel: 'Qwen/Qwen3-1.7B', epochs: 3.0, lr: 2e-4, batchSize: 2, gradAccum: 4,
  seqLen: 4096, loraR: 16, loraAlpha: 32, warmupRatio: 0.03, seed: 3407,
};

export function validateTrain(body) {
  if (!body || typeof body !== 'object') return { ok: false, status: 400, error: 'body required' };
  const b = { ...DEFAULTS, ...body };
  const num = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi && !Number.isNaN(v);
  if (!num(b.epochs, 0.01, 100)) return { ok: false, status: 400, error: 'epochs must be a number in [0.01, 100]' };
  if (!num(b.lr, 1e-7, 1)) return { ok: false, status: 400, error: 'lr must be a number in [1e-7, 1]' };
  if (!num(b.batchSize, 1, 16)) return { ok: false, status: 400, error: 'batchSize must be in [1, 16]' };
  if (!num(b.gradAccum, 1, 32)) return { ok: false, status: 400, error: 'gradAccum must be in [1, 32]' };
  if (!num(b.seqLen, 256, 8192)) return { ok: false, status: 400, error: 'seqLen must be in [256, 8192]' };
  if (!num(b.loraR, 1, 256)) return { ok: false, status: 400, error: 'loraR must be in [1, 256]' };
  if (!num(b.loraAlpha, 1, 512)) return { ok: false, status: 400, error: 'loraAlpha must be in [1, 512]' };
  if (typeof b.baseModel !== 'string' || !b.baseModel) return { ok: false, status: 400, error: 'baseModel must be a string' };
  return { ok: true, value: b };
}

export async function launchTrain(body, opts = {}) {
  const v = validateTrain(body);
  if (!v.ok) return { ok: false, status: v.status, error: v.error };
  const b = v.value;
  await mkdir(RUNS_DIR, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(RUNS_DIR, id);
  await mkdir(runDir, { recursive: true });
  const args = [
    TRAIN_PY,
    '--data-dir', DATA_DIR,
    '--run-dir', runDir,
    '--base-model', String(b.baseModel),
    '--epochs', String(b.epochs),
    '--lr', String(b.lr),
    '--batch-size', String(b.batchSize),
    '--grad-accum', String(b.gradAccum),
    '--seq-len', String(b.seqLen),
    '--lora-r', String(b.loraR),
    '--lora-alpha', String(b.loraAlpha),
    '--warmup-ratio', String(b.warmupRatio),
    '--seed', String(b.seed),
  ];
  const py = opts.python || 'python';
  const child = spawn(py, args, { detached: true, stdio: 'ignore', cwd: REPO, windowsHide: false });
  child.unref();
  return { ok: true, id, pid: child.pid, runDir };
}

// ---------- stop ----------
export async function stopRun(id) {
  const dir = join(RUNS_DIR, id);
  const status = await readJson(join(dir, 'status.json'));
  if (!status) return { ok: false, status: 404, error: 'run not found' };
  if (status.status !== 'running') return { ok: false, status: 409, error: 'run not running (status=' + status.status + ')' };
  if (!status.pid) return { ok: false, status: 409, error: 'no pid recorded' };
  if (!isProcessAlive(status.pid)) return { ok: false, status: 409, error: 'process already gone' };
  await stopByPid(status.pid);
  return { ok: true, pid: status.pid };
}

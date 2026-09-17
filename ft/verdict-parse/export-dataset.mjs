#!/usr/bin/env node
// W1 — Dataset export for the verdict-parser FT pilot (FOC-359).
//
// Walks every recorded supervisor verdict, joins it with the review child's
// final assistant text (the "odprawa" STATUS block), validates the output
// against the frozen schema (PRD §3.2 = supervisor-verdict.mjs guards), and
// writes a stratified 80/20 train/eval split to JSONL.
//
// Pair shape (PRD §3.3 / §3.4):
//   input  = diff-stats prefix + review child's final assistant text
//   output = { verdict, findings[], acMapping[], fingerprint: { failingTests } }
// The runtime-filled fields (declaredAcs, fingerprint.{diff,tests,combined,
// changedFiles,error}) are STRIPPED from the target — the model does not see
// the worktree and cannot predict them. failingTests is model-drafted then
// runtime-validated (§10.2), so it stays in the target.
//
// Read-only on .state/supervisor/; writes only to ft/verdict-parse/data/.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/mateu/Documents/GitHub/linear-agents';
const SUP = path.join(ROOT, '.state/supervisor');
const OUTDIR = path.join(ROOT, 'ft/verdict-parse/data');

// ---------- schema guards (frozen from supervisor-verdict.mjs:90-105) ----------
const VERDICTS = ['pass', 'fail'];
const SEVERITIES = ['issue', 'todo', 'nit', 'question', 'praise'];
const NON_EVIDENCE = ['', '-', '--', 'n/a', 'na', 'none', 'todo', 'tbd', '?', 'see above', 'obvious'];
const isEvidence = (s) => {
  const t = String(s ?? '').trim();
  return t.length >= 4 && !NON_EVIDENCE.includes(t.toLowerCase());
};

// ---------- walk ----------
const walk = (dir, pred, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, acc);
    else if (pred(e.name, p)) acc.push(p);
  }
  return acc;
};

// ---------- last assistant text from a review child tee (from census.mjs:78-93) ----------
const lastAssistantText = (teePath) => {
  if (!fs.existsSync(teePath)) return null;
  let last = null;
  for (const line of fs.readFileSync(teePath, 'utf8').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.type === 'assistant') last = j;
    } catch { /* partial line */ }
  }
  if (!last) return null;
  const c = last.message && last.message.content;
  return Array.isArray(c)
    ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    : typeof c === 'string' ? c : '';
};

// ---------- output projection: keep model fields, strip runtime-filled ----------
const projectOutput = (v) => {
  const failingTests = v.fingerprint && Array.isArray(v.fingerprint.failingTests)
    ? v.fingerprint.failingTests
    : [];
  return {
    verdict: v.verdict,
    findings: (v.findings || []).map((f) => ({
      severity: f.severity,
      text: f.text,
      evidence: f.evidence,
    })),
    acMapping: (v.acMapping || v.acs || v.acceptanceCriteria || []).map((a) => ({
      ac: a.ac,
      evidence: a.evidence,
    })),
    fingerprint: { failingTests },
  };
};

// ---------- schema-validate a projected output ----------
const validate = (out, src) => {
  const errs = [];
  if (!VERDICTS.includes(out.verdict)) errs.push(`verdict "${out.verdict}" not in ${JSON.stringify(VERDICTS)}`);
  if (!Array.isArray(out.findings)) errs.push('findings not array');
  else for (const f of out.findings) {
    if (!SEVERITIES.includes(f.severity)) errs.push(`finding severity "${f.severity}" not in ${JSON.stringify(SEVERITIES)}`);
    if (!String(f.text || '').trim()) errs.push('finding text empty');
    if (!isEvidence(f.evidence)) errs.push(`finding evidence not evidence: "${f.evidence}"`);
  }
  if (!Array.isArray(out.acMapping)) errs.push('acMapping not array');
  else for (const a of out.acMapping) {
    if (!String(a.ac || '').trim()) errs.push('acMapping ac empty');
    if (!isEvidence(a.evidence)) errs.push(`acMapping evidence not evidence: "${a.evidence}"`);
  }
  if (!Array.isArray(out.fingerprint.failingTests)) errs.push('failingTests not array');
  return errs;
};

// ---------- collect pairs ----------
const verdictFiles = walk(SUP, (n, p) => n.endsWith('.json') && p.includes(path.sep + 'verdicts' + path.sep));
const pairs = [];
const dropped = [];
const teeCache = new Map();
for (const vp of verdictFiles) {
  let v; try { v = JSON.parse(fs.readFileSync(vp, 'utf8')); } catch { dropped.push({ vp, reason: 'verdict-parse-err' }); continue; }
  const childId = v.childId;
  const runId = v.runId;
  if (!childId || !runId) { dropped.push({ vp, reason: 'no-childId/runId' }); continue; }
  const key = runId + '|' + childId;
  let txt;
  if (teeCache.has(key)) txt = teeCache.get(key);
  else { txt = lastAssistantText(path.join(SUP, runId, 'children', childId + '.jsonl')); teeCache.set(key, txt); }
  if (txt === null) { dropped.push({ vp, reason: 'no-tee' }); continue; }
  if (!txt.trim()) { dropped.push({ vp, reason: 'tee-no-assistant-text' }); continue; }

  const src = `${v.taskId}-round${v.round}@${runId}`;
  const out = projectOutput(v);
  const errs = validate(out, src);
  if (errs.length) { dropped.push({ vp, src, reason: 'schema-invalid', errs }); continue; }

  const changedFiles = v.fingerprint && v.fingerprint.changedFiles != null ? v.fingerprint.changedFiles : '?';
  const input = `diff-stats: changedFiles=${changedFiles}\n${txt}`;
  pairs.push({ src, verdict: v.verdict, input, output: out });
}

// ---------- stratified 80/20 split BY TASK (no leakage) ----------
// Group pairs by taskId; a task's every round goes to the same split. A task's
// stratum = verdict of its highest round (the final outcome) — review loops
// that go fail→pass count as pass. Deterministic within each stratum.
const taskIdOf = (src) => src.split('-round')[0];
const tasks = new Map(); // taskId -> { verdict, pairs[] }
for (const p of pairs) {
  const tid = taskIdOf(p.src);
  if (!tasks.has(tid)) tasks.set(tid, { verdict: null, pairs: [], maxRound: -1 });
  const t = tasks.get(tid);
  t.pairs.push(p);
  const round = parseInt(p.src.split('-round')[1] || '0', 10);
  if (round > t.maxRound) { t.maxRound = round; t.verdict = p.verdict; }
}
const byVerdict = { pass: [], fail: [] };
for (const [tid, t] of tasks) (byVerdict[t.verdict] ||= []).push({ tid, ...t });
for (const k of Object.keys(byVerdict)) byVerdict[k].sort((a, b) => a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0);

const pickEval = (arr) => {
  const n = arr.length;
  const want = Math.round(n * 0.2);
  if (want === 0) return new Set();
  const idx = new Set();
  const step = n / want;
  for (let i = 0; i < want; i++) idx.add(Math.floor(i * step));
  return idx;
};

const train = [], eval_ = [];
const trainTasks = new Set(), evalTasks = new Set();
for (const [verdict, arr] of Object.entries(byVerdict)) {
  const evalIdx = pickEval(arr);
  arr.forEach((t, i) => {
    const target = evalIdx.has(i) ? eval_ : train;
    const tset = evalIdx.has(i) ? evalTasks : trainTasks;
    tset.add(t.tid);
    for (const p of t.pairs) target.push(p);
  });
}
// sort final sets for readability
const bySrc = (a, b) => a.src < b.src ? -1 : a.src > b.src ? 1 : 0;
train.sort(bySrc); eval_.sort(bySrc);

// sanity: no task in both splits
const leak = [...evalTasks].filter((t) => trainTasks.has(t));

// ---------- write ----------
fs.mkdirSync(OUTDIR, { recursive: true });
const writeJsonl = (file, rows) => {
  const lines = rows.map((r) => JSON.stringify({ input: r.input, output: r.output, _src: r.src, _verdict: r.verdict }));
  fs.writeFileSync(path.join(OUTDIR, file), lines.join('\n') + '\n');
};
writeJsonl('train.jsonl', train);
writeJsonl('eval.jsonl', eval_);

// ---------- report ----------
const dist = (rows) => {
  const d = { pass: 0, fail: 0 };
  for (const r of rows) d[r.verdict]++;
  return d;
};
const report = {
  verdictFiles: verdictFiles.length,
  pairs: pairs.length,
  tasks: tasks.size,
  dropped,
  train: { n: train.length, tasks: trainTasks.size, dist: dist(train) },
  eval: { n: eval_.length, tasks: evalTasks.size, dist: dist(eval_) },
  leakage: leak,
  inputChars: { train: train.reduce((a, r) => a + r.input.length, 0), eval: eval_.reduce((a, r) => a + r.input.length, 0) },
  outDir: OUTDIR,
};
console.log(JSON.stringify(report, null, 2));

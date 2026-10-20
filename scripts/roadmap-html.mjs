#!/usr/bin/env node
// scripts/roadmap-html.mjs — render docs/roadmap/fenix-roadmap.html, the Fenix
// roadmap by CAPABILITY: each area says what it is, where it stands and what
// comes next, and the Linear tickets hang under the area (shipped / in flight /
// next / later), never the other way round.
//
// Inputs (both checked in):
//   docs/roadmap/taxonomy.json        — the areas and which tickets belong to them
//   docs/roadmap/linear-snapshot.json — id → [title, status, milestone, priority],
//                                       plus the milestone table; refreshed by hand
//                                       from Linear until FOC-718 renders it
// Output: one self-contained HTML file (inline CSS, a few lines of inline JS for
// the status filter; readable with JS off). No dependencies, no network.
//
// Usage: node scripts/roadmap-html.mjs [--out <path>] [--check]
//   --check  exit 1 when a ticket in the taxonomy is missing from the snapshot,
//            appears in two areas, or a snapshot ticket is in no area.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const OUT = argOf("--out") ?? join(ROOT, "docs", "roadmap", "fenix-roadmap.html");
const CHECK = args.includes("--check");

const taxonomy = JSON.parse(readFileSync(join(ROOT, "docs", "roadmap", "taxonomy.json"), "utf8"));
const snapshot = JSON.parse(readFileSync(join(ROOT, "docs", "roadmap", "linear-snapshot.json"), "utf8"));

// ── consistency ──────────────────────────────────────────────────────────────
const seen = new Map();
const problems = [];
for (const area of taxonomy.areas) {
  for (const id of area.tickets) {
    if (!snapshot.issues[id]) problems.push(`${id} (area ${area.id}) is not in the snapshot`);
    if (seen.has(id)) problems.push(`${id} is in two areas: ${seen.get(id)} and ${area.id}`);
    seen.set(id, area.id);
  }
}
for (const id of Object.keys(snapshot.issues)) {
  if (!seen.has(id)) problems.push(`${id} is in the snapshot but in no area`);
}
if (problems.length) {
  console.error(`roadmap-html: ${problems.length} consistency problem(s):\n  ${problems.join("\n  ")}`);
  if (CHECK) process.exit(1);
}

// ── buckets ──────────────────────────────────────────────────────────────────
// shipped: Done · flight: In Progress / In Review · next: Todo · later: Backlog
const BUCKET = { Done: "shipped", "In Progress": "flight", "In Review": "flight", Todo: "next", Backlog: "later" };
const BUCKET_LABEL = { shipped: "Shipped", flight: "In flight", next: "Next", later: "Later" };
const BUCKET_ORDER = ["flight", "next", "later", "shipped"];
const MILESTONE_ORDER = ["M1", "M2", "M8", "M7", "M3", "M4", "M5", "M6", ""];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const linearUrl = (id) => `https://linear.app/jointhubs/issue/${id}`;

function ticketRow(id) {
  const [title, status, ms, priority] = snapshot.issues[id];
  const bucket = BUCKET[status] ?? "later";
  const epic = /^\[EPIC\]/.test(title);
  return `<li class="t t-${bucket}${epic ? " t-epic" : ""}" data-bucket="${bucket}">
  <a class="id" href="${linearUrl(id)}" target="_blank" rel="noopener">${id}</a>
  <span class="title">${esc(title)}</span>
  <span class="meta">${ms ? `<span class="ms ms-${ms}" title="${esc(snapshot.milestones[ms]?.name ?? ms)} · target ${esc(snapshot.milestones[ms]?.target ?? "")}">${ms}</span>` : ""}${priority === 1 ? '<span class="pri pri-1" title="Urgent">!!</span>' : priority === 2 ? '<span class="pri pri-2" title="High">!</span>' : ""}<span class="st st-${bucket}">${esc(status)}</span></span>
</li>`;
}

function areaSection(area) {
  const groups = { flight: [], next: [], later: [], shipped: [] };
  for (const id of area.tickets) {
    const row = snapshot.issues[id];
    if (!row) continue;
    groups[BUCKET[row[1]] ?? "later"].push(id);
  }
  // Inside a bucket: urgent first, then milestone order, then id.
  const sortIds = (ids) => ids.sort((a, b) => {
    const A = snapshot.issues[a], B = snapshot.issues[b];
    const pa = A[3] || 9, pb = B[3] || 9;
    if (pa !== pb) return pa - pb;
    const ma = MILESTONE_ORDER.indexOf(A[2]), mb = MILESTONE_ORDER.indexOf(B[2]);
    if (ma !== mb) return ma - mb;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const counts = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]));
  const total = area.tickets.length;
  const shippedPct = total ? Math.round((counts.shipped / total) * 100) : 0;
  const lists = BUCKET_ORDER.map((b) => {
    if (!groups[b].length) return "";
    return `<div class="bucket bucket-${b}">
  <h4>${BUCKET_LABEL[b]} <span class="n">${groups[b].length}</span></h4>
  <ul>${sortIds(groups[b]).map(ticketRow).join("\n")}</ul>
</div>`;
  }).join("\n");
  return `<section class="area" id="${esc(area.id)}">
  <header>
    <h2>${esc(area.name)}</h2>
    <div class="meter" title="${counts.shipped} of ${total} tickets shipped"><span style="width:${shippedPct}%"></span></div>
    <p class="counts"><b>${counts.shipped}</b> shipped · <b>${counts.flight}</b> in flight · <b>${counts.next}</b> next · <b>${counts.later}</b> later</p>
  </header>
  <dl class="narrative">
    <dt>What</dt><dd>${esc(area.what)}</dd>
    <dt>Now</dt><dd>${esc(area.now)}</dd>
    <dt>Next</dt><dd>${esc(area.next)}</dd>
  </dl>
  <div class="buckets">
${lists}
  </div>
</section>`;
}

// ── page ─────────────────────────────────────────────────────────────────────
const totals = { shipped: 0, flight: 0, next: 0, later: 0 };
for (const id of Object.keys(snapshot.issues)) totals[BUCKET[snapshot.issues[id][1]] ?? "later"]++;

const milestoneRows = Object.entries(snapshot.milestones)
  .sort((a, b) => a[1].target.localeCompare(b[1].target))
  .map(([code, m]) => `<tr><td><span class="ms ms-${code}">${code}</span></td><td>${esc(m.name)}</td><td>${esc(m.target)}</td><td><a href="${linearUrl(m.epic)}" target="_blank" rel="noopener">${m.epic}</a></td></tr>`)
  .join("\n");

const toc = taxonomy.areas.map((a) => `<li><a href="#${esc(a.id)}">${esc(a.name)}</a></li>`).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fenix roadmap by capability</title>
<meta name="description" content="${esc(taxonomy.subtitle)}">
<style>
:root{--bg:#f7f6f2;--card:#ffffff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#b4521a;--shipped:#2f7d4f;--flight:#1f5fa8;--next:#b4521a;--later:#7a7873;--meter:#dcd9d1;--chip:#f1efe9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15161a;--card:#1d1f25;--ink:#ecebe7;--muted:#a09e98;--line:#2c2f37;--accent:#e6894b;--shipped:#5fbf86;--flight:#6ea5ea;--next:#e6894b;--later:#9c9a94;--meter:#2c2f37;--chip:#262932}}
:root[data-theme="dark"]{--bg:#15161a;--card:#1d1f25;--ink:#ecebe7;--muted:#a09e98;--line:#2c2f37;--accent:#e6894b;--shipped:#5fbf86;--flight:#6ea5ea;--next:#e6894b;--later:#9c9a94;--meter:#2c2f37;--chip:#262932}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:0 16px 64px}
main{max-width:1100px;margin:0 auto}
h1{font-size:28px;margin:32px 0 4px;letter-spacing:-0.01em}
.sub{color:var(--muted);margin:0 0 20px;max-width:70ch}
.principle{border-left:3px solid var(--accent);padding:6px 12px;color:var(--muted);margin:0 0 24px;max-width:80ch}
.summary{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 20px}
.summary .k{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.summary .k b{display:block;font-size:22px}
.summary .k span{color:var(--muted);font-size:13px}
.filters{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:0 0 24px;color:var(--muted);font-size:14px}
.filters label{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.layout{display:grid;grid-template-columns:240px 1fr;gap:28px}
nav.toc{position:sticky;top:16px;align-self:start;font-size:14px}
nav.toc ol{margin:0;padding-left:18px}
nav.toc li{margin:4px 0}
nav.toc a{color:var(--ink);text-decoration:none}
nav.toc a:hover{color:var(--accent)}
table.ms-table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0 0}
table.ms-table td{padding:4px 6px;border-top:1px solid var(--line);vertical-align:top}
.area{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:0 0 20px;scroll-margin-top:16px}
.area header{display:grid;grid-template-columns:1fr auto;gap:4px 16px;align-items:center}
.area h2{font-size:20px;margin:0}
.meter{grid-column:1/-1;height:6px;background:var(--meter);border-radius:3px;overflow:hidden}
.meter span{display:block;height:100%;background:var(--shipped)}
.counts{grid-column:1/-1;color:var(--muted);font-size:13px;margin:0}
dl.narrative{display:grid;grid-template-columns:52px 1fr;gap:4px 12px;margin:14px 0 6px;font-size:14px}
dl.narrative dt{color:var(--muted);font-weight:600}
dl.narrative dd{margin:0}
.buckets{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px 24px;margin-top:10px}
.bucket h4{margin:10px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.bucket h4 .n{display:inline-block;min-width:20px;text-align:center;background:var(--chip);border-radius:10px;padding:0 6px;margin-left:4px;color:var(--ink)}
.bucket ul{list-style:none;margin:0;padding:0}
.t{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;padding:5px 0;border-top:1px solid var(--line);font-size:13.5px}
.t:first-child{border-top:0}
.t .id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--accent);text-decoration:none;white-space:nowrap}
.t .id:hover{text-decoration:underline}
.t .title{color:var(--ink);flex:1 1 200px;min-width:0}
.t .meta{display:inline-flex;gap:6px;align-items:baseline;margin-left:auto;white-space:nowrap}
.bucket-shipped .st,.bucket-later .st,.bucket-next .st{display:none}
.t-shipped .title{color:var(--muted)}
.t-epic .title{font-weight:600}
.ms{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;padding:1px 6px;border-radius:8px;background:var(--chip);color:var(--muted);white-space:nowrap}
.pri{font-family:ui-monospace,monospace;font-size:11px;color:var(--next);font-weight:700}
.st{font-size:11px;white-space:nowrap;padding:1px 7px;border-radius:8px;color:#fff}
.st-shipped{background:var(--shipped)}.st-flight{background:var(--flight)}.st-next{background:var(--next)}.st-later{background:var(--later)}
body.hide-shipped .t-shipped,body.hide-flight .t-flight,body.hide-next .t-next,body.hide-later .t-later{display:none}
body.hide-shipped .bucket-shipped,body.hide-flight .bucket-flight,body.hide-next .bucket-next,body.hide-later .bucket-later{display:none}
footer{color:var(--muted);font-size:13px;margin-top:28px;max-width:80ch}
@media (max-width:860px){.layout{grid-template-columns:1fr}nav.toc{position:static}.area header{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<h1>${esc(taxonomy.title)}</h1>
<p class="sub">${esc(taxonomy.subtitle)}</p>
<p class="principle">${esc(taxonomy.principle)}</p>
<div class="summary">
  <div class="k"><b>${taxonomy.areas.length}</b><span>capabilities</span></div>
  <div class="k"><b>${totals.shipped}</b><span>shipped (Done, last 45 days)</span></div>
  <div class="k"><b>${totals.flight}</b><span>in flight</span></div>
  <div class="k"><b>${totals.next}</b><span>next (Todo)</span></div>
  <div class="k"><b>${totals.later}</b><span>later (Backlog)</span></div>
</div>
<div class="filters" id="filters">
  <span>Show:</span>
  <label><input type="checkbox" data-bucket="flight" checked> In flight</label>
  <label><input type="checkbox" data-bucket="next" checked> Next</label>
  <label><input type="checkbox" data-bucket="later" checked> Later</label>
  <label><input type="checkbox" data-bucket="shipped" checked> Shipped</label>
</div>
<div class="layout">
<nav class="toc" aria-label="Capabilities">
  <ol>
${toc}
  </ol>
  <table class="ms-table" aria-label="Milestones">
    <thead><tr><td colspan="4" style="border-top:0;color:var(--muted);font-weight:600">Milestones</td></tr></thead>
    <tbody>
${milestoneRows}
    </tbody>
  </table>
</nav>
<div class="areas">
${taxonomy.areas.map(areaSection).join("\n")}
</div>
</div>
<footer>
Generated ${esc(new Date().toISOString().slice(0, 10))} by <code>scripts/roadmap-html.mjs</code> from <code>docs/roadmap/taxonomy.json</code> (capabilities, hand-curated) and <code>docs/roadmap/linear-snapshot.json</code> (Linear project FENIX, fetched ${esc(snapshot.fetchedAt.slice(0, 10))}: every open ticket plus tickets completed in the previous 45 days — older shipped work is not listed). Ticket ids link to Linear. Status words are Linear's; "shipped" = Done, "in flight" = In Progress or In Review, "next" = Todo, "later" = Backlog. Milestone targets from <code>docs/ROADMAP.md</code> (2026-10-15 revision).
</footer>
</main>
<script>
(function(){
  var b=document.body, f=document.getElementById('filters');
  if(!f) return;
  f.addEventListener('change', function(e){
    var cb=e.target; if(!cb || !cb.dataset || !cb.dataset.bucket) return;
    b.classList.toggle('hide-'+cb.dataset.bucket, !cb.checked);
  });
})();
</script>
</body>
</html>
`;

writeFileSync(OUT, html, "utf8");
console.log(`roadmap-html: wrote ${OUT} — ${taxonomy.areas.length} areas, ${Object.keys(snapshot.issues).length} tickets (${totals.shipped} shipped, ${totals.flight} in flight, ${totals.next} next, ${totals.later} later)${problems.length ? `, ${problems.length} consistency problem(s) above` : ""}`);

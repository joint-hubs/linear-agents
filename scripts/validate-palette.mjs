#!/usr/bin/env node
/**
 * validate-palette.mjs — computable validator for the Fenix UI squad accent palette.
 *
 * PROVENANCE
 *   Port of the dataviz reference validator (validate_palette.js, bundled dataviz
 *   skill) used for the original FOC-225 palette measurement; floors per the
 *   FOC-227 reconstruction. Color math (color spaces, CVD simulation method, ΔE
 *   formula, lightness band and chroma floor constants) is ported verbatim so
 *   numbers stay comparable with the captured FOC-225 run.
 *
 * COLOR MODEL
 *   sRGB (hex) -> linear RGB (IEC 61966-2-1 sRGB gamma) -> OKLab, per Björn
 *   Ottosson's reference implementation (the matrices below are his constants).
 *   OKLCH C = hypot(a, b); hue = atan2(b, a).
 *
 * CVD SIMULATION
 *   Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for
 *   Simulation of Color Vision Deficiency" (IEEE TVCG 15(6)), severity-1.0
 *   matrices applied on LINEAR RGB. The ΔE thresholds are calibrated to this
 *   simulation model — the model is part of the standard, not an implementation
 *   detail (swapping in e.g. Viénot-1999 moves borderline pairs and would
 *   require recalibrating).
 *
 * ΔE FORMULA
 *   Euclidean distance in OKLab × 100 between the (optionally CVD-simulated)
 *   OKLab coordinates of two colors.
 *
 * FLOORS (one-line rationale each)
 *   Lightness band  OKLab L in [0.43, 0.77] — light-mode band: dark enough to
 *                   read on white, light enough to still read as a hue.
 *   Chroma floor    OKLab C >= 0.10 — below it a hue reads as gray and stops
 *                   doing identity work.
 *   CVD separation  deutan AND tritan ΔE >= 9.3, HARD — FOC-227 sets the floor
 *                   above the reference's 6–8 warn band, so NO
 *                   secondary-encoding exemption is implemented here.
 *   Normal vision   ΔE >= 15 unsimulated — full-color readers must be able to
 *                   tell any pair apart too; hard gate, no exemption.
 *   Contrast        WCAG 2.x ratio >= 3.0 vs surface — non-text contrast for
 *                   squad marks (bars/dots) on the card surface.
 *   Text contrast   WCAG 2.x ratio >= 4.5 vs #ffffff — AA small-text: every
 *                   token is rendered as small bold uppercase label TEXT on
 *                   white (Live run-card squad labels via color: var(--sq-*),
 *                   manager coordinator tag via color: var(--sq-supervisor)),
 *                   so AA 4.5:1 applies app-wide to all six. This forces
 *                   darker shades than the 3:1 mark floor.
 *
 * USAGE
 *   node scripts/validate-palette.mjs                  # validate ui/src/theme.css :root --sq-* tokens
 *   node scripts/validate-palette.mjs --colors "#6e56cf,#2563eb,#d97706,#059669,#64748b,#be185d"
 *   node scripts/validate-palette.mjs --surface "#hex" --pairs adjacent|all
 *
 * Exit 0 = all checks pass; 1 = any check fails; 2 = usage/input error.
 * Protan ΔE is printed for reference only (the reference validator additionally
 * gates on it); the FOC-227 gate is deutan+tritan.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// -- thresholds ----------------------------------------------------------------
export const LIGHTNESS_BAND = [0.43, 0.77]; // OKLab L, light-mode band (ported from reference BAND.light)
export const CHROMA_FLOOR = 0.10; // OKLab C (ported from reference CHROMA_FLOOR)
export const CVD_FLOOR = 9.3; // OKLab dE x100, deutan AND tritan, hard floor (FOC-227; reference warn band 6-8 not implemented)
export const NORMAL_FLOOR = 15.0; // OKLab dE x100, unsimulated vision (ported from reference NORMAL_FLOOR)
export const SURFACE_CONTRAST_MIN = 3.0; // WCAG 2.x non-text contrast vs surface (ported CONTRAST_MIN)
export const TEXT_CONTRAST_MIN = 4.5; // WCAG 2.x AA small text vs #ffffff (FOC-227; rationale in header)
export const TEXT_REFERENCE = "#ffffff";
export const DEFAULT_SURFACE = "#ffffff"; // --surface card in ui/src/theme.css
// The FOC-227 palette search proved all-pairs (15 pairs) feasible: the shipped
// squad palette passes --pairs all, so the stricter list is the default here.
// "adjacent" (the reference/FOC-225 default) stays available via --pairs adjacent.
export const DEFAULT_PAIRS = "all";

export const CANONICAL = ["plan", "dev", "review", "test", "cadence", "supervisor"];

// Machado, Oliveira & Fernandes (2009) CVD transforms at severity 1.0 (linear RGB).
// Ported verbatim from the reference validator.
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779],
           [-0.078411, 0.930809, 0.147602],
           [0.004733, 0.691367, 0.303900]],
};

// -- color conversions (ported verbatim from the reference validator) ------------
export const hex2srgb = (h) => { h = h.trim().replace(/^#/, ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
export const s2lin = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const lin2s = (c) => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
export const lin = (h) => hex2srgb(h).map(s2lin);
export const relLum = (h) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

export function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, // L
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, // a
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s, // b
  ];
}
export const oklab = (h) => oklabFromLin(lin(h));
export const oklch = (h) => { const [L, a, b] = oklab(h); return [L, Math.hypot(a, b)]; };

export function simulate(h, kind) {
  const [r, g, b] = lin(h), M = MACHADO[kind];
  const clamp = (c) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}
// Precomputed per-color OKLab coordinates under each vision model.
export function labs(h) {
  return {
    normal: oklabFromLin(lin(h)),
    protan: oklabFromLin(simulate(h, "protan")),
    deutan: oklabFromLin(simulate(h, "deutan")),
    tritan: oklabFromLin(simulate(h, "tritan")),
  };
}
const dE = (lab1, lab2) =>
  100 * Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);

// -- input boundary --------------------------------------------------------------
const isHexColor = (v) => /^#[0-9a-fA-F]{6}$/.test(v);
const splitColors = (raw) => (raw || "").split(",").map(s => s.trim()).filter(Boolean);

export function readThemePalette(themePath) {
  const css = readFileSync(themePath, "utf8");
  const root = css.match(/:root\s*\{([^}]*)\}/s);
  if (!root) throw new Error(`no :root block found in ${themePath}`);
  const body = root[1];
  return CANONICAL.map((name) => {
    const m = body.match(new RegExp(`--sq-${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`--sq-${name} (hex) not found in :root of ${themePath}`);
    return m[1].toLowerCase();
  });
}

// -- checks ----------------------------------------------------------------------
export function pairMetrics(a, b) {
  const la = labs(a), lb = labs(b);
  const deutan = dE(la.deutan, lb.deutan);
  const tritan = dE(la.tritan, lb.tritan);
  const normal = dE(la.normal, lb.normal);
  const protan = dE(la.protan, lb.protan); // informational only (FOC-227 gate = deutan+tritan)
  const margin = Math.min(Math.min(deutan, tritan) - CVD_FLOOR, normal - NORMAL_FLOOR);
  return { a, b, deutan, tritan, normal, protan, margin, pass: margin >= 0 };
}

export function validatePalette(palette, { surface = DEFAULT_SURFACE, pairs = DEFAULT_PAIRS } = {}) {
  const [lo, hi] = LIGHTNESS_BAND;
  const n = palette.length;
  const rows = [];
  let ok = true;
  const pairlist = pairs === "all"
    ? Array.from({ length: n }, (_, i) => Array.from({ length: n - i - 1 }, (_, k) => [i, i + 1 + k])).flat()
    : Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
  const label = pairs === "all" ? "all-pairs" : "adjacent";

  // 1. lightness band
  const offband = palette.filter(c => { const L = oklch(c)[0]; return L < lo || L > hi; })
    .map(c => [c, +oklch(c)[0].toFixed(3)]);
  if (offband.length) ok = false;
  rows.push(["Lightness band", !offband.length,
    offband.length ? `outside band: ${JSON.stringify(offband)}` : `all ${n} inside L ${lo}–${hi}`]);

  // 2. chroma floor
  const lowc = palette.filter(c => oklch(c)[1] < CHROMA_FLOOR).map(c => [c, +oklch(c)[1].toFixed(3)]);
  if (lowc.length) ok = false;
  rows.push(["Chroma floor", !lowc.length,
    lowc.length ? `below floor (reads gray): ${JSON.stringify(lowc)}` : `all ${n} >= ${CHROMA_FLOOR}`]);

  // 3. CVD separation — deutan AND tritan >= CVD_FLOOR, hard (no 6-8 exemption band)
  const metrics = pairlist.map(([i, j]) => pairMetrics(palette[i], palette[j]));
  const cvdWorst = metrics.reduce((w, m) => {
    const d = Math.min(m.deutan, m.tritan);
    return !w || d < w.d ? { d, kind: m.deutan <= m.tritan ? "deutan" : "tritan", m } : w;
  }, null);
  const cvdPass = metrics.every(m => m.deutan >= CVD_FLOOR && m.tritan >= CVD_FLOOR);
  if (!cvdPass) ok = false;
  rows.push(["CVD separation", cvdPass,
    `worst ${label} ${cvdWorst.m.a}↔${cvdWorst.m.b} ΔE ${cvdWorst.d.toFixed(1)} (${cvdWorst.kind})`
    + ` · tritan ${Math.min(...metrics.map(m => m.tritan)).toFixed(1)}`]);

  // 4. normal-vision floor — worst pair >= NORMAL_FLOOR, hard
  const nWorst = metrics.reduce((w, m) => (!w || m.normal < w.normal ? m : w), null);
  const nPass = metrics.every(m => m.normal >= NORMAL_FLOOR);
  if (!nPass) ok = false;
  rows.push(["Normal-vision floor", nPass,
    `worst ${label} ${nWorst.a}↔${nWorst.b} ΔE ${nWorst.normal.toFixed(1)} (normal)`
    + (nPass ? "" : ` — below ${NORMAL_FLOOR.toFixed(0)}, hard to tell apart even with full color vision`)]);

  // 5. contrast vs surface
  const lowContrast = palette.filter(c => contrast(c, surface) < SURFACE_CONTRAST_MIN)
    .map(c => [c, +contrast(c, surface).toFixed(2)]);
  if (lowContrast.length) ok = false;
  rows.push(["Contrast vs surface", !lowContrast.length,
    lowContrast.length ? `below ${SURFACE_CONTRAST_MIN}:1: ${JSON.stringify(lowContrast)}` : `all ${n} >= ${SURFACE_CONTRAST_MIN}:1`]);

  // 6. text contrast (AA) vs #ffffff — see header rationale
  const lowText = palette.filter(c => contrast(c, TEXT_REFERENCE) < TEXT_CONTRAST_MIN)
    .map(c => [c, +contrast(c, TEXT_REFERENCE).toFixed(2)]);
  if (lowText.length) ok = false;
  rows.push(["Text contrast (AA)", !lowText.length,
    lowText.length ? `below ${TEXT_CONTRAST_MIN}:1 vs ${TEXT_REFERENCE}: ${JSON.stringify(lowText)}`
                   : `all ${n} >= ${TEXT_CONTRAST_MIN}:1 vs ${TEXT_REFERENCE}`]);

  return { rows, pairs: metrics, label, ok };
}

// -- CLI -------------------------------------------------------------------------
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const opts = { surface: DEFAULT_SURFACE, pairs: DEFAULT_PAIRS, colors: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--colors") opts.colors = args[++i];
    else if (a === "--surface") opts.surface = args[++i];
    else if (a === "--pairs") { opts.pairs = args[++i]; }
    else { console.error(`unknown or malformed flag: ${a}`); printUsage(); process.exit(2); }
  }
  if (!["adjacent", "all"].includes(opts.pairs)) {
    console.error(`--pairs must be adjacent|all (got ${JSON.stringify(opts.pairs)})`); process.exit(2);
  }
  if (!isHexColor(opts.surface)) {
    console.error(`--surface must be #rrggbb (got ${JSON.stringify(opts.surface)})`); process.exit(2);
  }

  let palette, source;
  if (opts.colors != null) {
    palette = splitColors(opts.colors).map(c => c.toLowerCase());
    source = "--colors";
  } else {
    const themePath = join(here, "..", "ui", "src", "theme.css");
    palette = readThemePalette(themePath);
    source = join(here, "..", "ui", "src", "theme.css");
  }
  const bad = palette.filter(c => !isHexColor(c));
  if (palette.length !== 6 || bad.length) {
    console.error(`expected exactly 6 #rrggbb colors in canonical order (plan, dev, review, test, cadence, supervisor)`
      + (bad.length ? `; invalid: ${bad.join(", ")}` : `; got ${palette.length}`));
    process.exit(2);
  }

  const result = validatePalette(palette, { surface: opts.surface, pairs: opts.pairs });
  const pad = 22;
  console.log(`scope: categorical (${palette.length} colors)`);
  console.log(`  source ${source} · surface ${opts.surface} · pairs ${result.label}`);
  for (const [name, state, detail] of result.rows) {
    console.log(`  [${(state ? "PASS" : "FAIL").padEnd(4)}] ${name.padEnd(pad)} ${detail}`);
  }
  // per-pair dE table (REVIEW/DEV attach this to the hand-off)
  console.log(`\n  pair ΔE table (${result.label}); floors: deutan+tritan >= ${CVD_FLOOR}, normal >= ${NORMAL_FLOOR}`);
  console.log(`  ${"pair".padEnd(24)} ${"deutan".padStart(7)} ${"tritan".padStart(7)} ${"normal".padStart(7)} ${"protan*".padStart(7)} ${"margin".padStart(7)}  verdict`);
  for (const m of result.pairs) {
    const names = ["plan", "dev", "review", "test", "cadence", "supervisor"];
    const pairName = `${names[palette.indexOf(m.a)]}↔${names[palette.indexOf(m.b)]}`.padEnd(24);
    const verdict = m.pass ? "PASS" : `FAIL (needs ${m.deutan < CVD_FLOOR || m.tritan < CVD_FLOOR ? `d/t>=${CVD_FLOOR} ` : ""}${m.normal < NORMAL_FLOOR ? `n>=${NORMAL_FLOOR}` : ""})`.trimEnd() + " ";
    console.log(`  ${pairName} ${m.deutan.toFixed(1).padStart(7)} ${m.tritan.toFixed(1).padStart(7)} ${m.normal.toFixed(1).padStart(7)} ${m.protan.toFixed(1).padStart(7)} ${m.margin.toFixed(1).padStart(7)}  ${verdict}`);
  }
  console.log(`  * protan reported for reference only (reference validator gates on it); FOC-227 gate = deutan+tritan`);
  console.log(`\n  → ${result.ok ? "PASSED" : "FAILED"} (floors: deutan+tritan ≥ ${CVD_FLOOR} hard — no secondary-encoding exemption; normal ≥ ${NORMAL_FLOOR}; contrast ≥ ${SURFACE_CONTRAST_MIN}:1 surface / ≥ ${TEXT_CONTRAST_MIN}:1 text)`);
  process.exit(result.ok ? 0 : 1);
}

function printUsage() {
  console.error("usage: node scripts/validate-palette.mjs [--colors \"#hex,#hex,#hex,#hex,#hex,#hex\"] [--surface #hex] [--pairs adjacent|all]");
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("validate-palette.mjs")) {
  main();
}

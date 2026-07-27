// gen-icon.mjs — generate favicon.ico with white "F" on purple rounded square
// Pure Node.js: zero npm dependencies. Uses only node:zlib, node:fs, node:buffer.
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ── CRC-32/ISO-HDLC (reflected polynomial 0xEDB88320) ──────────────────────
function makeCrc32Table() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c;
  }
  return t;
}
const CRC_TABLE = makeCrc32Table();

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]) & 0xFF];
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Binary helpers ──────────────────────────────────────────────────────────
function u32be(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n, 0);
  return b;
}

// ── PNG encoder ─────────────────────────────────────────────────────────────
function makePngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = u32be(data.length);
  const crc = u32be(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function makeIhdr(width, height) {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  return ihdr;
}

function encodePng(width, height, pixels) {
  // pixels: Buffer of width*height*4 bytes (RGBA, row-major)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // Build raw image data: each row prefixed with filter byte 0 (None)
  const rowLen = 1 + width * 4;
  const raw = Buffer.allocUnsafe(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: None
    pixels.copy(raw, y * rowLen + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = deflateSync(raw);

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', makeIhdr(width, height)),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing primitives ──────────────────────────────────────────────────────
function isInsideRoundedRect(x, y, w, h, r) {
  // Test pixel center (x+0.5, y+0.5) against rounded rectangle
  const cx = x + 0.5;
  const cy = y + 0.5;

  if (cx < 0 || cx >= w || cy < 0 || cy >= h) return false;

  // Top-left corner
  if (cx < r && cy < r) {
    const dx = r - cx;
    const dy = r - cy;
    return dx * dx + dy * dy <= r * r;
  }
  // Top-right corner
  if (cx >= w - r && cy < r) {
    const dx = cx - (w - r);
    const dy = r - cy;
    return dx * dx + dy * dy <= r * r;
  }
  // Bottom-left corner
  if (cx < r && cy >= h - r) {
    const dx = r - cx;
    const dy = cy - (h - r);
    return dx * dx + dy * dy <= r * r;
  }
  // Bottom-right corner
  if (cx >= w - r && cy >= h - r) {
    const dx = cx - (w - r);
    const dy = cy - (h - r);
    return dx * dx + dy * dy <= r * r;
  }

  return true; // inside the straight-edge region
}

function drawRoundedRect(pixels, w, h, r, color) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isInsideRoundedRect(x, y, w, h, r)) {
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = color[3];
      } else {
        // Transparent outside the rounded rect
        pixels[i] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
        pixels[i + 3] = 0;
      }
    }
  }
}

function fillRect(pixels, imgW, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px >= 0 && px < imgW && py >= 0 && py < imgW) {
        const i = (py * imgW + px) * 4;
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = color[3];
      }
    }
  }
}

// ── Letter "F" — proportional to icon size ─────────────────────────────────
function drawF(pixels, size) {
  const w = size;
  const h = size;
  const stroke = Math.max(2, Math.round(w * 0.18));
  const left = Math.round(w * 0.22);
  const topY = Math.round(h * 0.12);
  const midY = Math.round(h * 0.42);
  const topRight = Math.round(w * 0.78);
  const midRight = Math.round(w * 0.62);
  const bottomY = Math.round(h * 0.88);

  const white = [255, 255, 255, 255];

  // Vertical stem
  fillRect(pixels, w, left, topY, stroke, bottomY - topY, white);
  // Top arm
  fillRect(pixels, w, left, topY, topRight - left, stroke, white);
  // Middle arm
  fillRect(pixels, w, left, midY, midRight - left, stroke, white);
}

// ── Generate one PNG icon at given size ─────────────────────────────────────
function generateIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const bgColor = [0x6E, 0x56, 0xCF, 255]; // #6E56CF — Fenix plan squad purple
  const radius = Math.round(size * 0.22);

  drawRoundedRect(pixels, size, size, radius, bgColor);
  drawF(pixels, size);

  return encodePng(size, size, pixels);
}

// ── ICO container builder ───────────────────────────────────────────────────
function buildIco(pngs) {
  const count = pngs.length;

  // ICONDIR header (6 bytes, little-endian)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: 1 = ICO
  header.writeUInt16LE(count, 4); // image count

  const entrySize = 16;
  const dataStart = 6 + count * entrySize;

  const entries = [];
  const imageDatas = [];
  let offset = dataStart;

  for (const png of pngs) {
    // Read dimensions from PNG IHDR (offset 16 from PNG start)
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);

    const entry = Buffer.alloc(16);
    entry.writeUInt8(w === 256 ? 0 : w, 0);  // width  (0 = 256)
    entry.writeUInt8(h === 256 ? 0 : h, 1);  // height (0 = 256)
    entry.writeUInt8(0, 2);                   // color count (0 = no palette)
    entry.writeUInt8(0, 3);                   // reserved
    entry.writeUInt16LE(1, 4);                // planes
    entry.writeUInt16LE(32, 6);              // bit count (32-bit RGBA)
    entry.writeUInt32LE(png.length, 8);      // size in bytes
    entry.writeUInt32LE(offset, 12);         // offset to image data

    entries.push(entry);
    imageDatas.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...imageDatas]);
}

// ── Main ────────────────────────────────────────────────────────────────────
const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => generateIcon(s));
const ico = buildIco(pngs);

const outDir = join(REPO_ROOT, 'ui', 'public');
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}
const outPath = join(outDir, 'favicon.ico');
writeFileSync(outPath, ico);

// ── Verification ────────────────────────────────────────────────────────────
const data = readFileSync(outPath);
const results = [];

results.push(`File size: ${data.length} bytes`);

// 1. ICO header
const isIco = data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0;
results.push(`ICO header (00 00 01 00): ${isIco ? 'PASS' : 'FAIL'}`);

const count = data.readUInt16LE(4);
results.push(`Image count: ${count} (expected 4): ${count === 4 ? 'PASS' : 'FAIL'}`);

// 2. Each ICONDIRENTRY → PNG signature at declared offset
// 3. Inflate IDAT → check decompressed size
let allPngOk = true;
let allIdatOk = true;

for (let i = 0; i < count; i++) {
  const entryOff = 6 + i * 16;
  const w = data.readUInt8(entryOff) || 256;
  const h = data.readUInt8(entryOff + 1) || 256;
  const imgSize = data.readUInt32LE(entryOff + 8);
  const imgOffset = data.readUInt32LE(entryOff + 12);

  const pngSig = data.slice(imgOffset, imgOffset + 8);
  const isPng =
    pngSig[0] === 137 &&
    pngSig[1] === 80 &&
    pngSig[2] === 78 &&
    pngSig[3] === 71;
  if (!isPng) allPngOk = false;
  results.push(
    `Entry ${i} (${w}x${h}): PNG sig ${isPng ? 'PASS' : 'FAIL'}, size=${imgSize}`
  );

  // Find IDAT chunk and verify decompressed size
  if (isPng) {
    let pos = imgOffset + 8; // skip PNG signature
    let foundIdat = false;
    while (pos < imgOffset + imgSize) {
      const chunkLen = data.readUInt32BE(pos);
      const chunkType = data.slice(pos + 4, pos + 8).toString('ascii');
      if (chunkType === 'IDAT') {
        const compressed = data.slice(pos + 8, pos + 8 + chunkLen);
        const decompressed = inflateSync(compressed);
        const expected = h * (1 + w * 4);
        const ok = decompressed.length === expected;
        if (!ok) allIdatOk = false;
        results.push(
          `  IDAT decompressed: ${decompressed.length} vs expected ${expected}: ${ok ? 'PASS' : 'FAIL'}`
        );
        foundIdat = true;
        break;
      }
      pos += 12 + chunkLen;
    }
    if (!foundIdat) {
      allIdatOk = false;
      results.push('  IDAT chunk not found: FAIL');
    }
  }
}

results.push(`All PNG signatures valid: ${allPngOk ? 'PASS' : 'FAIL'}`);
results.push(`All IDAT sizes correct: ${allIdatOk ? 'PASS' : 'FAIL'}`);

console.log(results.join('\n'));

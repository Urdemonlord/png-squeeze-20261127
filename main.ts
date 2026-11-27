// PNG Squeeze: lossless PNG recompressor. Pure Node, no dependencies.
// Pipeline per image: decode stored RGBA PNG, screen colour-type forms
// (palette by count / luminance / nearest-neighbour order, grey, grey+alpha,
// RGB, RGBA, plus a tRNS-key form) and filter choices (fixed, minsum,
// pairs, per-row brute force) by zlib level 6, then write the winner with
// a zopfli-style optimal-parse DEFLATE (hash-chain match finder, shortest
// path parse, iterated dynamic Huffman, block split). Falls back to
// zlib level 9 when the custom stream is not smaller. Deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------- CRC-32, PNG read/write ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
function pngOf(chunks) {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(w, h, ct) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, w);
  new DataView(d.buffer).setUint32(4, h);
  d[8] = 8; d[9] = ct;
  return d;
}
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, header = null, palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0); }
    else if (ft === 2) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0); }
    else if (ft === 3) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1); }
    else { for (let i = 0; i < stride; i++) { const a = i >= bpp ? samples[o + i - bpp] : 0; const b = y > 0 ? samples[p + i] : 0; const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0; samples[o + i] = raw[src + i] + paeth(a, b, c); } }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) { const g = samples[i]; rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = g === key ? 0 : 255; }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1]; }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------- PNG filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); }
  else if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); }
  else if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); }
  else { for (let i = 0; i < n; i++) { const a = i >= bpp ? cur[i - bpp] : 0; const b = prev === null ? 0 : prev[i]; const c = prev !== null && i >= bpp ? prev[i - bpp] : 0; out[i] = cur[i] - paeth(a, b, c); } }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}
const BRUTE_CONTEXT = 32768;
function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  if (!raw) raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) { const row = new Uint8Array(stride + 1); row[0] = t; trial.push(row); }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- Image analysis and forms ----------
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) { if (counts.size === 256) many = true; else counts.set(c, 1); }
      else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
// Palette order: transparent entries first (by alpha), then opaque entries by
// greedy nearest-neighbour walk in RGB space (keeps neighbouring indices
// similar, so Sub/Up filters produce small deltas). Falls back to count or
// luminance order when order is not 'tsp'.
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const trans = colours.filter((c) => c.rgba[3] !== 255).sort((x, y) => x.rgba[3] - y.rgba[3] || x.word - y.word);
  const opaq = colours.filter((c) => c.rgba[3] === 255);
  if (order === 'count') opaq.sort((x, y) => y.count - x.count || x.word - y.word);
  else if (order === 'luminance') opaq.sort((x, y) => lum(x) - lum(y) || x.word - y.word);
  else {
    const used = new Uint8Array(opaq.length);
    const seq = [];
    let cur = 0;
    for (let i = 1; i < opaq.length; i++) if (opaq[i].count > opaq[cur].count) cur = i;
    seq.push(opaq[cur]); used[cur] = 1;
    for (let k = 1; k < opaq.length; k++) {
      const c = seq[seq.length - 1].rgba;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < opaq.length; i++) {
        if (used[i]) continue;
        const r = opaq[i].rgba;
        const dr = r[0] - c[0], dg = r[1] - c[1], db = r[2] - c[2];
        const d = 299 * dr * dr + 587 * dg * dg + 114 * db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      seq.push(opaq[best]); used[best] = 1;
    }
    return [...trans, ...seq];
  }
  return [...trans, ...opaq];
}
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [['count', [0]], ['luminance', [0, 'minsum', 'brute']], ['tsp', [0, 'minsum', 'brute']]]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
const SCREEN = { level: 6, memLevel: 8 };
function screen(rgba, width, height) {
  let best = null, spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else spare = data;
    }
  }
  return best;
}
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- DEFLATE: Huffman, bit writer, dynamic blocks ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenCodeOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distCodeOf(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}
function revBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>= 1; }
  return r;
}
class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.at = 0; this.acc = 0; this.nbits = 0; }
  grow() { const nb = new Uint8Array(this.buf.length * 2 + 1024); nb.set(this.buf.subarray(0, this.at)); this.buf = nb; }
  put(code, len) {
    this.acc |= (code & ((1 << len) - 1)) << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      if (this.at >= this.buf.length) this.grow();
      this.buf[this.at++] = this.acc & 0xff;
      this.acc >>>= 8; this.nbits -= 8;
    }
  }
  putRev(code, len) { this.put(revBits(code, len), len); }
  align() { if (this.nbits > 0) { if (this.at >= this.buf.length) this.grow(); this.buf[this.at++] = this.acc & 0xff; this.acc = 0; this.nbits = 0; } }
  bytes() { return this.buf.subarray(0, this.at); }
}
// Length-limited Huffman lengths from frequencies. Heap tree, then halve
// frequencies and rebuild while any length exceeds maxBits (converges fast).
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  const f = new Float64Array(freq);
  for (let iter = 0; iter < 24; iter++) {
    // Min-heap of [freq, tie, nodeIndex]; leaves are symbol indexes, internal
    // nodes are indexes into nodes[].
    const nodes = syms.map((s) => ({ freq: f[s], sym: s, left: -1, right: -1 }));
    const heap = nodes.map((_, i) => i);
    const cmp = (a, b) => nodes[a].freq - nodes[b].freq || a - b;
    const down = (i) => {
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
      }
    };
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) { heap[0] = last; down(0); }
      return top;
    };
    const push = (v) => {
      heap.push(v);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (cmp(heap[i], heap[p]) >= 0) break; const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; }
    };
    while (heap.length > 1) {
      const a = pop(), b = pop();
      nodes.push({ freq: nodes[a].freq + nodes[b].freq, sym: -1, left: a, right: b });
      push(nodes.length - 1);
    }
    const root = heap[0];
    lengths.fill(0);
    let maxLen = 0;
    const walk = (ni, depth) => {
      const nd = nodes[ni];
      if (nd.sym >= 0) { lengths[nd.sym] = depth; if (depth > maxLen) maxLen = depth; return; }
      walk(nd.left, depth + 1); walk(nd.right, depth + 1);
    };
    walk(root, 0);
    if (maxLen <= maxBits) return lengths;
    for (const s of syms) f[s] = Math.max(1, Math.floor(f[s] / 2));
  }
  // Last resort: cap lengths (still a valid prefix code when rebuilt below).
  for (const s of syms) if (lengths[s] > maxBits) lengths[s] = maxBits;
  return lengths;
}
function canonicalCodes(lengths) {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
  return codes;
}
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// Emit one dynamic-Huffman DEFLATE block. Tokens are parallel arrays:
// isMatch (0 literal, 1 match), lit (byte), mlen, mdist. `last` sets BFINAL.
function emitBlock(bw, isMatch, lit, mlen, mdist, ntok, last) {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < ntok; i++) {
    if (isMatch[i]) { litFreq[257 + lenCodeOf(mlen[i])]++; distFreq[distCodeOf(mdist[i])]++; }
    else litFreq[lit[i]]++;
  }
  litFreq[256]++;
  const litLen = buildLengths(litFreq, 15);
  const distLen = buildLengths(distFreq, 15);
  let hlit = 257;
  for (let i = 285; i >= 257; i--) if (litLen[i] > 0) { hlit = i + 1; break; }
  let hdist = 1;
  for (let i = 29; i >= 1; i--) if (distLen[i] > 0) { hdist = i + 1; break; }
  // RLE of the combined code lengths.
  const all = new Uint8Array(hlit + hdist);
  all.set(litLen.subarray(0, hlit), 0);
  all.set(distLen.subarray(0, hdist), hlit);
  const items = []; // [sym, extraBits, extraVal]
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const k = Math.min(r, 138); items.push([18, 7, k - 11]); r -= k; }
      if (r >= 3) items.push([17, 3, r - 3]);
      else for (let k = 0; k < r; k++) items.push([0, 0, 0]);
    } else {
      items.push([v, 0, 0]);
      let r = run - 1;
      while (r >= 3) { const k = Math.min(r, 6); items.push([16, 2, k - 3]); r -= k; }
      for (let k = 0; k < r; k++) items.push([v, 0, 0]);
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const [s] of items) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 4;
  for (let k = 18; k >= 4; k--) if (clLen[CL_ORDER[k]] > 0) { hclen = k + 1; break; }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  bw.put(last ? 1 : 0, 1);
  bw.put(2, 2);
  bw.put(hlit - 257, 5);
  bw.put(hdist - 1, 5);
  bw.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.put(clLen[CL_ORDER[k]], 3);
  for (const [s, eb, ev] of items) { bw.putRev(clCode[s], clLen[s]); if (eb) bw.put(ev, eb); }
  for (let t = 0; t < ntok; t++) {
    if (!isMatch[t]) bw.putRev(litCode[lit[t]], litLen[lit[t]]);
    else {
      const lc = lenCodeOf(mlen[t]);
      bw.putRev(litCode[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc]) bw.put(mlen[t] - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(mdist[t]);
      bw.putRev(distCode[dc], distLen[dc]);
      if (DIST_EXTRA[dc]) bw.put(mdist[t] - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.putRev(litCode[256], litLen[256]);
}

// ---------- DEFLATE: hash-chain match finder + shortest-path parse ----------
// One block's LZ77 candidates: bestLen/bestDist per position, window 32 KiB.
function matchFind(data, maxChain) {
  const n = data.length;
  const bestLen = new Uint16Array(n);
  const bestDist = new Uint16Array(n);
  const nearLen = new Uint16Array(n);
  const nearDist = new Uint16Array(n);
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n);
  const limit = n - 3;
  const wordAt = (p) => (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
  const BREAK_LEN = Number(process.env.SQUEEZE_BREAK ?? '128');
  for (let i = 0; i < limit; i++) {
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
    let cand = head[h];
    prev[i] = cand;
    head[h] = i;
    if (cand < 0) continue;
    const maxLen = Math.min(258, n - i);
    let best = 0, bestD = 0, near = 0, nearD = 0, chain = 0;
    const earliest = Math.max(0, i - 32768);
    while (cand >= earliest && chain < maxChain) {
      chain++;
      const dist = i - cand;
      if (best > 0 && data[cand + best] !== data[i + best]) { cand = prev[cand]; continue; }
      let len = 0;
      while (len + 4 <= maxLen && wordAt(cand + len) === wordAt(i + len)) len += 4;
      while (len < maxLen && data[cand + len] === data[i + len]) len++;
      if (len > best) {
        best = len; bestD = dist;
        if (len >= maxLen) { if (dist <= 1024) { near = len; nearD = dist; } break; }
        if (len >= BREAK_LEN) break;
      }
      if (dist <= 1024 && len > near) { near = len; nearD = dist; }
      cand = prev[cand];
    }
    if (best >= 3) { bestLen[i] = best; bestDist[i] = bestD; }
    if (near >= 3 && nearD !== bestD) { nearLen[i] = near; nearDist[i] = nearD; }
  }
  return { bestLen, bestDist, nearLen, nearDist };
}
// Shortest-path parse over the candidates. litCost[256], lenCost[29] (cost of
// the length symbol incl. extra bits), distCost[30] (dist symbol incl. extra).
// Costs are in 1/16 bit. Returns token arrays.
function optimalParse(data, bestLen, bestDist, nearLen, nearDist, litCost, lenCost, distCost) {
  const n = data.length;
  const INF = 1 << 30;
  const cost = new Int32Array(n + 1).fill(INF);
  const prevPos = new Int32Array(n + 1);
  const actLen = new Int16Array(n + 1);
  const actDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === INF) continue;
    const litC = ci + litCost[data[i]];
    if (litC < cost[i + 1]) { cost[i + 1] = litC; prevPos[i + 1] = i; actLen[i + 1] = 1; }
    // Two candidates: the longest match, and the longest nearby match
    // (a shorter match at a small distance often costs fewer bits).
    for (let k = 0; k < 2; k++) {
      const bl = k === 0 ? bestLen[i] : nearLen[i];
      if (bl < 3) continue;
      const dist = k === 0 ? bestDist[i] : nearDist[i];
      const dc = distCost[distCodeOf(dist)];
      let lastL = 0;
      for (let c = 0; c < 29; c++) {
        if (LEN_BASE[c] > bl) break;
        let L = LEN_BASE[c] + (LEN_EXTRA[c] ? (1 << LEN_EXTRA[c]) - 1 : 0);
        if (L > bl) L = bl;
        if (L === lastL) continue;
        lastL = L;
        // The length's true code: 258 belongs to code 28, not to code 27
        // whose range also reaches it. Charge the code that will be emitted.
        const mc = ci + lenCost[lenCodeOf(L)] + dc;
        if (mc < cost[i + L]) { cost[i + L] = mc; prevPos[i + L] = i; actLen[i + L] = L; actDist[i + L] = dist; }
      }
    }
  }
  // Reconstruct tokens backwards.
  const isMatch = [];
  const lit = [];
  const mlen = [];
  const mdist = [];
  let j = n;
  while (j > 0) {
    const p = prevPos[j];
    const L = actLen[j];
    if (L === 1) { isMatch.push(0); lit.push(data[p]); mlen.push(0); mdist.push(0); }
    else { isMatch.push(1); lit.push(0); mlen.push(L); mdist.push(actDist[j]); }
    j = p;
  }
  isMatch.reverse(); lit.reverse(); mlen.reverse(); mdist.reverse();
  return {
    isMatch: Uint8Array.from(isMatch), lit: Uint8Array.from(lit),
    mlen: Uint16Array.from(mlen), mdist: Uint16Array.from(mdist),
    ntok: isMatch.length,
  };
}
function costsFromTables(litLen, distLen) {
  // Floor every symbol cost at 1 bit: a symbol unused by the previous parse
  // has length 0 in the table, and a 0-bit cost would make the shortest path
  // prefer phantom matches of that length. Extra bits are real and added.
  const litCost = new Int32Array(256);
  for (let i = 0; i < 256; i++) litCost[i] = Math.max(16, litLen[i] * 16);
  const lenCost = new Int32Array(29);
  for (let c = 0; c < 29; c++) lenCost[c] = Math.max(16, litLen[257 + c] * 16) + LEN_EXTRA[c] * 16;
  const distCost = new Int32Array(30);
  for (let c = 0; c < 30; c++) distCost[c] = Math.max(16, distLen[c] * 16) + DIST_EXTRA[c] * 16;
  return { litCost, lenCost, distCost };
}
function fixedCosts() {
  const litLen = new Uint8Array(286);
  for (let i = 0; i < 144; i++) litLen[i] = 8;
  for (let i = 144; i < 256; i++) litLen[i] = 9;
  for (let i = 256; i < 280; i++) litLen[i] = 7;
  for (let i = 280; i < 288; i++) litLen[i] = 8;
  const distLen = new Uint8Array(30).fill(5);
  return costsFromTables(litLen, distLen);
}
function freqsOfTokens(t) {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < t.ntok; i++) {
    if (t.isMatch[i]) { litFreq[257 + lenCodeOf(t.mlen[i])]++; distFreq[distCodeOf(t.mdist[i])]++; }
    else litFreq[t.lit[i]]++;
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}
// Custom DEFLATE of `data` as one zlib stream (0x78DA header, Adler-32).
// Splits into 128 KiB blocks; each block gets two optimal-parse passes.
function deflateCustom(data, maxChain) {
  const BLOCK = Number(process.env.SQUEEZE_BLOCK ?? '524288');
  const bw = new BitWriter(data.length + 4096);
  const nblocks = Math.max(1, Math.ceil(data.length / BLOCK));
  for (let b = 0; b < nblocks; b++) {
    const from = b * BLOCK;
    const to = Math.min(data.length, from + BLOCK);
    const block = data.subarray(from, to);
    const { bestLen, bestDist, nearLen, nearDist } = matchFind(block, maxChain);
    const ITERS = Number(process.env.SQUEEZE_ITERS ?? '2');
    let costs = fixedCosts();
    let tok = optimalParse(block, bestLen, bestDist, nearLen, nearDist, costs.litCost, costs.lenCost, costs.distCost);
    for (let it = 1; it < ITERS; it++) {
      const { litFreq, distFreq } = freqsOfTokens(tok);
      costs = costsFromTables(buildLengths(litFreq, 15), buildLengths(distFreq, 15));
      tok = optimalParse(block, bestLen, bestDist, nearLen, nearDist, costs.litCost, costs.lenCost, costs.distCost);
    }
    emitBlock(bw, tok.isMatch, tok.lit, tok.mlen, tok.mdist, tok.ntok, b === nblocks - 1);
  }
  bw.align();
  const raw = bw.bytes();
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78; out[1] = 0xda;
  out.set(raw, 2);
  new DataView(out.buffer).setUint32(2 + raw.length, adler32(data));
  return out;
}

// ---------- Main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_CHAIN = Number(process.env.SQUEEZE_CHAIN ?? '256');
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const win = screen(image.rgba, image.width, image.height);
  const z9 = deflateSync(win.data, { level: 9, memLevel: 9 });
  let best = z9;
  let which = 'zlib9';
  try {
    const mine = deflateCustom(win.data, MAX_CHAIN);
    if (mine.length < best.length) { best = mine; which = 'custom'; }
  } catch (e) {
    console.error(id, 'custom deflate failed, using zlib9:', String(e).slice(0, 120));
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), pngOfForm(image.width, image.height, win.form, best));
  console.log(`${id} ct=${win.form.colourType} filter=${win.choice} screen6=${win.bytes} zlib9=${z9.length} chose=${which} bytes=${best.length}`);
}

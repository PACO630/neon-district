// Procedural PBR texture synthesis (base color, normal, ORM = AO/roughness/metalness, emissive).
// Generated once at load on the client: zero texture download, resolution chosen per quality level.
import * as THREE from 'three';

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  orm: THREE.Texture;          // R = AO, G = roughness, B = metalness (glTF convention, as used by three)
  emissiveMap?: THREE.Texture;
  mask?: THREE.Texture;        // extra data (puddle mask etc.)
}

let maxAniso = 4;
export function setMaxAnisotropy(n: number): void { maxAniso = n; }

// ---------------------------------------------------------------- noise
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
/** Tileable value-noise fBm, returns values ~0..1 */
export function fbm(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const cell = size / period;
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = hash2(i % period, Math.floor(i / period), seed + o * 101);
    for (let y = 0; y < size; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy) % period;
      const y1 = (y0 + 1) % period;
      let fy = gy - Math.floor(gy);
      fy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx) % period;
        const x1 = (x0 + 1) % period;
        let fx = gx - Math.floor(gx);
        fx = fx * fx * (3 - 2 * fx);
        const a = grid[y0 * period + x0], b = grid[y0 * period + x1], c = grid[y1 * period + x0], d = grid[y1 * period + x1];
        out[y * size + x] += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
      }
    }
    total += amp;
    amp *= gain;
    period = Math.min(period * 2, size);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function heightToNormal(h: Float32Array, size: number, strength: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function tex(data: Uint8ClampedArray, size: number, srgb: boolean, repeat = true): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(data.buffer), size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function rgba(size: number): Uint8ClampedArray { return new Uint8ClampedArray(size * size * 4); }
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- materials
/** Wet asphalt: dark aggregate, cracks, tar seams. `mask` R = puddle depth (low frequency), G = cracks. */
export function asphalt(size: number, seed = 11): PBRSet {
  const big = fbm(size, 4, 4, seed);
  const fine = fbm(size, 64, 3, seed + 5, 0.6);
  const grit = fbm(size, Math.min(size, 256), 1, seed + 9);
  const puddleN = fbm(size, 3, 4, seed + 17, 0.55);
  const crackN = fbm(size, 8, 5, seed + 23, 0.55);
  const col = rgba(size), orm = rgba(size), mask = rgba(size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const crack = clamp01(1 - Math.abs(crackN[i] - 0.5) * 40); // thin ridge lines
    const puddle = clamp01((puddleN[i] - 0.52) * 5.5);
    const speck = grit[i] > 0.82 ? (grit[i] - 0.82) * 2.5 : 0;
    const base = 0.055 + big[i] * 0.05 + fine[i] * 0.03 + speck * 0.12 - crack * 0.03;
    const tint = big[i] * 0.01;
    col[i * 4] = clamp01(base + tint) * 255;
    col[i * 4 + 1] = clamp01(base + tint * 0.5) * 255;
    col[i * 4 + 2] = clamp01(base + 0.006) * 255;
    col[i * 4 + 3] = 255;
    height[i] = fine[i] * 0.6 + grit[i] * 0.4 - crack * 0.8 - puddle * 0.3;
    orm[i * 4] = (1 - crack * 0.5) * 255;
    orm[i * 4 + 1] = clamp01(0.62 + fine[i] * 0.25 + speck * 0.2 - puddle * 0.5) * 255;
    orm[i * 4 + 2] = 0;
    orm[i * 4 + 3] = 255;
    mask[i * 4] = puddle * 255;
    mask[i * 4 + 1] = crack * 255;
    mask[i * 4 + 2] = big[i] * 255;
    mask[i * 4 + 3] = 255;
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(height, size, size / 96), size, false), orm: tex(orm, size, false), mask: tex(mask, size, false) };
}

/** Weathered concrete with rain streak stains running down. */
export function concrete(size: number, seed = 3, tone = 0.32): PBRSet {
  const big = fbm(size, 4, 4, seed);
  const fine = fbm(size, 128, 2, seed + 1);
  const pits = fbm(size, Math.min(256, size), 1, seed + 2);
  const streakCols = fbm(size, 32, 2, seed + 4);
  const col = rgba(size), orm = rgba(size), h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const streak = clamp01((streakCols[x] - 0.55) * 4) * (0.5 + 0.5 * big[i]);
      const pit = pits[i] > 0.86 ? 1 : 0;
      const v = tone * (0.75 + big[i] * 0.4 + fine[i] * 0.15) * (1 - streak * 0.45) * (1 - pit * 0.4);
      col[i * 4] = clamp01(v) * 255;
      col[i * 4 + 1] = clamp01(v * 1.0) * 255;
      col[i * 4 + 2] = clamp01(v * 1.06) * 255;
      col[i * 4 + 3] = 255;
      h[i] = fine[i] * 0.5 + big[i] * 0.3 - pit * 0.6;
      orm[i * 4] = (1 - pit * 0.6 - streak * 0.1) * 255;
      orm[i * 4 + 1] = clamp01(0.82 + fine[i] * 0.15 - streak * 0.35) * 255;
      orm[i * 4 + 2] = 0;
      orm[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, size / 64), size, false), orm: tex(orm, size, false) };
}

/** Riveted metal panels with seams, grime and scratches. */
export function metalPanels(size: number, seed = 7, tint: [number, number, number] = [0.22, 0.24, 0.27], panels = 4): PBRSet {
  const grime = fbm(size, 4, 5, seed);
  const scratch = fbm(size, Math.min(size, 512), 1, seed + 3);
  const fine = fbm(size, 64, 2, seed + 8);
  const col = rgba(size), orm = rgba(size), h = new Float32Array(size * size);
  const cell = size / panels;
  const r = rng(seed);
  const panelTone: number[] = Array.from({ length: panels * panels }, () => 0.85 + r() * 0.3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const px = x % cell, py = y % cell;
      const seam = Math.min(px, py, cell - px, cell - py) < 2 ? 1 : 0;
      const rx = px - 8, ry = py - 8, rx2 = cell - px - 8, ry2 = cell - py - 8;
      const rivet = [Math.hypot(rx, ry), Math.hypot(rx2, ry), Math.hypot(rx, ry2), Math.hypot(rx2, ry2)].some((d) => d < 3) ? 1 : 0;
      const pt = panelTone[Math.floor(y / cell) * panels + Math.floor(x / cell)];
      const sc = scratch[i] > 0.9 ? 1 : 0;
      const g = clamp01((grime[i] - 0.45) * 2);
      const k = pt * (1 - g * 0.55) * (1 - seam * 0.6) + sc * 0.15;
      col[i * 4] = clamp01(tint[0] * k) * 255;
      col[i * 4 + 1] = clamp01(tint[1] * k) * 255;
      col[i * 4 + 2] = clamp01(tint[2] * k) * 255;
      col[i * 4 + 3] = 255;
      h[i] = -seam * 1 + rivet * 0.8 + fine[i] * 0.05 - sc * 0.1;
      orm[i * 4] = (1 - seam * 0.7) * 255;
      orm[i * 4 + 1] = clamp01(0.32 + g * 0.45 + fine[i] * 0.1 - sc * 0.15) * 255;
      orm[i * 4 + 2] = clamp01(0.55 - g * 0.35) * 255;
      orm[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, 2.2), size, false), orm: tex(orm, size, false) };
}

/** Building facade: window grid with lit interiors (emissive), blinds, frames. One texture tile = 4x4 windows. */
export function facade(size: number, seed: number, style: 'office' | 'residential' | 'industrial'): PBRSet {
  const r = rng(seed);
  // fine window grid; lighting comes in whole-floor runs (occupied offices / flats) instead of
  // random per-window confetti, mostly in warm white with a few cool screens
  const cols = 16, rows = 16;
  const cw = size / cols, ch = size / rows;
  const grime = fbm(size, 4, 4, seed + 1);
  const col = rgba(size), orm = rgba(size), emi = rgba(size), h = new Float32Array(size * size);
  const warm: [number, number, number][] = [[1.0, 0.82, 0.58], [1.0, 0.9, 0.74], [0.98, 0.95, 0.88]];
  const cool: [number, number, number][] = [[0.6, 0.86, 1.0], [0.45, 0.95, 0.95]];
  const win: { lit: number; c: [number, number, number]; blind: number; flicker: number }[] = [];
  const floorLit = style === 'office' ? 0.5 : style === 'residential' ? 0.4 : 0.18;
  for (let y = 0; y < rows; y++) {
    const floorOn = r() < floorLit;
    const floorColor = r() < 0.82 ? warm[Math.floor(r() * warm.length)] : cool[Math.floor(r() * cool.length)];
    let runOn = floorOn;
    for (let x = 0; x < cols; x++) {
      if (r() < 0.18) runOn = floorOn ? r() < 0.75 : r() < 0.12;
      win.push({ lit: runOn ? 0.45 + r() * 0.4 : 0, c: floorColor, blind: style === 'office' ? 0 : r() < 0.5 ? 0.3 + r() * 0.5 : 0, flicker: r() });
    }
  }
  const frameT = style === 'office' ? 0.05 : style === 'residential' ? 0.18 : 0.26;
  const base: [number, number, number] = style === 'office' ? [0.16, 0.17, 0.19] : style === 'residential' ? [0.3, 0.29, 0.29] : [0.34, 0.33, 0.31];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cx = Math.floor(x / cw), cy = Math.floor(y / ch);
      const lx = (x % cw) / cw, ly = (y % ch) / ch;
      const inWin = lx > frameT && lx < 1 - frameT && ly > frameT * 1.4 && ly < 1 - frameT * 0.8;
      const w = win[cy * cols + cx];
      const g = clamp01((grime[i] - 0.4) * 1.6);
      if (inWin) {
        const wy = (ly - frameT * 1.4) / (1 - frameT * 2.2);
        const blinds = w.blind && wy < w.blind ? (Math.floor(wy * 40) % 2 === 0 ? 0.55 : 0.9) : 1;
        const interiorGrad = 0.6 + 0.4 * Math.sin(lx * Math.PI);
        const e = w.lit * blinds * interiorGrad;
        col[i * 4] = 14; col[i * 4 + 1] = 18; col[i * 4 + 2] = 24; col[i * 4 + 3] = 255;
        emi[i * 4] = clamp01(w.c[0] * e) * 255;
        emi[i * 4 + 1] = clamp01(w.c[1] * e) * 255;
        emi[i * 4 + 2] = clamp01(w.c[2] * e) * 255;
        orm[i * 4] = 255; orm[i * 4 + 1] = 0.06 * 255; orm[i * 4 + 2] = 0.1 * 255;
        h[i] = -0.6;
      } else {
        const sill = ly > 1 - frameT * 0.8 - 0.02 && ly < 1 - frameT * 0.8 + 0.02 ? 1 : 0;
        const k = (1 - g * 0.5) * (sill ? 1.3 : 1);
        col[i * 4] = clamp01(base[0] * k) * 255;
        col[i * 4 + 1] = clamp01(base[1] * k) * 255;
        col[i * 4 + 2] = clamp01(base[2] * k) * 255;
        col[i * 4 + 3] = 255;
        orm[i * 4] = 230;
        orm[i * 4 + 1] = clamp01(style === 'office' ? 0.35 + g * 0.3 : 0.75 + g * 0.2) * 255;
        orm[i * 4 + 2] = style === 'office' ? 0.7 * 255 : 0.05 * 255;
        h[i] = sill * 0.4 + grime[i] * 0.1;
      }
      orm[i * 4 + 3] = 255;
      emi[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, 3), size, false), orm: tex(orm, size, false), emissiveMap: tex(emi, size, true) };
}

/** Plaza stone tiles with grout lines. */
export function tiles(size: number, seed = 31, n = 4): PBRSet {
  const big = fbm(size, 4, 4, seed);
  const fine = fbm(size, 128, 2, seed + 2);
  const r = rng(seed);
  const tone = Array.from({ length: n * n }, () => 0.8 + r() * 0.35);
  const col = rgba(size), orm = rgba(size), h = new Float32Array(size * size), mask = rgba(size);
  const cell = size / n;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const px = x % cell, py = y % cell;
      const d = Math.min(px, py, cell - px, cell - py);
      const grout = d < size / 256 + 1 ? 1 : 0;
      const t = tone[Math.floor(y / cell) * n + Math.floor(x / cell)];
      const v = grout ? 0.04 : 0.14 * t * (0.85 + big[i] * 0.3 + fine[i] * 0.1);
      col[i * 4] = clamp01(v) * 255;
      col[i * 4 + 1] = clamp01(v * 1.01) * 255;
      col[i * 4 + 2] = clamp01(v * 1.08) * 255;
      col[i * 4 + 3] = 255;
      h[i] = grout ? -1 : fine[i] * 0.1 - clamp01(1 - d / 6) * 0.3;
      orm[i * 4] = grout ? 140 : 255;
      orm[i * 4 + 1] = clamp01(grout ? 0.9 : 0.4 + fine[i] * 0.2) * 255;
      orm[i * 4 + 2] = 0;
      orm[i * 4 + 3] = 255;
      mask[i * 4] = clamp01((big[i] - 0.5) * 4 + grout * 0.6) * 255;
      mask[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, 2), size, false), orm: tex(orm, size, false), mask: tex(mask, size, false) };
}

/** Corrugated, painted shipping-container steel with rust. */
export function corrugated(size: number, seed: number, paint: [number, number, number]): PBRSet {
  const rust = fbm(size, 4, 5, seed);
  const fine = fbm(size, 64, 2, seed + 3);
  const col = rgba(size), orm = rgba(size), h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const ridge = Math.sin((x / size) * Math.PI * 2 * 16);
      const rr = clamp01((rust[i] - 0.58) * 4 + (y / size > 0.9 ? 0.4 : 0));
      const p = 0.85 + fine[i] * 0.2;
      col[i * 4] = clamp01(paint[0] * p * (1 - rr) + 0.25 * rr) * 255;
      col[i * 4 + 1] = clamp01(paint[1] * p * (1 - rr) + 0.11 * rr) * 255;
      col[i * 4 + 2] = clamp01(paint[2] * p * (1 - rr) + 0.05 * rr) * 255;
      col[i * 4 + 3] = 255;
      h[i] = ridge * 0.5 + fine[i] * 0.1;
      orm[i * 4] = (0.85 + ridge * 0.15) * 255;
      orm[i * 4 + 1] = clamp01(0.45 + rr * 0.45 + fine[i] * 0.1) * 255;
      orm[i * 4 + 2] = clamp01(0.35 - rr * 0.3) * 255;
      orm[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, 4), size, false), orm: tex(orm, size, false) };
}

/** Diamond-plate / grating floor for catwalks. */
export function grating(size: number, seed = 51): PBRSet {
  const grime = fbm(size, 4, 4, seed);
  const col = rgba(size), orm = rgba(size), h = new Float32Array(size * size);
  const cell = size / 16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const px = (x % cell) / cell, py = (y % cell) / cell;
      const flip = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const dx = flip ? px - py : px + py - 1;
      const bump = Math.abs(dx) < 0.12 && Math.abs(px - 0.5) < 0.4 && Math.abs(py - 0.5) < 0.4 ? 1 : 0;
      const g = clamp01((grime[i] - 0.4) * 2);
      const v = 0.26 * (1 - g * 0.5) + bump * 0.04;
      col[i * 4] = v * 255; col[i * 4 + 1] = v * 255; col[i * 4 + 2] = v * 1.05 * 255; col[i * 4 + 3] = 255;
      h[i] = bump;
      orm[i * 4] = 255;
      orm[i * 4 + 1] = clamp01(0.35 + g * 0.4 - bump * 0.1) * 255;
      orm[i * 4 + 2] = clamp01(0.9 - g * 0.4) * 255;
      orm[i * 4 + 3] = 255;
    }
  }
  return { map: tex(col, size, true), normalMap: tex(heightToNormal(h, size, 3), size, false), orm: tex(orm, size, false) };
}

// ---------------------------------------------------------------- canvas-based (text, signs, ads)
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

/** Neon tube-style text sign (emissive map). Text glow is baked lightly; Bloom does the rest. */
export function neonText(text: string, color: string, opts: { font?: string; w?: number; h?: number; bg?: string; frame?: boolean; vertical?: boolean } = {}): THREE.CanvasTexture {
  const w = opts.w ?? 1024, hh = opts.h ?? 256;
  return canvasTexture(w, hh, (ctx) => {
    ctx.fillStyle = opts.bg ?? '#000';
    ctx.fillRect(0, 0, w, hh);
    if (opts.frame) {
      ctx.strokeStyle = color;
      ctx.lineWidth = hh * 0.03;
      ctx.shadowColor = color;
      ctx.shadowBlur = hh * 0.06;
      ctx.strokeRect(hh * 0.06, hh * 0.06, w - hh * 0.12, hh - hh * 0.12);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const font = opts.font ?? '700 {s}px Orbitron, Rajdhani, "PingFang TC", "Microsoft JhengHei", sans-serif';
    if (opts.vertical) {
      const chars = [...text];
      const s = Math.min(w * 0.8, (hh * 0.9) / chars.length);
      ctx.font = font.replace('{s}', String(Math.floor(s)));
      chars.forEach((ch, i) => {
        const y = hh * 0.05 + s * (i + 0.5);
        ctx.shadowColor = color; ctx.shadowBlur = s * 0.25; ctx.fillStyle = color; ctx.fillText(ch, w / 2, y);
        ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.65; ctx.fillText(ch, w / 2, y); ctx.globalAlpha = 1;
      });
      return;
    }
    let s = hh * 0.62;
    ctx.font = font.replace('{s}', String(Math.floor(s)));
    const mw = ctx.measureText(text).width;
    if (mw > w * 0.88) { s *= (w * 0.88) / mw; ctx.font = font.replace('{s}', String(Math.floor(s))); }
    ctx.shadowColor = color;
    ctx.shadowBlur = s * 0.3;
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, hh / 2);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, w / 2, hh / 2);
    ctx.globalAlpha = 1;
  });
}

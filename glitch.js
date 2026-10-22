/*
 * Glitch Simulator
 *
 * Every frame starts from a clean source picture (text card, test card, image
 * or camera) and runs it through a pixel pipeline on a 2D canvas:
 *
 *   rows      per-row horizontal offsets: VHS wobble, tracking band, slices
 *   main      RGB channel split + row offsets + vertical roll in one pass
 *   blocks    macroblock corruption: displaced, tinted, flat and bleeding blocks
 *   mosh      blocks that keep dragging the previous frame (datamosh)
 *   sort      pixel sorting of runs inside horizontal bands
 *   crush     bit-depth reduction
 *   noise     static lines and snow (film grain is composited by the canvas)
 *
 * Effects sit at a low "calm" level and swell during bursts, which happen at
 * random (burst rate) or on demand (Glitch button, G / Space, holding the screen).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Canvas and buffers
  // ---------------------------------------------------------------------------

  const compact = Math.min(window.innerWidth, window.screen.width) < 720;
  const W = compact ? 640 : 960;
  const H = Math.round((W * 9) / 16);
  const U = W / 960; // effect sizes below are tuned in 960px-wide units
  const N = W * H;
  const FRAME_MS = 1000 / 30;

  const canvas = document.getElementById('screen');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Static sources are painted once into `base`; the camera is painted every frame.
  const base = document.createElement('canvas');
  base.width = W;
  base.height = H;
  const bctx = base.getContext('2d', { willReadFrequently: true });

  const outImg = ctx.createImageData(W, H);
  const d = outImg.data;
  const d8 = new Uint8Array(d.buffer); // unclamped view for lookup-table passes
  const d32 = new Uint32Array(d.buffer);
  const crushLUT = new Uint8Array(256);
  const prev = new Uint8ClampedArray(N * 4);
  let hasPrev = false;
  let srcData = null;

  const rowOff = new Float32Array(H);
  const rowShift = new Int32Array(H);
  const rowNoise = new Float32Array(H);
  const sortBuf = new Float64Array(W);
  const TWO32 = 4294967296;

  const NOISE_SIZE = 1 << 16;
  const NOISE_MASK = NOISE_SIZE - 1;
  const noiseTab = new Float32Array(NOISE_SIZE);
  for (let i = 0; i < NOISE_SIZE; i++) noiseTab[i] = Math.random() + Math.random() - 1;

  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
  const DISPLAY = '"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif';

  const rand = (a, b) => a + Math.random() * (b - a);
  const irand = (a, b) => Math.floor(rand(a, b + 1));
  const chance = (p) => Math.random() < p;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---------------------------------------------------------------------------
  // Effects, presets and state
  // ---------------------------------------------------------------------------

  // `calm` is the share of each effect that stays on between bursts.
  const EFFECTS = [
    { id: 'rgb', label: 'RGB split', calm: 0.35 },
    { id: 'slice', label: 'Slice shift', calm: 0.2 },
    { id: 'wobble', label: 'VHS tracking', calm: 0.5 },
    { id: 'blocks', label: 'Block corruption', calm: 0.15 },
    { id: 'smear', label: 'Datamosh smear', calm: 0.35 },
    { id: 'sort', label: 'Pixel sort', calm: 0.7 },
    { id: 'crush', label: 'Bit crush', calm: 0.8 },
    { id: 'noise', label: 'Static noise', calm: 0.6 },
  ];

  const PRESETS = {
    'Signal loss': { rgb: 0.45, slice: 0.45, wobble: 0.3, blocks: 0.3, smear: 0.15, sort: 0, crush: 0, noise: 0.3, scan: 0.5 },
    'VHS': { rgb: 0.35, slice: 0.12, wobble: 0.75, blocks: 0, smear: 0.05, sort: 0, crush: 0.1, noise: 0.55, scan: 0.7 },
    'Broken stream': { rgb: 0.2, slice: 0.4, wobble: 0, blocks: 0.85, smear: 0.7, sort: 0, crush: 0.25, noise: 0.05, scan: 0.15 },
    'Pixel sort': { rgb: 0.3, slice: 0.2, wobble: 0, blocks: 0.05, smear: 0, sort: 0.85, crush: 0.15, noise: 0.1, scan: 0.2 },
    'Meltdown': { rgb: 0.9, slice: 0.8, wobble: 0.6, blocks: 0.7, smear: 0.8, sort: 0.5, crush: 0.5, noise: 0.6, scan: 0.6 },
    'Clean': { rgb: 0, slice: 0, wobble: 0, blocks: 0, smear: 0, sort: 0, crush: 0, noise: 0.05, scan: 0.3 },
  };

  const CHANNEL = { text: 'CH 03', test: 'CH 00', image: 'AUX', camera: 'CAM' };
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const state = {
    params: { ...PRESETS['Signal loss'] },
    preset: 'Signal loss',
    master: 0.75,
    rate: 0.35,
    osd: true,
    source: 'text',
    text: 'SIGNAL LOST',
    running: true,
    holds: new Set(),
    burst: 0,
    recording: false,
  };

  // Glitch structures; re-rolled at random, more often during bursts.
  const fx = {
    slices: [],
    blocks: [],
    sorts: [],
    moshes: [],
    vroll: 0,
    rgbX: 1,
    rgbY: 0.25,
    drop: -1,
    invert: null,
  };

  function amounts() {
    const A = {};
    const b = state.burst;
    for (const e of EFFECTS) A[e.id] = Math.min(1, state.params[e.id] * state.master * (e.calm + (1 - e.calm) * b));
    return A;
  }

  // ---------------------------------------------------------------------------
  // Glitch structures
  // ---------------------------------------------------------------------------

  function regenSlices(a) {
    fx.slices.length = 0;
    if (a < 0.005) return;
    const n = Math.floor(Math.random() * (a * 14 + 0.5));
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, Math.round(rand(2, 4 + a * 70) * U));
      const y0 = irand(0, H - 1);
      fx.slices.push({ y0, y1: Math.min(H, y0 + h), dx: Math.round((Math.random() - 0.5) * 2 * a * W * 0.18) });
    }
  }

  const BLOCK_SIZES = [8, 16, 16, 32, 32, 64];

  function regenBlocks(a) {
    fx.blocks.length = 0;
    if (a < 0.005) return;
    const n = Math.floor(Math.random() * (a * 34 + 0.5));
    for (let i = 0; i < n; i++) {
      const bs = Math.max(4, Math.round(BLOCK_SIZES[irand(0, BLOCK_SIZES.length - 1)] * U));
      const maxW = Math.max(bs, Math.floor((W * 0.5) / bs) * bs);
      const w = Math.min(maxW, bs * irand(1, 1 + Math.round(a * 8)));
      const h = Math.min(H, bs * irand(1, 2 + Math.round(a * 2)));
      const x = irand(0, Math.floor((W - w) / bs)) * bs;
      const y = irand(0, Math.floor((H - h) / bs)) * bs;
      const r = Math.random();
      const type = r < 0.3 ? 0 : r < 0.55 ? 1 : r < 0.75 ? 2 : 3;
      fx.blocks.push({
        x, y, w, h, type,
        sx: clamp(x + Math.round(rand(-0.25, 0.25) * W), 0, W - w),
        sy: clamp(y + Math.round(rand(-0.15, 0.15) * H), 0, H - h),
        ch: irand(0, 2),
      });
    }
  }

  // Rough luma range of a source row; sorting flat rows changes nothing.
  function rowContrast(y) {
    if (!srcData) return 0;
    let lo = 255;
    let hi = 0;
    for (let x = 0, o = y * W * 4; x < W; x += 8, o += 32) {
      const l = (srcData[o] * 54 + srcData[o + 1] * 183 + srcData[o + 2] * 19) >> 8;
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
    return hi - lo;
  }

  function regenSorts(a) {
    fx.sorts.length = 0;
    if (a < 0.005) return;
    const n = 1 + Math.floor(Math.random() * (1 + a * 2.5));
    for (let i = 0; i < n; i++) {
      const h = Math.max(2, Math.round(rand(8, 20 + a * 140) * U));
      // Of a few random spots, prefer the busiest so the sort is visible.
      let y0 = 0;
      let best = -1;
      for (let tries = 0; tries < 6; tries++) {
        const y = irand(0, H - h);
        const score = rowContrast(y + (h >> 1)) + Math.random() * 40;
        if (score > best) {
          best = score;
          y0 = y;
        }
      }
      // Threshold bands sort bright runs; segment bands sort fixed-length runs
      // regardless of brightness, which streaks even flat graphics.
      const segment = chance(0.5);
      fx.sorts.push({
        y0,
        y1: y0 + h,
        t: segment ? 0 : Math.round(clamp(200 - a * 240 + rand(-25, 25), 8, 250)),
        len: segment ? Math.max(4, Math.round(rand(20, 60 + a * 300) * U)) : W,
        rev: chance(0.35),
      });
    }
  }

  function regenMoshes(a) {
    fx.moshes.length = 0;
    if (a < 0.005) return;
    const bs = Math.max(8, Math.round(16 * U));
    const step = Math.max(1, Math.round(2 * U));
    const n = Math.floor(Math.random() * a * 45 + a * 6);
    // A shared drift direction makes the smear read as one melting motion.
    const dx = irand(-2, 2);
    const dy = irand(-1, 3);
    for (let i = 0; i < n; i++) {
      const w = Math.min(W, bs * irand(1, 2 + Math.round(a * 6)));
      const h = Math.min(H, bs * irand(1, 2 + Math.round(a * 4)));
      let mx = (dx + irand(-1, 1)) * step;
      let my = (dy + irand(-1, 1)) * step;
      if (!mx && !my) my = step;
      fx.moshes.push({
        x: irand(0, Math.floor((W - w) / bs)) * bs,
        y: irand(0, Math.floor((H - h) / bs)) * bs,
        w, h, mx, my,
      });
    }
  }

  function evolve(A, force) {
    const b = state.burst;
    const churn = force ? 1 : 0.12 + 0.75 * b;
    if (chance(churn) || A.slice < 0.005) regenSlices(A.slice);
    if (chance(churn) || A.blocks < 0.005) regenBlocks(A.blocks);
    if (chance(churn * 0.35) || A.sort < 0.005 || !fx.sorts.length) regenSorts(A.sort);
    if (chance(force ? 1 : 0.06 + 0.5 * b) || A.smear < 0.005) regenMoshes(A.smear);

    if (b > 0.3 && chance(b * 0.7)) {
      fx.rgbX = rand(-1.6, 1.6);
      fx.rgbY = rand(-1, 1);
    } else if (b < 0.1) {
      fx.rgbX = 1;
      fx.rgbY = 0.25;
    }

    // Vertical hold: jump, then settle back over a few frames.
    fx.vroll = Math.trunc(fx.vroll * 0.55);
    if (b > 0.6 && chance(0.1 * (A.wobble + A.slice))) fx.vroll = irand(-H * 0.35, H * 0.35);

    fx.drop = b > 0.55 && A.rgb > 0.08 && chance(0.1) ? irand(0, 2) : -1;

    fx.invert = null;
    if (b > 0.5 && A.slice + A.blocks > 0.2 && chance(0.07)) {
      const h = irand(4, Math.round(H / 8));
      const y0 = irand(0, H - h);
      fx.invert = { y0, y1: y0 + h };
    }
  }

  // ---------------------------------------------------------------------------
  // Pixel pipeline
  // ---------------------------------------------------------------------------

  function buildRows(t, A) {
    const w = A.wobble;
    rowOff.fill(0);
    rowNoise.fill(0);

    if (w > 0.01) {
      const a1 = w * 7 * U;
      const a2 = w * 2.5 * U;
      const jit = w * 2.2 * U;
      const ph = t * 0.0021;
      for (let y = 0; y < H; y++) {
        rowOff[y] = a1 * Math.sin(y * 0.021 + ph) + a2 * Math.sin(y * 0.13 + ph * 5.3) + (Math.random() - 0.5) * jit;
      }

      // Tracking band rolling down the picture.
      const bandH = (18 + w * 70) * U;
      const period = H + bandH * 5;
      const top = ((t * 0.05 * U) % period) - bandH;
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(H, Math.ceil(top + bandH));
      for (let y = y0; y < y1; y++) {
        const k = 1 - Math.abs(((y - top) / bandH) * 2 - 1);
        rowOff[y] += (Math.random() * 0.8 + 0.2) * w * 70 * U * k;
        rowNoise[y] += k * w * 170;
      }

      // Head-switching noise along the bottom edge.
      const hs = Math.round((5 + w * 12) * U);
      for (let y = H - hs; y < H; y++) {
        const f = (y - (H - hs) + 1) / hs;
        rowOff[y] += f * w * 46 * U;
        rowNoise[y] += f * w * 110;
      }
    }

    for (const s of fx.slices) for (let y = s.y0; y < s.y1; y++) rowOff[y] += s.dx;

    if (A.noise > 0.01) {
      const lines = Math.floor(Math.random() * A.noise * 7);
      for (let i = 0; i < lines; i++) rowNoise[irand(0, H - 1)] += rand(90, 220);
    }

    for (let y = 0; y < H; y++) {
      let o = Math.round(rowOff[y]) % W;
      if (o < 0) o += W;
      rowShift[y] = o;
    }
  }

  function mainPass(s, A) {
    const rd = Math.round(A.rgb * 26 * U * fx.rgbX);
    const rdy = Math.round(A.rgb * 6 * U * fx.rgbY);
    const vroll = fx.vroll;
    for (let y = 0; y < H; y++) {
      let sy = y + vroll;
      if (sy >= H) sy -= H;
      else if (sy < 0) sy += H;
      const rowG = sy * W;
      const rowR = clamp(sy - rdy, 0, H - 1) * W;
      const rowB = clamp(sy + rdy, 0, H - 1) * W;
      const off = rowShift[y];
      let p = y * W;
      for (let x = 0; x < W; x++, p++) {
        let xs = x - off;
        if (xs < 0) xs += W;
        let xr = xs + rd;
        if (xr < 0) xr = 0;
        else if (xr >= W) xr = W - 1;
        let xb = xs - rd;
        if (xb < 0) xb = 0;
        else if (xb >= W) xb = W - 1;
        // One packed write per pixel (ABGR, little-endian like every browser).
        d32[p] = 0xff000000 | (s[((rowB + xb) << 2) + 2] << 16) | (s[((rowG + xs) << 2) + 1] << 8) | s[(rowR + xr) << 2];
      }
    }
    if (fx.drop >= 0) for (let i = fx.drop; i < d.length; i += 4) d[i] = 0;
  }

  function applyBlocks(s) {
    for (const b of fx.blocks) {
      const { x, y, w, h } = b;
      if (b.type === 0) {
        // Block copied from somewhere else in the frame.
        for (let r = 0; r < h; r++) {
          const from = ((b.sy + r) * W + b.sx) << 2;
          d.set(s.subarray(from, from + (w << 2)), ((y + r) * W + x) << 2);
        }
      } else if (b.type === 1) {
        // Wrong chroma.
        for (let r = 0; r < h; r++) {
          let o = ((y + r) * W + x) << 2;
          for (let c = 0; c < w; c++, o += 4) {
            const R = d[o];
            const Gr = d[o + 1];
            const B = d[o + 2];
            if (b.ch === 0) {
              d[o] = Gr;
              d[o + 1] = B;
              d[o + 2] = R;
            } else if (b.ch === 1) {
              d[o] = 255 - R;
              d[o + 2] = 255 - B;
            } else {
              d[o] = R >> 1;
              d[o + 1] = Gr * 0.6 + 90;
              d[o + 2] = B >> 1;
            }
          }
        }
      } else if (b.type === 2) {
        // Only the average colour survived.
        let sr = 0, sg = 0, sb = 0;
        for (let r = 0; r < h; r++) {
          let o = ((y + r) * W + x) << 2;
          for (let c = 0; c < w; c++, o += 4) {
            sr += d[o];
            sg += d[o + 1];
            sb += d[o + 2];
          }
        }
        const n = w * h;
        sr /= n;
        sg /= n;
        sb /= n;
        for (let r = 0; r < h; r++) {
          let o = ((y + r) * W + x) << 2;
          for (let c = 0; c < w; c++, o += 4) {
            d[o] = sr;
            d[o + 1] = sg;
            d[o + 2] = sb;
          }
        }
      } else {
        // The top row bleeds down.
        const y1 = Math.min(H, y + h * 3);
        const from = (y * W + x) << 2;
        const len = w << 2;
        for (let yy = y + 1; yy < y1; yy++) d.copyWithin((yy * W + x) << 2, from, from + len);
      }
    }
  }

  function applyMosh() {
    for (const m of fx.moshes) {
      const px = clamp(m.x - m.mx, 0, W - m.w);
      const len = m.w << 2;
      for (let r = 0; r < m.h; r++) {
        const py = clamp(m.y + r - m.my, 0, H - 1);
        const from = (py * W + px) << 2;
        d.set(prev.subarray(from, from + len), ((m.y + r) * W + m.x) << 2);
      }
    }
  }

  function luma(p) {
    const o = p << 2;
    return (d[o] * 54 + d[o + 1] * 183 + d[o + 2] * 19) >> 8;
  }

  function applySort() {
    for (const band of fx.sorts) {
      const { t, len: maxLen } = band;
      for (let y = band.y0; y < band.y1; y++) {
        const row = y * W;
        // Stagger segment boundaries per row so they don't line up into columns.
        let x = maxLen < W ? ((y * 2654435761) >>> 0) % maxLen : 0;
        while (x < W) {
          while (x < W && luma(row + x) < t) x++;
          const start = x;
          const stop = Math.min(W, start + maxLen);
          while (x < stop && luma(row + x) >= t) x++;
          const len = x - start;
          if (len < 2) continue;
          // Pack luma above the 32-bit pixel so a numeric sort orders by brightness.
          for (let i = 0; i < len; i++) {
            const p = row + start + i;
            sortBuf[i] = luma(p) * TWO32 + d32[p];
          }
          const run = sortBuf.subarray(0, len);
          run.sort();
          if (band.rev) run.reverse();
          for (let i = 0; i < len; i++) d32[row + start + i] = run[i] % TWO32;
        }
      }
    }
  }

  function applyInvert(band) {
    for (let i = band.y0 * W * 4, end = band.y1 * W * 4; i < end; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
  }

  let crushShift = 0;

  function applyCrush(c) {
    const shift = Math.min(6, Math.round(c * 6.5));
    if (!shift) return;
    if (shift !== crushShift) {
      crushShift = shift;
      const half = 1 << (shift - 1);
      for (let v = 0; v < 256; v++) crushLUT[v] = Math.min(255, ((v + half) >> shift) << shift);
    }
    for (let i = 0; i < d8.length; i += 4) {
      d8[i] = crushLUT[d8[i]];
      d8[i + 1] = crushLUT[d8[i + 1]];
      d8[i + 2] = crushLUT[d8[i + 2]];
    }
  }

  // Static lines, the tracking band and snow. Fine grain over the whole frame
  // is composited afterwards by drawGrain().
  function applyNoise(n) {
    for (let y = 0; y < H; y++) {
      const amp = rowNoise[y];
      if (amp < 0.5) continue;
      const lift = amp * 0.3;
      let k = (Math.random() * NOISE_SIZE) | 0;
      let o = y * W * 4;
      for (let x = 0; x < W; x++, o += 4) {
        const v = noiseTab[k] * amp + lift;
        const c = noiseTab[(k + 7919) & NOISE_MASK] * amp * 0.25;
        k = (k + 1) & NOISE_MASK;
        d[o] += v + c;
        d[o + 1] += v;
        d[o + 2] += v - c;
      }
    }
    const specks = Math.floor(n * n * 1800 * U * U);
    for (let i = 0; i < specks; i++) {
      const p = ((Math.random() * N) | 0) << 2;
      const v = chance(0.5) ? 255 : 0;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  }

  // A mid-grey noise tile in hard-light mode lightens and darkens the picture
  // around its own values, like additive grain, but the canvas does the work.
  function makeGrain(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    const p = img.data;
    for (let i = 0; i < p.length; i += 4) {
      const v = 128 + (Math.random() + Math.random() - 1) * 127;
      const ch = (Math.random() - 0.5) * 36;
      p[i] = v + ch;
      p[i + 1] = v;
      p[i + 2] = v - ch;
      p[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return ctx.createPattern(c, 'repeat');
  }

  const GRAIN_SIZE = 256;
  const grains = [makeGrain(GRAIN_SIZE), makeGrain(GRAIN_SIZE), makeGrain(GRAIN_SIZE)];

  function drawGrain(n) {
    if (n < 0.01) return;
    const ox = irand(0, GRAIN_SIZE - 1);
    const oy = irand(0, GRAIN_SIZE - 1);
    ctx.save();
    ctx.globalCompositeOperation = 'hard-light';
    ctx.globalAlpha = Math.min(1, n * 0.45);
    ctx.fillStyle = grains[irand(0, grains.length - 1)];
    ctx.translate(-ox, -oy);
    ctx.fillRect(ox, oy, W, H);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  let userImage = null;
  let userImageUrl = null;
  let stream = null;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:0';
  document.body.appendChild(video);

  function paintCover(c, img, iw, ih, mirror) {
    const scale = Math.max(W / iw, H / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    c.save();
    if (mirror) {
      c.translate(W, 0);
      c.scale(-1, 1);
    }
    c.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    c.restore();
  }

  function fitText(c, text, maxW, maxH, weight, family, lineH) {
    const words = text.trim().split(/\s+/);
    for (let size = Math.round(H * 0.3); size >= 10; size -= 2) {
      c.font = `${weight} ${size}px ${family}`;
      const lines = [];
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (!line || c.measureText(test).width <= maxW) line = test;
        else {
          lines.push(line);
          line = word;
        }
      }
      if (line) lines.push(line);
      const widest = Math.max(...lines.map((l) => c.measureText(l).width));
      if (widest <= maxW && lines.length * size * lineH <= maxH) return { lines, size };
    }
    return { lines: [text], size: 10 };
  }

  function paintTitleCard(c, text, caption) {
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0a1430');
    g.addColorStop(0.55, '#150a2c');
    g.addColorStop(1, '#2c0822');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    const horizon = Math.round(H * 0.7);
    const lw = Math.max(1, U);

    // Fine grid in the sky.
    c.strokeStyle = 'rgba(0, 229, 255, 0.07)';
    c.lineWidth = lw;
    const cell = Math.round(48 * U);
    c.beginPath();
    for (let x = (W / 2) % cell; x < W; x += cell) {
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, horizon);
    }
    for (let y = horizon - cell; y > 0; y -= cell) {
      c.moveTo(0, y + 0.5);
      c.lineTo(W, y + 0.5);
    }
    c.stroke();

    // Sunset on the horizon, striped with the sky showing through.
    const sunR = H * 0.24;
    const sun = c.createLinearGradient(0, horizon - sunR, 0, horizon);
    sun.addColorStop(0, '#ffd319');
    sun.addColorStop(0.55, '#ff2d75');
    sun.addColorStop(1, '#8c1eff');
    c.save();
    c.fillStyle = sun;
    c.shadowColor = 'rgba(255, 45, 117, 0.55)';
    c.shadowBlur = 40 * U;
    c.beginPath();
    c.arc(W / 2, horizon, sunR, Math.PI, 0);
    c.fill();
    c.restore();
    c.fillStyle = g;
    for (let i = 0; i < 6; i++) {
      const y = horizon - sunR * 0.55 * (1 - i / 6);
      c.fillRect(W / 2 - sunR, y, sunR * 2, (2 + i * 2.2) * U);
    }

    // Perspective floor.
    const floor = c.createLinearGradient(0, horizon, 0, H);
    floor.addColorStop(0, 'rgba(255, 45, 117, 0.7)');
    floor.addColorStop(1, 'rgba(255, 45, 117, 0.25)');
    c.strokeStyle = floor;
    c.beginPath();
    for (let i = -14; i <= 14; i++) {
      c.moveTo(W / 2 + i * W * 0.025, horizon);
      c.lineTo(W / 2 + i * W * 0.2, H);
    }
    for (let i = 1; i <= 9; i++) {
      const y = horizon + (H - horizon) * Math.pow(i / 9, 2);
      c.moveTo(0, y);
      c.lineTo(W, y);
    }
    c.stroke();
    c.fillStyle = 'rgba(255, 120, 170, 0.9)';
    c.fillRect(0, horizon - lw, W, lw * 2);

    // Headline.
    const lineH = 1.02;
    const { lines, size } = fitText(c, text || ' ', W * 0.84, H * 0.34, 900, DISPLAY, lineH);
    const block = lines.length * size * lineH;
    const cy = H * 0.33;
    c.font = `900 ${size}px ${DISPLAY}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0, 229, 255, 0.6)';
    c.shadowBlur = 28 * U;
    c.fillStyle = '#f5f5ff';
    lines.forEach((l, i) => c.fillText(l, W / 2, cy - block / 2 + size * lineH * (i + 0.5)));
    c.shadowBlur = 0;

    if (caption) {
      c.font = `700 ${Math.round(15 * U)}px ${MONO}`;
      c.fillStyle = 'rgba(255, 255, 255, 0.6)';
      c.fillText(caption, W / 2, cy - block / 2 - 24 * U);
    }
  }

  function paintTestCard(c, label) {
    const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
    const bottom = [['#00214c', 1.25], ['#ffffff', 1.25], ['#32006a', 1.25], ['#131313', 1.25],
      ['#090909', 1 / 3], ['#131313', 1 / 3], ['#1d1d1d', 1 / 3], ['#131313', 1]];
    const bw = W / 7;
    const h1 = Math.round(H * 0.67);
    const h2 = Math.round(H * 0.08);
    top.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(Math.floor(i * bw), 0, Math.ceil(bw) + 1, h1);
    });
    mid.forEach((col, i) => {
      c.fillStyle = col;
      c.fillRect(Math.floor(i * bw), h1, Math.ceil(bw) + 1, h2);
    });
    let x = 0;
    for (const [col, units] of bottom) {
      c.fillStyle = col;
      c.fillRect(Math.floor(x), h1 + h2, Math.ceil(units * bw) + 1, H - h1 - h2);
      x += units * bw;
    }

    // Circle and crosshair.
    const cx = W / 2;
    const cy = H * 0.4;
    const r = H * 0.3;
    c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    c.lineWidth = Math.max(2, 3 * U);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.moveTo(cx - r * 1.15, cy);
    c.lineTo(cx + r * 1.15, cy);
    c.moveTo(cx, cy - r * 1.15);
    c.lineTo(cx, cy + r * 1.15);
    c.stroke();

    // Label box.
    const text = (label || '').trim() || 'TEST';
    let size = Math.round(H * 0.075);
    c.font = `700 ${size}px ${MONO}`;
    while (size > 10 && c.measureText(text).width > W * 0.42) {
      size -= 2;
      c.font = `700 ${size}px ${MONO}`;
    }
    const tw = Math.min(W * 0.46, c.measureText(text).width);
    const bh = size * 1.7;
    c.fillStyle = '#000';
    c.fillRect(cx - tw / 2 - size * 0.7, cy - bh / 2, tw + size * 1.4, bh);
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, cx, cy + size * 0.05, W * 0.46);
  }

  function rebuildBase() {
    const c = bctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.shadowBlur = 0;
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    if (state.source === 'test') paintTestCard(c, state.text);
    else if (state.source === 'image') {
      if (userImage) paintCover(c, userImage, userImage.naturalWidth, userImage.naturalHeight, false);
      else paintTitleCard(c, 'DROP AN IMAGE', 'DRAG · PASTE · OR CHOOSE A FILE');
    } else if (state.source === 'camera') paintTitleCard(c, 'NO CAMERA', 'WAITING FOR VIDEO…');
    else paintTitleCard(c, state.text, 'PLEASE STAND BY');
    srcData = c.getImageData(0, 0, W, H).data;
  }

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('this browser has no camera access'));
    }
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  let clockSec = -1;
  let clockDate = '';
  let clockTime = '';

  // The deck's on-screen display sits on top of the picture, so it stays clean.
  function drawOSD(now) {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== clockSec) {
      clockSec = sec;
      const dt = new Date();
      clockDate = `${MONTHS[dt.getMonth()]} ${pad2(dt.getDate())} ${dt.getFullYear()}`;
      clockTime = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
    }
    const p = Math.round(22 * U);
    const fs = Math.round(21 * U);
    ctx.save();
    ctx.font = `700 ${fs}px ${MONO}`;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, Math.round(2 * U));
    ctx.fillStyle = '#f2f2f2';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    if (state.recording) {
      if (Math.floor(now / 500) % 2 === 0) {
        ctx.fillStyle = '#ff3b3b';
        ctx.fillText('● REC', p, p);
        ctx.fillStyle = '#f2f2f2';
      }
    } else {
      ctx.fillText(state.running ? 'PLAY ▶' : 'PAUSE ❚❚', p, p);
    }
    ctx.textAlign = 'right';
    ctx.fillText(CHANNEL[state.source], W - p, p);
    ctx.textBaseline = 'bottom';
    ctx.fillText('SP', W - p, H - p);
    ctx.textAlign = 'left';
    ctx.fillText(clockTime, p, H - p);
    ctx.fillText(clockDate, p, H - p - Math.round(fs * 1.25));
    ctx.restore();
  }

  // `advance` is false for still frames redrawn while paused; they leave the
  // datamosh history untouched so repeated redraws stay put.
  function render(now, advance) {
    const A = amounts();
    if (advance) evolve(A, false);
    if (state.source === 'camera' && video.readyState >= 2 && video.videoWidth) {
      paintCover(bctx, video, video.videoWidth, video.videoHeight, true);
      srcData = bctx.getImageData(0, 0, W, H).data;
    }
    const s = srcData;
    buildRows(now, A);
    mainPass(s, A);
    if (fx.blocks.length) applyBlocks(s);
    if (fx.moshes.length && hasPrev) applyMosh();
    if (fx.sorts.length) applySort();
    if (fx.invert) applyInvert(fx.invert);
    if (A.crush > 0.02) applyCrush(A.crush);
    if (advance || !hasPrev) {
      prev.set(d);
      hasPrev = true;
    }
    applyNoise(A.noise);
    ctx.putImageData(outImg, 0, 0);
    drawGrain(A.noise);
    if (state.osd) drawOSD(now);
  }

  let raf = 0;
  let last = 0;
  let frames = 0;
  let fpsAt = 0;
  let bursting = false;
  const HOLD_BURST = 1.35;

  function kick(strength) {
    state.burst = Math.max(state.burst, Math.min(1, strength));
  }

  function tick() {
    // Holding overdrives a little past a normal burst.
    if (state.holds.size) state.burst = HOLD_BURST;
    else {
      state.burst *= 0.86;
      if (state.burst < 0.01) state.burst = 0;
      if (chance(state.rate * state.rate * 0.13)) kick(rand(0.45, 1));
    }
    const on = state.burst > 0.5;
    if (on !== bursting) {
      bursting = on;
      document.body.classList.toggle('is-bursting', on);
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME_MS - 2) return;
    last = now;
    tick();
    render(now, true);

    const sig = clamp(1 - state.burst * 0.85 - Math.random() * 0.08 * (state.burst + 0.2), 0.04, 1);
    meter.style.setProperty('--sig', sig.toFixed(3));
    frames++;
    if (now - fpsAt >= 1000) {
      fpsEl.textContent = `${Math.round((frames * 1000) / (now - fpsAt))} fps`;
      frames = 0;
      fpsAt = now;
    }
  }

  let stillQueued = false;
  let stillRegen = false;

  function requestStill(regen) {
    if (state.running) return;
    stillRegen = stillRegen || regen;
    if (stillQueued) return;
    stillQueued = true;
    requestAnimationFrame((now) => {
      stillQueued = false;
      if (stillRegen) evolve(amounts(), true);
      stillRegen = false;
      render(now, false);
    });
  }

  // A burst while paused draws a fresh glitched still instead.
  function glitchNow() {
    kick(1);
    if (!state.running) {
      state.burst = 1;
      requestStill(true);
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const screenWrap = $('#screen-wrap');
  const meter = $('#meter');
  const fpsEl = $('#fps');
  const toastEl = $('#toast');
  const btnGlitch = $('#btn-glitch');
  const btnPause = $('#btn-pause');
  const btnRec = $('#btn-rec');
  const btnFile = $('#btn-file');
  const fileInput = $('#file');
  const textInput = $('#text');
  const osdInput = $('#osd');
  const radios = [...document.querySelectorAll('input[name="source"]')];

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function slider(id, label, value, onInput) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<label for="${id}">${label}</label><output id="${id}-out" for="${id}"></output>` +
      `<input type="range" id="${id}" min="0" max="100" step="1">`;
    const input = row.querySelector('input');
    const output = row.querySelector('output');
    const sync = () => {
      output.textContent = input.value;
      input.style.setProperty('--p', `${input.value}%`);
    };
    input.addEventListener('input', () => {
      sync();
      onInput(input.value / 100);
    });
    const set = (v) => {
      input.value = Math.round(v * 100);
      sync();
    };
    set(value);
    return { row, set };
  }

  function applyScan() {
    screenWrap.style.setProperty('--scan', state.params.scan);
  }

  // Effect sliders, including the display-only scanline overlay.
  const controls = {};
  const effectsEl = $('#effects');
  for (const e of [...EFFECTS, { id: 'scan', label: 'Scanlines' }]) {
    controls[e.id] = slider(`fx-${e.id}`, e.label, state.params[e.id], (v) => {
      state.params[e.id] = v;
      state.preset = null;
      markPreset();
      if (e.id === 'scan') applyScan();
      else requestStill(true);
    });
    effectsEl.appendChild(controls[e.id].row);
  }

  const signalEl = $('#signal');
  signalEl.appendChild(slider('master', 'Intensity', state.master, (v) => {
    state.master = v;
    requestStill(true);
  }).row);
  signalEl.appendChild(slider('rate', 'Burst rate', state.rate, (v) => {
    state.rate = v;
  }).row);

  const presetsEl = $('#presets');
  const chips = Object.keys(PRESETS).map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.dataset.preset = name;
    b.addEventListener('click', () => applyPreset(name));
    presetsEl.appendChild(b);
    return b;
  });

  function markPreset() {
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.preset === state.preset));
  }

  function syncControls() {
    for (const id in controls) controls[id].set(state.params[id]);
    applyScan();
    markPreset();
  }

  function applyPreset(name) {
    state.params = { ...PRESETS[name] };
    state.preset = name;
    syncControls();
    glitchNow();
  }

  function randomize() {
    const p = {};
    const pick = () => Math.round(rand(0.1, 0.95) * 100) / 100;
    for (const e of EFFECTS) p[e.id] = chance(0.6) ? pick() : 0;
    while (EFFECTS.filter((e) => p[e.id] > 0).length < 2) p[EFFECTS[irand(0, EFFECTS.length - 1)].id] = pick();
    p.scan = Math.round(rand(0.15, 0.8) * 100) / 100;
    state.params = p;
    state.preset = null;
    syncControls();
    glitchNow();
  }

  function setRunning(on) {
    state.running = on;
    btnPause.setAttribute('aria-pressed', String(!on));
    btnPause.querySelector('.btn-label').textContent = on ? 'Pause' : 'Play';
    if (on && !raf) {
      last = 0;
      fpsAt = performance.now();
      frames = 0;
      raf = requestAnimationFrame(loop);
    } else if (!on && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      fpsEl.textContent = 'paused';
      requestStill(false);
    }
  }

  function updateSourceUI() {
    const s = state.source;
    textInput.hidden = !(s === 'text' || s === 'test');
    btnFile.hidden = s !== 'image';
    btnFile.textContent = userImage ? 'Choose another image…' : 'Choose image…';
    for (const r of radios) r.checked = r.value === s;
  }

  let sourceToken = 0;

  async function setSource(kind) {
    const token = ++sourceToken;
    const previous = state.source;
    if (kind !== 'camera') stopCamera();
    if (kind === 'camera' && !stream) {
      state.source = 'camera';
      rebuildBase();
      updateSourceUI();
      requestStill(false);
      try {
        const s = await openCamera();
        // The user may have picked another source while the permission prompt was up.
        if (token !== sourceToken) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play();
      } catch (err) {
        if (token !== sourceToken) return;
        stopCamera();
        state.source = previous === 'camera' ? 'text' : previous;
        rebuildBase();
        updateSourceUI();
        requestStill(false);
        toast(err && err.name === 'NotAllowedError' ? 'Camera permission was denied' : `Camera unavailable: ${(err && err.message) || err}`);
        return;
      }
      if (token !== sourceToken) return;
      toast('Camera on: mirrored, processed locally');
    }
    state.source = kind;
    rebuildBase();
    updateSourceUI();
    glitchNow();
  }

  function loadImageFile(file) {
    if (!file || !/^image\//.test(file.type)) {
      toast('That file is not an image');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (userImageUrl) URL.revokeObjectURL(userImageUrl);
      userImage = img;
      userImageUrl = url;
      setSource('image');
      toast(`Loaded ${file.name || 'image'}`);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Could not read that image');
    };
    img.src = url;
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function savePNG() {
    canvas.toBlob((blob) => {
      if (!blob) return toast('Could not save the frame');
      download(blob, `glitch-${stamp()}.png`);
      toast('Saved PNG');
    }, 'image/png');
  }

  const canRecord = typeof window.MediaRecorder === 'function' && typeof canvas.captureStream === 'function';

  function record() {
    if (state.recording) return;
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const type = types.find((t) => MediaRecorder.isTypeSupported(t));
    const capture = canvas.captureStream(30);
    let rec;
    try {
      rec = new MediaRecorder(capture, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined);
    } catch (err) {
      capture.getTracks().forEach((t) => t.stop());
      toast('Recording is not supported here');
      return;
    }
    const chunks = [];
    let countdown = 0;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      capture.getTracks().forEach((t) => t.stop());
      clearInterval(countdown);
      state.recording = false;
      btnRec.disabled = false;
      btnRec.classList.remove('is-recording');
      btnRec.textContent = 'Record 5s';
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'video/webm' });
      download(blob, `glitch-${stamp()}.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`);
      toast('Saved clip');
    };
    try {
      rec.start();
    } catch (err) {
      capture.getTracks().forEach((t) => t.stop());
      toast('Recording is not supported here');
      return;
    }
    state.recording = true;
    if (!state.running) setRunning(true);
    btnRec.disabled = true;
    btnRec.classList.add('is-recording');
    let left = 5;
    btnRec.textContent = `● Rec ${left}`;
    countdown = setInterval(() => {
      left--;
      if (left > 0) btnRec.textContent = `● Rec ${left}`;
    }, 1000);
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), 5000);
  }

  // Press-and-hold for a sustained burst.
  function holdable(el, name) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
      state.holds.add(name);
      glitchNow();
    });
    const release = () => state.holds.delete(name);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  holdable(btnGlitch, 'button');
  holdable(screenWrap, 'screen');
  // Keyboard activation of the button (pointer presses are handled above).
  btnGlitch.addEventListener('click', (e) => {
    if (e.detail === 0) glitchNow();
  });

  btnPause.addEventListener('click', () => setRunning(!state.running));
  $('#btn-random').addEventListener('click', randomize);
  $('#btn-save').addEventListener('click', savePNG);
  if (canRecord) {
    btnRec.hidden = false;
    btnRec.addEventListener('click', record);
  }

  for (const r of radios) {
    r.addEventListener('change', () => {
      if (r.checked) setSource(r.value);
    });
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const cam = $('#src-camera');
    cam.disabled = true;
    cam.nextElementSibling.title = 'Camera access is not available in this browser';
  }

  textInput.addEventListener('input', () => {
    state.text = textInput.value;
    if (state.source === 'text' || state.source === 'test') {
      rebuildBase();
      requestStill(false);
    }
  });

  osdInput.addEventListener('change', () => {
    state.osd = osdInput.checked;
    requestStill(false);
  });

  btnFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) loadImageFile(fileInput.files[0]);
    fileInput.value = '';
  });

  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  ['dragenter', 'dragover'].forEach((type) => screenWrap.addEventListener(type, (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    screenWrap.classList.add('is-dragover');
  }));
  screenWrap.addEventListener('dragleave', (e) => {
    if (!screenWrap.contains(e.relatedTarget)) screenWrap.classList.remove('is-dragover');
  });
  screenWrap.addEventListener('drop', (e) => {
    e.preventDefault();
    screenWrap.classList.remove('is-dragover');
    if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
  });
  // Keep a stray drop elsewhere from navigating away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  window.addEventListener('paste', (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const item = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!item) return;
    e.preventDefault();
    loadImageFile(item.getAsFile());
  });

  const isTextEntry = (el) => el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
    (el.tagName === 'INPUT' && !['range', 'radio', 'checkbox', 'button'].includes(el.type)));
  // Space keeps its usual job on buttons and toggles.
  const usesSpace = (el) => el && (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && ['radio', 'checkbox'].includes(el.type)));

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'g' || (key === ' ' && !usesSpace(e.target))) {
      e.preventDefault();
      if (!e.repeat) {
        state.holds.add('key');
        glitchNow();
      }
      return;
    }
    if (e.repeat) return;
    if (key === 'p') setRunning(!state.running);
    else if (key === 'r') randomize();
    else if (key === 's') savePNG();
    else if (key === 'o') {
      osdInput.checked = !osdInput.checked;
      osdInput.dispatchEvent(new Event('change'));
    } else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'g' || e.key === ' ') state.holds.delete('key');
  });
  window.addEventListener('blur', () => state.holds.clear());

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  syncControls();
  updateSourceUI();
  rebuildBase();

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#motion-notice').hidden = false;
    state.running = false;
    btnPause.setAttribute('aria-pressed', 'true');
    btnPause.querySelector('.btn-label').textContent = 'Play';
    fpsEl.textContent = 'paused';
    state.burst = 0.6;
    requestStill(true);
  } else {
    kick(1);
    setRunning(true);
  }
})();

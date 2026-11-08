// ─────────────────────────────────────────────────────────────────────────────
//  Voice meters: for each voice, its last 8.5 s (the same history the floor
//  reads, newest at the right) and its level now. Onsets show as bright ticks, so
//  the spacing of each lane is that voice's rhythm.
// ─────────────────────────────────────────────────────────────────────────────
import { NB, HIST, VOICE_NAMES } from '../params.js';
import { bands } from '../bands.js';

export class Meters {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.score = document.createElement('canvas');
    this.score.width = HIST; this.score.height = NB;
    this.sctx = this.score.getContext('2d');
    this.img = this.sctx.createImageData(HIST, NB);
    this.rgb = Array.from({ length: NB }, () => [255, 255, 255]);
  }

  setPalette(look) {
    for (let k = 0; k < NB; k++) {
      const c = look['v' + k].clone().convertLinearToSRGB();
      this.rgb[k] = [c.r * 255, c.g * 255, c.b * 255];
    }
  }

  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, Math.round(r.width * dpr)), h = Math.max(60, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  draw() {
    const { ctx, canvas } = this, W = canvas.width, H = canvas.height, d = this.dpr || 1;
    const px = this.img.data, h = bands.hist;
    for (let k = 0; k < NB; k++) {
      const y = NB - 1 - k;                         // high voices on top
      const [r, g, b] = this.rgb[k];
      for (let row = 0; row < HIST; row++) {
        const i = (row * NB + k) * 4, lv = h[i], on = h[i + 1];
        const x = HIST - 1 - row, o = (y * HIST + x) * 4;
        const a = Math.min(1, lv * 0.9), w = Math.min(1, on * 1.2);
        px[o] = r * a + (255 - r * a) * w; px[o + 1] = g * a + (255 - g * a) * w; px[o + 2] = b * a + (255 - b * a) * w; px[o + 3] = 255;
      }
    }
    this.sctx.putImageData(this.img, 0, 0);

    ctx.clearRect(0, 0, W, H);
    const labelW = 74 * d, barW = 56 * d, gap = 8 * d;
    const sx = labelW, sw = W - labelW - barW - gap * 2, rowH = H / NB;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.score, sx, 0, sw, H);
    ctx.globalAlpha = 1;
    ctx.font = `${10 * d}px "IBM Plex Mono", monospace`;
    ctx.textBaseline = 'middle';
    for (let k = 0; k < NB; k++) {
      const y = (NB - 1 - k) * rowH, [r, g, b] = this.rgb[k];
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(0, y + rowH * 0.3, 3 * d, rowH * 0.4);
      ctx.fillStyle = 'rgba(238,241,247,0.7)';
      ctx.fillText(VOICE_NAMES[k], 8 * d, y + rowH / 2);
      const bx = W - barW, lv = bands.level[k], on = bands.onset[k];
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(bx, y + rowH * 0.22, barW, rowH * 0.56);
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(bx, y + rowH * 0.22, barW * lv, rowH * 0.56);
      if (on > 0.05) { ctx.fillStyle = `rgba(255,255,255,${Math.min(1, on)})`; ctx.fillRect(bx + barW * lv - 2 * d, y + rowH * 0.12, 2 * d, rowH * 0.76); }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, 0.5, sw - 1, H - 1);
    ctx.fillStyle = 'rgba(238,241,247,0.35)';
    ctx.textAlign = 'right'; ctx.fillText('now', sx + sw - 4 * d, H - 6 * d);
    ctx.textAlign = 'left'; ctx.fillText('−8.5 s', sx + 4 * d, H - 6 * d);
  }
}

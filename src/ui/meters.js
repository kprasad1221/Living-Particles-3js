// ─────────────────────────────────────────────────────────────────────────────
//  Meters, under the floor:
//    left   voice score — each voice's floor-lift output over the history window
//           (newest at the right) with hits as white ticks; spacing is rhythm
//    right  fine spectrum — 32 log bands in dB with the noise floor and reference
//           lines — and the inspected mapping as three aligned meters:
//             measured  the voice's input level in dB (after gain and tilt)
//             processed after the gate and normalisation (0–1)
//             output    the destination envelope (what the floor actually gets)
// ─────────────────────────────────────────────────────────────────────────────
import { NB, HIST, VOICE_NAMES, P } from '../params.js';
import { response } from '../response.js';

const COLS = NB + 1;
const DEST = { lift: 'Floor lift', rim: 'Rim breath', hits: 'Hits', colour: 'Colour drift' };

export class Meters {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.score = document.createElement('canvas'); this.score.width = HIST; this.score.height = NB;
    this.sctx = this.score.getContext('2d'); this.img = this.sctx.createImageData(HIST, NB);
    this.rgb = Array.from({ length: NB }, () => [255, 255, 255]);
    this.dpr = 1;
  }
  setPalette(look) {
    for (let k = 0; k < NB; k++) { const c = look['v' + k].clone().convertLinearToSRGB(); this.rgb[k] = [c.r * 255, c.g * 255, c.b * 255]; }
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, Math.round(r.width * dpr)), h = Math.max(60, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  draw(app, timeline) {
    const { ctx, canvas } = this, W = canvas.width, H = canvas.height, d = this.dpr;
    const px = this.img.data, hst = response.hist;
    for (let k = 0; k < NB; k++) {
      const y = NB - 1 - k, [r, g, b] = this.rgb[k];
      for (let row = 0; row < HIST; row++) {
        const i = (row * COLS + k) * 4, lv = Math.min(1, hst[i]), on = Math.min(1, hst[i + 1] * 1.2);
        const o = (y * HIST + (HIST - 1 - row)) * 4;
        px[o] = r * lv + (255 - r * lv) * on; px[o + 1] = g * lv + (255 - g * lv) * on; px[o + 2] = b * lv + (255 - b * lv) * on; px[o + 3] = 255;
      }
    }
    this.sctx.putImageData(this.img, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${10 * d}px "IBM Plex Mono", monospace`; ctx.textBaseline = 'middle';
    const labelW = 70 * d, split = Math.round(W * 0.5), rowH = H / NB;
    // score
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.score, labelW, 0, split - labelW - 8 * d, H);
    const insp = P.inspect.voice;
    for (let k = 0; k < NB; k++) {
      const y = (NB - 1 - k) * rowH, [r, g, b] = this.rgb[k];
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`; ctx.fillRect(0, y + rowH * 0.3, 3 * d, rowH * 0.4);
      ctx.fillStyle = k === insp ? 'rgba(255,255,255,0.95)' : 'rgba(238,241,247,0.6)';
      ctx.fillText(VOICE_NAMES[k], 8 * d, y + rowH / 2);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.strokeRect(labelW + 0.5, 0.5, split - labelW - 8 * d - 1, H - 1);
    const histSec = HIST / timeline.rowHz;
    ctx.fillStyle = 'rgba(238,241,247,0.35)'; ctx.textAlign = 'left';
    ctx.fillText(`−${histSec.toFixed(1)} s`, labelW + 4 * d, H - 6 * d);
    ctx.textAlign = 'right'; ctx.fillText('now', split - 12 * d, H - 6 * d); ctx.textAlign = 'left';

    // fine spectrum
    const x0 = split + 6 * d, sw = W - x0 - 4 * d, specH = H * 0.46;
    const dbLo = -96, dbHi = 0, yOf = db => specH - ((Math.max(dbLo, Math.min(dbHi, db)) - dbLo) / (dbHi - dbLo)) * (specH - 12 * d);
    const bd = timeline.bandDb, nb = bd.length, bw = sw / nb;
    for (let i = 0; i < nb; i++) {
      const y = yOf(bd[i]);
      ctx.fillStyle = 'rgba(238,241,247,0.55)';
      ctx.fillRect(x0 + i * bw + 0.5 * d, y, Math.max(1, bw - 1 * d), specH - y);
    }
    const m = P.music, line = (db, c, label) => { const y = yOf(db); ctx.fillStyle = c; ctx.fillRect(x0, y, sw, 1 * d); ctx.fillText(label, x0 + 2 * d, y - 5 * d); };
    line(m.noiseFloor, 'rgba(255,120,120,0.7)', `floor ${m.noiseFloor} dB`);
    line(m.reference, 'rgba(120,220,255,0.7)', `reference ${m.reference} dB`);
    ctx.fillStyle = 'rgba(238,241,247,0.4)'; ctx.textAlign = 'right';
    ctx.fillText('30 Hz … 16 kHz · 32 bands', x0 + sw, 7 * d); ctx.textAlign = 'left';

    // inspected mapping: measured / processed / output
    const dest = P.inspect.dest, it = timeline.interp;
    const col = dest === 'rim' || dest === 'colour' ? P.map[dest].source : insp;
    const voiceName = col === 8 ? 'global' : VOICE_NAMES[col];
    const mx = x0, my = specH + 10 * d, mw = sw, mh = (H - my) / 4;
    ctx.fillStyle = 'rgba(238,241,247,0.85)';
    ctx.fillText(`${voiceName} → ${DEST[dest]}${P.solo.dest === dest ? ' · solo' : ''}`, mx, my + mh * 0.4);
    const bar = (row, label, frac, text, c) => {
      const y = my + mh * row, bx = mx + 70 * d, bwid = mw - 70 * d - 80 * d;
      ctx.fillStyle = 'rgba(238,241,247,0.55)'; ctx.fillText(label, mx, y + mh / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(bx, y + mh * 0.25, bwid, mh * 0.5);
      ctx.fillStyle = c; ctx.fillRect(bx, y + mh * 0.25, bwid * Math.max(0, Math.min(1, frac)), mh * 0.5);
      ctx.fillStyle = 'rgba(238,241,247,0.8)'; ctx.fillText(text, bx + bwid + 6 * d, y + mh / 2);
      return { bx, bwid, y };
    };
    const inDb = it.inDb[col];
    const b1 = bar(1, 'measured', (inDb - dbLo) / (dbHi - dbLo), `${Number.isFinite(inDb) ? inDb.toFixed(1) : '—'} dB`, 'rgba(238,241,247,0.7)');
    const fx = v => b1.bx + b1.bwid * (v - dbLo) / (dbHi - dbLo);
    ctx.fillStyle = 'rgba(255,120,120,0.9)'; ctx.fillRect(fx(m.noiseFloor), b1.y + mh * 0.15, 1.5 * d, mh * 0.7);
    ctx.fillStyle = 'rgba(120,220,255,0.9)'; ctx.fillRect(fx(it.refEff[col] ?? m.reference), b1.y + mh * 0.15, 1.5 * d, mh * 0.7);
    const lv = col < NB ? timeline.levels[col] : it.level[NB];
    bar(2, 'processed', lv, `${(lv * 100).toFixed(0)} %${it.gate[col] < 0.5 ? ' · gated' : ''}`, 'rgba(238,241,247,0.9)');
    const [r, g, b] = col < NB ? this.rgb[col] : [255, 255, 255];
    let outV, outT;
    if (dest === 'hits') { outV = response.hit[insp]; outT = `${response.hitCount[insp]} hits · last ${response.lastHit[insp].toFixed(2)}`; }
    else { outV = response[dest][col] * (P.map[dest].amount ?? 1); outT = `${(outV * 100).toFixed(0)} %`; }
    bar(3, 'output', outV, outT, `rgb(${r | 0},${g | 0},${b | 0})`);
  }
}

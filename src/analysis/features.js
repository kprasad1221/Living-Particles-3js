// ─────────────────────────────────────────────────────────────────────────────
//  FEATURES — measurement, interpretation and hit detection. Pure JS (no DOM, no
//  three.js): the same code runs in the analysis worker, on the page for live
//  input, and in Node for the waveform fixtures (tools/fixtures.mjs).
//
//  Three layers, kept apart (spec §5.1):
//    measured     power per band in dB re a full-scale sine, spectral novelty, times
//    interpreted  gate, normalised level, onset events with strength
//    mapped       (response.js) envelopes per visual destination
//
//  Precise path (tracks and the test pattern): STFTs of the decoded PCM, ahead of
//  playback, with a periodic Hann window. Frame i is centred on sample i·hop
//  (the signal is zero-padded by win/2 at the start), so a frame's time is
//  i·hop / sampleRate — "window-centre" timing.
//
//    band path   4096 / 512   85.3 ms window, 10.7 ms hop @ 48 kHz  → 32 log bands, 8 voices, global,
//                                                                      novelty for the 4 low voices
//    fast path   1024 / 256   21.3 ms window, 5.33 ms hop           → novelty for the 4 high voices
//    harmonic    8192 / 1024  170.7 ms window, 21.3 ms hop          → peaks, notes (harmony.js)
//
//  Power: P_k = 2·|X_k|² / (N·Σw²) for 0 < k < N/2, so Σ P_k over a band is that band's
//  mean-square value; a full-scale sine sums to 0.5 = 0 dB. Stereo is analysed per
//  channel and the powers averaged (phase-opposed channels do not cancel).
//
//  Live path (microphone, stress test): the AnalyserNode's Blackman-windowed dB
//  spectrum, converted back to power with P_k = 2·10^(dB/10) / mean(w²), at the
//  60 Hz update rate. It has no hop control and only one snapshot per update, so
//  it is labelled "Live · basic analysis".
// ─────────────────────────────────────────────────────────────────────────────
import { fft, hann } from './fft.js';
import { BAND_EDGES, NB } from '../params.js';
import { HARMONY, framePeaks, notesFromPeaks } from './harmony.js';

// lp-analysis-2 adds the harmonic path (8192 / 1024); band and fast paths are unchanged.
export const ANALYSIS_VERSION = 'lp-analysis-2';
export const STORED_PEAKS = 12;            // strongest harmonic-path peaks kept per frame (for chroma)
export const CONFIG = {
  bandWin: 4096, bandHop: 512,
  fastWin: 1024, fastHop: 256,
  nBands: 32, fMin: 30, fMax: 16000,
  compression: 1000,       // novelty: log(1 + compression · amplitude)
  noveltyFloorDb: -80,     // bins quieter than this (amplitude, dB re full scale) add no novelty
};
export const LOW_NOVELTY_VOICES = 4;     // sub … mid take novelty from the band path
// Measured timestamp bias of each path on the isolated-burst fixture (see tools/fixtures.mjs);
// event times are corrected by these so they land on the attack.
export const BIAS = { band: 0.0250, fast: 0.0041, live: 0.0 };

const SINE_POWER = 0.5;
export const toDb = p => 10 * Math.log10(Math.max(p, 1e-15) / SINE_POWER);
export const VOICE_CENTRES = Array.from({ length: NB }, (_, k) => Math.sqrt(BAND_EDGES[k] * BAND_EDGES[k + 1]));

export function logBandEdges(sr, n = CONFIG.nBands, fMin = CONFIG.fMin, fMax = CONFIG.fMax) {
  const top = Math.min(fMax, sr / 2 * 0.999);
  return Array.from({ length: n + 1 }, (_, i) => fMin * Math.pow(top / fMin, i / n));
}

// Fractional bin weights for bands [e_i, e_{i+1}). Bin k covers [(k−½)Δ, (k+½)Δ).
// `support` is the number of whole bins of information a band really has; below 1 the
// band shares a bin with its neighbours and is not separately resolved.
export function bandWeights(edges, nfft, sr) {
  const df = sr / nfft, half = nfft / 2, out = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const f0 = edges[b], f1 = Math.min(edges[b + 1], sr / 2);
    const bins = [], w = [];
    const k0 = Math.max(1, Math.floor(f0 / df - 0.5)), k1 = Math.min(half - 1, Math.ceil(f1 / df + 0.5));
    for (let k = k0; k <= k1; k++) {
      const lo = Math.max(f0, (k - 0.5) * df), hi = Math.min(f1, (k + 0.5) * df);
      if (hi > lo) { bins.push(k); w.push((hi - lo) / df); }
    }
    out.push({ f0, f1, bins: Int32Array.from(bins), w: Float32Array.from(w), support: (f1 - f0) / df });
  }
  return out;
}
const integrate = (P, band) => { let s = 0; for (let i = 0; i < band.bins.length; i++) s += P[band.bins[i]] * band.w[i]; return s; };

// One windowed frame → one-sided power spectrum P (length N/2+1), averaged over channels.
function framePower(channels, centre, N, w, sw2, re, im, P) {
  const len = channels[0].length, C = channels.length, s0 = centre - N / 2, half = N / 2;
  P.fill(0);
  for (let c = 0; c < C; c += 2) {
    const L = channels[c], R = channels[c + 1];
    for (let n = 0; n < N; n++) {
      const s = s0 + n, inside = s >= 0 && s < len;
      re[n] = inside ? L[s] * w[n] : 0;
      im[n] = inside && R ? R[s] * w[n] : 0;
    }
    fft(re, im);
    const norm = 1 / (N * sw2);
    for (let k = 0; k <= half; k++) {
      const j = (N - k) % N;
      let p;
      if (!R) p = re[k] * re[k] + im[k] * im[k];
      else {
        // two real channels from one complex FFT: X = (Z_k + Z*_{N−k})/2, Y = (Z_k − Z*_{N−k})/2i
        const xr = re[k] + re[j], xi = im[k] - im[j], yr = re[k] - re[j], yi = im[k] + im[j];
        p = (xr * xr + xi * xi + yr * yr + yi * yi) / 4;
      }
      P[k] += (k === 0 || k === half ? 1 : 2) * p * norm;
    }
  }
  // each pair added two channels' power (an odd last channel adds one): average per channel
  for (let k = 0; k <= half; k++) P[k] /= C;
}

// Novelty of one frame: mean positive change of log-compressed amplitude over a voice's bins.
function novelty(P, prevC, curC, voices, voiceFrom, voiceTo, out, outOffset, cfg) {
  const floorAmp = Math.pow(10, cfg.noveltyFloorDb / 20);
  for (let k = 0; k < P.length; k++) {
    const a = Math.sqrt(2 * P[k]);
    curC[k] = a < floorAmp ? 0 : Math.log(1 + cfg.compression * a);
  }
  for (let v = voiceFrom; v < voiceTo; v++) {
    const b = voices[v]; let s = 0, ws = 0;
    for (let i = 0; i < b.bins.length; i++) { const k = b.bins[i]; s += b.w[i] * Math.max(0, curC[k] - prevC[k]); ws += b.w[i]; }
    out[outOffset + v - voiceFrom] = ws > 0 ? s / ws : 0;
  }
  prevC.set(curC);
}

// The whole precise analysis of decoded PCM. channels: Float32Array[] at sampleRate.
export function analyzePCM(channels, sr, cfg = CONFIG, onProgress = null) {
  const len = channels[0].length;
  const fineEdges = logBandEdges(sr, cfg.nBands, cfg.fMin, cfg.fMax);
  const out = {
    meta: {
      analysisVersion: ANALYSIS_VERSION, sampleRate: sr, length: len, duration: len / sr, channels: channels.length,
      bandWin: cfg.bandWin, bandHop: cfg.bandHop, fastWin: cfg.fastWin, fastHop: cfg.fastHop,
      timing: 'window-centre', window: 'periodic Hann', power: 'mean-square per band, dB re full-scale sine',
      stereo: 'mean of channel powers',
    },
    bandEdges: Float32Array.from(fineEdges),
  };
  // band path
  {
    const N = cfg.bandWin, H = cfg.bandHop, w = hann(N), sw2 = (3 * N) / 8;
    const fine = bandWeights(fineEdges, N, sr), voices = bandWeights(BAND_EDGES, N, sr);
    const glob = bandWeights([cfg.fMin, Math.min(cfg.fMax, sr / 2 * 0.999)], N, sr)[0];
    const frames = Math.ceil(len / H) + 1;
    const bandDb = new Float32Array(frames * cfg.nBands), voiceDb = new Float32Array(frames * NB);
    const globalDb = new Float32Array(frames), nov = new Float32Array(frames * LOW_NOVELTY_VOICES);
    const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2 + 1);
    const prevC = new Float64Array(N / 2 + 1), curC = new Float64Array(N / 2 + 1);
    for (let i = 0; i < frames; i++) {
      framePower(channels, i * H, N, w, sw2, re, im, P);
      for (let b = 0; b < fine.length; b++) bandDb[i * cfg.nBands + b] = toDb(integrate(P, fine[b]));
      for (let v = 0; v < NB; v++) voiceDb[i * NB + v] = toDb(integrate(P, voices[v]));
      globalDb[i] = toDb(integrate(P, glob));
      novelty(P, prevC, curC, voices, 0, LOW_NOVELTY_VOICES, nov, i * LOW_NOVELTY_VOICES, cfg);
      if (onProgress && i % 512 === 0) onProgress(0.6 * i / frames);
    }
    Object.assign(out, { frames, hop: H / sr, bandDb, voiceDb, globalDb, noveltyLow: nov,
      bandSupport: Float32Array.from(fine.map(b => b.support)) });
  }
  // fast path (novelty for the high voices)
  {
    const N = cfg.fastWin, H = cfg.fastHop, w = hann(N), sw2 = (3 * N) / 8;
    const voices = bandWeights(BAND_EDGES, N, sr);
    const frames = Math.ceil(len / H) + 1, k0 = LOW_NOVELTY_VOICES;
    const nov = new Float32Array(frames * (NB - k0));
    const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2 + 1);
    const prevC = new Float64Array(N / 2 + 1), curC = new Float64Array(N / 2 + 1);
    for (let i = 0; i < frames; i++) {
      framePower(channels, i * H, N, w, sw2, re, im, P);
      novelty(P, prevC, curC, voices, k0, NB, nov, i * (NB - k0), cfg);
      if (onProgress && i % 1024 === 0) onProgress(0.6 + 0.2 * i / frames);
    }
    Object.assign(out, { fastFrames: frames, fastHop: H / sr, noveltyHigh: nov });
  }
  // harmonic path (the §6 experiment): peaks and notes per frame
  {
    const hc = HARMONY, N = hc.win, H = hc.hop, w = hann(N), sw2 = (3 * N) / 8, df = sr / N, M = hc.maxNotes;
    const frames = Math.ceil(len / H) + 1;
    const notesF = new Float32Array(frames * M), notesS = new Float32Array(frames * M), nNotes = new Uint8Array(frames);
    const peakF = new Float32Array(frames * STORED_PEAKS), peakA = new Float32Array(frames * STORED_PEAKS);
    const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2 + 1);
    const pf = new Float32Array(hc.maxPeaks), pa = new Float32Array(hc.maxPeaks), nf = new Float32Array(M), ns = new Float32Array(M);
    for (let i = 0; i < frames; i++) {
      framePower(channels, i * H, N, w, sw2, re, im, P);
      const n = framePeaks(P, df, hc, pf, pa);
      nNotes[i] = notesFromPeaks(pf, pa, n, hc, nf, ns);
      notesF.set(nf, i * M); notesS.set(ns, i * M);
      for (let j = 0; j < Math.min(n, STORED_PEAKS); j++) { peakF[i * STORED_PEAKS + j] = pf[j]; peakA[i * STORED_PEAKS + j] = pa[j]; }
      if (onProgress && i % 256 === 0) onProgress(0.8 + 0.2 * i / frames);
    }
    out.harmony = { frames, hop: H / sr, win: N, maxNotes: M, notesF, notesS, nNotes, peakF, peakA, storedPeaks: STORED_PEAKS,
      config: { ...hc } };
    out.meta.harmonyWin = N; out.meta.harmonyHop = H;
  }
  onProgress?.(1);
  return out;
}

// ── Hit detection ───────────────────────────────────────────────────────────
// A frame is a hit when its novelty is a local peak (one frame of look-ahead) and
// exceeds median + k·1.4826·MAD of the preceding 0.5 s, plus an absolute minimum.
// Sensitivity 0–10 sets k (10 → 1, 0 → 7): higher sensitivity triggers more easily.
// After a hit the voice re-arms after its cooldown.
export const thresholdK = s => 1 + (10 - Math.min(10, Math.max(0, s))) * 0.6;
export const MIN_NOVELTY = 0.08;

export class OnsetDetector {
  constructor(hopSec, cooldownSec, opts = {}) {
    this.hop = hopSec; this.cool = cooldownSec;
    this.k = thresholdK(opts.sensitivity ?? 5); this.min = opts.minNovelty ?? MIN_NOVELTY;
    this.W = Math.max(8, Math.round(0.5 / hopSec));
    this.win = new Float64Array(this.W); this.wn = 0; this.wi = 0; this.sorted = [];
    this.p2 = 0; this.p1 = 0; this.t1 = 0; this.n = 0; this.last = -Infinity;
    this.threshold = this.min; this.median = 0;
  }
  _stats() {
    const s = this.sorted, m = s.length;
    if (!m) { this.median = 0; this.threshold = this.min; return; }
    const med = m & 1 ? s[m >> 1] : 0.5 * (s[m / 2 - 1] + s[m / 2]);
    const dev = s.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = m & 1 ? dev[m >> 1] : 0.5 * (dev[m / 2 - 1] + dev[m / 2]);
    this.median = med; this.threshold = med + this.k * 1.4826 * mad + this.min;
  }
  _add(v) {
    if (this.wn === this.W) {                              // drop the oldest from the sorted copy
      const old = this.win[this.wi], s = this.sorted;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < old) lo = mid + 1; else hi = mid; }
      s.splice(lo, 1);
    } else this.wn++;
    this.win[this.wi] = v; this.wi = (this.wi + 1) % this.W;
    const s = this.sorted; let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < v) lo = mid + 1; else hi = mid; }
    s.splice(lo, 0, v);
  }
  // Push the novelty of the frame at `time`; returns a hit for the previous frame, or null.
  push(v, time) {
    let hit = null;
    if (this.n >= 2) {
      this._stats();
      const p1 = this.p1;
      if (p1 > this.threshold && p1 >= this.p2 && p1 > v && this.t1 - this.last >= this.cool - 1e-9) {
        const over = (p1 - this.threshold) / Math.max(this.threshold - this.median, 1e-6);
        hit = { time: this.t1, strength: 1 - Math.exp(-0.7 - over), novelty: p1, threshold: this.threshold };
        this.last = this.t1;
      }
    }
    if (this.n >= 1) this._add(this.p1);
    this.p2 = this.p1; this.p1 = v; this.t1 = time; this.n++;
    return hit;
  }
}

// Detect hits for all voices from a precise analysis. Returns parallel typed arrays sorted by time.
// Hits within 15 ms in three or more voices share a parent transient id.
export function detectEvents(feat, opts) {
  const ev = [];
  const run = (series, count, voiceFrom, hop, bias) => {
    for (let v = 0; v < count; v++) {
      const voice = voiceFrom + v;
      const cool = (voice < 4 ? opts.cooldownLow : opts.cooldownHigh) / 1000;
      const d = new OnsetDetector(hop, cool, opts);
      const frames = series.length / count;
      for (let i = 0; i < frames; i++) {
        const h = d.push(series[i * count + v], i * hop);
        if (h) ev.push({ time: Math.max(0, h.time + bias), voice, strength: h.strength });
      }
    }
  };
  run(feat.noveltyLow, LOW_NOVELTY_VOICES, 0, feat.hop, BIAS.band);
  run(feat.noveltyHigh, NB - LOW_NOVELTY_VOICES, LOW_NOVELTY_VOICES, feat.fastHop, BIAS.fast);
  ev.sort((a, b) => a.time - b.time || a.voice - b.voice);
  const n = ev.length, out = { time: new Float64Array(n), voice: new Uint8Array(n), strength: new Float32Array(n), parent: new Int32Array(n) };
  let g = 0;
  for (let i = 0; i < n; i++) {
    out.time[i] = ev[i].time; out.voice[i] = ev[i].voice; out.strength[i] = ev[i].strength;
    if (i > 0 && ev[i].time - ev[g].time > 0.015) g = i;
    out.parent[i] = g;
  }
  // only keep a parent where three or more voices hit together
  for (let i = 0; i < n;) { let j = i; while (j < n && out.parent[j] === out.parent[i]) j++; if (j - i < 3) for (let q = i; q < j; q++) out.parent[q] = -1; i = j; }
  return out;
}

// ── Interpretation: dB → gate → normalised level ──────────────────────────────
// preserve  fixed reference: quiet passages stay quiet, sustained tones never fade out
// adaptive  the reference follows each voice's recent peak, bounded to ±12 dB, slowly
// The gate opens `gateHyst` dB above the noise floor and closes at the floor, with soft
// open/close envelopes, so it does not chatter. It holds calibration while closed.
const t90 = (ms, dt) => (ms <= 0 ? 1 : 1 - Math.exp(-Math.LN10 * dt / (ms / 1000)));
export const ADAPT_RANGE = 12, ADAPT_UP_MS = 2000, ADAPT_DOWN_MS = 20000;

export class Interpreter {
  constructor() {
    const n = NB + 1;
    this.open = new Uint8Array(n); this.gate = new Float32Array(n); this.track = new Float32Array(n).fill(NaN);
    this.inDb = new Float32Array(n); this.level = new Float32Array(n); this.refEff = new Float32Array(n);
  }
  reset() { this.open.fill(0); this.gate.fill(0); this.track.fill(NaN); this.level.fill(0); }
  // voiceDb: 8 values, globalDb: 1 value. Fills this.level (0..1, index 8 = global).
  step(voiceDb, globalDb, dt, m) {
    const go = t90(m.gateOpen, dt), gc = t90(m.gateClose, dt), up = t90(ADAPT_UP_MS, dt), dn = t90(ADAPT_DOWN_MS, dt);
    for (let k = 0; k <= NB; k++) {
      const raw = k < NB ? voiceDb[k] : globalDb;
      const tilt = k < NB ? m.tilt * Math.max(0, Math.log2(VOICE_CENTRES[k] / 500)) : 0;
      const db = (Number.isFinite(raw) ? raw : -150) + m.gain + tilt;
      this.inDb[k] = db;
      if (this.open[k]) { if (db < m.noiseFloor) this.open[k] = 0; }
      else if (db > m.noiseFloor + m.gateHyst) this.open[k] = 1;
      this.gate[k] += ((this.open[k] ? 1 : 0) - this.gate[k]) * (this.open[k] ? go : gc);
      let ref = m.reference;
      if (m.normalize === 'adaptive') {
        if (Number.isNaN(this.track[k])) this.track[k] = m.reference;
        if (this.open[k]) this.track[k] += (db - this.track[k]) * (db > this.track[k] ? up : dn);
        ref += m.adapt * Math.max(-ADAPT_RANGE, Math.min(ADAPT_RANGE, this.track[k] - m.reference));
      }
      this.refEff[k] = ref;
      const span = Math.max(ref - m.noiseFloor, 1);
      const x = Math.min(1, Math.max(0, (db - m.noiseFloor) / span));
      this.level[k] = Math.pow(x, m.curve) * this.gate[k];
    }
    return this.level;
  }
}

// ── Live (AnalyserNode) conversion ────────────────────────────────────────────
const BLACKMAN_MS = 0.42 * 0.42 + 0.5 * 0.5 / 2 + 0.08 * 0.08 / 2;      // mean(w²) = 0.3046
export function analyserToPower(db, P) {
  const c = 2 / BLACKMAN_MS;
  for (let k = 0; k < db.length; k++) {
    const d = db[k];
    P[k] = d === -Infinity || !Number.isFinite(d) ? 0 : c * Math.pow(10, d / 10);
  }
  P[0] *= 0.5;
  return P;
}

export class LiveAnalyzer {
  constructor(sr, hiSize, loSize) {
    this.sr = sr;
    this.hi = { size: hiSize, voices: bandWeights(BAND_EDGES, hiSize, sr), P: new Float64Array(hiSize / 2), prev: new Float64Array(hiSize / 2), cur: new Float64Array(hiSize / 2) };
    this.lo = loSize ? { size: loSize, voices: bandWeights(BAND_EDGES, loSize, sr), P: new Float64Array(loSize / 2), prev: new Float64Array(loSize / 2), cur: new Float64Array(loSize / 2),
      fine: bandWeights(logBandEdges(sr), loSize, sr), glob: bandWeights([CONFIG.fMin, Math.min(CONFIG.fMax, sr / 2 * 0.999)], loSize, sr)[0] } : null;
    this.hiFine = bandWeights(logBandEdges(sr), hiSize, sr);
    this.hiGlob = bandWeights([CONFIG.fMin, Math.min(CONFIG.fMax, sr / 2 * 0.999)], hiSize, sr)[0];
    this.voiceDb = new Float32Array(NB); this.bandDb = new Float32Array(CONFIG.nBands); this.globalDb = -150;
    this.nov = new Float32Array(NB); this.detectors = null; this.opts = null;
  }
  setDetect(opts, hop) {
    this.opts = opts;
    this.detectors = Array.from({ length: NB }, (_, v) => new OnsetDetector(hop, (v < 4 ? opts.cooldownLow : opts.cooldownHigh) / 1000, opts));
  }
  // dbHi / dbLo: analyser dB arrays (dbLo may be null). Returns hits found this update.
  step(dbHi, dbLo, time) {
    analyserToPower(dbHi, this.hi.P);
    const useLo = this.lo && dbLo;
    if (useLo) analyserToPower(dbLo, this.lo.P);
    const src = useLo ? this.lo : this.hi;
    const fine = useLo ? this.lo.fine : this.hiFine, glob = useLo ? this.lo.glob : this.hiGlob;
    for (let b = 0; b < fine.length; b++) this.bandDb[b] = toDb(integrate(src.P, fine[b]));
    for (let v = 0; v < NB; v++) this.voiceDb[v] = toDb(integrate((v < 4 && useLo ? this.lo : this.hi).P, (v < 4 && useLo ? this.lo : this.hi).voices[v]));
    this.globalDb = toDb(integrate(src.P, glob));
    const cfg = CONFIG;
    if (useLo) {
      novelty(this.hi.P, this.hi.prev, this.hi.cur, this.hi.voices, LOW_NOVELTY_VOICES, NB, this.nov, LOW_NOVELTY_VOICES, cfg);
      novelty(this.lo.P, this.lo.prev, this.lo.cur, this.lo.voices, 0, LOW_NOVELTY_VOICES, this.nov, 0, cfg);
    } else novelty(this.hi.P, this.hi.prev, this.hi.cur, this.hi.voices, 0, NB, this.nov, 0, cfg);
    const hits = [];
    if (this.detectors) for (let v = 0; v < NB; v++) {
      const h = this.detectors[v].push(this.nov[v], time);
      if (h) hits.push({ voice: v, time: h.time + BIAS.live, strength: h.strength });
    }
    return hits;
  }
}

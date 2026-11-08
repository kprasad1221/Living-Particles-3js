// ─────────────────────────────────────────────────────────────────────────────
//  VOICES — eight frequency bands, each followed as its own voice.
//
//  This is the analysis from Audio Geology 3JS 02.2, carried over so a track
//  reads the same in both studies. It is also the Unity AudioBands script
//  (512 bins → 8 bands, attack/release smoothing, peak-normalise) with two
//  changes that matter for particles:
//
//    range   each band keeps its own slow peak and floor, so a quiet hat and a loud
//            kick both use 0..1 (in Unity the peaks only ever grew)
//    onset   a rise larger than `onset` × the band's recent average rise fires a
//            pulse of 1 that decays with a 0.1 s half-life — the "hit" that drives
//            flashes and spark bursts (VFX Graph would call it a GPU event)
//
//  The four low voices read a 4096-point FFT (11.7 Hz bins) so sub and bass
//  separate; the four high voices read the 1024-point FFT (46.9 Hz bins) so their
//  timing stays sharp.
//
//  History: every 60 Hz step writes one row of (level, onset, norm) per voice
//  into an 8 × 512 float texture, newest row first. A tile at distance d reads
//  the row d / travel seconds old — that is how the music travels outward as
//  rings. It is the Trail CHOP / Cache TOP idea: the past kept as data.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NB, HIST, P, SIM_HZ, BAND_EDGES } from './params.js';

const coef = halfLife => 1 - Math.pow(2, -1 / (SIM_HZ * Math.max(halfLife, 1e-4)));
const PEAK_HALF = 3.0, FLOOR_HALF = 8.0, FLUX_HALF = 1.0, ONSET_HALF = 0.1;
const MIN_RANGE = 0.04, MIN_FLUX = 0.08, REFRACTORY = 4, CURVE = 1.35;

export const bands = {
  raw: new Float32Array(NB), norm: new Float32Array(NB), prev: new Float32Array(NB),
  level: new Float32Array(NB), onset: new Float32Array(NB), hit: new Uint8Array(NB),
  peak: new Float32Array(NB), floor: new Float32Array(NB), flux: new Float32Array(NB),
  refractory: new Int32Array(NB),
  started: false,
  hist: new Float32Array(HIST * NB * 4),
  tex: null,
};
bands.tex = new THREE.DataTexture(bands.hist, NB, HIST, THREE.RGBAFormat, THREE.FloatType);
bands.tex.minFilter = bands.tex.magFilter = THREE.NearestFilter;
bands.tex.needsUpdate = true;

function bandMean(arr, binHz, f0, f1) {
  const i0 = Math.max(1, Math.floor(f0 / binHz));
  const i1 = Math.min(arr.length, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += arr[i];
  return s / (i1 - i0);
}

// One analysis step. hi: the 512-bin spectrum (hiHz per bin); low: optional finer spectrum.
export function cookBands(hi, hiHz, low, lowHz) {
  const v = P.voices;
  const atk = coef(v.attack);
  for (let k = 0; k < NB; k++) {
    const raw = (k < 4 && low) ? bandMean(low, lowHz, BAND_EDGES[k], BAND_EDGES[k + 1])
                               : bandMean(hi, hiHz, BAND_EDGES[k], BAND_EDGES[k + 1]);
    bands.raw[k] = raw;
    if (!bands.started) { bands.floor[k] = raw; bands.peak[k] = raw + MIN_RANGE; }
    if (raw > bands.peak[k]) bands.peak[k] = raw; else bands.peak[k] += (raw - bands.peak[k]) * coef(PEAK_HALF);
    if (raw < bands.floor[k]) bands.floor[k] = raw; else bands.floor[k] += (raw - bands.floor[k]) * coef(FLOOR_HALF);
    const range = Math.max(bands.peak[k] - bands.floor[k], MIN_RANGE);
    const n = Math.pow(Math.min(Math.max((raw - bands.floor[k]) / range, 0), 1), CURVE);
    const rel = coef(v.releaseLow * Math.pow(v.releaseHigh / v.releaseLow, k / (NB - 1)));
    bands.level[k] += (n - bands.level[k]) * (n > bands.level[k] ? atk : rel);
    const rise = Math.max(0, n - bands.prev[k]);
    if (bands.refractory[k] > 0) bands.refractory[k]--;
    bands.hit[k] = 0;
    if (rise > Math.max(v.onset * bands.flux[k], MIN_FLUX) && bands.refractory[k] === 0) {
      bands.onset[k] = 1; bands.refractory[k] = REFRACTORY; bands.hit[k] = 1;
    } else {
      bands.onset[k] *= 1 - coef(ONSET_HALF);
    }
    bands.flux[k] += (rise - bands.flux[k]) * coef(FLUX_HALF);
    bands.prev[k] = n; bands.norm[k] = n;
  }
  bands.started = true;
}

// Manual test: override one voice's level and fire single hits after the detector.
let pendingHit = -1;
export function fireManualHit(voice) { pendingHit = voice; }
export function applyManual() {
  const M = P.manual;
  if (M.on) { const k = M.voice; bands.level[k] = M.level; bands.norm[k] = M.level; }
  if (pendingHit >= 0) { bands.onset[pendingHit] = 1; bands.hit[pendingHit] = 1; pendingHit = -1; }
}

// Push the present into row 0; everything else moves one row older.
export function depositBands() {
  const row = NB * 4;
  bands.hist.copyWithin(row, 0, (HIST - 1) * row);
  for (let k = 0; k < NB; k++) {
    const i = k * 4;
    bands.hist[i] = bands.level[k]; bands.hist[i + 1] = bands.onset[k]; bands.hist[i + 2] = bands.norm[k]; bands.hist[i + 3] = 1;
  }
  bands.tex.needsUpdate = true;
}

// CPU read of the history, same interpolation as the shader (used to place sparks).
export function histAt(voice, row, channel = 0) {
  row = Math.min(Math.max(row, 0), HIST - 1);
  const r0 = Math.floor(row), r1 = Math.min(r0 + 1, HIST - 1), f = row - r0;
  const a = bands.hist[(r0 * NB + voice) * 4 + channel], b = bands.hist[(r1 * NB + voice) * 4 + channel];
  return a + (b - a) * f;
}

export function clearBands() {
  for (const a of [bands.raw, bands.norm, bands.prev, bands.level, bands.onset, bands.flux]) a.fill(0);
  bands.refractory.fill(0); bands.hit.fill(0); bands.hist.fill(0); bands.started = false;
  bands.tex.needsUpdate = true;
}

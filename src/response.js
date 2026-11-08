// ─────────────────────────────────────────────────────────────────────────────
//  RESPONSE — interpreted controls → per-destination envelopes → history.
//
//  Input each update: a normalised level per voice (0..1) plus the global level,
//  and the hit events that fell in this update. Output: one history row.
//
//  Every destination has its own smoothing, because floor movement, rim breath,
//  a transient flash and slow colour change want different timing:
//
//    lift    each tile's own voice   → height and fill        (rise / fall, fall eases from sub to air)
//    rim     one source voice/global → whole-floor rim breath
//    hits    discrete events          → accent + flash         (rise / hold / fall; events stay events)
//    colour  one source voice/global → slow hue migration
//
//  Times are t90 in ms (see params.js). The history texture is 9 columns (8 voices +
//  global) × HIST rows, newest first; channels r = lift, g = hit, b = rim, a = colour.
//  A tile at distance d reads the row d / travel seconds old.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NB, HIST, P, GLOBAL, t90coef } from './params.js';

const COLS = NB + 1;
const ss = x => Math.min(1, Math.max(0, x));

export const response = {
  measured: new Float32Array(COLS),     // what came in (normalised level)
  lift: new Float32Array(COLS), rim: new Float32Array(COLS), colour: new Float32Array(COLS),
  hit: new Float32Array(NB), hitTarget: new Float32Array(NB), hitHold: new Float32Array(NB),
  hitCount: new Uint32Array(NB), lastHit: new Float32Array(NB),
  shimmer: 0,                            // harmony confidence (0..1), kept in the global column's g channel
  hist: new Float32Array(HIST * COLS * 4),
  tex: null,
  rows: 0,                               // rows written since the last clear
};
response.tex = new THREE.DataTexture(response.hist, COLS, HIST, THREE.RGBAFormat, THREE.FloatType);
response.tex.minFilter = response.tex.magFilter = THREE.NearestFilter;
response.tex.needsUpdate = true;

const shape = (x, m) => Math.pow(ss(x * m.sensitivity), m.curve);

// One update of dt seconds. levels: Float32Array(8) normalised 0..1; global 0..1;
// hits: Float32Array(8) of event strengths (0 = no event this update); shimmer: harmony confidence.
export function stepResponse(levels, global, hits, dt, shimmer = 0) {
  const M = P.map, R = response;
  R.shimmer = shimmer;
  for (let k = 0; k < COLS; k++) R.measured[k] = k < NB ? levels[k] : global;
  // lift: rise shared, fall eased log-wise from sub (fall) to air (fallHigh)
  const up = t90coef(M.lift.rise, dt);
  for (let k = 0; k < COLS; k++) {
    const x = shape(R.measured[k], M.lift);
    const fallMs = k < NB ? M.lift.fall * Math.pow(M.lift.fallHigh / M.lift.fall, k / (NB - 1)) : M.lift.fall;
    R.lift[k] += (x - R.lift[k]) * (x > R.lift[k] ? up : t90coef(fallMs, dt));
  }
  for (const [name, arr] of [['rim', R.rim], ['colour', R.colour]]) {
    const m = M[name], u = t90coef(m.rise, dt), d = t90coef(m.fall, dt);
    for (let k = 0; k < COLS; k++) { const x = shape(R.measured[k], m); arr[k] += (x - arr[k]) * (x > arr[k] ? u : d); }
  }
  // hits: an event sets a target for rise + hold, then the envelope falls
  const h = M.hits, hu = t90coef(h.rise, dt), hd = t90coef(h.fall, dt);
  for (let k = 0; k < NB; k++) {
    if (hits[k] > 0) {
      R.hitTarget[k] = Math.max(R.hitTarget[k], Math.min(1, hits[k]));
      R.hitHold[k] = (h.rise + h.hold) / 1000;
      R.hitCount[k]++; R.lastHit[k] = hits[k];
      if (h.rise <= 0) R.hit[k] = Math.max(R.hit[k], R.hitTarget[k]);
    }
    if (R.hitHold[k] > 0) { R.hit[k] += (R.hitTarget[k] - R.hit[k]) * hu; R.hitHold[k] -= dt; }
    else { R.hitTarget[k] = 0; R.hit[k] *= 1 - hd; }
  }
  writeRow();
}

function writeRow() {
  const R = response, row = COLS * 4;
  R.hist.copyWithin(row, 0, (HIST - 1) * row);
  for (let k = 0; k < COLS; k++) {
    const i = k * 4;
    R.hist[i] = R.lift[k]; R.hist[i + 1] = k < NB ? R.hit[k] : R.shimmer;      // global column: g = shimmer (travels with the ripple) R.hist[i + 2] = R.rim[k]; R.hist[i + 3] = R.colour[k];
  }
  R.rows = Math.min(HIST, R.rows + 1);
  R.tex.needsUpdate = true;
}

// CPU read of the history with the same interpolation as the shader.
export function histAt(col, row, channel = 0) {
  row = Math.min(Math.max(row, 0), HIST - 1);
  const r0 = Math.floor(row), r1 = Math.min(r0 + 1, HIST - 1), f = row - r0;
  const a = response.hist[(r0 * COLS + col) * 4 + channel], b = response.hist[(r1 * COLS + col) * 4 + channel];
  return a + (b - a) * f;
}

export function clearResponse() {
  const R = response;
  for (const a of [R.measured, R.lift, R.rim, R.colour, R.hit, R.hitTarget, R.hitHold, R.lastHit]) a.fill(0);
  R.hitCount.fill(0); R.hist.fill(0); R.rows = 0; R.shimmer = 0; R.tex.needsUpdate = true;
}

// How long the history reaches back, at a given update rate.
export const historySeconds = rowHz => HIST / rowHz;

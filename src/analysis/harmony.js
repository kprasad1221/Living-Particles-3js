// ─────────────────────────────────────────────────────────────────────────────
//  HARMONY — an experiment (spec §6): is there a fifth between two notes right now?
//
//  Evidence, step by step, all inspectable in the Music response panel:
//
//    1 peaks      long-window spectrum (8192 / 1024: 186 ms window, 23.2 ms hop at
//                 44.1 kHz; 5.4 Hz bins). Local maxima of log power, frequency refined by
//                 parabolic interpolation on dB, kept if within 45 dB of the frame's
//                 strongest peak and above −70 dB re a full-scale sine.
//    2 notes      harmonic summation: every peak in 55–1760 Hz is a candidate
//                 fundamental; its salience sums the peaks found at 1…8 × f (±35 cents),
//                 weighted 0.85^(h−1). The strongest candidate becomes a note and the
//                 peaks it explains are used up, then the next, up to 4 notes. A single
//                 note's overtones (2f, 3f — themselves a fifth apart) are explained by
//                 that note, so they do not count as a second note.
//                 The fundamental must be present as a peak (no "missing fundamental").
//    3 chroma     12 pitch classes from the peaks, amplitude-weighted (A4 = tuning).
//    4 score      for each pair of notes: interval in cents, folded into one octave;
//                 within the tolerance of 701 ± 1 cents (just 3:2 = 701.96,
//                 equal-tempered = 700) the pair scores 1 − (dev / tolerance)⁴ (flat near
//                 the centre, 0 at the tolerance), × the
//                 weaker note's relative salience. A fourth (the inverted fifth) does
//                 not count. Frame score = best pair.
//    5 confidence a frame score above "confident above" for "must hold" ms switches the
//                 response on; below "let go below" for longer than "bridge gaps" switches
//                 it off (a kick briefly masking the notes is bridged); the output follows
//                 the score with its own rise and release. While off, a score between
//                 the two thresholds is reported as "uncertain".
//
//  The score is a heuristic, not a probability. It is not chord recognition: dense
//  mixes, missing fundamentals and inharmonic sounds will confuse it.
// ─────────────────────────────────────────────────────────────────────────────

export const HARMONY = {
  win: 8192, hop: 1024,
  fLo: 55, fHi: 1760,        // supported fundamental range (A1 … A6)
  peakMax: 6000,             // peaks searched up to here (for overtones)
  maxPeaks: 32,
  peakFloorDb: -70,          // dB re full-scale sine
  relFloorDb: 45,            // below the frame's strongest peak
  harmonics: 8,
  harmTolCents: 35,
  maxNotes: 4,
  noteRel: 0.15,             // a note's salience must be at least this × the strongest note's
};
export const MAX_NOTES = HARMONY.maxNotes;

const LOG2 = Math.log(2);
const cents = (a, b) => 1200 * Math.log(b / a) / LOG2;

// Peaks of one power spectrum P (one-sided, mean-square calibrated, full-scale sine = 0.5).
export function framePeaks(P, df, cfg, outF, outA) {
  const k0 = Math.max(2, Math.floor(cfg.fLo / df) - 1), k1 = Math.min(P.length - 2, Math.ceil(cfg.peakMax / df));
  const dB = k => 10 * Math.log10(Math.max(P[k], 1e-20) / 0.5);
  let max = -Infinity;
  for (let k = k0; k <= k1; k++) if (P[k] > P[k - 1] && P[k] >= P[k + 1]) max = Math.max(max, dB(k));
  const floor = Math.max(cfg.peakFloorDb, max - cfg.relFloorDb);
  const found = [];
  for (let k = k0; k <= k1; k++) {
    if (!(P[k] > P[k - 1] && P[k] >= P[k + 1])) continue;
    const b = dB(k); if (b < floor) continue;
    const a = dB(k - 1), c = dB(k + 1), den = a - 2 * b + c;
    const p = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    const lev = b - 0.25 * (a - c) * p;
    found.push([(k + p) * df, Math.pow(10, lev / 20)]);
  }
  found.sort((x, y) => y[1] - x[1]);
  const n = Math.min(found.length, cfg.maxPeaks);
  for (let i = 0; i < n; i++) { outF[i] = found[i][0]; outA[i] = found[i][1]; }
  return n;
}

// Notes from peaks by greedy harmonic summation. Writes up to maxNotes (f, relative salience).
export function notesFromPeaks(pf, pa, n, cfg, outF, outS) {
  const rem = Float64Array.from(pa.subarray(0, n));
  const used = new Uint8Array(n);
  let count = 0, first = 0;
  const match = (f) => {           // index of the strongest unused peak within tolerance of f
    let best = -1;
    for (let j = 0; j < n; j++) if (rem[j] > 0 && Math.abs(cents(f, pf[j])) <= cfg.harmTolCents && (best < 0 || rem[j] > rem[best])) best = j;
    return best;
  };
  while (count < cfg.maxNotes) {
    let bestI = -1, bestS = 0;
    for (let i = 0; i < n; i++) {
      if (used[i] || rem[i] <= 0 || pf[i] < cfg.fLo || pf[i] > cfg.fHi) continue;
      let s = rem[i];
      for (let h = 2; h <= cfg.harmonics; h++) { const j = match(pf[i] * h); if (j >= 0 && j !== i) s += Math.pow(0.85, h - 1) * rem[j]; }
      if (s > bestS) { bestS = s; bestI = i; }
    }
    if (bestI < 0) break;
    if (count === 0) first = bestS;
    else if (bestS < cfg.noteRel * first) break;
    outF[count] = pf[bestI]; outS[count] = bestS / first; count++;
    used[bestI] = 1; rem[bestI] = 0;
    for (let h = 2; h <= cfg.harmonics; h++) { const j = match(pf[bestI] * h); if (j >= 0) rem[j] = 0; }
  }
  for (let i = count; i < cfg.maxNotes; i++) { outF[i] = 0; outS[i] = 0; }
  return count;
}

// 12 pitch classes (0 = C … 9 = A) from peaks, amplitude-weighted, max = 1.
export function chromaFromPeaks(pf, pa, n, tuning, out) {
  out.fill(0);
  for (let i = 0; i < n; i++) {
    const midi = 69 + 12 * Math.log(pf[i] / tuning) / LOG2;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] += pa[i];
  }
  let m = 0; for (let i = 0; i < 12; i++) m = Math.max(m, out[i]);
  if (m > 0) for (let i = 0; i < 12; i++) out[i] /= m;
}

// Best fifth among the notes of one frame. Returns { score, a, b, cents } (a < b, Hz).
export function fifthScore(f, s, tol) {
  let best = { score: 0, a: 0, b: 0, cents: NaN };
  for (let i = 0; i < f.length; i++) for (let j = 0; j < f.length; j++) {
    if (!(f[i] > 0 && f[j] > f[i])) continue;
    const c = cents(f[i], f[j]), cm = c - 1200 * Math.floor(c / 1200);
    const dev = Math.max(0, Math.abs(cm - 701) - 1);
    if (dev >= tol) continue;
    const sc = (1 - (dev / tol) ** 4) * Math.min(s[i], s[j]);          // flat inside, falling to 0 at the tolerance
    if (sc > best.score) best = { score: sc, a: f[i], b: f[j], cents: c };
  }
  return best;
}

// Analysis output → per-frame score, confidence and state, for given settings.
// state: 0 no evidence (fewer than two notes) · 1 uncertain · 2 confident (response on)
export function harmonyTrack(h, o) {
  const N = h.frames, M = h.maxNotes, hop = h.hop;
  const raw = new Float32Array(N), conf = new Float32Array(N), state = new Uint8Array(N);
  const f = new Float32Array(M), s = new Float32Array(M);
  const t90 = ms => (ms <= 0 ? 1 : 1 - Math.exp(-Math.LN10 * hop / (ms / 1000)));
  const up = t90(o.rise), down = t90(o.release), hold = o.persist / 1000, bridge = o.bridge / 1000;
  let on = false, above = 0, below = 0, last = 0, c = 0;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < M; k++) { f[k] = h.notesF[i * M + k]; s[k] = h.notesS[i * M + k]; }
    const notes = h.nNotes[i];
    const sc = notes >= 2 ? fifthScore(f, s, o.tolerance).score : 0;
    raw[i] = sc;
    above = sc >= o.activate ? above + hop : 0;
    below = sc < o.release_ ? below + hop : 0;
    if (!on && above >= hold - 1e-9) on = true;
    if (on && below > bridge + 1e-9) on = false;          // a short gap (a kick masking the notes) is bridged
    if (on && sc >= o.release_) last = sc;
    const target = on ? (sc >= o.release_ ? sc : last) : 0;
    c += (target - c) * (target > c ? up : down);
    conf[i] = c;
    state[i] = on ? 2 : notes >= 2 && sc >= o.release_ ? 1 : 0;
  }
  return { raw, conf, state, hop, frames: N };
}

// Settings (P.harmony) → the options harmonyTrack expects.
export const trackOpts = H => ({ tolerance: H.tolerance, activate: H.activate, release_: Math.min(H.letGo, H.activate - 0.01), persist: H.persist, bridge: H.bridge, rise: H.rise, release: H.release });

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(f, tuning = 440) {
  if (!(f > 0)) return '—';
  const midi = 69 + 12 * Math.log(f / tuning) / LOG2, m = Math.round(midi);
  const dev = Math.round((midi - m) * 100);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}${dev ? (dev > 0 ? ' +' : ' ') + dev + '¢' : ''}`;
}
export const PITCH_CLASSES = NAMES;

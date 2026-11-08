// Waveform fixtures (spec §8.1): deterministic PCM run through the real feature extractor.
//   node tools/fixtures.mjs            → prints a summary and writes tools/captures/fixtures.json
// No browser needed: src/analysis/*.js are plain modules.
import { analyzePCM, detectEvents, Interpreter, BIAS, CONFIG } from '../src/analysis/features.js';
import { harmonyTrack, trackOpts, HARMONY } from '../src/analysis/harmony.js';
import { P, NB, VOICE_NAMES } from '../src/params.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const music = { ...P.music };
const detectOpts = { sensitivity: music.hitSensitivity, cooldownLow: music.cooldownLow, cooldownHigh: music.cooldownHigh };
const rng = (a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(12345);
const db2a = db => Math.pow(10, db / 20);
const results = {};
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] : NaN; };

function interpret(f, mus = music) {
  const it = new Interpreter(), out = [];
  for (let i = 0; i < f.frames; i++) {
    const lv = it.step(f.voiceDb.subarray(i * NB, i * NB + NB), f.globalDb[i], f.hop, mus);
    out.push({ t: i * f.hop, level: Float32Array.from(lv), inDb: Float32Array.from(it.inDb) });
  }
  return out;
}
function toneBurst(x, sr, t0, freq, amp, decay = 0.06) {
  const s0 = Math.round(t0 * sr), len = Math.round(decay * 6 * sr);
  for (let i = 0; i < len && s0 + i < x.length; i++) {
    const t = i / sr, env = Math.min(1, t / 0.002) * Math.exp(-t / decay);
    x[s0 + i] += amp * env * Math.sin(2 * Math.PI * freq * t);
  }
}
function noiseBurst(x, sr, t0, amp, decay = 0.05) {
  const s0 = Math.round(t0 * sr), len = Math.round(decay * 6 * sr);
  for (let i = 0; i < len && s0 + i < x.length; i++) { const t = i / sr; x[s0 + i] += amp * Math.min(1, t / 0.001) * Math.exp(-t / decay) * (rng() * 2 - 1); }
}
const voiceOf = f => { const e = [30, 60, 150, 400, 1000, 2500, 5000, 10000, 16000]; for (let k = 0; k < 8; k++) if (f >= e[k] && f < e[k + 1]) return k; return -1; };

// 1 · Silence, then a signal below the gate
{
  const sr = 48000, x = new Float32Array(sr * 10);
  for (let i = sr * 5; i < x.length; i++) x[i] = db2a(-82) * Math.sin(2 * Math.PI * 300 * i / sr) + db2a(-90) * (rng() * 2 - 1);
  const f = analyzePCM([x], sr), ev = detectEvents(f, detectOpts), it = interpret(f);
  const maxLevel = Math.max(...it.map(o => Math.max(...o.level)));
  results.silence_then_below_gate = { events: ev.time.length, maxNormalisedLevel: +maxLevel.toFixed(4), pass: ev.time.length === 0 && maxLevel < 0.05 };
}
// 2 · Sustained sine in Preserve dynamics
{
  const sr = 48000, x = new Float32Array(sr * 12);
  for (let i = 0; i < x.length; i++) x[i] = db2a(-20) * Math.sin(2 * Math.PI * 440 * i / sr);
  const f = analyzePCM([x], sr), it = interpret(f).filter(o => o.t >= 2 && o.t <= 11.9);
  const v = it.map(o => o.level[3]), mean = v.reduce((a, b) => a + b, 0) / v.length;
  const drift = (Math.max(...v) - Math.min(...v)) / mean;
  results.sustained_sine_preserve = { meanLevel: +mean.toFixed(4), driftPct: +(100 * drift).toFixed(3), pass: drift < 0.05 };
  const itA = interpret(f, { ...music, normalize: 'adaptive' }).filter(o => o.t >= 2 && o.t <= 11.9).map(o => o.level[3]);
  const mA = itA.reduce((a, b) => a + b, 0) / itA.length;
  results.sustained_sine_adaptive = { meanLevel: +mA.toFixed(4), driftPct: +(100 * (Math.max(...itA) - Math.min(...itA)) / mA).toFixed(2), note: 'adaptive moves the reference by design (bounded ±12 dB × adapt)' };
}
// 3 · The same tone at two amplitudes 6 dB apart
{
  const sr = 48000, x = new Float32Array(sr * 8);
  for (let i = 0; i < x.length; i++) x[i] = db2a(i < sr * 4 ? -26 : -20) * Math.sin(2 * Math.PI * 440 * i / sr);
  const f = analyzePCM([x], sr), it = interpret(f);
  const at = t => it[Math.round(t / f.hop)];
  const rawDiff = at(6).inDb[3] - at(2).inDb[3], n1 = at(2).level[3], n2 = at(6).level[3];
  results.six_dB_step = { rawDiffDb: +rawDiff.toFixed(3), normalisedBefore: +n1.toFixed(3), normalisedAfter: +n2.toFixed(3), pass: Math.abs(rawDiff - 6) <= 1 && n2 > n1 };
}
// 5 · Slow sweep through the band boundaries
{
  const sr = 48000, T = 20, x = new Float32Array(sr * T), f0 = 40, f1 = 14000;
  let ph = 0;
  for (let i = 0; i < x.length; i++) { const f = f0 * Math.pow(f1 / f0, i / x.length); ph += 2 * Math.PI * f / sr; x[i] = db2a(-20) * Math.sin(ph); }
  const f = analyzePCM([x], sr);
  let worstSum = 0, worstJump = 0, prev = null;
  for (let i = Math.round(1 / f.hop); i < f.frames - Math.round(1 / f.hop); i++) {
    let p = 0; for (let v = 0; v < NB; v++) p += Math.pow(10, f.voiceDb[i * NB + v] / 10);
    const sumDb = 10 * Math.log10(p);
    worstSum = Math.max(worstSum, Math.abs(sumDb - (-20)));
    if (prev !== null) worstJump = Math.max(worstJump, Math.abs(sumDb - prev));
    prev = sumDb;
  }
  results.sweep_band_handoff = { worstSummedErrorDb: +worstSum.toFixed(3), worstFrameJumpDb: +worstJump.toFixed(3), pass: worstSum <= 1 };
}
// 6 · Twenty isolated bursts with known attack times
{
  const sr = 48000, x = new Float32Array(sr * 16), truth = [];
  const freqs = [45, 100, 250, 700, 1700, 3800, 7500, 13000];
  for (let b = 0; b < 20; b++) {
    const t0 = 0.5 + b * 0.75 + rng() * 0.05, fr = freqs[b % 8];
    toneBurst(x, sr, t0, fr, 0.3, fr < 150 ? 0.12 : 0.06);
    truth.push({ t: t0, voice: voiceOf(fr) });
  }
  const f = analyzePCM([x], sr), ev = detectEvents(f, detectOpts);
  const errs = [], rawErrs = { band: [], fast: [] }; let missed = 0, extra = 0, dup = 0;
  const used = new Set();
  for (const tr of truth) {
    const hits = [];
    for (let i = 0; i < ev.time.length; i++) if (ev.voice[i] === tr.voice && Math.abs(ev.time[i] - tr.t) < 0.08) hits.push(i);
    if (!hits.length) { missed++; continue; }
    if (hits.length > 1) dup += hits.length - 1;
    hits.forEach(i => used.add(i));
    const i = hits[0], e = ev.time[i] - tr.t;
    errs.push(e);
    (tr.voice < 4 ? rawErrs.band : rawErrs.fast).push(e - (tr.voice < 4 ? BIAS.band : BIAS.fast));
  }
  for (let i = 0; i < ev.time.length; i++) if (!used.has(i)) {
    // a hit in another voice at the same moment is a legitimate broadband spill, not a false event
    const near = truth.some(tr => Math.abs(ev.time[i] - tr.t) < 0.08);
    if (!near) extra++;
  }
  const abs = errs.map(Math.abs);
  results.isolated_bursts = {
    bursts: truth.length, detected: truth.length - missed, missed, duplicates: dup, falseEventsAwayFromBursts: extra,
    spillHitsInOtherVoices: ev.time.length - used.size - extra,
    medianAbsErrorMs: +(1000 * pct(abs, 0.5)).toFixed(2), p95AbsErrorMs: +(1000 * pct(abs, 0.95)).toFixed(2),
    meanSignedErrorMs: +(1000 * errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)).toFixed(2),
    rawBiasMs: { band: +(1000 * pct(rawErrs.band, 0.5)).toFixed(2), fast: +(1000 * pct(rawErrs.fast, 0.5)).toFixed(2) },
    lookaheadMs: { band: +(1000 * f.hop).toFixed(2), fast: +(1000 * f.fastHop).toFixed(2) },
    pass: missed === 0 && dup === 0 && pct(abs, 0.5) <= 0.020 && pct(abs, 0.95) <= 0.035,
  };
}
// 6b · Held-out bursts: other frequencies, levels and timing (the bias was measured on 6)
{
  const sr = 44100, x = new Float32Array(sr * 14), truth = [];
  const freqs = [52, 170, 550, 1300, 3000, 6200, 11000, 120];
  for (let b = 0; b < 16; b++) {
    const t0 = 0.4 + b * 0.8 + rng() * 0.2, fr = freqs[b % 8];
    toneBurst(x, sr, t0, fr, 0.08 + 0.25 * rng(), fr < 150 ? 0.1 : 0.05);
    truth.push({ t: t0, voice: voiceOf(fr) });
  }
  for (let i = 0; i < x.length; i++) x[i] += db2a(-60) * (rng() * 2 - 1);          // a little background noise
  const f = analyzePCM([x], sr), ev = detectEvents(f, detectOpts);
  const errs = []; let missed = 0, dup = 0;
  for (const tr of truth) {
    const hits = []; for (let i = 0; i < ev.time.length; i++) if (ev.voice[i] === tr.voice && Math.abs(ev.time[i] - tr.t) < 0.08) hits.push(i);
    if (!hits.length) { missed++; continue; } if (hits.length > 1) dup += hits.length - 1;
    errs.push(ev.time[hits[0]] - tr.t);
  }
  const abs = errs.map(Math.abs);
  results.isolated_bursts_holdout = { sampleRate: sr, bursts: truth.length, missed, duplicates: dup,
    medianAbsErrorMs: +(1000 * pct(abs, 0.5)).toFixed(2), p95AbsErrorMs: +(1000 * pct(abs, 0.95)).toFixed(2),
    meanSignedErrorMs: +(1000 * errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)).toFixed(2),
    pass: missed === 0 && dup === 0 && pct(abs, 0.5) <= 0.020 && pct(abs, 0.95) <= 0.035 };
}
// 7 · Rapid high bursts at 125 ms and 62.5 ms spacing
for (const spacing of [0.125, 0.0625]) {
  const sr = 48000, x = new Float32Array(sr * 4), n = Math.floor(3 / spacing);
  for (let b = 0; b < n; b++) toneBurst(x, sr, 0.5 + b * spacing, 7500, 0.25, 0.012);
  const f = analyzePCM([x], sr), ev = detectEvents(f, detectOpts);
  const got = Array.from(ev.voice).filter(v => v === 6).length;
  results[`rapid_high_${spacing * 1000}ms`] = { expected: n, detectedInBrilliance: got, pass: got >= n - 1 && got <= n };
}
// 8 · Phase-opposed stereo
{
  const sr = 48000, L = new Float32Array(sr * 2), R = new Float32Array(sr * 2);
  for (let i = 0; i < L.length; i++) { L[i] = db2a(-20) * Math.sin(2 * Math.PI * 440 * i / sr); R[i] = -L[i]; }
  const f = analyzePCM([L, R], sr), m = Math.floor(f.frames / 2);
  results.phase_opposed_stereo = { globalDb: +f.globalDb[m].toFixed(3), pass: Math.abs(f.globalDb[m] - (-20)) < 0.5 };
}
// 9 · Same fixtures at 44.1 and 48 kHz
{
  const out = {};
  for (const sr of [44100, 48000]) {
    const x = new Float32Array(sr * 3);
    for (let i = 0; i < x.length; i++) x[i] = db2a(-20) * Math.sin(2 * Math.PI * 700 * i / sr);
    const f = analyzePCM([x], sr), m = Math.floor(f.frames / 2);
    const vdb = Array.from(f.voiceDb.subarray(m * NB, m * NB + NB));
    out[sr] = { loudestVoice: VOICE_NAMES[vdb.indexOf(Math.max(...vdb))], upperMidDb: +vdb[4].toFixed(3), midDb: +vdb[3].toFixed(3), globalDb: +f.globalDb[m].toFixed(3) };
  }
  results.sample_rates = { ...out, pass: Math.abs(out[44100].globalDb - out[48000].globalDb) < 0.2 };
}

// ── Harmonic experiment (spec §6, §8.1) ─────────────────────────────────────
// Defaults of P.harmony; cents error measured on the strongest detected note.
const H = trackOpts(P.harmony);
const centsOf = (a, b) => 1200 * Math.log2(b / a);
function tones(sr, secs, parts, from = 0) {
  const x = new Float32Array(sr * secs), s0 = Math.round(from * sr);
  for (const [f, a] of parts) for (let i = s0; i < x.length; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / sr) * Math.min(1, (i - s0) / (0.01 * sr));
  return x;
}
function harmonyRun(x, sr) {
  const f = analyzePCM([x], sr), h = f.harmony, tr = harmonyTrack(h, H), M = h.maxNotes;
  const at = t => { const i = Math.min(h.frames - 1, Math.round(t / h.hop)); return { i, notes: Array.from(h.notesF.subarray(i * M, i * M + h.nNotes[i])), raw: tr.raw[i], conf: tr.conf[i], state: tr.state[i] }; };
  return { f, h, tr, at };
}
// 10 · Single tones: sample-rate mapping and peak interpolation (< 15 cents)
{
  const out = {}; let worst = 0;
  for (const sr of [44100, 48000]) for (const hz of [220, 440, 880]) {
    const r = harmonyRun(tones(sr, 2, [[hz, db2a(-12)]]), sr).at(1.0);
    const err = r.notes.length ? centsOf(hz, r.notes[0]) : NaN;
    worst = Math.max(worst, Math.abs(err));
    out[`${sr}_${hz}`] = { detected: +(r.notes[0] || 0).toFixed(3), centsError: +err.toFixed(2), notes: r.notes.length };
  }
  results.single_tone_frequency = { ...out, worstCents: +worst.toFixed(2), pass: worst < 15 };
}
// 11 · One harmonic-rich note (2f, 3f — themselves a fifth apart): no confident fifth
{
  const out = {};
  for (const [name, parts] of [['A3_h1-4', [[220, .4], [440, .3], [660, .25], [880, .15]]], ['E2_h1-6', [[82.41, .3], [164.81, .3], [247.22, .3], [329.63, .2], [412.03, .15], [494.44, .1]]],
                               ['A3_strong_h3', [[220, .2], [440, .25], [660, .4], [880, .1]]]]) {
    const r = harmonyRun(tones(48000, 2, parts), 48000);
    let maxConf = 0, confident = 0; for (let i = 0; i < r.tr.frames; i++) { maxConf = Math.max(maxConf, r.tr.conf[i]); if (r.tr.state[i] === 2) confident++; }
    out[name] = { notesMid: r.at(1.0).notes.map(v => +v.toFixed(1)), maxConfidence: +maxConf.toFixed(3), confidentFrames: confident };
  }
  results.harmonic_rich_single_note = { ...out, pass: Object.values(out).every(o => o.confidentFrames === 0) };
}
// 12 · Two sines a fifth apart, then a major third (control)
{
  const sr = 48000, x = new Float32Array(sr * 4), a = db2a(-12);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, upper = t < 2 ? 220 * 2 ** (7 / 12) : 220 * 2 ** (4 / 12);
    x[i] = a * Math.sin(2 * Math.PI * 220 * t) + a * Math.sin(2 * Math.PI * upper * t);
  }
  const r = harmonyRun(x, sr), f5 = r.at(1.5), m3 = r.at(3.5);
  // latency: time from the fifth's start (0 s) until confidence ≥ 0.5, and from the change at 2 s until it falls below 0.1
  let on = NaN, off = NaN;
  for (let i = 0; i < r.tr.frames; i++) { const t = i * r.h.hop; if (Number.isNaN(on) && r.tr.conf[i] >= 0.5) on = t; if (t > 2 && Number.isNaN(off) && r.tr.conf[i] < 0.1) off = t - 2; }
  results.fifth_then_third = { fifth: { notes: f5.notes.map(v => +v.toFixed(1)), score: +f5.raw.toFixed(3), confidence: +f5.conf.toFixed(3), state: f5.state },
    third: { notes: m3.notes.map(v => +v.toFixed(1)), score: +m3.raw.toFixed(3), confidence: +m3.conf.toFixed(3), state: m3.state },
    msToConfident: +(on * 1000).toFixed(0), msToLetGoAfterChange: +(off * 1000).toFixed(0),
    pass: f5.state === 2 && f5.conf > 0.7 && m3.state !== 2 && m3.conf < 0.1 };
}
// 13 · Equal-tempered fifth and detuned variants (tolerance ±25 cents by default)
{
  const out = {};
  for (const dc of [0, 1.96, 10, -20, 30, 40]) {
    const r = harmonyRun(tones(48000, 2, [[220, db2a(-12)], [220 * 2 ** ((700 + dc) / 1200), db2a(-12)]]), 48000).at(1.5);
    out[`${dc >= 0 ? '+' : ''}${dc}c`] = { score: +r.raw.toFixed(3), confidence: +r.conf.toFixed(3), state: r.state };
  }
  const inside = ['+0c', '+1.96c', '+10c', '-20c'].every(k => out[k].state === 2), outside = ['+30c', '+40c'].every(k => out[k].state !== 2);
  const monotone = out['+0c'].score >= out['+10c'].score - 0.01 && out['+10c'].score >= out['-20c'].score - 0.01;   // falls with distance from the fifth (0.01 slack)
  results.detuned_fifths = { ...out, toleranceCents: P.harmony.tolerance, pass: inside && outside && monotone };
}
// 14 · Two harmonic-rich notes a fifth apart (A3 + E4, shared overtone at 660 Hz)
{
  const parts = [[220, .3], [440, .2], [660, .15], [880, .08], [329.63, .3], [659.26, .1], [988.88, .08]];
  const r = harmonyRun(tones(48000, 2, parts), 48000).at(1.0);
  results.rich_fifth = { notes: r.notes.map(v => +v.toFixed(1)), score: +r.raw.toFixed(3), confidence: +r.conf.toFixed(3), state: r.state, pass: r.state === 2 };
}
// 15 · Silence and noise: no notes, no shimmer
{
  const sr = 48000, x = new Float32Array(sr * 2);
  for (let i = sr; i < x.length; i++) x[i] = db2a(-30) * (rng() * 2 - 1);
  const r = harmonyRun(x, sr); let maxConf = 0; for (let i = 0; i < r.tr.frames; i++) maxConf = Math.max(maxConf, r.tr.conf[i]);
  results.silence_and_noise_harmony = { maxConfidence: +maxConf.toFixed(3), pass: maxConf < 0.1 };
}

mkdirSync(join(HERE, 'captures'), { recursive: true });
writeFileSync(join(HERE, 'captures', 'fixtures.json'), JSON.stringify({ config: CONFIG, harmony: { config: HARMONY, settings: P.harmony }, bias: BIAS, music, results }, null, 2));
for (const [k, v] of Object.entries(results)) console.log((v.pass === undefined ? '  · ' : v.pass ? 'PASS' : 'FAIL'), k, JSON.stringify(v));

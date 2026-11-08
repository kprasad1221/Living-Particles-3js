// ─────────────────────────────────────────────────────────────────────────────
//  TIMELINE — turns musical time into history rows and events.
//
//  Precise path (pattern, tracks): features were computed ahead of time. Each display
//  frame asks for musical time t; every feature frame up to t + one hop is processed in
//  order (one ahead, so the shader can interpolate between the last two). The same t
//  always gives the same rows and the same events, whatever the display rate.
//
//    frame time     i · hop (window centre), unwrapped: loop · duration + i · hop
//    event id       epoch : loop : index — a restart or seek starts a new epoch
//    discontinuity  t going backwards (restart, seek) or jumping > 1 s ahead (hidden tab,
//                   stall): history is rebuilt from cached features for the last
//                   HIST rows, without spawning sparks, instead of replaying a storm
//
//  Live path (mic, stress test): one update per 60 Hz step from the analyser snapshot.
//  Labelled "Live · basic analysis": one window per update, no hop control.
// ─────────────────────────────────────────────────────────────────────────────
import { NB, HIST, P } from './params.js';
import { Interpreter, LiveAnalyzer, CONFIG } from './analysis/features.js';
import { harmonyTrack, trackOpts } from './analysis/harmony.js';
import { stepResponse, clearResponse } from './response.js';

export class Timeline {
  constructor({ onEvent, onReset }) {
    this.onEvent = onEvent; this.onReset = onReset;
    this.interp = new Interpreter();
    this.levels = new Float32Array(NB); this.hits = new Float32Array(NB);
    this.bandDb = new Float32Array(CONFIG.nBands);
    this.mode = 'live'; this.live = null; this.f = null; this.ev = null;
    this.epoch = 0; this.t = 0; this.latest = -Infinity; this.started = false;
    this.manualHits = [];
    this.stats = { frames: 0, events: 0, resets: 0 };
  }

  get rowHz() { return this.mode === 'precise' ? 1 / this.f.hop : 60; }

  // ── precise ──
  setPrecise(features, events, duration, loop) {
    this.mode = 'precise'; this.f = features; this.ev = events; this.dur = duration; this.loop = loop;
    this.refreshHarmony();
    this.framesPerLoop = Math.max(1, Math.ceil(duration / features.hop - 1e-9));
    this.started = false;
  }
  setEvents(events) {
    this.ev = events;
    if (this.mode === 'precise') this._seekEvents(this.latest);
  }
  setLoop(loop) { this.loop = loop; }
  // Harmony settings changed (or new features): recompute score → confidence for the whole
  // track. Cheap (no transforms), and the same audio time always gives the same value.
  refreshHarmony() {
    const h = this.mode === 'precise' && this.f && this.f.harmony;
    this.harm = h ? harmonyTrack(h, trackOpts(P.harmony)) : null;
    this.harmIdx = -1;
  }
  harmonyAt(localTime) {
    const H = this.harm; if (!H) return 0;
    const x = Math.min(Math.max(localTime / H.hop, 0), H.frames - 1), i = Math.floor(x), j = Math.min(i + 1, H.frames - 1);
    this.harmIdx = Math.round(x);
    return H.conf[i] + (H.conf[j] - H.conf[i]) * (x - i);
  }

  _frameTime(loop, i) { return loop * this.dur + i * this.f.hop; }
  _evTime(loop, j) { return loop * this.dur + this.ev.time[j]; }
  _seekEvents(T) {
    const n = this.ev ? this.ev.time.length : 0;
    this.eLoop = this.loop && this.dur > 0 ? Math.max(0, Math.floor(T / this.dur)) : 0;
    const local = T - this.eLoop * this.dur;
    let j = 0; while (j < n && this.ev.time[j] <= local) j++;
    this.eIdx = j;
    if (j >= n && this.loop && n) { this.eLoop++; this.eIdx = 0; }
  }

  reset(t) {
    this.epoch++; this.stats.resets++;
    clearResponse(); this.interp.reset(); this.onReset?.();
    const lookback = (HIST + 8) * this.f.hop;
    const start = Math.max(0, t - lookback);
    this.cLoop = this.loop && this.dur > 0 ? Math.floor(start / this.dur) : 0;
    this.cIdx = Math.max(0, Math.ceil((start - this.cLoop * this.dur) / this.f.hop));
    this.latest = -Infinity;
    this._seekEvents(start - 1e-9);
    this.started = true;
    this._run(t, false);
  }

  advancePrecise(t) {
    if (!this.started || t < this.t - 0.05 || t - this.latest > 1.0) this.reset(t);
    this._run(t, true);
    this.t = t;
  }

  _run(t, emit) {
    const hop = this.f.hop;
    while (true) {
      if (!this.loop && this.cIdx >= this.framesPerLoop) break;
      if (this.cIdx >= this.framesPerLoop) { this.cLoop++; this.cIdx = 0; }
      const T = this._frameTime(this.cLoop, this.cIdx);
      if (T > t + hop) break;
      this._processFrame(this.cIdx, T, emit);
      this.cIdx++;
    }
  }

  _processFrame(i, T, emit) {
    const f = this.f, nb = CONFIG.nBands;
    i = Math.min(i, f.frames - 1);
    this.hits.fill(0);
    // events whose time is at or before this frame
    const n = this.ev ? this.ev.time.length : 0;
    let guard = 0;
    while (n && guard++ < 10000) {
      if (this.eIdx >= n) { if (!this.loop) break; this.eLoop++; this.eIdx = 0; }
      const et = this._evTime(this.eLoop, this.eIdx);
      if (et > T) break;
      const v = this.ev.voice[this.eIdx], s = this.ev.strength[this.eIdx];
      this.hits[v] = Math.max(this.hits[v], s);
      if (emit) { this.onEvent?.({ id: `${this.epoch}:${this.eLoop}:${this.eIdx}`, time: et, voice: v, strength: s }); this.stats.events++; }
      this.eIdx++;
    }
    this._manual(T, emit);
    const lv = this.interp.step(f.voiceDb.subarray(i * NB, i * NB + NB), f.globalDb[i], f.hop, P.music);
    this._finish(lv, f.hop, this.harmonyAt(i * f.hop));
    this.bandDb.set(f.bandDb.subarray(i * nb, i * nb + nb));
    this.latest = T; this.stats.frames++;
  }

  // ── live ──
  setLive(sr, hiSize, loSize) {
    this.mode = 'live'; this.f = null; this.harm = null;
    this.live = new LiveAnalyzer(sr, hiSize, loSize);
    this.live.setDetect(this.detectOpts(), 1 / 60);
    this.interp.reset(); clearResponse(); this.onReset?.();
    this.epoch++; this.liveStep = 0;
  }
  refreshLiveDetect() { if (this.live) this.live.setDetect(this.detectOpts(), 1 / 60); }
  detectOpts() { const m = P.music; return { sensitivity: m.hitSensitivity, cooldownLow: m.cooldownLow, cooldownHigh: m.cooldownHigh }; }

  stepLive(db, t, dt, emit = true) {
    this.hits.fill(0);
    const hits = this.live.step(db.hi, db.lo, t);
    for (const h of hits) {
      this.hits[h.voice] = Math.max(this.hits[h.voice], h.strength);
      if (emit) { this.onEvent?.({ id: `${this.epoch}:L${this.liveStep}:${h.voice}`, time: t, voice: h.voice, strength: h.strength }); this.stats.events++; }
    }
    this._manual(t, emit);
    const lv = this.interp.step(this.live.voiceDb, this.live.globalDb, dt, P.music);
    this._finish(lv, dt);
    this.bandDb.set(this.live.bandDb);
    this.latest = t; this.liveStep++; this.stats.frames++;
  }

  // ── shared ──
  fireManual(voice) { this.manualHits.push(voice); }
  _manual(T, emit) {
    while (this.manualHits.length) {
      const v = this.manualHits.shift();
      this.hits[v] = 1;
      if (emit) this.onEvent?.({ id: `${this.epoch}:M${this.stats.frames}:${v}`, time: T, voice: v, strength: 1, manual: true });
    }
  }
  _finish(lv, dt, shimmer = 0) {
    for (let k = 0; k < NB; k++) this.levels[k] = lv[k];
    if (P.manual.on) this.levels[P.manual.voice] = P.manual.level;      // manual test: after interpretation
    if (P.manual.shimmer) shimmer = 1;                                    // manual test: full confidence
    stepResponse(this.levels, lv[NB], this.hits, dt, shimmer);
  }
}

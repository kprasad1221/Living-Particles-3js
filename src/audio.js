// ─────────────────────────────────────────────────────────────────────────────
//  Sources and the playback timeline.
//
//    pattern  the built-in test pattern, rendered to PCM (precise path, audible)
//    track    a file from the library (precise path)
//    mic      microphone (Live · basic analysis)
//    stress   the original synthetic spectrum (visual stress test, silent)
//
//  For buffered sources the musical time is derived from the audio clock, not from
//  display frames: heard = (context time now being heard − time playback resumed)
//  + position at resume. "Being heard" uses getOutputTimestamp when available, else
//  currentTime − outputLatency. Time is unwrapped across loops (loop 2 of a 16 s
//  pattern starts at 16 s), so events at the seam are neither repeated nor lost.
//
//  Web Audio graph:  BufferSource / MediaStream → AnalyserNode 1024 → AnalyserNode 4096
//                                                       └→ destination (buffered sources only)
// ─────────────────────────────────────────────────────────────────────────────
import { BINS, FFT_SIZE, LOW_FFT_SIZE } from './params.js';

// The original synthetic spectrum (Audio Geology 02.2), kept as a visual stress test.
const POLY = [
  { c: 1,   w: 0.7, amp: 0.6,  period: 8,     offset: 0,    decay: 0,  swell: true },
  { c: 2.5, w: 0.7, amp: 0.95, period: 0.5,   offset: 0,    decay: 9 },
  { c: 6,   w: 1.2, amp: 0.65, period: 0.375, offset: 0,    decay: 10 },
  { c: 14,  w: 3,   amp: 0.55, period: 1 / 3, offset: 0.02, decay: 8 },
  { c: 36,  w: 10,  amp: 0.7,  period: 1,     offset: 0.5,  decay: 14 },
  { c: 80,  w: 12,  amp: 0.5,  period: 0.4,   offset: 0.05, decay: 12 },
  { c: 160, w: 30,  amp: 0.3,  period: 0.125, offset: 0,    decay: 30, accent: 4 },
  { c: 280, w: 40,  amp: 0.38, period: 2 / 7, offset: 0.1,  decay: 22 },
];
const env = (t, v) => {
  if (v.swell) return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / v.period);
  const x = t - v.offset; if (x < 0) return 0;
  const n = Math.floor(x / v.period), ph = x - n * v.period;
  return Math.exp(-ph * v.decay) * (v.accent && n % v.accent === 0 ? 1.6 : 1);
};
// Fills `db` (512 analyser-style dB values for 46.875 Hz bins) for time t.
export function stressSpectrumDb(t, db) {
  const drift = 2 * Math.sin(t * 0.4), e = POLY.map(v => env(t, v) * v.amp);
  for (let i = 0; i < BINS; i++) {
    let s = 0.04 * (0.5 + 0.5 * Math.sin(i * 0.7 + t * 3.1)) * Math.exp(-i / 200);
    for (let k = 0; k < POLY.length; k++) {
      const v = POLY[k], c = k === 3 ? v.c + drift : v.c, d = i - c;
      if (Math.abs(d) > v.w * 4) continue;
      s += e[k] * Math.exp(-(d * d) / (2 * v.w * v.w));
    }
    db[i] = -100 + 80 * Math.min(1, s);
  }
}

export class Sources {
  constructor() {
    this.ctx = null; this.analyser = null; this.lowAnalyser = null;
    this.mode = 'pattern';
    this.node = null; this.stream = null;
    this.buffer = null; this.trackId = null; this.trackName = '';
    this.playing = false; this.loop = true; this.onEnded = null; this._token = 0;
    this.base = 0;        // unwrapped position (s) at the last resume / pause / seek
    this.resumeAt = 0;    // context time playback (re)started
    this.virtual = null;  // headless checks: a number here overrides the audio clock
    this.liveTime = 0;    // mic / stress: time advances with the display while running
    this.dbHi = new Float32Array(FFT_SIZE / 2);
    this.dbLo = new Float32Array(LOW_FFT_SIZE / 2);
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get buffered() { return this.mode === 'pattern' || this.mode === 'track'; }
  get duration() { return this.buffered && this.buffer ? this.buffer.duration : null; }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const a = ctx.createAnalyser();
    a.fftSize = FFT_SIZE; a.smoothingTimeConstant = 0; a.minDecibels = -100; a.maxDecibels = -20;
    const low = ctx.createAnalyser();
    low.fftSize = LOW_FFT_SIZE; low.smoothingTimeConstant = 0; low.minDecibels = -100; low.maxDecibels = -20;
    a.connect(low);
    this.ctx = ctx; this.analyser = a; this.lowAnalyser = low;
    return ctx;
  }

  // The context time whose sound is reaching the listener now.
  heardContextTime() {
    const ctx = this.ctx; if (!ctx) return 0;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return Math.min(ctx.currentTime, ts.contextTime + (performance.now() - ts.performanceTime) / 1000);
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  get outputLatency() { return this.ctx ? Math.max(0, this.ctx.currentTime - this.heardContextTime()) : 0; }

  // Unwrapped musical time of buffered playback, in seconds.
  heardTime() {
    if (this.virtual !== null) return this.virtual;
    let t = this.base;
    if (this.playing) t += Math.max(0, this.heardContextTime() - this.resumeAt);
    if (!this.loop && this.buffer) t = Math.min(t, this.buffer.duration);
    return t;
  }
  position() {
    if (!this.buffered) return this.liveTime;
    const t = this.heardTime(), d = this.duration;
    return d ? (this.loop ? t % d : Math.min(t, d)) : t;
  }

  readDb() {
    if (this.mode === 'stress') { stressSpectrumDb(this.liveTime, this.dbHi); return { hi: this.dbHi, lo: null, sr: 48000 }; }
    if (!this.analyser) return null;
    this.analyser.getFloatFrequencyData(this.dbHi);
    this.lowAnalyser.getFloatFrequencyData(this.dbLo);
    return { hi: this.dbHi, lo: this.dbLo, sr: this.sampleRate };
  }

  stopNode() {
    this._token++;
    if (this.node) { try { this.node.stop?.(); } catch (e) {} this.node.disconnect(); this.node = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.playing = false;
  }

  async decode(blob) { const ctx = this.ensureContext(); return ctx.decodeAudioData(await blob.arrayBuffer()); }

  useStress() { this.stopNode(); this.mode = 'stress'; this.buffer = null; }

  async useBuffer(mode, id, name, buffer) {
    const ctx = this.ensureContext(); ctx.resume();
    this.stopNode();
    this.buffer = buffer; this.trackId = id; this.trackName = name; this.base = 0; this.mode = mode;
  }

  async useMic() {
    const ctx = this.ensureContext(); await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stopNode();
    try { this.analyser.disconnect(ctx.destination); } catch (e) {}   // never route the mic to the speakers
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.analyser);
    this.mode = 'mic'; this.buffer = null;
  }

  play() {
    if (!this.buffered || !this.buffer || this.playing) return;
    if (this.virtual !== null) { this.playing = true; return; }
    const ctx = this.ctx; ctx.resume();
    const d = this.buffer.duration;
    if (!this.loop && this.base >= d - 0.01) this.base = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = this.loop;
    src.connect(this.analyser); this.analyser.connect(ctx.destination);
    const startCtx = ctx.currentTime + 0.01;
    src.start(startCtx, this.base % d);
    // the first sample is heard when heardContextTime() reaches startCtx
    this.resumeAt = startCtx; this.node = src; this.playing = true;
    const token = ++this._token;
    src.onended = () => {
      if (token !== this._token) return;
      this.playing = false; this.node = null; this.base = d;
      this.onEnded?.();
    };
  }
  pause() {
    if (!this.buffered || !this.playing) return;
    this.base = this.heardTime();
    this.stopNode();
  }
  setLoop(on) { this.loop = on; if (this.node && 'loop' in this.node) this.node.loop = on; }
  // Restart from the top: a fresh unwrapped timeline starting at 0.
  restart() {
    this.liveTime = 0;
    if (!this.buffered) return;
    const was = this.playing;
    this.stopNode(); this.base = 0;
    if (was) this.play();
  }
}

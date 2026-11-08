// ─────────────────────────────────────────────────────────────────────────────
//  Sources: the built-in polyrhythm test signal, a track from the library, or
//  the microphone. One is live at a time. Tracks are decoded locally and never
//  leave the page.
//
//  Web Audio graph (TouchDesigner: Audio File In → Audio Spectrum CHOP):
//
//    BufferSource / MediaStream ─► AnalyserNode (1024) ─► AnalyserNode (4096)
//                                         └──────────────► destination (tracks only)
// ─────────────────────────────────────────────────────────────────────────────
import { BINS, FFT_SIZE, LOW_FFT_SIZE } from './params.js';

// Polyrhythm test signal from Audio Geology 02.2: eight voices, one per band, each on its
// own cycle at 120 BPM. Bin numbers assume 46.875 Hz bins (48 kHz, fftSize 1024).
//   sub 45 Hz 8 s swell · bass kick every beat · low mid 4 against 3 · mid 3 against 2
//   upper mid clap on 2 and 4 · presence 5 against 4 · brilliance sixteenths · air 7 against 4
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
  const x = t - v.offset;
  if (x < 0) return 0;
  const n = Math.floor(x / v.period), ph = x - n * v.period;
  return Math.exp(-ph * v.decay) * (v.accent && n % v.accent === 0 ? 1.6 : 1);
};
export function polySpectrum(t, bins) {
  const drift = 2 * Math.sin(t * 0.4);
  const e = POLY.map(v => env(t, v) * v.amp);
  for (let i = 0; i < BINS; i++) {
    let s = 0.04 * (0.5 + 0.5 * Math.sin(i * 0.7 + t * 3.1)) * Math.exp(-i / 200);
    for (let k = 0; k < POLY.length; k++) {
      const v = POLY[k], c = k === 3 ? v.c + drift : v.c;
      const d = i - c;
      if (Math.abs(d) > v.w * 4) continue;
      s += e[k] * Math.exp(-(d * d) / (2 * v.w * v.w));
    }
    bins[i] = s;
  }
}

export class Sources {
  constructor() {
    this.ctx = null; this.analyser = null; this.lowAnalyser = null;
    this.mode = 'test';               // 'test' | 'track' | 'mic'
    this.node = null; this.stream = null;
    this.buffer = null; this.trackId = null; this.trackName = '';
    this.playing = false; this.offset = 0; this.startAt = 0;
    this.loop = true; this.onEnded = null; this._token = 0;
    this.testTime = 0;
    this.db = new Float32Array(BINS);
    this.dbLow = new Float32Array(LOW_FFT_SIZE / 2);
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get binHz() { return this.sampleRate / FFT_SIZE; }
  get lowBinHz() { return this.sampleRate / LOW_FFT_SIZE; }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const a = ctx.createAnalyser();
    a.fftSize = FFT_SIZE; a.smoothingTimeConstant = 0;     // smoothing happens in bands.js, where you can tune it
    a.minDecibels = -100; a.maxDecibels = -20;
    const low = ctx.createAnalyser();
    low.fftSize = LOW_FFT_SIZE; low.smoothingTimeConstant = 0;
    low.minDecibels = a.minDecibels; low.maxDecibels = a.maxDecibels;
    a.connect(low);
    this.ctx = ctx; this.analyser = a; this.lowAnalyser = low;
    return ctx;
  }

  read(bins) {
    if (this.mode === 'test' || !this.analyser) { polySpectrum(this.testTime, bins); return; }
    this.analyser.getFloatFrequencyData(this.db);
    const lo = this.analyser.minDecibels, hi = this.analyser.maxDecibels;
    for (let i = 0; i < BINS; i++) bins[i] = Math.max(0, (this.db[i] - lo) / (hi - lo));
  }

  readLow(out) {
    if (this.mode === 'test' || !this.lowAnalyser) return false;
    this.lowAnalyser.getFloatFrequencyData(this.dbLow);
    const lo = this.lowAnalyser.minDecibels, hi = this.lowAnalyser.maxDecibels;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(0, (this.dbLow[i] - lo) / (hi - lo));
    return true;
  }

  advance(dt) { if (this.mode === 'test') this.testTime += dt; }

  position() {
    if (this.mode === 'test') return this.testTime;
    if (this.mode === 'track' && this.buffer) {
      const p = this.playing ? this.ctx.currentTime - this.startAt : this.offset;
      return Math.min(p, this.buffer.duration);
    }
    return null;
  }
  get duration() { return this.mode === 'track' && this.buffer ? this.buffer.duration : null; }

  stopNode() {
    this._token++;
    if (this.node) { try { this.node.stop?.(); } catch (e) {} this.node.disconnect(); this.node = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.playing = false;
  }

  useTest() { this.stopNode(); this.mode = 'test'; }

  async decode(blob) {
    const ctx = this.ensureContext();
    return ctx.decodeAudioData(await blob.arrayBuffer());
  }

  async useTrack(id, name, buffer) {
    const ctx = this.ensureContext(); await ctx.resume();
    this.stopNode();
    this.buffer = buffer; this.trackId = id; this.trackName = name; this.offset = 0;
    this.mode = 'track';
  }

  async useMic() {
    const ctx = this.ensureContext(); await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stopNode();
    try { this.analyser.disconnect(ctx.destination); } catch (e) {}   // a track may have connected it
    this.stream = stream;
    this.node = ctx.createMediaStreamSource(stream);
    this.node.connect(this.analyser);       // not to the speakers: no feedback howl
    this.mode = 'mic';
  }

  play() {
    if (this.mode !== 'track' || !this.buffer || this.playing) return;
    const ctx = this.ctx; ctx.resume();
    if (this.offset >= this.buffer.duration - 0.01) this.offset = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.loop = this.loop;
    src.connect(this.analyser); this.analyser.connect(ctx.destination);
    src.start(0, this.offset % this.buffer.duration);
    this.startAt = ctx.currentTime - this.offset; this.node = src; this.playing = true;
    const token = ++this._token;
    src.onended = () => {
      if (token !== this._token) return;          // stopped on purpose
      this.playing = false; this.node = null; this.offset = this.buffer.duration;
      this.onEnded?.();
    };
  }
  pause() {
    if (this.mode !== 'track' || !this.playing) return;
    let p = this.ctx.currentTime - this.startAt;
    if (this.loop) p %= this.buffer.duration;
    this.offset = p;
    this.stopNode();
  }
  setLoop(on) { this.loop = on; if (this.node && 'loop' in this.node) this.node.loop = on; }
  seekStart() {
    this.testTime = 0;
    if (this.mode === 'track') {
      const was = this.playing;
      this.stopNode(); this.offset = 0;
      if (was) this.play();
    }
  }
}

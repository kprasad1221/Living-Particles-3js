// ─────────────────────────────────────────────────────────────────────────────
//  SCORE — authored gestures on a musical clock.   (shared module: no three.js, no app state)
//
//  The measured music says how loud and when. A score says what happens: a slow foundation, a call
//  that travels, a reply that answers it. Each gesture has its own shape in time and returns to rest,
//  so several can overlap and there is still quiet between them. The music may change a gesture's
//  weight or its entry, within limits you set; it never becomes the gesture.
//
//  Nothing here knows about tiles, ribbons or branches. The score hands out gesture INSTANCES:
//
//    { id, kind: 'call' | 'reply', parent, n, route, start, travel, rise, crest, release, strength }
//
//  and a world draws them its own way (a route index → its own path; see world/gestures.js here).
//  For a point a fraction u (0…1) along the route, the local envelope at time t is
//
//    τ = t − (start + u · travel)        the front reaches u at start + u · travel
//    0 before · rises over `rise` · holds `crest` · falls over `release` · 0 again      (envelope())
//
//  so a place the front has passed decays on its own while the front moves on.
//
//  CLOCK   Tempo is set by hand (bpm) with an origin you tap; nothing is inferred from loudness.
//    'loop'  phase = (t − origin) / period, exactly. Call n starts at origin + n · period and is called
//            'c<n>' wherever you come from: a seek, a loop seam or a late frame gives the same
//            instances with the same ids and times. Tails from before a seek are filled in.
//    'free'  the music may nudge the rate within ±rateDepth. Phase is integrated (phase += rate · dt),
//            so a rate change bends the motion and never makes it jump. Ids count from the last reset.
//
//  ONE CALL, ONE ANSWER   A reply is created with its call, carries the call's id as `parent` and its
//  strength, and is scheduled at call.start + delay. reset() (seek, restart, source change) drops
//  everything pending. A long gap between two advance() calls (a suspended tab) creates only the
//  instances that could still be alive, never a backlog.
//
//  The world drives it:   score.reset()                       on seek / restart / source change
//                         score.advance(t, energy, onStart)   once per analysis step, t increasing
//                         score.instances                     alive or pending, oldest first
//                         score.foundation(t, level)          0…1, the slow swell's height now
//
//  Origin: Living Particles 3JS, study-01-composed-motion (v0.3 · P3). When copying this file into
//  another sketch, keep this header and note the commit it came from and anything you changed.
// ─────────────────────────────────────────────────────────────────────────────

export const SCORE_DEFAULTS = {
  on: false,
  mode: 'loop',            // loop: exact phase from the clock · free: integrated phase, rate may follow the music
  bpm: 120,                // set by hand; not measured
  origin: 0,               // s: where beat 1 is (tap it)
  callBeats: 4,            // a call every this many beats (4 at 120 = every 2 s)
  foundationBeats: 16,     // one foundation swell per this many beats (16 at 120 = 8 s)
  routes: 3,               // how many routes the calls step through (the world says what they are)
  source: 8,               // which measured level may weigh on the gestures (the world reads it): 0–7 a voice · 8 global
  rateDepth: 0,            // free mode only: the rate may move within ±this share of the tempo
  call:  { travel: 0.7, rise: 0.12, crest: 0.1, release: 0.5, strength: 1, audio: 0.5 },   // audio: share of the strength that follows the level at the start
  reply: { on: true, delay: 0.5, travel: 0.8, rise: 0.15, crest: 0.05, release: 0.8, gain: 0.8 },   // delay: after the call starts
  foundation: { rise: 2, crest: 1, release: 3, amount: 1, audio: 0.5 },   // the rest is whatever remains of the cycle
};
export const MAX_INSTANCES = 8;

const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = x => { x = clamp01(x); return x * x * (3 - 2 * x); };

// The local envelope of one gesture: 0 before it arrives, rise, crest, release, 0 after.
export function envelope(tau, rise, crest, release) {
  if (tau <= 0) return 0;
  if (tau < rise) return smooth(tau / Math.max(rise, 1e-6));
  if (tau < rise + crest) return 1;
  return 1 - smooth((tau - rise - crest) / Math.max(release, 1e-6));
}
export const lifeOf = g => g.travel + g.rise + g.crest + g.release;
export const periodOf = p => (Math.max(0.25, p.callBeats) * 60) / Math.max(1, p.bpm);                 // s between calls
export const foundationCycles = p => Math.max(1, Math.round(p.foundationBeats / Math.max(0.25, p.callBeats)));   // calls per foundation swell
const gcd = (a, b) => (b ? gcd(b, a % b) : a), lcm = (a, b) => (a / gcd(a, b)) * b;
// After this many seconds the whole score repeats exactly (loop mode): the length to capture for a seamless loop.
export const commonPeriod = p => lcm(foundationCycles(p), Math.max(1, Math.round(p.routes))) * periodOf(p);

// A bounded weight: `share` of it follows the level (0…1), the rest is always there. Never above `amount`.
export const weighted = (amount, share, level) => amount * (1 - clamp01(share) + clamp01(share) * clamp01(level));

export class Score {
  constructor(params) {
    this.p = params;                 // a plain object shaped like SCORE_DEFAULTS, owned by the world (saved in its scene)
    this.epoch = 0;
    this.stats = { calls: 0, replies: 0, dropped: 0, resets: 0 };
    this._clear();
  }
  _clear() { this.instances = []; this.lastT = null; this.phase = 0; this.rate = 0; this.serial = 0; this.started = new Set(); }

  // Seek, restart or a new source: nothing pending survives.
  reset() { this.epoch++; this.stats.resets++; this._clear(); }

  // Phase of the call cycle at time t (whole number = a call starts). Loop mode: from the clock alone.
  phaseAt(t) { return this.p.mode === 'loop' ? (t - this.p.origin) / periodOf(this.p) : this.phase; }

  _make(kind, n, start, strength, parent) {
    const p = this.p, s = kind === 'call' ? p.call : p.reply, loop = p.mode === 'loop';
    const tag = `${kind === 'call' ? 'c' : 'r'}${loop ? n : this.serial}`;
    return { id: loop ? tag : `${this.epoch}:${tag}`, kind, parent, n, route: ((n % p.routes) + p.routes) % p.routes,
             start, travel: s.travel, rise: s.rise, crest: s.crest, release: s.release, strength };
  }
  _spawn(n, start, energy) {
    const p = this.p, call = this._make('call', n, start, weighted(p.call.strength, p.call.audio, energy), null);
    this._push(call); this.stats.calls++;
    if (p.reply.on) { this._push(this._make('reply', n, start + p.reply.delay, call.strength * p.reply.gain, call.id)); this.stats.replies++; }
    this.serial++;
  }
  _push(g) {
    this.instances.push(g);
    if (this.instances.length > MAX_INSTANCES) { this.instances.shift(); this.stats.dropped++; }
  }

  // Advance to time t (s, increasing between resets). `energy` (0…1) is the measured level now.
  // onStart(instance) fires once per instance, on the step that reaches its start.
  advance(t, energy = 0.5, onStart = null) {
    const p = this.p;
    if (!p.on) { if (this.instances.length) this._clear(); this.lastT = t; return; }
    const period = periodOf(p), maxLife = Math.max(lifeOf(p.call), p.reply.delay + lifeOf(p.reply));
    const first = this.lastT === null;
    if (first || t < this.lastT) { this.instances = []; this.started = new Set(); }
    if (p.mode === 'loop') {
      // every call whose start is in (from, t]; on the first step or after a long gap, only those that can still be alive
      const from = first || t < this.lastT || t - this.lastT > maxLife ? t - maxLife : this.lastT;
      const n0 = Math.floor((from - p.origin) / period) + 1, n1 = Math.floor((t - p.origin) / period);
      for (let n = n0; n <= n1; n++) this._spawn(n, p.origin + n * period, energy);
      this.phase = (t - p.origin) / period;
    } else {
      // integrated phase: the rate eases toward its (bounded) target, so nothing jumps when it changes
      const dt = first || t < this.lastT ? 0 : Math.min(t - this.lastT, maxLife);
      const target = (1 / period) * (1 + clamp01(p.rateDepth) * (2 * clamp01(energy) - 1));
      if (first || this.rate === 0) { this.rate = target; this.phase = (t - p.origin) / period; }
      else this.rate += (target - this.rate) * (1 - Math.exp(-dt / 0.5));
      const before = this.phase; this.phase += this.rate * dt;
      for (let n = Math.floor(before) + 1; n <= Math.floor(this.phase); n++)
        this._spawn(n, t - (this.phase - n) / Math.max(this.rate, 1e-6), energy);      // the moment the phase crossed n
    }
    // retire what has ended; announce what has started
    this.instances = this.instances.filter(g => t <= g.start + lifeOf(g) + 0.05);
    for (const g of this.instances) if (g.start <= t && !this.started.has(g.id)) {
      this.started.add(g.id);
      if (onStart && !(first || (this.lastT !== null && g.start <= this.lastT))) onStart(g);
    }
    if (this.started.size > 64) this.started = new Set(this.instances.map(g => g.id));
    this.lastT = t;
  }

  // The foundation swell, 0…1 before weighting: rise, crest, release, then rest until the cycle ends.
  foundationShape(t) {
    const f = this.p.foundation, cycles = foundationCycles(this.p), period = periodOf(this.p) * cycles;
    const ph = this.phaseAt(t) / cycles, local = (ph - Math.floor(ph)) * period;
    return envelope(local, f.rise, f.crest, f.release);
  }
  // …and weighted by the music, bounded: never above foundation.amount.
  foundation(t, level = 0.5) { return this.p.on ? this.foundationShape(t) * weighted(this.p.foundation.amount, this.p.foundation.audio, level) : 0; }

  // Is anything of this kind still to be heard at t? (for readouts and tests)
  alive(t, kind) { return this.instances.filter(g => (!kind || g.kind === kind) && t >= g.start && t <= g.start + lifeOf(g)); }
}

// Keep a params object valid (after an import or a control change). Returns it.
export function sanitizeScore(p, d = SCORE_DEFAULTS) {
  const num = (v, def, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  p.mode = p.mode === 'free' ? 'free' : 'loop';
  p.bpm = num(p.bpm, d.bpm, 20, 300); p.origin = num(p.origin, 0, -3600, 3600);
  p.callBeats = num(p.callBeats, d.callBeats, 0.5, 64); p.foundationBeats = num(p.foundationBeats, d.foundationBeats, 1, 256);
  p.routes = Math.round(num(p.routes, d.routes, 1, 8)); p.source = Math.round(num(p.source, d.source, 0, 8)); p.rateDepth = num(p.rateDepth, 0, 0, 0.5);
  for (const k of ['call', 'reply']) for (const f of ['travel', 'rise', 'crest', 'release']) p[k][f] = num(p[k][f], d[k][f], f === 'crest' ? 0 : 0.01, 8);
  p.call.strength = num(p.call.strength, 1, 0, 2); p.call.audio = num(p.call.audio, 0.5, 0, 1);
  p.reply.delay = num(p.reply.delay, d.reply.delay, 0, 8); p.reply.gain = num(p.reply.gain, d.reply.gain, 0, 2);
  const f = p.foundation; f.rise = num(f.rise, d.foundation.rise, 0.01, 60); f.crest = num(f.crest, d.foundation.crest, 0, 60); f.release = num(f.release, d.foundation.release, 0.01, 60);
  f.amount = num(f.amount, 1, 0, 2); f.audio = num(f.audio, 0.5, 0, 1);
  return p;
}

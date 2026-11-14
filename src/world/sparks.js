// ─────────────────────────────────────────────────────────────────────────────
//  SPARKS — a particle system with real lifetimes, driven by discrete hit events.
//
//    SPAWN       one hit event (id, voice, time, strength) gets one finite budget:
//                perHit × strength particles, spread over tiles of that voice. With an
//                outward ripple each particle's birth is scheduled for when the ripple
//                reaches its tile. Nothing re-emits because a flash is still bright.
//                Continuous emission adds particles/s in proportion to a voice's level.
//    INITIALIZE  one ring-buffer slot: start (tile top at birth), velocity in a cone,
//                birth time, lifetime, voice, seed. Births can lie in the future; the
//                shader hides a particle until its birth, so a late frame never shifts
//                a gesture — the particle simply appears at its correct age.
//    UPDATE      none stored: p = p0 + v·age + ½·g·age² + turbulence, in the shader.
//    OUTPUT      additive sprites, coloured body + separate white core, size/alpha over life.
//
//  Randomness is seeded from the event id, so the same music and seed give the same
//  sparks at any frame rate. Capacity is fixed; when full the oldest slot is reused and
//  any still-living particle it held is counted as dropped.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NB, P } from '../params.js';
import { histAt } from '../response.js';
import { mulberry32 } from './hexfield.js';

export const CAPACITY = 8192;

const vertexShader = /* glsl */`
  uniform float uTime, uGravity, uTurb, uTurbScale, uSize, uPixel;
  uniform float uPlumeH, uPlumeCurl, uPlumeSpread, uPlumeDrift, uPlumeSize;
  uniform vec3 uPalette[${NB}];
  uniform sampler2D uRamp;      // the look's ramps (row 1: accent)
  uniform float uAccent;        // 0 voice colours … 1 the accent ramp (look.ramp × look.accent)
  attribute vec4 aStart;   // xyz, birth time
  attribute vec4 aVel;     // spark: velocity xyz, lifetime · plume: dir x, dir z, start angle, lifetime
  attribute vec4 aMeta;    // voice, seed, kind (0 spark · 1 plume), fade (trail ghosts < 1)
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float age = uTime - aStart.w;
    float t = age / max(aVel.w, 1e-3);
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
    vec3 p;
    float life;
    float ph = aMeta.y * 6.2831;
    if (aMeta.z < 0.5) {
      p = aStart.xyz + aVel.xyz * age + vec3(0.0, 0.5 * uGravity * age * age, 0.0);
      vec3 q = p * uTurbScale;
      p += uTurb * age * vec3(sin(q.y * 0.9 + ph + uTime * 1.7), 0.35 * sin(q.x * 0.6 + uTime * 1.1 + ph), cos(q.y * 0.8 + ph * 1.3 - uTime * 1.4));
      life = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.45, 1.0, t));      // short appearance ramp, shaped fade
    } else {
      // PLUME, on a 0–1.6 s authored clock: emerge · rise · curl · disperse · rest
      float s = t * 1.6;
      float rise = 1.0 - exp(-max(s - 0.03, 0.0) * 6.5);                       // most height by ~0.25 s
      float curl = smoothstep(0.25, 0.9, s);
      float disperse = smoothstep(0.9, 1.6, s);
      float ang = aVel.z + uPlumeCurl * 6.2831 * curl * (0.6 + 0.4 * aMeta.y);
      float r = (0.15 + 0.85 * aMeta.y) * (0.35 + uPlumeSpread * smoothstep(0.15, 1.3, s)) + disperse * 1.2 * aMeta.y;
      vec2 dir = vec2(aVel.x, aVel.y);
      p = aStart.xyz + vec3(dir.x, 0.0, dir.y) * uPlumeDrift * s
        + vec3(cos(ang) * r, uPlumeH * rise * (0.75 + 0.25 * fract(aMeta.y * 7.0)) - disperse * disperse * 1.5, sin(ang) * r);
      life = smoothstep(0.0, 0.05, s) * (1.0 - disperse);
    }
    life *= aMeta.w;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (aMeta.z < 0.5 ? uSize : uPlumeSize) * uPixel * (0.4 + 0.6 * life) / max(-mv.z, 0.1);
    // Particles are events: when the look colours by role they take the accent family, each at its own place on it.
    vColor = mix(uPalette[int(aMeta.x + 0.5)], texture2D(uRamp, vec2(0.3 + 0.7 * aMeta.y, 0.75)).rgb, uAccent);
    vAlpha = life;
  }
`;
const fragmentShader = /* glsl */`
  uniform float uBright, uCore;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = 1.0 - smoothstep(0.0, 1.0, d);          // descending ramps written with ordered edges
    float core = 1.0 - smoothstep(0.0, 0.35, d);      // (smoothstep is undefined when edge0 >= edge1)
    gl_FragColor = vec4((vColor * a + vec3(core) * uCore) * uBright * vAlpha, 1.0);
  }
`;

export const EMITTERS = { highs: [5, 6, 7], 'mids+highs': [3, 4, 5, 6, 7], all: [0, 1, 2, 3, 4, 5, 6, 7] };

const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export class Sparks {
  constructor() {
    const g = new THREE.BufferGeometry();
    this.start = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.vel = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.meta = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.start.array.fill(-1e6);                    // every slot born long ago → dead
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
    g.setAttribute('aStart', this.start); g.setAttribute('aVel', this.vel); g.setAttribute('aMeta', this.meta);
    this.uniforms = {
      uTime: { value: 0 }, uGravity: { value: -4 }, uTurb: { value: 1 }, uTurbScale: { value: 1 }, uSize: { value: 0.3 },
      uPixel: { value: 500 }, uBright: { value: 1 }, uCore: { value: 0.6 },
      uPlumeH: { value: 8 }, uPlumeCurl: { value: 1 }, uPlumeSpread: { value: 3 }, uPlumeDrift: { value: 1 }, uPlumeSize: { value: 0.5 },
      uPalette: { value: Array.from({ length: NB }, () => new THREE.Color()) },
      uRamp: { value: null }, uAccent: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.cursor = 0; this.lo = Infinity; this.hi = -1;
    this.seed = 1; this.steady = new Float32Array(NB);
    this.stats = { events: 0, emitted: 0, dropped: 0, alive: 0, plumes: 0, plumesDropped: 0 };
    this.plumeEnds = [];
    this.now = 0;
  }

  reseed(seed) { this.seed = seed | 0; }

  emit(x, y, z, voice, birth, rand) {
    const S = P.sparks, i = this.cursor, s = this.start.array, v = this.vel.array;
    if (s[i * 4 + 3] + v[i * 4 + 3] > this.now) this.stats.dropped++;      // overwriting a particle that is still alive
    const cone = (S.cone * Math.PI) / 180;
    const cosT = 1 - rand() * (1 - Math.cos(cone)), sinT = Math.sqrt(1 - cosT * cosT), az = rand() * Math.PI * 2;
    const sp = S.speed * (0.6 + 0.4 * rand());
    s.set([x + (rand() - 0.5) * 0.8, y + 0.05, z + (rand() - 0.5) * 0.8, birth], i * 4);
    v.set([Math.cos(az) * sinT * sp, cosT * sp, Math.sin(az) * sinT * sp, S.life * (0.65 + 0.35 * rand())], i * 4);
    this.meta.array.set([voice, rand(), 0, 1], i * 4);
    this.lo = Math.min(this.lo, i); this.hi = Math.max(this.hi, i);
    this.cursor = (i + 1) % CAPACITY;
    if (this.cursor === 0) this.flush();
    this.stats.emitted++;
  }

  // One plume particle (plus its trail ghosts) — positions are worked out in the shader.
  emitPlume(cx, cy, cz, voice, birth, dirX, dirZ, rand) {
    const Pl = P.plume, seed = rand(), ang = rand() * Math.PI * 2, ghosts = Math.max(0, Math.round(Pl.trail));
    for (let g = 0; g <= ghosts; g++) {
      const i = this.cursor, s = this.start.array, v = this.vel.array;
      if (s[i * 4 + 3] + v[i * 4 + 3] > this.now) this.stats.dropped++;
      s.set([cx, cy, cz, birth + (g * Pl.trailGap) / 1000], i * 4);
      v.set([dirX, dirZ, ang, Pl.length], i * 4);
      this.meta.array.set([voice, seed, 1, g === 0 ? 1 : 0.55 * (1 - g / (ghosts + 1))], i * 4);
      this.lo = Math.min(this.lo, i); this.hi = Math.max(this.hi, i);
      this.cursor = (i + 1) % CAPACITY;
      if (this.cursor === 0) this.flush();
      this.stats.emitted++;
    }
  }

  // A plume: one cluster, one direction, a bounded number alive at once.
  //   from a hit        ev is the hit; only the plume's voice launches one
  //   cued or a reply   opts.any: no voice test · opts.at {x, z}: start at the tile nearest that point,
  //                     at ev.time exactly (no ripple delay: the score already says when)
  plume(ev, field, aff, delayOf, opts = {}) {
    const Pl = P.plume;
    if (!Pl.on || (!opts.any && ev.voice !== Pl.voice) || !field.layout) return false;
    const list = opts.at ? field.layout.all : field.layout.byVoice[ev.voice]; if (!list.length) return false;
    this.plumeEnds = this.plumeEnds.filter(t => t > ev.time);
    if (this.plumeEnds.length >= Pl.maxConcurrent) { this.stats.plumesDropped++; return true; }
    const L = field.layout, rand = mulberry32(hashStr('plume:' + ev.id.slice(ev.id.indexOf(':') + 1)) ^ (this.seed * 40503));
    // the selected cluster: nearest the pointer while it touches the floor, else a seeded tile near the centre
    let i = -1;
    if (opts.at) {
      let bd = Infinity; for (const k of list) { const d = (L.x[k] - opts.at.x) ** 2 + (L.z[k] - opts.at.z) ** 2; if (d < bd) { bd = d; i = k; } }
    } else if (aff.on > 0.5 && P.pointer.on) {
      let bd = Infinity; for (const k of list) { const d = (L.x[k] - aff.x) ** 2 + (L.z[k] - aff.z) ** 2; if (d < bd) { bd = d; i = k; } }
    } else {
      const near = Pl.area > 0 ? list.filter(k => L.d[k] <= Pl.area) : list;
      const pool = near.length ? near : list;
      i = pool[(rand() * pool.length) | 0];
    }
    const delay = opts.at ? 0 : delayOf(i), birth = ev.time + delay;
    const st = field.tileState(i, histAt, birth, aff, 60, -1e9);
    const a = rand() * Math.PI * 2, dirX = Math.cos(a), dirZ = Math.sin(a);
    const strength = 0.6 + 0.4 * Math.min(1, ev.strength);
    const n = Math.round(Pl.perHit * strength * P.macros.sparks);
    for (let j = 0; j < n; j++) {
      const ox = (rand() - 0.5) * 1.6, oz = (rand() - 0.5) * 1.6;
      this.emitPlume(L.x[i] + ox, st.height + 0.05, L.z[i] + oz, ev.voice, birth + rand() * 0.08, dirX, dirZ, rand);
    }
    this.plumeEnds.push(birth + Pl.length + 0.08 + (Pl.trail * Pl.trailGap) / 1000);
    this.stats.plumes++;
    return true;
  }

  // One hit event → one finite budget. `delayOf(i)` gives the ripple delay (s) for tile i.
  burst(ev, field, aff, delayOf) {
    if (P.plume.entry === 'hits') this.plume(ev, field, aff, delayOf);
    const S = P.sparks;
    if (!S.on || !field.layout || !(EMITTERS[S.from] || EMITTERS.highs).includes(ev.voice)) return 0;
    const list = field.layout.byVoice[ev.voice];
    if (!list.length) return 0;
    // seeded from the event's place in the music (loop : index), not the restart epoch, so the same
    // music and seed give the same sparks after any restart
    const L = field.layout, rand = mulberry32(hashStr(ev.id.slice(ev.id.indexOf(':') + 1)) ^ (this.seed * 2654435761));
    const n = Math.round(S.perHit * P.macros.sparks * (0.4 + 0.6 * Math.min(1, ev.strength)));
    this.stats.events++;
    for (let j = 0; j < n; j++) {
      // prefer tiles lit by this voice right now (they are what the ripple carries outward)
      let i = list[(rand() * list.length) | 0], st = field.tileState(i, histAt, ev.time, aff, 60, -1e9);
      for (let t = 0; t < 4 && st.act < 0.2; t++) { i = list[(rand() * list.length) | 0]; st = field.tileState(i, histAt, ev.time, aff, 60, -1e9); }
      const birth = ev.time + delayOf(i);
      this.emit(L.x[i], field.tileState(i, histAt, birth, aff, 60, -1e9).height, L.z[i], ev.voice, birth, rand);
    }
    return n;
  }

  // Continuous emission: particles/s × the voice's level, seeded by the update index.
  continuous(field, aff, levels, time, dt, stepIndex, delayOf) {
    const S = P.sparks;
    if (!S.on || S.continuous <= 0 || !field.layout) return;
    const L = field.layout, rand = mulberry32((stepIndex * 2654435761) ^ this.seed);
    for (const k of EMITTERS[S.from] || EMITTERS.highs) {
      const list = L.byVoice[k]; if (!list.length) continue;
      this.steady[k] = Math.min(this.steady[k] + S.continuous * P.macros.sparks * levels[k] * dt, 16);
      while (this.steady[k] >= 1) {
        const i = list[(rand() * list.length) | 0], st = field.tileState(i, histAt, time, aff, 60, -1e9);
        this.emit(L.x[i], st.height, L.z[i], k, time + delayOf(i), rand);
        this.steady[k] -= 1;
      }
    }
  }

  flush() {
    if (this.hi < 0) return;
    const n = this.hi - this.lo + 1;
    for (const [attr, size] of [[this.start, 4], [this.vel, 4], [this.meta, 4]]) {
      attr.addUpdateRange(this.lo * size, n * size);
      attr.needsUpdate = true;
    }
    this.lo = Infinity; this.hi = -1;
  }

  clear() {
    this.start.array.fill(-1e6); this.start.clearUpdateRanges(); this.start.needsUpdate = true;
    this.steady.fill(0); this.lo = Infinity; this.hi = -1; this.cursor = 0;
    this.stats = { events: 0, emitted: 0, dropped: 0, alive: 0, plumes: 0, plumesDropped: 0 };
    this.plumeEnds = [];
  }

  sync(look, time, pixel) {
    const u = this.uniforms, S = P.sparks;
    this.now = time;
    u.uTime.value = time; u.uGravity.value = S.gravity; u.uTurb.value = S.turbulence; u.uTurbScale.value = S.turbScale;
    u.uSize.value = S.size; u.uPixel.value = pixel; u.uBright.value = S.bright; u.uCore.value = look.sparkCore;
    for (let k = 0; k < NB; k++) u.uPalette.value[k].copy(look['v' + k]);
    u.uAccent.value = look.ramp * look.accent;
    const Pl = P.plume;
    u.uPlumeH.value = Pl.height; u.uPlumeCurl.value = Pl.curl; u.uPlumeSpread.value = Pl.spread; u.uPlumeDrift.value = Pl.drift; u.uPlumeSize.value = Pl.size;
    const solo = P.solo.dest;
    this.points.visible = (S.on || P.plume.on) && P.diag.view !== 'surface' && P.diag.view !== 'light' && (solo === 'none' || solo === 'sparks');
    this.flush();
  }

  countAlive(time) {
    let n = 0; const s = this.start.array, v = this.vel.array;
    for (let i = 0; i < CAPACITY; i++) { const age = time - s[i * 4 + 3]; if (age >= 0 && age <= v[i * 4 + 3]) n++; }
    return (this.stats.alive = n);
  }
}

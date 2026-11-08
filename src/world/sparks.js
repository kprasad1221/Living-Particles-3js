// ─────────────────────────────────────────────────────────────────────────────
//  SPARKS — a particle system with real lifetimes, the way VFX Graph lays it out.
//
//    SPAWN       CPU, per 60 Hz step: sample tiles of the emitting voices; a tile whose
//                delayed onset is flashing may throw sparks (Burst), a loud tile may
//                emit steadily (Shimmer). VFX Graph: Spawn context + GPU events.
//    INITIALIZE  write one slot of a ring buffer: start position, velocity, birth time,
//                lifetime, voice, seed. VFX Graph: Initialize Particle.
//    UPDATE      none stored. The vertex shader evaluates the motion in closed form from
//                age = now − birth: p = p0 + v·age + ½·g·age² + turbulence.
//                VFX Graph: Update Particle (Gravity, Turbulence, Age) — here as maths.
//    OUTPUT      additive point sprites, size and alpha over life, voice colour.
//                VFX Graph: Output Particle Quad with Size/Color over Life.
//
//  Capacity is fixed (like VFX Graph's capacity). When it is full the oldest slot is
//  reused. Only the slots written this frame are uploaded to the GPU.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NB, P } from '../params.js';
import { histAt, bands } from '../bands.js';

export const CAPACITY = 8192;

const vertexShader = /* glsl */`
  uniform float uTime, uGravity, uTurb, uSize, uPixel;
  uniform vec3 uPalette[${NB}];
  attribute vec4 aStart;   // xyz, birth time
  attribute vec4 aVel;     // xyz, lifetime
  attribute vec2 aMeta;    // voice, seed
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float age = uTime - aStart.w;
    float t = age / max(aVel.w, 1e-3);
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vAlpha = 0.0; return; }
    vec3 p = aStart.xyz + aVel.xyz * age + vec3(0.0, 0.5 * uGravity * age * age, 0.0);
    float ph = aMeta.y * 6.2831;
    p += uTurb * age * vec3(sin(p.y * 0.9 + ph + uTime * 1.7), 0.35 * sin(p.x * 0.6 + uTime * 1.1 + ph), cos(p.y * 0.8 + ph * 1.3 - uTime * 1.4));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float life = smoothstep(0.0, 0.06, t) * (1.0 - t);
    gl_PointSize = uSize * uPixel * (0.4 + 0.6 * life) / max(-mv.z, 0.1);
    vColor = uPalette[int(aMeta.x + 0.5)];
    vAlpha = life;
  }
`;
const fragmentShader = /* glsl */`
  uniform float uBright;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    float core = smoothstep(0.35, 0.0, d);
    gl_FragColor = vec4((vColor * a + vec3(core) * 0.6) * uBright * vAlpha, 1.0);
  }
`;

const EMITTERS = { highs: [5, 6, 7], 'mids+highs': [3, 4, 5, 6, 7], all: [0, 1, 2, 3, 4, 5, 6, 7] };
const SAMPLES = 72;          // tiles tested per emitting voice per step

export class Sparks {
  constructor() {
    const g = new THREE.BufferGeometry();
    this.start = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.vel = new THREE.BufferAttribute(new Float32Array(CAPACITY * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.meta = new THREE.BufferAttribute(new Float32Array(CAPACITY * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.start.array.fill(-1e6);                    // every slot born long ago → dead
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
    g.setAttribute('aStart', this.start); g.setAttribute('aVel', this.vel); g.setAttribute('aMeta', this.meta);
    this.uniforms = {
      uTime: { value: 0 }, uGravity: { value: -4 }, uTurb: { value: 1 }, uSize: { value: 0.3 }, uPixel: { value: 500 },
      uBright: { value: 1 }, uPalette: { value: Array.from({ length: NB }, () => new THREE.Color()) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.cursor = 0; this.lo = Infinity; this.hi = -1;   // dirty range this frame
    this.rand = Math.random;
    this.steady = new Float32Array(NB);                   // shimmer accumulators
    this.alive = 0; this.spawned = 0;
  }

  emit(x, y, z, voice, time) {
    const S = P.sparks, r = this.rand, i = this.cursor;
    const a = r() * Math.PI * 2, spread = 0.35 + 0.65 * r();
    const sp = S.speed * (0.55 + 0.45 * r());
    this.start.array.set([x + (r() - 0.5) * 0.8, y + 0.05, z + (r() - 0.5) * 0.8, time], i * 4);
    this.vel.array.set([Math.cos(a) * sp * 0.35 * spread, sp, Math.sin(a) * sp * 0.35 * spread, S.life * (0.6 + 0.4 * r())], i * 4);
    this.meta.array.set([voice, r()], i * 2);
    this.lo = Math.min(this.lo, i); this.hi = Math.max(this.hi, i);
    this.cursor = (i + 1) % CAPACITY;
    if (this.cursor === 0) { this.flush(); }                // wrapped: upload what we have, start a new range
    this.spawned++;
  }

  // SPAWN: called once per simulation step.
  step(field, time, dt) {
    const S = P.sparks;
    if (!S.on || !field.layout) return;
    const L = field.layout, r = this.rand;
    for (const k of EMITTERS[S.from] || EMITTERS.highs) {
      const list = L.byVoice[k];
      if (!list.length) continue;
      // Burst: a tile whose (delayed) onset is flashing throws sparks.
      if (S.burst > 0) {
        for (let s = 0; s < SAMPLES; s++) {
          const i = list[(r() * list.length) | 0];
          const a = field.activation(i, histAt);
          if (a.onset > 0.55 && r() < S.burst) {
            const n = 1 + ((r() * 3) | 0);
            for (let j = 0; j < n; j++) this.emit(L.x[i], a.height, L.z[i], k, time);
          }
        }
      }
      // Shimmer: steady emission proportional to the voice's level.
      if (S.shimmer > 0) {
        this.steady[k] += S.shimmer * bands.level[k] * dt;
        let guard = 0;
        while (this.steady[k] >= 1 && guard++ < 64) {
          const i = list[(r() * list.length) | 0];
          const a = field.activation(i, histAt);
          if (a.act > 0.3) { this.emit(L.x[i], a.height, L.z[i], k, time); this.steady[k] -= 1; }
          else if (guard > 16) break;
        }
        this.steady[k] = Math.min(this.steady[k], 8);
      }
    }
  }

  flush() {
    if (this.hi < 0) return;
    const n = this.hi - this.lo + 1;
    for (const [attr, size] of [[this.start, 4], [this.vel, 4], [this.meta, 2]]) {
      attr.addUpdateRange(this.lo * size, n * size);
      attr.needsUpdate = true;
    }
    this.lo = Infinity; this.hi = -1;
  }

  clear() {
    for (let i = 0; i < CAPACITY; i++) this.start.array[i * 4 + 3] = -1e6;
    this.start.clearUpdateRanges(); this.start.needsUpdate = true;
    this.steady.fill(0); this.lo = Infinity; this.hi = -1;
  }

  sync(look, time, pixel) {
    const u = this.uniforms, S = P.sparks;
    u.uTime.value = time; u.uGravity.value = S.gravity; u.uTurb.value = S.turbulence;
    u.uSize.value = S.size; u.uPixel.value = pixel; u.uBright.value = S.bright;
    for (let k = 0; k < NB; k++) u.uPalette.value[k].copy(look['v' + k]);
    this.points.visible = S.on;
    this.flush();
  }

  countAlive(time) {
    let n = 0; const s = this.start.array, v = this.vel.array;
    for (let i = 0; i < CAPACITY; i++) { const age = time - s[i * 4 + 3]; if (age >= 0 && age <= v[i * 4 + 3]) n++; }
    return (this.alive = n);
  }
}

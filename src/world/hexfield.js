// ─────────────────────────────────────────────────────────────────────────────
//  HEX FIELD — the Living Particles floor, as one instanced draw call.
//
//  In the Unity capture, the floor is the pack's hex particles with an FFT script
//  feeding them. Here the same idea is split the way the GPU sees it:
//
//    SPAWN       buildLayout()   CPU, once: one entry per tile (axial hex grid)
//    INITIALIZE  instanced attributes, once: position, distance, voice, threshold, seed
//    UPDATE      vertex shader, every frame, stateless: reads the voice history at the
//                tile's delay and computes height, activation, flash
//    OUTPUT      fragment shader: rim, fill, sides, grain, fog — the look
//
//  Nothing per-tile is stored between frames. Everything a tile "remembers" comes
//  from the shared history texture (bands.js), which is why ten thousand tiles cost
//  almost nothing to update. When a study needs real per-particle state (velocity,
//  age that survives), that's the next step: GPGPU ping-pong textures — VFX Graph's
//  Update context, TouchDesigner's Feedback TOP on a position texture.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { NB, HIST, SIM_HZ, SQ3, P } from '../params.js';

// Small seeded PRNG so a layout is reproducible from its seed.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pingPong = (i, n) => { const m = 2 * (n - 1); const k = ((i % m) + m) % m; return k < n ? k : m - k; };

// SPAWN: one record per tile. Pointy-top hexes (a vertex on +z), circumradius 1, cut to a disc.
export function buildLayout(spawn) {
  const R = Math.max(1, Math.round(spawn.rings));
  const rand = mulberry32(spawn.seed * 9973 + 1);
  const maxD = 1.5 * R + 0.5;                          // a round floor: keep tiles within 1.5 R of the centre
  let count = 0;
  for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++)
    if (Math.hypot(SQ3 * (q + r / 2), 1.5 * r) <= maxD) count++;
  const L = {
    count,
    x: new Float32Array(count), z: new Float32Array(count), d: new Float32Array(count),
    voice: new Float32Array(count), gate: new Float32Array(count), live: new Float32Array(count),
    jitter: new Float32Array(count), rnd: new Float32Array(count),
    byVoice: Array.from({ length: NB }, () => []),
    radius: 0,
  };
  const w = Math.max(0.25, spawn.ringWidth) * SQ3;      // one voice band, in scene units
  let i = 0;
  for (let q = -R; q <= R; q++) {
    const r0 = Math.max(-R, -q - R), r1 = Math.min(R, -q + R);
    for (let r = r0; r <= r1; r++) {
      const x = SQ3 * (q + r / 2), z = 1.5 * r;
      const d = Math.hypot(x, z), ang = Math.atan2(z, x);
      if (d > maxD) continue;
      let k;
      switch (spawn.pattern) {
        case 'sectors': k = pingPong(Math.floor(((ang / (2 * Math.PI)) + 1) * 16), NB); break;
        case 'spiral':  k = pingPong(Math.floor(d / w + (ang / (2 * Math.PI)) * NB), NB); break;
        case 'scatter': k = Math.floor(rand() * NB); break;
        default:        k = pingPong(Math.floor(d / w), NB);
      }
      const sr = rand(), vr = rand();
      if (spawn.pattern !== 'scatter' && sr < spawn.scatter) k = Math.min(NB - 1, Math.floor(vr * NB));
      if (spawn.order === 'high-in') k = NB - 1 - k;
      L.x[i] = x; L.z[i] = z; L.d[i] = d; L.voice[i] = k;
      L.gate[i] = rand();
      L.live[i] = rand() < spawn.density ? 1 : 0;
      L.jitter[i] = rand(); L.rnd[i] = rand();
      if (L.live[i]) L.byVoice[k].push(i);
      L.radius = Math.max(L.radius, d);
      i++;
    }
  }
  return L;
}

const vertexShader = /* glsl */`
  uniform sampler2D uHist;
  uniform float uTime, uTravel, uExtrude, uShape, uFloor, uCeil, uSpread, uBase, uJitter, uGap, uSwell, uPulseVoice;
  uniform vec4 uAff;            // x, z, radius, on
  uniform float uAffLift, uAffGlow;
  uniform vec3 uPalette[${NB}];

  attribute vec4 aTile;         // x, z, distance from centre, voice
  attribute vec4 aSeed;         // threshold, live, height jitter, random

  varying vec2 vLocal;          // hex-local position (circumradius 1)
  varying float vY;             // 0 at the floor, 1 at the top edge
  varying float vTop;           // 1 on the top cap
  varying float vAct, vOnset, vPulse, vAff, vHeight;
  varying vec3 vColor, vWorld;

  const float ROWS = ${HIST.toFixed(1)};

  vec4 hist(float voice, float row) {
    row = clamp(row, 0.0, ROWS - 1.0);
    float r0 = floor(row);
    float u = (voice + 0.5) / ${NB.toFixed(1)};
    vec4 a = texture2D(uHist, vec2(u, (r0 + 0.5) / ROWS));
    vec4 b = texture2D(uHist, vec2(u, (min(r0 + 1.0, ROWS - 1.0) + 0.5) / ROWS));
    return mix(a, b, row - r0);
  }

  void main() {
    float voice = aTile.w;
    // UPDATE · the music reaches this tile d / travel seconds after the centre.
    float row = uTravel > 0.0 ? aTile.z / uTravel * ${SIM_HZ.toFixed(1)} : 0.0;
    vec4 h = hist(voice, row);
    float presence = smoothstep(uFloor, uCeil, h.r);

    // Threshold spread: each tile has its own threshold, so a louder voice lights more tiles.
    float thr = aSeed.x * uSpread * 0.9;
    float act = smoothstep(thr, thr + mix(1.0, 0.12, uSpread), presence) * aSeed.y;
    float onset = h.g * aSeed.y * step(thr, presence + 0.05);

    float pulse = smoothstep(uFloor, uCeil, hist(uPulseVoice, row).r);
    float sub = smoothstep(uFloor, uCeil, hist(0.0, row).r);
    float fold = 0.5 + 0.5 * sin(aTile.x * 0.075 + uTime * 0.35) * cos(aTile.y * 0.06 - uTime * 0.27);
    float swell = uSwell * sub * fold;

    // Affector: distance to a point you move (the hand in the Unity capture).
    float aff = uAff.w * pow(1.0 - smoothstep(0.0, uAff.z, length(aTile.xy - uAff.xy)), 2.0);

    float height = uBase + aSeed.z * uJitter + uExtrude * pow(act, uShape) + swell + aff * uAffLift;
    act = max(act, aff * uAffGlow);

    float s = 1.0 - uGap;
    vec3 wp = vec3(aTile.x + position.x * s, position.y * height, aTile.y + position.z * s);

    vLocal = position.xz; vY = position.y; vTop = step(0.5, normal.y);
    vAct = act; vOnset = onset; vPulse = pulse; vAff = aff; vHeight = height;
    vColor = uPalette[int(voice + 0.5)];
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform vec3 uRim, uFace, uSide, uFogColor, uAffColor;
  uniform float uRimWidth, uRimGlow, uRimPulse, uFillGlow, uFillCore, uSideGlow, uEdgeLines, uGrain, uFlash, uFog, uAffTint;

  varying vec2 vLocal;
  varying float vY, vTop, vAct, vOnset, vPulse, vAff, vHeight;
  varying vec3 vColor, vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    // Distance to the hex edge on the top cap: 0 at the centre, 1 on the edge.
    vec2 q = abs(vLocal);
    float hexd = max(q.x, dot(q, vec2(0.5, 0.8660254))) / 0.8660254;
    float aa = fwidth(hexd) * 1.2 + 1e-4;
    float rim = smoothstep(1.0 - uRimWidth - aa, 1.0 - uRimWidth * 0.35, hexd);
    float inner = pow(clamp(hexd, 0.0, 1.0), 5.0);

    vec3 rimCol = mix(uRim, vColor, vAct);
    float rimI = uRimGlow * (0.55 + 0.45 * uRimPulse * vPulse) + vAct * uFillGlow * 0.45 + vOnset * uFlash;

    // Top cap: stone face + voice fill (from the rim inward, or solid with Fill core) + rim.
    float g = uGrain * (vnoise(vWorld.xz * 3.1) * 0.6 + vnoise(vWorld.xz * 11.0) * 0.4 - 0.5);
    vec3 face = uFace * (1.0 + 2.0 * g);
    vec3 fill = vColor * vAct * uFillGlow * mix(inner, 0.55 + 0.45 * inner, uFillCore);
    vec3 topCol = face + fill + rimCol * (rim * rimI + inner * 0.18 * rimI);
    topCol += vec3(1.0) * vOnset * uFlash * 0.35 * rim;            // white-hot flash on hits

    // Sides: flat-shaded stone, the voice glowing down from the top edge.
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float lit = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.45, 0.7, 0.55))), 0.0);
    float grad = pow(clamp(vY, 0.0, 1.0), mix(9.0, 2.6, vAct));        // glow hangs from the top edge
    float topLine = smoothstep(1.0 - 0.07 / max(vHeight, 0.07), 1.0, vY);
    float ang = atan(vLocal.x, vLocal.y) / 1.0471976;                // 60° segments
    float fa = abs(fract(ang + 0.5) - 0.5);
    float corner = 1.0 - smoothstep(0.0, fwidth(ang) * 1.5 + 0.02, fa);
    vec3 sideCol = uSide * lit * (0.5 + 0.5 * vY)
      + vColor * grad * vAct * uSideGlow
      + rimCol * topLine * rimI * 0.8
      + rimCol * corner * uEdgeLines * (0.25 + vAct) * rimI * 0.5;

    vec3 col = mix(sideCol, topCol, vTop);
    col += uAffColor * vAff * uAffTint * (0.25 + rim * vTop + topLine * (1.0 - vTop));

    float dist = length(vWorld.xz - cameraPosition.xz);           // ground distance: a high camera still sees a crisp floor
    float fog = 1.0 - exp(-pow(max(dist - 24.0, 0.0) * uFog, 1.5));   // clear near the viewer, haze toward the horizon
    gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
  }
`;

export class HexField {
  constructor(histTex) {
    // One hex prism, circumradius 1, from y = 0 to y = 1. The bottom cap is never seen.
    const prism = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    prism.translate(0, 0.5, 0);
    const keep = prism.groups.filter(g => g.materialIndex !== 2);       // drop the bottom cap
    const idx = prism.index.array, kept = [];
    for (const g of keep) for (let i = g.start; i < g.start + g.count; i++) kept.push(idx[i]);
    prism.setIndex(kept); prism.clearGroups();
    this.prism = prism;

    this.uniforms = {
      uHist: { value: histTex }, uTime: { value: 0 },
      uTravel: { value: 0 }, uExtrude: { value: 0 }, uShape: { value: 1 }, uFloor: { value: 0.2 }, uCeil: { value: 0.9 },
      uSpread: { value: 0.5 }, uBase: { value: 0.1 }, uJitter: { value: 0 }, uGap: { value: 0.05 }, uSwell: { value: 0 },
      uPulseVoice: { value: 1 },
      uAff: { value: new THREE.Vector4(0, 0, 8, 0) }, uAffLift: { value: 0 }, uAffGlow: { value: 0 },
      uAffTint: { value: 0 }, uAffColor: { value: new THREE.Color(1, 1, 1) },
      uPalette: { value: Array.from({ length: NB }, () => new THREE.Color()) },
      uRim: { value: new THREE.Color() }, uFace: { value: new THREE.Color() }, uSide: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color() },
      uRimWidth: { value: 0.1 }, uRimGlow: { value: 1 }, uRimPulse: { value: 1 }, uFillGlow: { value: 1 }, uFillCore: { value: 0 },
      uSideGlow: { value: 1 }, uEdgeLines: { value: 0 }, uGrain: { value: 0 }, uFlash: { value: 1 }, uFog: { value: 0.01 },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.mesh = null;
    this.layout = null;
  }

  build(spawn) {
    const L = buildLayout(spawn);
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.prism.index;
    g.setAttribute('position', this.prism.getAttribute('position'));
    g.setAttribute('normal', this.prism.getAttribute('normal'));
    const tile = new Float32Array(L.count * 4), seed = new Float32Array(L.count * 4);
    for (let i = 0; i < L.count; i++) {
      tile.set([L.x[i], L.z[i], L.d[i], L.voice[i]], i * 4);
      seed.set([L.gate[i], L.live[i], L.jitter[i], L.rnd[i]], i * 4);
    }
    g.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 4));
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = L.count;
    if (this.mesh) { this.mesh.geometry.dispose(); this.mesh.geometry = g; }
    else { this.mesh = new THREE.Mesh(g, this.material); this.mesh.frustumCulled = false; }
    this.layout = L;
    return L;
  }

  // Parameters → uniforms. `look` is a mixed look (colours are THREE.Color).
  sync(look, time, aff) {
    const u = this.uniforms, I = P.init, U = P.update, A = P.affector;
    u.uTime.value = time;
    u.uTravel.value = U.travel; u.uExtrude.value = U.extrude; u.uShape.value = U.shape;
    u.uFloor.value = U.floor; u.uCeil.value = Math.max(U.ceil, U.floor + 0.01);
    u.uSpread.value = I.spread; u.uBase.value = I.base; u.uJitter.value = I.jitter; u.uGap.value = I.gap;
    u.uSwell.value = U.swell; u.uPulseVoice.value = U.pulseVoice;
    u.uAff.value.set(aff.x, aff.z, A.radius, aff.on);
    u.uAffLift.value = A.lift; u.uAffGlow.value = A.glow; u.uAffTint.value = A.tint; u.uAffColor.value.set(A.color);
    for (let k = 0; k < NB; k++) u.uPalette.value[k].copy(look['v' + k]);
    u.uRim.value.copy(look.rim); u.uFace.value.copy(look.face); u.uSide.value.copy(look.side);
    u.uFogColor.value.copy(look.horizon);
    for (const k of ['rimWidth', 'rimGlow', 'rimPulse', 'fillGlow', 'fillCore', 'sideGlow', 'edgeLines', 'grain', 'flash', 'fog'])
      u['u' + k[0].toUpperCase() + k.slice(1)].value = look[k];
  }

  // The same activation the vertex shader computes, on the CPU (sparks use it to find lit tiles).
  activation(i, histAt) {
    const L = this.layout, U = P.update, I = P.init;
    const row = U.travel > 0 ? (L.d[i] / U.travel) * SIM_HZ : 0;
    const k = L.voice[i];
    const ss = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const pres = ss(U.floor, Math.max(U.ceil, U.floor + 0.01), histAt(k, row, 0));
    const thr = L.gate[i] * I.spread * 0.9;
    const act = ss(thr, thr + (1 + (0.12 - 1) * I.spread), pres) * L.live[i];
    const onset = histAt(k, row, 1) * L.live[i] * (pres + 0.05 >= thr ? 1 : 0);
    const height = I.base + L.jitter[i] * I.jitter + U.extrude * Math.pow(act, U.shape);
    return { act, onset, height };
  }
}

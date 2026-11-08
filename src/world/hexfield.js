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
import { NB, HIST, SQ3, P, GLOBAL } from '../params.js';
import { SHADER_LOOK_KEYS } from '../looks.js';

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
      L.live[i] = rand() < spawn.active ? 1 : 0;
      L.jitter[i] = rand(); L.rnd[i] = rand();
      if (L.live[i]) L.byVoice[k].push(i);
      L.radius = Math.max(L.radius, d);
      i++;
    }
  }
  return L;
}

// Shared fold used by the sub swell (GPU and CPU must agree, so sparks start on the surface).
const FOLD = { kx: 0.075, wx: 0.35, kz: 0.06, wz: 0.27 };
export const fold = (x, z, t) => 0.5 + 0.5 * Math.sin(x * FOLD.kx + t * FOLD.wx) * Math.cos(z * FOLD.kz - t * FOLD.wz);
export const MIN_HEIGHT = 0.02;     // a negative pointer lift can press tiles down, never through the floor

const vertexShader = /* glsl */`
  uniform sampler2D uHist;
  uniform float uTime, uRowHz, uRowShift, uTravel, uExtrude, uShape, uFloor, uCeil, uSpread, uBase, uJitter, uGap, uSwell, uRimSource;
  uniform vec4 uAmt;            // destination amounts × solo: lift, hits, rim, colour
  uniform float uShimmer;       // harmony → shimmer amount × on × solo
  uniform vec4 uAff;            // x, z, radius, on
  uniform float uAffLift, uAffGlow;
  uniform vec3 uPalette[${NB}];

  attribute vec4 aTile;         // x, z, distance from centre, voice
  attribute vec4 aSeed;         // threshold, live, height jitter, random

  varying vec2 vLocal;          // hex-local position (circumradius 1)
  varying float vY;             // 0 at the floor, 1 at the top edge
  varying float vTop;           // 1 on the top cap
  varying float vAct, vOnset, vPulse, vAff, vHeight, vShim;
  varying vec3 vColor, vWorld;

  const float ROWS = ${HIST.toFixed(1)};

  vec4 hist(float voice, float row) {
    row = clamp(row, 0.0, ROWS - 1.0);
    float r0 = floor(row);
    float u = (voice + 0.5) / ${(NB + 1).toFixed(1)};
    vec4 a = texture2D(uHist, vec2(u, (r0 + 0.5) / ROWS));
    vec4 b = texture2D(uHist, vec2(u, (min(r0 + 1.0, ROWS - 1.0) + 0.5) / ROWS));
    return mix(a, b, row - r0);
  }

  void main() {
    float voice = aTile.w;
    // UPDATE · the music reaches this tile d / travel seconds after the centre.
    float row = (uTravel > 0.0 ? aTile.z / uTravel * uRowHz : 0.0) + uRowShift;
    vec4 h = hist(voice, row);                     // r lift · g hit · b rim · a colour
    float presence = smoothstep(uFloor, uCeil, h.r) * uAmt.x;

    // Activation variation: each tile has its own threshold, so a louder voice lights more tiles.
    float thr = aSeed.x * uSpread * 0.9;
    float act = smoothstep(thr, thr + mix(1.0, 0.12, uSpread), presence) * aSeed.y;
    float onset = h.g * uAmt.y * aSeed.y * step(thr, presence + 0.05);

    float pulse = hist(uRimSource, row).b * uAmt.z;
    float sub = smoothstep(uFloor, uCeil, hist(0.0, row).r) * uAmt.x;
    float drift = clamp(h.a * uAmt.w, 0.0, 1.0);
    // Shimmer: harmony confidence (global column, g) makes each rim twinkle at its own rate.
    float tw = pow(0.5 + 0.5 * sin(uTime * (6.0 + aSeed.w * 9.0) + aSeed.w * 61.0), 6.0);
    vShim = hist(${GLOBAL}.0, row).g * uShimmer * tw;
    float fold = 0.5 + 0.5 * sin(aTile.x * ${FOLD.kx} + uTime * ${FOLD.wx}) * cos(aTile.y * ${FOLD.kz} - uTime * ${FOLD.wz});
    float swell = uSwell * sub * fold;

    // Pointer: distance to a point you move (the hand in the Unity capture).
    float aff = uAff.w * pow(1.0 - smoothstep(0.0, uAff.z, length(aTile.xy - uAff.xy)), 2.0);

    float height = max(uBase + aSeed.z * uJitter + uExtrude * pow(act, uShape) + swell + aff * uAffLift, ${MIN_HEIGHT});
    act = max(act, aff * uAffGlow);

    float s = 1.0 - uGap;
    vec3 wp = vec3(aTile.x + position.x * s, position.y * height, aTile.y + position.z * s);

    vLocal = position.xz; vY = position.y; vTop = step(0.5, normal.y);
    vAct = act; vOnset = onset; vPulse = pulse; vAff = aff; vHeight = height;
    int vi = int(voice + 0.5);
    vColor = mix(uPalette[vi], uPalette[int(mod(float(vi) + 1.0, ${NB}.0))], drift);
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

// OUTPUT · every light contribution is its own term with its own control:
//   base surface   face / side colour with restrained directional shading (readable with emission off)
//   resting rim    restRim: the grid at rest
//   rim breath     rimBreath × the rim mapping's level (a whole-floor pulse)
//   responsive     rimResponse on the rim, fill across the face, sideGlow down the sides, × tile activation
//   inner spill    light leaking inward from the rim, × the rim's brightness
//   hit accent     hitAccent: coloured boost on a hit · hitWhiten: separate move toward white
//   pointer        tint near the pointer
const fragmentShader = /* glsl */`
  uniform vec3 uRim, uFace, uSide, uFogColor, uAffColor;
  uniform float uRimWidth, uRestRim, uRimBreath, uRimResponse, uInnerSpill, uSpillFalloff, uFill, uFillCore;
  uniform float uSideGlow, uSideFalloff, uTopLine, uEdgeLines, uHitAccent, uHitWhiten, uGrain, uFog, uAffTint;
  uniform float uDiag;          // 0 normal · 1 emission only · 2 surface only

  varying vec2 vLocal;
  varying float vY, vTop, vAct, vOnset, vPulse, vAff, vHeight, vShim;
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
    // Rim: a band of world width uRimWidth (in tile radii). aa is the screen footprint of one
    // pixel in the same units. When the band is thinner than ~2 pixels its energy is scaled by
    // its coverage, so distant rims fade instead of inflating into a glowing sheet.
    float aa = fwidth(hexd) + 1e-4;
    float inEdge = 1.0 - uRimWidth;
    float rim = smoothstep(inEdge - aa, inEdge + aa, hexd);
    rim *= clamp(uRimWidth / (2.0 * aa), 0.0, 1.0);
    float inner = pow(clamp(hexd, 0.0, 1.0), uSpillFalloff);

    vec3 rimCol = mix(uRim, vColor, vAct);
    float rimI = uRestRim + uRimBreath * vPulse + uRimResponse * vAct + uHitAccent * vOnset;

    // Top cap
    float g = uGrain * (vnoise(vWorld.xz * 3.1) * 0.6 + vnoise(vWorld.xz * 11.0) * 0.4 - 0.5);
    vec3 face = uFace * (1.0 + 2.0 * g);
    vec3 fill = vColor * vAct * uFill * mix(inner, 0.55 + 0.45 * inner, uFillCore);
    vec3 topEmit = fill + rimCol * rimI * (rim + inner * uInnerSpill)
                 + vec3(uHitWhiten * vOnset * rim)
                 + mix(vColor, vec3(1.0), 0.35) * vShim * 2.0 * rim;              // harmony shimmer

    // Sides: flat-shaded stone; the voice glows down from the top edge.
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float lit = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.45, 0.7, 0.55))), 0.0);
    float grad = pow(clamp(vY, 0.0, 1.0), mix(9.0, uSideFalloff, vAct));
    float ly = 0.07 / max(vHeight, 0.07);
    float topLine = smoothstep(1.0 - ly, 1.0, vY);
    float ang = atan(vLocal.x, vLocal.y) / 1.0471976;                // 60° segments
    float fa = abs(fract(ang + 0.5) - 0.5);
    float corner = 1.0 - smoothstep(0.0, fwidth(ang) * 1.5 + 0.02, fa);
    vec3 sideBase = uSide * lit * (0.5 + 0.5 * vY);
    vec3 sideEmit = vColor * grad * vAct * uSideGlow
      + rimCol * rimI * (topLine * uTopLine + corner * uEdgeLines * (0.25 + vAct) * 0.5);

    vec3 base = mix(sideBase, face, vTop);
    vec3 emit = mix(sideEmit, topEmit, vTop)
              + uAffColor * vAff * uAffTint * (0.25 + rim * vTop + topLine * (1.0 - vTop));
    if (uDiag > 1.5) emit = vec3(0.0);
    else if (uDiag > 0.5) base = vec3(0.0);

    float dist = length(vWorld.xz - cameraPosition.xz);           // ground distance: a high camera still sees a crisp floor
    float fog = 1.0 - exp(-pow(max(dist - 24.0, 0.0) * uFog, 1.5));   // clear near the viewer, haze toward the horizon
    // Emission-only (also the bloom source): emission fades with distance but never gains fog colour.
    if (uDiag > 0.5 && uDiag < 1.5) { gl_FragColor = vec4(emit * (1.0 - fog), 1.0); return; }
    gl_FragColor = vec4(mix(base + emit, uFogColor, fog), 1.0);
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
      uRimSource: { value: 1 }, uAmt: { value: new THREE.Vector4(1, 1, 1, 0) }, uShimmer: { value: 0 },
      uAff: { value: new THREE.Vector4(0, 0, 8, 0) }, uAffLift: { value: 0 }, uAffGlow: { value: 0 },
      uAffTint: { value: 0 }, uAffColor: { value: new THREE.Color(1, 1, 1) },
      uPalette: { value: Array.from({ length: NB }, () => new THREE.Color()) },
      uRim: { value: new THREE.Color() }, uFace: { value: new THREE.Color() }, uSide: { value: new THREE.Color() },
      uFogColor: { value: new THREE.Color() },
      uRowHz: { value: 60 }, uRowShift: { value: 0 }, uDiag: { value: 0 },
      ...Object.fromEntries(SHADER_LOOK_KEYS.map(k => ['u' + k[0].toUpperCase() + k.slice(1), { value: 0 }])),
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
  // Parameters → uniforms that the CPU also relies on (ripple delay, heights for spark origins).
  // Called whenever the music advances, so it never depends on a frame being drawn.
  syncParams(aff) {
    const u = this.uniforms, F = P.floor, Mv = P.movement, A = P.pointer, M = P.map;
    u.uTravel.value = Mv.ripple === 'outward' ? Mv.travel : 0;
    u.uExtrude.value = Mv.lift * M.lift.amount * P.macros.movement; u.uShape.value = Mv.curve;
    u.uFloor.value = Mv.floor; u.uCeil.value = Math.max(Mv.ceil, Mv.floor + 0.01);
    u.uSpread.value = F.variation; u.uBase.value = F.rest; u.uJitter.value = F.jitter; u.uGap.value = F.gap;
    u.uSwell.value = Mv.swell; u.uRimSource.value = M.rim.source;
    const solo = P.solo.dest, on = d => (solo === 'none' || solo === d ? 1 : 0);
    u.uAmt.value.set(on('lift'), M.hits.amount * on('hits'), M.rim.amount * on('rim'), M.colour.amount * on('colour'));
    u.uShimmer.value = P.harmony.on ? P.harmony.amount * on('shimmer') : 0;
    u.uAff.value.set(aff.x, aff.z, A.radius, aff.on * (solo === 'none' ? 1 : 0));
    u.uAffLift.value = A.lift; u.uAffGlow.value = A.glow; u.uAffTint.value = A.tint; u.uAffColor.value.set(A.color);
  }

  sync(look, time, aff, timing = { rowHz: 60, rowShift: 0 }) {
    const u = this.uniforms;
    u.uTime.value = time; u.uRowHz.value = timing.rowHz; u.uRowShift.value = timing.rowShift;
    this.syncParams(aff);
    for (let k = 0; k < NB; k++) u.uPalette.value[k].copy(look['v' + k]);
    u.uRim.value.copy(look.rim); u.uFace.value.copy(look.face); u.uSide.value.copy(look.side);
    u.uFogColor.value.copy(look.horizon);
    u.uDiag.value = { emission: 1, surface: 2 }[P.diag.view] || 0;
    for (const k of SHADER_LOOK_KEYS) u['u' + k[0].toUpperCase() + k.slice(1)].value = look[k];
  }

  // The vertex shader's tile state, on the CPU, so sparks start exactly on the drawn surface
  // (including sub swell and pointer lift). `aff` is the stage's affector {x, z, on}.
  tileState(i, histAt, time, aff, rowHz = 60, rowShift = 0) {
    const L = this.layout, u = this.uniforms;
    const row = (u.uTravel.value > 0 ? (L.d[i] / u.uTravel.value) * rowHz : 0) + rowShift;
    const k = L.voice[i], amt = u.uAmt.value;
    const sm = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const lo = u.uFloor.value, hi = u.uCeil.value, sp = u.uSpread.value;
    const pres = sm(lo, hi, histAt(k, row, 0)) * amt.x;
    const thr = L.gate[i] * sp * 0.9;
    const act = sm(thr, thr + (1 + (0.12 - 1) * sp), pres) * L.live[i];
    const onset = histAt(k, row, 1) * amt.y * L.live[i] * (pres + 0.05 >= thr ? 1 : 0);
    const swell = u.uSwell.value * sm(lo, hi, histAt(0, row, 0)) * amt.x * fold(L.x[i], L.z[i], time);
    const av = u.uAff.value, dA = Math.hypot(L.x[i] - av.x, L.z[i] - av.y);
    const affV = av.w * Math.pow(1 - sm(0, av.z, dA), 2);
    const height = Math.max(u.uBase.value + L.jitter[i] * u.uJitter.value + u.uExtrude.value * Math.pow(act, u.uShape.value)
      + swell + affV * u.uAffLift.value, MIN_HEIGHT);
    return { act, onset, height };
  }
}

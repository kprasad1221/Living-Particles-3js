// ─────────────────────────────────────────────────────────────────────────────
//  Looks — the Output context as data.
//
//  Since the precision pass every light contribution has its own value (see the
//  fragment shader in world/hexfield.js). The four original looks are kept exactly
//  as they were authored, in the old form, and converted on load so they render as
//  before; they stay as comparison presets.
//
//    av1  Violet     magenta/purple rim floor, outline-only, Unity daylight sky
//    av2  Tropical   red rim floor; blue, cyan, yellow and orange columns on the voices
//    av3  Funk       warm-white rims on dark stone; solid red columns with lit edges
//    nocturne        a night version leaning toward Tetris Effect's dark stages
//    av2p Precision  AV2 rebuilt for edge/interior separation (precision pass, CP2)
//
//  The AV looks are read off the Unity capture (a phone photo of a monitor): use
//  them for edge/interior relationships and hierarchy, not as calibrated colours.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

export const LOOK_KEYS = {
  colors: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'rim', 'face', 'side', 'skyTop', 'horizon'],
  numbers: [
    'rimWidth', 'restRim', 'rimBreath', 'rimResponse', 'innerSpill', 'spillFalloff',
    'fill', 'fillCore', 'sideGlow', 'sideFalloff', 'topLine', 'edgeLines',
    'hitAccent', 'hitWhiten', 'grain', 'sparkCore',
    'fog', 'horizonGlow',
    'bloom', 'bloomRadius', 'bloomThreshold', 'bloomSky', 'exposure',
  ],
};
// Look values the tile shader reads directly as uniforms.
export const SHADER_LOOK_KEYS = ['rimWidth', 'restRim', 'rimBreath', 'rimResponse', 'innerSpill', 'spillFalloff',
  'fill', 'fillCore', 'sideGlow', 'sideFalloff', 'topLine', 'edgeLines', 'hitAccent', 'hitWhiten', 'grain', 'fog'];

// Study 01's looks used fewer, coupled values. This reproduces their response term for term:
//   old rim = rimGlow × (0.55 + 0.45 × rimPulse × pulse) + 0.45 × fillGlow × act + flash × onset
//   old white flash = 0.35 × flash × onset on the rim; inner spill 0.18; spill falloff 5;
//   side falloff 2.6 at full activation; side top line 0.8; spark core 0.6.
// Bloom used the whole scene (sky included), which is bloomSky = 1.
export const isLegacy = l => l && 'rimGlow' in l && !('restRim' in l);
export function fromLegacy(l) {
  const out = {};
  for (const k of LOOK_KEYS.colors) out[k] = l[k];
  Object.assign(out, {
    name: l.name, rimWidth: l.rimWidth,
    restRim: 0.55 * l.rimGlow, rimBreath: 0.45 * l.rimGlow * l.rimPulse, rimResponse: 0.45 * l.fillGlow,
    innerSpill: 0.18, spillFalloff: 5, fill: l.fillGlow, fillCore: l.fillCore,
    sideGlow: l.sideGlow, sideFalloff: 2.6, topLine: 0.8, edgeLines: l.edgeLines,
    hitAccent: l.flash, hitWhiten: 0.35 * l.flash, grain: l.grain, sparkCore: 0.6,
    fog: l.fog, horizonGlow: l.horizonGlow,
    bloom: l.bloom, bloomRadius: l.bloomRadius, bloomThreshold: l.bloomThreshold, bloomSky: 1, exposure: l.exposure,
  });
  return out;
}

// The originals, exactly as authored in Study 01.
const LEGACY = {
  av1: {
    name: 'AV1 · Violet',
    v0: '#5a1cff', v1: '#9b2bff', v2: '#d22cff', v3: '#ff2fd0', v4: '#ff4fae', v5: '#c86bff', v6: '#ff8ae6', v7: '#f3d6ff',
    rim: '#c51fff', face: '#0d0614', side: '#1a0b26', skyTop: '#3d64b8', horizon: '#c9d6ee',
    rimWidth: 0.16, rimGlow: 1.7, rimPulse: 1.2, fillGlow: 1.0, fillCore: 0.12, sideGlow: 0.8, edgeLines: 0.0, grain: 0.0,
    flash: 1.6, fog: 0.006, horizonGlow: 0.35, bloom: 0.6, bloomRadius: 0.5, bloomThreshold: 0.85, exposure: 0.9,
  },
  av2: {
    name: 'AV2 · Tropical',
    v0: '#1f55ff', v1: '#1aa8ff', v2: '#22e3ff', v3: '#ffd23a', v4: '#ff9a1f', v5: '#ff5a1f', v6: '#5fd0ff', v7: '#fff1b0',
    rim: '#ff1f35', face: '#12040a', side: '#24070f', skyTop: '#3f6cc4', horizon: '#d5e1f2',
    rimWidth: 0.15, rimGlow: 1.5, rimPulse: 1.0, fillGlow: 0.85, fillCore: 0.12, sideGlow: 0.75, edgeLines: 0.15, grain: 0.0,
    flash: 1.8, fog: 0.006, horizonGlow: 0.35, bloom: 0.6, bloomRadius: 0.45, bloomThreshold: 0.85, exposure: 0.92,
  },
  av3: {
    name: 'AV3 · Funk',
    v0: '#ff1430', v1: '#ff1d2f', v2: '#ff2a3a', v3: '#ff1430', v4: '#ff3346', v5: '#ff1430', v6: '#ff5a66', v7: '#ffffff',
    rim: '#ffd9cf', face: '#16110f', side: '#2a0d10', skyTop: '#4a6cb4', horizon: '#cdd5e6',
    rimWidth: 0.11, rimGlow: 1.3, rimPulse: 0.6, fillGlow: 1.3, fillCore: 0.85, sideGlow: 0.9, edgeLines: 1.0, grain: 0.55,
    flash: 1.2, fog: 0.0055, horizonGlow: 0.3, bloom: 0.5, bloomRadius: 0.35, bloomThreshold: 0.9, exposure: 0.95,
  },
  nocturne: {
    name: 'Nocturne',
    v0: '#4b2bd6', v1: '#3a5bff', v2: '#1fa2ff', v3: '#19d6c4', v4: '#79f29a', v5: '#ffe06b', v6: '#ff9a5c', v7: '#fff3e6',
    rim: '#1b6f9e', face: '#020409', side: '#05080f', skyTop: '#010207', horizon: '#071022',
    rimWidth: 0.08, rimGlow: 0.9, rimPulse: 1.6, fillGlow: 1.5, fillCore: 0.2, sideGlow: 1.2, edgeLines: 0.35, grain: 0.0,
    flash: 2.4, fog: 0.007, horizonGlow: 0.25, bloom: 0.9, bloomRadius: 0.4, bloomThreshold: 0.55, exposure: 1.0,
  },
};

export const LOOKS = Object.fromEntries(Object.entries(LEGACY).map(([k, l]) => [k, fromLegacy(l)]));

// AV2 · Precision. Tuned with bloom off first, then glow restored from emission only:
// rims carry the colour, interiors stay dark, the white flash is gone, the sky never blooms.
LOOKS.av2p = {
  ...LOOKS.av2,
  name: 'AV2 · Precision',
  face: '#170a10', side: '#3b1622',          // a little more surface, so height reads with emission off
  rimWidth: 0.12,
  restRim: 0.75, rimBreath: 0.3, rimResponse: 1.05,
  innerSpill: 0.1, spillFalloff: 7,
  fill: 0.28, fillCore: 0.0,
  sideGlow: 0.75, sideFalloff: 3.6, topLine: 0.9, edgeLines: 0.2,
  hitAccent: 0.5, hitWhiten: 0.0, sparkCore: 0.15,
  bloom: 0.2, bloomRadius: 0.25, bloomThreshold: 1.1, bloomSky: 0.0, exposure: 0.92,
};

export const LOOK_ORDER = ['av2p', 'av1', 'av2', 'av3', 'nocturne'];

export function cloneLook(l) { return JSON.parse(JSON.stringify(l)); }

const ca = new THREE.Color(), cb = new THREE.Color();

// Mix two looks into `out`: colours become THREE.Color (linear), numbers mix linearly.
// Colour pickers give sRGB hex; THREE.Color.set converts to linear once, here.
export function mixLooks(a, b, t, out) {
  for (const k of LOOK_KEYS.colors) {
    ca.set(a[k]); cb.set(b[k]);
    (out[k] ||= new THREE.Color()).copy(ca).lerp(cb, t);
  }
  for (const k of LOOK_KEYS.numbers) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

// Keep only the keys a look owns (used when importing and migrating). Old-form looks are
// converted first, so a Study 01 scene keeps its colours and its response.
export function sanitizeLook(src, fallback) {
  const base = isLegacy(fallback) ? fromLegacy(fallback) : fallback;
  const l = cloneLook(base);
  if (!src) return l;
  if (isLegacy(src)) src = fromLegacy(src);
  for (const k of LOOK_KEYS.colors) if (typeof src[k] === 'string' && /^#[0-9a-f]{6}$/i.test(src[k])) l[k] = src[k];
  for (const k of LOOK_KEYS.numbers) if (Number.isFinite(src[k])) l[k] = src[k];
  if (typeof src.name === 'string') l.name = src.name.slice(0, 60);
  return l;
}

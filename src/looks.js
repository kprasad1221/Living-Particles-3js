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
//  v0.3 · P2 adds two things to every look, both off for the looks above so they render as before:
//    ramps    colour by role instead of by voice: a body ramp (a tile's activation → shadow, body,
//             crest) and a small accent ramp (events: hits, sparks, plume). `ramp` blends from the
//             voice colours (0) to the ramps (1), so the two can be compared on one fader.
//    light    one local light that the surfaces receive (not emission, so it never blooms on its own)
//  and two looks built on them:
//    mineral   Mineral Night        deep blue body, cyan and pearl crests, a small amber accent, dark gaps
//    daylight  Daylight Precision   readable stone faces, a restrained sky, coloured rims, local highlights
//  Their palettes are working art direction, not colours sampled from a reference.
//
//  The AV looks are read off the Unity capture (a phone photo of a monitor): use
//  them for edge/interior relationships and hierarchy, not as calibrated colours.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { sanitizeStops, sanitizePalette, bakeRows, mixBaked, stopsKey, PALETTE_SCHEMA } from './shared/palette.js';

export const LOOK_KEYS = {
  colors: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'rim', 'face', 'side', 'skyTop', 'horizon', 'lightColor'],
  numbers: [
    'rimWidth', 'restRim', 'rimBreath', 'rimResponse', 'innerSpill', 'spillFalloff',
    'fill', 'fillCore', 'sideGlow', 'sideFalloff', 'topLine', 'edgeLines',
    'hitAccent', 'hitWhiten', 'grain', 'sparkCore',
    'fog', 'horizonGlow',
    'bloom', 'bloomRadius', 'bloomThreshold', 'bloomSky', 'exposure',
    'ramp', 'rampCurve', 'rampSpread', 'accent',             // colour by role (v0.3)
    'lightAmount', 'lightReach', 'lightHeight',               // receiving light (v0.3)
  ],
  ramps: ['rampBody', 'rampAccent'],                          // ordered stops: [{ id, position, color }]
};
// Rows of the ramp texture, in order. The shaders sample row r at v = (r + 0.5) / RAMP_ROWS.length.
export const RAMP_ROWS = ['rampBody', 'rampAccent'];

// What a look gets when it does not say (every look made before v0.3): ramps off, light off, and
// ramps drawn from its own voice colours, so turning `ramp` up on an old look stays in its world.
export function rampDefaults(l) {
  return {
    ramp: 0, rampCurve: 1, rampSpread: 0.35, accent: 0.8,
    lightAmount: 0, lightReach: 16, lightHeight: 6, lightColor: '#ffe2b8',
    rampBody: [{ id: 'shadow', position: 0, color: l.side }, { id: 'deep', position: 0.3, color: l.v0 }, { id: 'body', position: 0.65, color: l.v2 }, { id: 'crest', position: 1, color: l.v7 }],
    rampAccent: [{ id: 'ember', position: 0, color: l.v5 }, { id: 'accent', position: 0.55, color: l.v3 }, { id: 'flare', position: 1, color: l.v7 }],
  };
}
const withRampDefaults = l => ({ ...rampDefaults(l), ...l });
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

export const LOOKS = Object.fromEntries(Object.entries(LEGACY).map(([k, l]) => [k, withRampDefaults(fromLegacy(l))]));

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

// Mineral Night. Compare with Nocturne under identical motion. The resting grid is dim so gaps stay
// dark; a tile climbs its ramp as it lights (deep blue → cyan → pearl); hits and particles take the
// small amber family; one warm light crosses the faces.
LOOKS.mineral = {
  name: 'Mineral Night',
  v0: '#1438c8', v1: '#1a55d8', v2: '#1e7ee6', v3: '#22a4ee', v4: '#3cc0f2', v5: '#7fd6f6', v6: '#b8e8fb', v7: '#e6f6ff',   // the body ramp by register (meters, and ramp < 1)
  rim: '#123a5c', face: '#03060c', side: '#070d18', skyTop: '#01030a', horizon: '#060d1c',
  rimWidth: 0.09, restRim: 0.38, rimBreath: 0.5, rimResponse: 1.1, innerSpill: 0.1, spillFalloff: 7,
  fill: 0.42, fillCore: 0.1, sideGlow: 0.95, sideFalloff: 3.2, topLine: 0.9, edgeLines: 0.25,
  hitAccent: 1.4, hitWhiten: 0, grain: 0.15, sparkCore: 0.12,
  fog: 0.007, horizonGlow: 0.22,
  bloom: 0.45, bloomRadius: 0.35, bloomThreshold: 0.75, bloomSky: 0, exposure: 1.0,
  ramp: 1, rampCurve: 1.15, rampSpread: 0.75, accent: 1,
  rampBody: [{ id: 'shadow', position: 0, color: '#0a1840' }, { id: 'deep', position: 0.32, color: '#1438c8' }, { id: 'body', position: 0.68, color: '#22b8f0' }, { id: 'crest', position: 1, color: '#e6f6ff' }],
  rampAccent: [{ id: 'ember', position: 0, color: '#7a2c08' }, { id: 'amber', position: 0.5, color: '#ff9a2e' }, { id: 'flare', position: 1, color: '#ffe9b0' }],
  lightAmount: 1.1, lightReach: 20, lightHeight: 3.5, lightColor: '#ffd2a0',
};
// Daylight Precision. Compare with AV2 · Precision under identical motion. Faces are stone you can
// read with every emission term off; the grid at rest is a joint, not a glow; colour lives on rims
// and in a few local highlights; the sky is quieter.
LOOKS.daylight = {
  name: 'Daylight Precision',
  v0: '#16408f', v1: '#1757b5', v2: '#1670c9', v3: '#148fc9', v4: '#10abc9', v5: '#3fc3d6', v6: '#86dceb', v7: '#c6f5fb',
  rim: '#2a2f3a', face: '#6f6a66', side: '#3d3a3c', skyTop: '#6f86ad', horizon: '#c9cfd8',
  rimWidth: 0.12, restRim: 0.2, rimBreath: 0.25, rimResponse: 1.3, innerSpill: 0.06, spillFalloff: 8,
  fill: 0.16, fillCore: 0, sideGlow: 0.8, sideFalloff: 3.6, topLine: 1.0, edgeLines: 0.2,
  hitAccent: 1.0, hitWhiten: 0, grain: 0.5, sparkCore: 0.15,
  fog: 0.006, horizonGlow: 0.2,
  bloom: 0.16, bloomRadius: 0.25, bloomThreshold: 1.15, bloomSky: 0, exposure: 0.9,
  ramp: 1, rampCurve: 1.0, rampSpread: 0.7, accent: 1,
  rampBody: [{ id: 'shadow', position: 0, color: '#16305e' }, { id: 'deep', position: 0.4, color: '#1763c9' }, { id: 'body', position: 0.78, color: '#10b5c9' }, { id: 'crest', position: 1, color: '#c6f5fb' }],
  rampAccent: [{ id: 'ember', position: 0, color: '#8a3a12' }, { id: 'amber', position: 0.5, color: '#ff7a1a' }, { id: 'flare', position: 1, color: '#ffd27a' }],
  lightAmount: 0.7, lightReach: 22, lightHeight: 7, lightColor: '#fff0d8',
};

export const LOOK_ORDER = ['av2p', 'av1', 'av2', 'av3', 'nocturne', 'mineral', 'daylight'];

// A look's ramps as a palette asset (src/shared/palette.js): the part of a look another world can use.
// The hex field reads `body` by a tile's level and `accent` by an event's strength; another world is
// free to read the same ramps by something else (a ribbon's age, a branch's height).
const slug = s => String(s || 'palette').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'palette';
export function lookToPalette(l, source = { kind: 'authored', note: 'Working art direction; not sampled from a reference.' }) {
  return {
    schema: PALETTE_SCHEMA, id: slug(l.name), version: 1, name: l.name || 'Palette', source, inputColorSpace: 'srgb',
    ramps: {
      body: { role: 'emission', domain: 'activation', curve: l.rampCurve, emissionScale: 1, stops: JSON.parse(JSON.stringify(l.rampBody)) },
      accent: { role: 'accent', domain: 'event', curve: 1, emissionScale: 1, stops: JSON.parse(JSON.stringify(l.rampAccent)) },
    },
  };
}
// Put a palette's ramps into a look. Returns { ok, message }; the look is untouched unless ok.
export function applyPalette(l, input) {
  const r = sanitizePalette(input);
  if (!r.ok) return { ok: false, message: r.message };
  const { body, accent } = r.palette.ramps;
  if (!body && !accent) return { ok: false, message: 'The palette has no "body" or "accent" ramp.' };
  if (body) { l.rampBody = body.stops; l.rampCurve = body.curve; }
  if (accent) l.rampAccent = accent.stops;
  return { ok: true, message: '', name: r.palette.name };
}

export function cloneLook(l) { return JSON.parse(JSON.stringify(l)); }

const ca = new THREE.Color(), cb = new THREE.Color();
const baked = new Map();           // stops of one look → linear ramp rows (bounded cache)
function bakeLook(l) {
  const key = RAMP_ROWS.map(k => stopsKey(l[k])).join('§');
  let data = baked.get(key);
  if (!data) { data = bakeRows(RAMP_ROWS.map(k => l[k])); baked.set(key, data); if (baked.size > 24) baked.delete(baked.keys().next().value); }
  return { key, data };
}

// Mix two looks into `out`: colours become THREE.Color (linear), numbers mix linearly, ramps mix
// in linear after baking (out.rampLinear; out.rampVersion counts changes so a texture knows when
// to upload). Colour pickers give sRGB hex; THREE.Color.set converts to linear once, here.
export function mixLooks(a, b, t, out) {
  for (const k of LOOK_KEYS.colors) {
    ca.set(a[k]); cb.set(b[k]);
    (out[k] ||= new THREE.Color()).copy(ca).lerp(cb, t);
  }
  for (const k of LOOK_KEYS.numbers) out[k] = a[k] + (b[k] - a[k]) * t;
  const A = bakeLook(a), B = bakeLook(b), sig = `${A.key}>${B.key}@${t.toFixed(4)}`;
  if (out.rampSig !== sig) { out.rampLinear = mixBaked(A.data, B.data, t, out.rampLinear); out.rampSig = sig; out.rampVersion = (out.rampVersion | 0) + 1; }
  return out;
}

// Keep only the keys a look owns (used when importing and migrating). Old-form looks are
// converted first, so a Study 01 scene keeps its colours and its response.
export function sanitizeLook(src, fallback) {
  const base = isLegacy(fallback) ? fromLegacy(fallback) : fallback;
  const l = cloneLook(base);
  if (!src) return l;
  if (isLegacy(src)) src = fromLegacy(src);
  // A look saved before v0.3 has no ramps or light of its own: it gets ramps off, light off and ramps drawn
  // from its own colours, never the fallback look's.
  if (!('ramp' in src)) src = { ...src, ...rampDefaults({ ...l, ...Object.fromEntries(LOOK_KEYS.colors.filter(k => typeof src[k] === 'string' && /^#[0-9a-f]{6}$/i.test(src[k])).map(k => [k, src[k]])) }) };
  for (const k of LOOK_KEYS.colors) if (typeof src[k] === 'string' && /^#[0-9a-f]{6}$/i.test(src[k])) l[k] = src[k];
  for (const k of LOOK_KEYS.numbers) if (Number.isFinite(src[k])) l[k] = src[k];
  for (const k of LOOK_KEYS.ramps) l[k] = sanitizeStops(src[k], l[k]);
  if (typeof src.name === 'string') l.name = src.name.slice(0, 60);
  return l;
}

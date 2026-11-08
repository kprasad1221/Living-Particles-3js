// ─────────────────────────────────────────────────────────────────────────────
//  Looks — the Output context as data.
//
//  The first three are read off the Unity capture (audio_reactivity_reference.MOV)
//  and named after the AudioVisualizer objects in that scene's hierarchy. They are
//  translations, not pixel matches: the Unity scene ran the built-in skybox and its
//  own particle shader; here the sky, rim, fill and bloom are separate knobs.
//
//    av1  Violet   magenta/purple rim floor, outline-only, Unity daylight sky
//    av2  Tropical red rim floor; blue, cyan, yellow and orange columns on the voices
//    av3  Funk     warm-white rims on dark stone; solid red columns with lit edges
//    nocturne      new — a night version that leans toward Tetris Effect's dark stages
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { LOOK_KEYS } from './params.js';

export const LOOKS = {
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

export const LOOK_ORDER = ['av1', 'av2', 'av3', 'nocturne'];

export function cloneLook(l) { return JSON.parse(JSON.stringify(l)); }

const ca = new THREE.Color(), cb = new THREE.Color();

// Mix two looks into `out`, where every colour is a THREE.Color (linear) and every number a number.
// Colours mix in linear light, which is how light adds in the shader.
export function mixLooks(a, b, t, out) {
  for (const k of LOOK_KEYS.colors) {
    ca.set(a[k]); cb.set(b[k]);
    (out[k] ||= new THREE.Color()).copy(ca).lerp(cb, t);
  }
  for (const k of LOOK_KEYS.numbers) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

// Keep only the keys a look owns (used when importing).
export function sanitizeLook(src, fallback) {
  const l = cloneLook(fallback);
  if (!src) return l;
  for (const k of LOOK_KEYS.colors) if (typeof src[k] === 'string' && /^#[0-9a-f]{6}$/i.test(src[k])) l[k] = src[k];
  for (const k of LOOK_KEYS.numbers) if (Number.isFinite(src[k])) l[k] = src[k];
  if (typeof src.name === 'string') l.name = src.name.slice(0, 60);
  return l;
}

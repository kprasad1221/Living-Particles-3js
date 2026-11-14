// ─────────────────────────────────────────────────────────────────────────────
//  PALETTE — colour ramps as a small, versioned asset.   (shared module: no three.js, no app state)
//
//  A ramp is an ordered list of stops. What the position means is up to the world that reads it:
//  here a tile's activation, in another world a ribbon's age or a branch's height. A palette
//  groups a few ramps by the job they do (role), so "the cyan body" and "the small amber
//  accent" stay separate things even when they are equally bright.
//
//    palette = {
//      schema: 1, id: 'mineral-night', version: 1, name: 'Mineral Night',
//      source: { kind: 'authored' | 'sampled', note, take?, frameTimes? },   // where the colours came from
//      inputColorSpace: 'srgb',                                              // how the stop colours are written
//      ramps: { body: ramp, accent: ramp, … }
//    }
//    ramp = { role: 'emission' | 'accent' | 'surface' | 'atmosphere', domain: 'activation' | 'event' | …,
//             curve: 1, emissionScale: 1, stops: [{ id, position: 0…1, color: '#rrggbb' }, …] }
//
//  Colour handling, stated once:
//    · Stop colours are sRGB hex, as a colour picker gives them.
//    · Between two stops the ramp interpolates the sRGB-encoded values, like a gradient tool or a
//      painted strip would, so what you see between two swatches is what a designer expects.
//    · bakeRamp() then decodes each sample to linear. Baked arrays are LINEAR; mixing two baked
//      ramps (look A ↔ look B) happens in linear.
//    · toSRGB8() re-encodes a baked array for an 8-bit sRGB texture. The GPU decodes it once when
//      sampling. Do not decode again in the shader.
//  Stops keep their ids, so a later colour script can move a stop over time without two stops
//  swapping places.
//
//  Origin: Living Particles 3JS, study-01-composed-motion (v0.3 · P2). When copying this file into
//  another sketch, keep this header and note the commit it came from and anything you changed.
// ─────────────────────────────────────────────────────────────────────────────

export const PALETTE_SCHEMA = 1;
export const RAMP_SIZE = 256;
export const MAX_STOPS = 8;
const HEX = /^#[0-9a-f]{6}$/i;

export const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = c => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export const hexToRgb = hex => { const n = parseInt(hex.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
export const rgbToHex = rgb => '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// Keep what is valid, repair what is not. Always returns 2…MAX_STOPS stops in position order.
export function sanitizeStops(input, fallback) {
  const out = [];
  if (Array.isArray(input)) {
    for (const s of input.slice(0, MAX_STOPS)) {
      if (!s || typeof s !== 'object' || typeof s.color !== 'string' || !HEX.test(s.color) || !Number.isFinite(s.position)) continue;
      out.push({ id: typeof s.id === 'string' && s.id ? s.id.slice(0, 24) : '', position: Math.min(1, Math.max(0, s.position)), color: s.color.toLowerCase() });
    }
  }
  if (out.length < 2) return fallback ? sanitizeStops(fallback) : [{ id: 'a', position: 0, color: '#000000' }, { id: 'b', position: 1, color: '#ffffff' }];
  out.sort((a, b) => a.position - b.position);
  const seen = new Set();
  out.forEach((s, i) => { let id = s.id || `s${i}`; while (seen.has(id)) id += '_'; seen.add(id); s.id = id; });
  return out;
}

export function sanitizeRamp(input, fallback = {}) {
  const r = input && typeof input === 'object' ? input : {};
  const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    role: typeof r.role === 'string' ? r.role.slice(0, 24) : fallback.role || 'emission',
    domain: typeof r.domain === 'string' ? r.domain.slice(0, 24) : fallback.domain || 'activation',
    curve: num(r.curve, fallback.curve ?? 1, 0.1, 8),
    emissionScale: num(r.emissionScale, fallback.emissionScale ?? 1, 0, 16),
    stops: sanitizeStops(r.stops, fallback.stops),
  };
}

// Returns { ok, message, palette }. A palette from a newer schema is refused rather than half-read.
export function sanitizePalette(input, fallback) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Not a palette.', palette: fallback || null };
  if (Number.isInteger(input.schema) && input.schema > PALETTE_SCHEMA)
    return { ok: false, message: `This palette uses a newer format (schema ${input.schema}); this build reads up to ${PALETTE_SCHEMA}.`, palette: fallback || null };
  if (input.inputColorSpace && input.inputColorSpace !== 'srgb')
    return { ok: false, message: `Stop colours must be sRGB hex (inputColorSpace is "${input.inputColorSpace}").`, palette: fallback || null };
  const ramps = {};
  for (const [k, r] of Object.entries(input.ramps && typeof input.ramps === 'object' ? input.ramps : {})) ramps[k.slice(0, 24)] = sanitizeRamp(r, fallback?.ramps?.[k]);
  if (!Object.keys(ramps).length) return { ok: false, message: 'The palette has no ramps.', palette: fallback || null };
  const str = (v, d, n) => (typeof v === 'string' && v ? v.slice(0, n) : d);
  return { ok: true, message: '', palette: {
    schema: PALETTE_SCHEMA, id: str(input.id, 'palette', 48), version: Number.isInteger(input.version) ? input.version : 1, name: str(input.name, 'Palette', 60),
    source: input.source && typeof input.source === 'object' ? JSON.parse(JSON.stringify(input.source)) : { kind: 'authored' },
    inputColorSpace: 'srgb', ramps,
  } };
}

// Colour at position t (0…1), LINEAR rgb. Before the first stop and after the last, the end colours hold.
export function sampleStops(stops, t, out = [0, 0, 0]) {
  const n = stops.length;
  let i = 0;
  while (i < n - 1 && t > stops[i + 1].position) i++;
  const a = stops[i], b = stops[Math.min(i + 1, n - 1)];
  const span = b.position - a.position, f = span > 1e-9 ? Math.min(1, Math.max(0, (t - a.position) / span)) : (t >= b.position ? 1 : 0);
  const ca = hexToRgb(a.color), cb = hexToRgb(b.color);
  for (let c = 0; c < 3; c++) out[c] = srgbToLinear(ca[c] + (cb[c] - ca[c]) * f);
  return out;
}

// n samples of one ramp → Float32Array(n × 3), LINEAR rgb. The first and last samples sit exactly on t = 0 and t = 1.
export function bakeStops(stops, n = RAMP_SIZE, out = new Float32Array(n * 3), offset = 0) {
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) { sampleStops(stops, n > 1 ? i / (n - 1) : 0, c); out[offset + i * 3] = c[0]; out[offset + i * 3 + 1] = c[1]; out[offset + i * 3 + 2] = c[2]; }
  return out;
}

// Several ramps, one after another (row 0, row 1, …) → Float32Array(rows × n × 3), LINEAR.
export function bakeRows(rows, n = RAMP_SIZE, out = new Float32Array(rows.length * n * 3)) {
  rows.forEach((stops, r) => bakeStops(stops, n, out, r * n * 3));
  return out;
}

export function mixBaked(a, b, t, out = new Float32Array(a.length)) {
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

// LINEAR float rgb → sRGB-encoded RGBA bytes, for an sRGB8 texture.
export function toSRGB8(linear, out = new Uint8Array((linear.length / 3) * 4)) {
  for (let i = 0, j = 0; i < linear.length; i += 3, j += 4) {
    out[j] = Math.round(Math.min(1, Math.max(0, linearToSrgb(linear[i]))) * 255);
    out[j + 1] = Math.round(Math.min(1, Math.max(0, linearToSrgb(linear[i + 1]))) * 255);
    out[j + 2] = Math.round(Math.min(1, Math.max(0, linearToSrgb(linear[i + 2]))) * 255);
    out[j + 3] = 255;
  }
  return out;
}

// For a control or a legend: the same gradient as a CSS background.
export const rampCSS = stops => `linear-gradient(90deg, ${stops.map(s => `${s.color} ${(s.position * 100).toFixed(1)}%`).join(', ')})`;

// Relative luminance of a LINEAR rgb triple (Rec. 709). Useful for checking a ramp's value structure.
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// A stable short signature of a set of stops, for "did anything change" checks.
export const stopsKey = stops => stops.map(s => `${s.id}:${s.position.toFixed(4)}:${s.color}`).join('|');

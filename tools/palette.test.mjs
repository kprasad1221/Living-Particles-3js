// Palette checks (v0.3 · P2).   node tools/palette.test.mjs → PASS/FAIL per check, captures/palette.json
// The shared module src/shared/palette.js has no three.js or app state, so these run on it directly.
// With `--write` the two built-in palettes are (re)written to palettes/*.json from the looks.
import { register } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
register('./three-resolve.mjs', import.meta.url);
const Pal = await import('../src/shared/palette.js');
const { LOOKS, LOOK_ORDER, lookToPalette, applyPalette, sanitizeLook, mixLooks, cloneLook, rampDefaults, RAMP_ROWS } = await import('../src/looks.js');
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = dirname(HERE);
const results = {}, near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const expect = (c, m) => { if (!c) throw new Error(m); };
const check = (name, fn) => { try { results[name] = { pass: true, ...(fn() || {}) }; } catch (e) { results[name] = { pass: false, error: String(e.message || e) }; } };
const FILES = { mineral: 'mineral-night.json', daylight: 'daylight-precision.json' };
if (process.argv.includes('--write')) for (const [k, f] of Object.entries(FILES)) writeFileSync(join(ROOT, 'palettes', f), JSON.stringify(lookToPalette(LOOKS[k]), null, 2) + '\n');

// 1 · Colour handling: ends are exact, the middle is interpolated on the sRGB-encoded values, the result is linear.
check('ramp_is_srgb_interpolated_and_linear_out', () => {
  const stops = [{ id: 'a', position: 0, color: '#000000' }, { id: 'b', position: 1, color: '#ffffff' }];
  const b = Pal.bakeStops(stops, 256);
  expect(b[0] === 0 && near(b[255 * 3], 1), 'ends are not exact');
  const mid = Pal.sampleStops(stops, 0.5)[0], want = Pal.srgbToLinear(0.5);
  expect(near(mid, want), `mid grey is ${mid}, expected ${want} (sRGB 0.5 decoded), not 0.5 (a linear mix)`);
  const bytes = Pal.toSRGB8(b);
  expect(bytes[0] === 0 && bytes[255 * 4] === 255 && bytes[128 * 4] === 128 && bytes[128 * 4 + 3] === 255, `8-bit sRGB strip should read 0 … 128 … 255 (got ${bytes[128 * 4]})`);
  for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) expect(near(Pal.linearToSrgb(Pal.srgbToLinear(v)), v, 1e-9), 'sRGB round trip');
  return { midGreyLinear: +mid.toFixed(5), strip_0_128_255: [bytes[0], bytes[128 * 4], bytes[255 * 4]] };
});

// 2 · A stop holds its colour before the first and after the last position; a stop sits exactly on its position.
check('stops_hold_and_hit_their_positions', () => {
  const stops = [{ id: 'a', position: 0.25, color: '#ff0000' }, { id: 'b', position: 0.5, color: '#00ff00' }, { id: 'c', position: 0.75, color: '#0000ff' }];
  const at = t => Pal.sampleStops(stops, t).map(v => +v.toFixed(4));
  expect(String(at(0)) === '1,0,0' && String(at(0.25)) === '1,0,0', 'before the first stop');
  expect(String(at(0.5)) === '0,1,0', 'on the middle stop');
  expect(String(at(1)) === '0,0,1', 'after the last stop');
  return { at0: at(0), at05: at(0.5), at1: at(1) };
});

// 3 · Bad input is repaired, never trusted: order, range, ids, count, colours.
check('sanitize_repairs_stops', () => {
  const s = Pal.sanitizeStops([{ position: 0.9, color: '#FFFFFF' }, { id: 'x', position: -2, color: '#000000' }, { id: 'x', position: 0.5, color: '#123456' },
    { position: 0.2, color: 'red' }, { position: NaN, color: '#111111' }, null]);
  expect(s.length === 3, `kept ${s.length} stops, expected 3`);
  expect(s.map(x => x.position).join() === '0,0.5,0.9', 'not sorted / clamped');
  expect(new Set(s.map(x => x.id)).size === 3, 'ids are not unique');
  expect(s[2].color === '#ffffff', 'colour not normalised');
  const fb = Pal.sanitizeStops([{ position: 0, color: '#000000' }], [{ id: 'p', position: 0, color: '#101010' }, { id: 'q', position: 1, color: '#f0f0f0' }]);
  expect(fb.length === 2 && fb[0].id === 'p', 'fewer than two valid stops should fall back');
  const many = Pal.sanitizeStops(Array.from({ length: 20 }, (_, i) => ({ position: i / 19, color: '#808080' })));
  expect(many.length === Pal.MAX_STOPS, 'stop count not capped');
  return { repaired: s };
});

// 4 · A palette file: a newer format and a non-sRGB one are refused with a message; a valid one round-trips.
check('palette_file_is_checked', () => {
  const p = lookToPalette(LOOKS.mineral);
  const ok = Pal.sanitizePalette(JSON.parse(JSON.stringify(p)));
  expect(ok.ok && JSON.stringify(ok.palette.ramps.body.stops) === JSON.stringify(p.ramps.body.stops), 'valid palette changed on the way through');
  const newer = Pal.sanitizePalette({ ...p, schema: Pal.PALETTE_SCHEMA + 1 }), lin = Pal.sanitizePalette({ ...p, inputColorSpace: 'linear' }), junk = Pal.sanitizePalette([1, 2]);
  expect(!newer.ok && /newer format/.test(newer.message), 'a newer schema was accepted');
  expect(!lin.ok && /sRGB/.test(lin.message), 'a linear-encoded palette was accepted as sRGB');
  expect(!junk.ok, 'an array was accepted');
  const look = cloneLook(LOOKS.av2p), before = JSON.stringify(look);
  expect(!applyPalette(look, { ...p, schema: 99 }).ok && JSON.stringify(look) === before, 'a refused palette changed the look');
  const r = applyPalette(look, p);
  expect(r.ok && JSON.stringify(look.rampBody) === JSON.stringify(LOOKS.mineral.rampBody) && look.rampCurve === LOOKS.mineral.rampCurve && look.v0 === LOOKS.av2p.v0, 'apply should replace the ramps and nothing else');
  return { messages: [newer.message, lin.message] };
});

// 5 · The palette files in palettes/ are the built-in looks' ramps (so another sketch loads what this one shows).
check('palette_files_match_the_looks', () => {
  const out = {};
  for (const [k, f] of Object.entries(FILES)) {
    const path = join(ROOT, 'palettes', f);
    expect(existsSync(path), `${f} is missing (run with --write)`);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(JSON.stringify(file) === JSON.stringify(lookToPalette(LOOKS[k])), `${f} differs from LOOKS.${k}`);
    out[f] = Object.fromEntries(Object.entries(file.ramps).map(([n, r]) => [n, r.stops.map(s => s.color).join(' → ')]));
  }
  return out;
});

// 6 · Value structure of the two new looks: each ramp gets lighter along its length (so "further along" always
//     reads as "more"), the body starts dark (under 5 % luminance), and the accent family is warm (red above blue) where the body is cool.
check('new_ramps_have_the_intended_value_structure', () => {
  const out = {};
  for (const k of ['mineral', 'daylight']) for (const row of RAMP_ROWS) {
    const b = Pal.bakeStops(LOOKS[k][row], 64), lum = Array.from({ length: 64 }, (_, i) => Pal.luminance(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]));
    for (let i = 1; i < 64; i++) expect(lum[i] >= lum[i - 1] - 1e-6, `${k}.${row}: luminance falls at ${i}/63`);
    const mid = [b[32 * 3], b[32 * 3 + 1], b[32 * 3 + 2]];
    if (row === 'rampBody') { expect(lum[0] < 0.05, `${k} body should start dark (${lum[0].toFixed(3)})`); expect(mid[2] > mid[0], `${k} body should be cool in the middle`); }
    else expect(mid[0] > mid[2], `${k} accent should be warm in the middle`);
    out[`${k}.${row}`] = { start: +lum[0].toFixed(4), middle: +lum[32].toFixed(4), end: +lum[63].toFixed(4) };
  }
  return out;
});

// 7 · Looks made before v0.3 are untouched in effect: ramps off, light off, and their default ramps come from
//     their own colours even when loaded into a slot that held a ramp look.
check('older_looks_keep_ramps_and_light_off', () => {
  for (const k of ['av1', 'av2', 'av3', 'nocturne', 'av2p']) expect(LOOKS[k].ramp === 0 && LOOKS[k].lightAmount === 0, `${k} should have ramps and light off`);
  const old = cloneLook(LOOKS.av3); for (const key of Object.keys(rampDefaults(old))) delete old[key];
  const got = sanitizeLook(old, LOOKS.mineral);
  expect(got.ramp === 0 && got.lightAmount === 0, 'an old look picked up the slot’s ramp or light');
  expect(got.rampBody[1].color === old.v0 && got.rampBody[1].color !== LOOKS.mineral.rampBody[1].color, 'an old look picked up the slot’s ramp colours');
  expect(LOOK_ORDER.slice(0, 5).join() === 'av2p,av1,av2,av3,nocturne', 'the original looks changed order');
  return { av3_default_body: got.rampBody.map(s => s.color).join(' → ') };
});

// 8 · Mixing A ↔ B mixes the ramps in linear, and only re-bakes when something changed.
check('look_mix_mixes_ramps', () => {
  const out = {}; mixLooks(LOOKS.nocturne, LOOKS.mineral, 0, out); const v0 = out.rampVersion, a = Float32Array.from(out.rampLinear);
  mixLooks(LOOKS.nocturne, LOOKS.mineral, 0, out); expect(out.rampVersion === v0, 're-baked with nothing changed');
  mixLooks(LOOKS.nocturne, LOOKS.mineral, 1, out); const b = Float32Array.from(out.rampLinear); expect(out.rampVersion === v0 + 1, 'did not re-bake when the mix moved');
  mixLooks(LOOKS.nocturne, LOOKS.mineral, 0.25, out);
  for (let i = 0; i < a.length; i += 97) expect(near(out.rampLinear[i], a[i] + (b[i] - a[i]) * 0.25, 1e-6), 'mix is not linear');
  expect(out.rampLinear.length === RAMP_ROWS.length * Pal.RAMP_SIZE * 3, 'unexpected ramp size');
  return { rows: RAMP_ROWS, size: Pal.RAMP_SIZE };
});

// 9 · Every other file in palettes/ (sampled from a reference by tools/sample_palette.py, or made by hand) loads as
//     written: nothing repaired, nothing renamed, and a sampled file says where each stop came from. Two things are
//     reported and not required, because they are art-direction findings and not defects: how many stops are still
//     the raw sample, and whether each ramp gets steadily lighter along its length.
check('other_palette_files_load_as_written', () => {
  const out = {}, own = new Set(Object.values(FILES));
  for (const f of readdirSync(join(ROOT, 'palettes')).filter(n => n.endsWith('.json') && !own.has(n)).sort()) {
    const file = JSON.parse(readFileSync(join(ROOT, 'palettes', f), 'utf8')), got = Pal.sanitizePalette(JSON.parse(JSON.stringify(file)));
    expect(got.ok, `${f}: ${got.message}`);
    expect(got.palette.id === file.id && got.palette.schema === file.schema && JSON.stringify(got.palette.source) === JSON.stringify(file.source), `${f}: id, schema or source changed on the way through`);
    const info = { ramps: {} }; let raw = 0, total = 0;
    for (const [name, r] of Object.entries(file.ramps)) {
      expect(JSON.stringify(got.palette.ramps[name]?.stops) === JSON.stringify(r.stops), `${f}: ramp "${name}" was repaired on load, so the file is not what a sketch would show`);
      expect(got.palette.ramps[name].role === r.role && got.palette.ramps[name].domain === r.domain, `${f}: ramp "${name}" lost its role or domain`);
      if (file.source?.kind === 'sampled') for (const s of r.stops) {
        const smp = file.source.samples?.[name]?.[s.id];
        expect(smp && Array.isArray(smp.box) && smp.box.length === 4 && Number.isFinite(smp.t) && Array.isArray(smp.rgb), `${f}: stop "${name}/${s.id}" has no record of where it was sampled`);
        total++; if (s.color === '#' + smp.rgb.map(v => v.toString(16).padStart(2, '0')).join('')) raw++;
      }
      const b = Pal.bakeStops(r.stops, 64), lum = Array.from({ length: 64 }, (_, i) => Pal.luminance(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]));
      let rises = true; for (let i = 1; i < 64; i++) if (lum[i] < lum[i - 1] - 1e-6) rises = false;
      info.ramps[name] = { stops: r.stops.map(s => s.color).join(' → '), startLuminance: +lum[0].toFixed(4), endLuminance: +lum[63].toFixed(4), getsSteadilyLighter: rises };
    }
    if (file.source?.kind === 'sampled') info.stopsStillTheRawSample = `${raw} of ${total}`;
    out[f] = info;
  }
  return out;
});

mkdirSync(join(HERE, 'captures'), { recursive: true });
writeFileSync(join(HERE, 'captures', 'palette.json'), JSON.stringify(results, null, 2));
let failed = 0;
for (const [k, v] of Object.entries(results)) { if (!v.pass) failed++; console.log(v.pass ? 'PASS' : 'FAIL', k, JSON.stringify(v)); }
console.log(`${Object.keys(results).length - failed} of ${Object.keys(results).length} palette checks pass`);
process.exit(failed ? 1 : 0);

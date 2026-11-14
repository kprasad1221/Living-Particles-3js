// ─────────────────────────────────────────────────────────────────────────────
//  Scenes: what is saved, how old saves are carried forward, and what is checked
//  before a scene is applied.
//
//  A scene is every saved parameter group, both looks, the look-mix state and the
//  camera. Diagnostic views, manual tests and A/B preview are never saved.
//
//  Schema history (each step migrates the previous one; old saves are upgraded,
//  never discarded, and re-saving writes the newest schema):
//    1  study-01/0.1.0  original Study 01
//    2  precision pass, checkpoint 1: schema field, transient groups split out
//    3  checkpoint 2: looks carry separate light terms (old looks converted term for term)
//    4  checkpoints 3–4: groups named for what the artist changes (floor, movement, music,
//       map, pointer, sparks, macros); timing shown as time-to-90 % in ms
//    5  checkpoint 5: plume group added (older scenes get the defaults, plume off)
//    6  checkpoint 6: harmony group added (experimental, off for older saves)
//    7  v0.3 · P1: Light macro added (macros.light, × emission; older saves get 1). Nothing renamed:
//       the bar's "Activity" is the same value as before (macros.sparks), now also labelled for plumes.
//    8  v0.3 · P2: looks carry colour ramps and a receiving light (older looks: ramps off, light off,
//       default ramps drawn from their own voice colours); light group added (where the light is)
//  Later checkpoints append steps here.
//
//  A scene saved by a newer build (schema above SCHEMA) is refused with a message instead of
//  being read as though it were understood.
// ─────────────────────────────────────────────────────────────────────────────
import { P, VERSION } from './params.js';
import { isLegacy, fromLegacy } from './looks.js';

export const SCHEMA = 8;

// Groups of P written into a scene. Everything else in P is transient.
export const SAVED_GROUPS = () => Object.keys(P).filter(k => !TRANSIENT.includes(k) && k !== 'looks');
export const TRANSIENT = ['diag', 'manual', 'solo', 'inspect'];

const STEPS = {
  // 1 → 2: nothing renamed yet; mark the schema and drop any transient state that slipped in.
  1: s => { for (const t of TRANSIENT) delete s[t]; s.schema = 2; return s; },
  2: s => {
    if (s.looks) for (const k of ['lookA', 'lookB']) if (isLegacy(s.looks[k])) s.looks[k] = fromLegacy(s.looks[k]);
    s.schema = 3; return s;
  },
  3: s => {
    const sp = s.spawn || {}, ini = s.init || {}, up = s.update || {}, vo = s.voices || {}, af = s.affector || {}, sk = s.sparks || {};
    const T90 = Math.log2(10) * 1000;                       // half-life (s) → time to 90 % (ms)
    const atk = vo.attack ?? 0.012, lo = vo.releaseLow ?? 0.24, hi = vo.releaseHigh ?? 0.06, pv = up.pulseVoice ?? 1;
    s.floor = { rings: sp.rings, pattern: sp.pattern, ringWidth: sp.ringWidth, order: sp.order, scatter: sp.scatter,
      active: sp.density, seed: sp.seed, variation: ini.spread, gap: ini.gap, rest: ini.base, jitter: ini.jitter };
    s.movement = { lift: up.extrude, curve: up.shape, floor: up.floor, ceil: up.ceil,
      ripple: up.travel === 0 ? 'instant' : 'outward', travel: up.travel > 0 ? up.travel : undefined, swell: up.swell };
    s.map = {
      lift: { rise: atk * T90, fall: lo * T90, fallHigh: hi * T90 },
      rim: { source: pv, rise: atk * T90, fall: lo * Math.pow(hi / lo, pv / 7) * T90 },
    };
    // The old detector (rise > onset × recent average rise) and the new one (novelty peak over
    // median + k·MAD) are not equivalent; the old default 1.8 maps to the new default 5, and a
    // lower old multiple (easier triggering) to a higher sensitivity. Approximate by design.
    if (Number.isFinite(vo.onset)) s.music = { hitSensitivity: Math.max(0, Math.min(10, 5 + (1.8 - vo.onset) * 5)) };
    s.pointer = af;
    s.sparks = { on: sk.on, from: sk.from, speed: sk.speed, life: sk.life, gravity: sk.gravity, turbulence: sk.turbulence,
      size: sk.size, bright: sk.bright, continuous: sk.shimmer,
      perHit: Number.isFinite(sk.burst) ? Math.round(10 + sk.burst * 60) : undefined };
    for (const k of ['spawn', 'init', 'update', 'voices', 'affector']) delete s[k];
    s.schema = 4; return s;
  },
  // 4 → 5: new group only; nothing renamed. Missing groups keep their defaults on apply.
  4: s => { s.schema = 5; return s; },
  5: s => { s.schema = 6; return s; },
  6: s => { s.schema = 7; return s; },
  // 7 → 8: new look fields and a new group; sanitizeLook fills the look fields from the look's own colours.
  7: s => { s.schema = 8; return s; },
};

// Can this build read the scene? Returns { ok, message }.
export function compatibility(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'That file is not a scene.' };
  if (Number.isInteger(input.schema) && input.schema > SCHEMA)
    return { ok: false, message: `This scene was saved by a newer version (schema ${input.schema}); this build reads up to ${SCHEMA}. Nothing was changed.` };
  return { ok: true, message: '' };
}

export function migrate(input) {
  if (!compatibility(input).ok) return null;
  let s = JSON.parse(JSON.stringify(input));
  if (!Number.isInteger(s.schema)) s.schema = 1;              // study-01/0.1.0 saves had no schema field
  const from = s.schema;
  while (s.schema < SCHEMA) {
    const step = STEPS[s.schema];
    if (!step) break;
    s = step(s);
  }
  s.migratedFrom = from < SCHEMA ? from : undefined;
  return s;
}

// Copy values from a (migrated) scene group into P, keeping only known keys whose type
// matches, and only finite numbers.
export function assignGroup(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const k of Object.keys(target)) {
    const v = src[k], cur = target[k];
    if (v === undefined) continue;
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) { assignGroup(cur, v); continue; }
    if (typeof v !== typeof cur) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    target[k] = v;
  }
}

// Keep relationships valid after any change (UI, import, migration).
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RULES = [
  P => { P.floor.rings = clamp(Math.round(P.floor.rings), 6, 96); P.floor.active = clamp(P.floor.active, 0, 1); },
  P => { const M = P.movement; M.floor = clamp(M.floor, 0, 0.95); M.ceil = clamp(Math.max(M.ceil, M.floor + 0.02), 0.02, 1);
         M.travel = clamp(M.travel, 1, 200); M.lift = clamp(M.lift, 0, 20); },
  P => { const m = P.music; m.noiseFloor = clamp(m.noiseFloor, -120, -10); m.reference = clamp(Math.max(m.reference, m.noiseFloor + 6), -60, 20);
         m.hitSensitivity = clamp(m.hitSensitivity, 0, 10); m.cooldownLow = clamp(m.cooldownLow, 10, 1000); m.cooldownHigh = clamp(m.cooldownHigh, 10, 1000); },
  P => { for (const d of Object.values(P.map)) for (const k of ['rise', 'hold', 'fall', 'fallHigh']) if (k in d) d[k] = clamp(d[k], 0, 20000); },
  P => { const S = P.sparks; S.life = clamp(S.life, 0.05, 10); S.size = Math.max(0.01, S.size); S.perHit = clamp(Math.round(S.perHit), 0, 400); S.cone = clamp(S.cone, 0, 90); },
  P => { for (const k of Object.keys(P.macros)) P.macros[k] = clamp(P.macros[k], 0, 3); },
  P => { const L = P.plume; L.perHit = clamp(Math.round(L.perHit), 0, 400); L.maxConcurrent = clamp(Math.round(L.maxConcurrent), 1, 12);
         L.length = clamp(L.length, 0.2, 10); L.size = clamp(L.size, 0.01, 4); L.trail = clamp(Math.round(L.trail), 0, 6); L.voice = clamp(Math.round(L.voice), 0, 7); },
  P => { const H = P.harmony; H.tolerance = clamp(H.tolerance, 1, 100); H.activate = clamp(H.activate, 0.05, 1); H.letGo = clamp(Math.min(H.letGo, H.activate - 0.01), 0, 0.99);
         H.persist = clamp(H.persist, 0, 2000); H.bridge = clamp(H.bridge, 0, 2000); H.rise = clamp(H.rise, 0, 5000); H.release = clamp(H.release, 0, 10000); H.tuning = clamp(H.tuning, 400, 480); H.amount = clamp(H.amount, 0, 4); },
  P => { const L = P.light; L.radius = clamp(L.radius, 0, 90); L.period = clamp(L.period, 1, 600); L.angle = clamp(L.angle, -360, 360); L.audio = clamp(L.audio, 0, 1);
         L.source = clamp(Math.round(L.source), 0, 8); if (!['orbit', 'still', 'pointer'].includes(L.path)) L.path = 'orbit'; },
];
export function validate() { for (const r of RULES) r(P); }

export function header() { return { version: VERSION, schema: SCHEMA, saved: new Date().toISOString() }; }

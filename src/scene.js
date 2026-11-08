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
//  Later checkpoints append steps here.
// ─────────────────────────────────────────────────────────────────────────────
import { P, VERSION } from './params.js';
import { isLegacy, fromLegacy } from './looks.js';

export const SCHEMA = 3;

// Groups of P written into a scene. Everything else in P is transient.
export const SAVED_GROUPS = () => Object.keys(P).filter(k => !TRANSIENT.includes(k) && k !== 'looks');
export const TRANSIENT = ['diag', 'manual'];

const STEPS = {
  // 1 → 2: nothing renamed yet; mark the schema and drop any transient state that slipped in.
  1: s => { for (const t of TRANSIENT) delete s[t]; s.schema = 2; return s; },
  2: s => {
    if (s.looks) for (const k of ['lookA', 'lookB']) if (isLegacy(s.looks[k])) s.looks[k] = fromLegacy(s.looks[k]);
    s.schema = 3; return s;
  },
};

export function migrate(input) {
  if (!input || typeof input !== 'object') return null;
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
  P => { P.spawn.rings = clamp(Math.round(P.spawn.rings), 6, 96); },
  P => { P.update.floor = clamp(P.update.floor, 0, 0.95); P.update.ceil = clamp(Math.max(P.update.ceil, P.update.floor + 0.02), 0.02, 1); },
  P => { P.update.travel = Math.max(0, P.update.travel); },
  P => { P.sparks.life = clamp(P.sparks.life, 0.05, 10); P.sparks.size = Math.max(0.01, P.sparks.size); },
];
export function validate() { for (const r of RULES) r(P); }

export function header() { return { version: VERSION, schema: SCHEMA, saved: new Date().toISOString() }; }

// ─────────────────────────────────────────────────────────────────────────────
//  The editor: one family at a time, each named for a question you can answer by looking.
//
//    Looks            Which world am I playing?    presets for A and B, how the mix moves, colours
//    Motion           How does it travel?          floor movement, ripple, plume gesture, pointer
//    Activity         How much happens?            the field and its active tiles, spark budgets
//    Light            How does the form read?      emission, glow, surfaces, fog, output
//    Music response   What can the music move?     one mapping at a time, then the analysis itself
//    Inspect          Why does this happen?        meters, solo, manual tests, diagnostic views, frame rate
//
//  Transport, A / Mix / B, the mix fader and scenes live in the bar and are not repeated here.
//  Looks and Light edit one look at a time; the header says which, and whether you can see it.
//  Double-click any label (or press ↺) to reset that control. A group's "reset" resets only that
//  group; tracks, saved looks and saved scenes are never touched.
// ─────────────────────────────────────────────────────────────────────────────
import { P, VOICE_NAMES, HIST } from '../params.js';
import { noteName, fifthScore } from '../analysis/harmony.js';
import { LOOKS, LOOK_ORDER } from '../looks.js';
import { Kit } from './kit.js';

const VOICES = VOICE_NAMES.map((n, i) => [n, i]);
const DEST = [['Floor lift', 'lift'], ['Rim breath', 'rim'], ['Hits (accent + flash)', 'hits'], ['Colour drift', 'colour'], ['Harmony → Shimmer (experimental)', 'shimmer']];
const DEST_NAME = Object.fromEntries(DEST.map(([l, v]) => [v, l]));
const pctOf = x => `${Math.round(x * 100)} %`;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export const FAMILIES = [
  ['looks', 'Looks', 'Which world am I playing?'],
  ['motion', 'Motion', 'How does it travel?'],
  ['activity', 'Activity', 'How much happens?'],
  ['light', 'Light', 'How does the form read?'],
  ['music', 'Music response', 'What can the music move?'],
  ['inspect', 'Inspect', 'Why does this happen?'],
];

export function buildPanel(container, app) {
  container.textContent = '';
  const D = app.defaults;
  const kit = new Kit((key, commit) => { app.validate(); if (commit) app.autosave(); });
  const root = el('div', 'k-root'); container.append(root);

  // ── Header: title, close, the family rail, and which look is being edited ──
  const head = el('div', 'k-head');
  const close = el('button', 'x', '×'); close.type = 'button'; close.id = 'paneClose'; close.setAttribute('aria-label', 'Close the editor'); close.title = 'Close the editor (E or Esc)';
  close.addEventListener('click', () => app.setMode('perform'));
  head.append(el('span', null, 'Edit'), el('span', 'k-hint', 'double-click a label to reset it'), close);
  const rail = el('div', 'k-rail'); rail.setAttribute('role', 'tablist'); rail.setAttribute('aria-label', 'Editor families');
  const question = el('p', 'k-question');
  const editing = el('div', 'k-editing');
  root.append(head, rail, question, editing);

  const fam = {}, famBtns = {};
  for (const [key, label, q] of FAMILIES) {
    const b = el('button', 'k-railbtn', label); b.type = 'button'; b.id = 'fam-' + key; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'family-' + key); b.title = q;
    b.addEventListener('click', () => app.setFamily(key));
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const keys = FAMILIES.map(f => f[0]), i = keys.indexOf(key), n = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      app.setFamily(n); famBtns[n].focus();
    });
    rail.append(b); famBtns[key] = b;
    const body = el('div', 'k-family'); body.id = 'family-' + key; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', b.id);
    root.append(body); fam[key] = body;
  }

  // Which look the Looks and Light families edit. One selector, shown in both.
  const edSeg = el('div', 'k-seg'); edSeg.setAttribute('role', 'group'); edSeg.setAttribute('aria-label', 'Look being edited');
  const edBtns = ['a', 'b'].map(s => { const b = el('button', null, `Edit ${s.toUpperCase()}`); b.type = 'button'; b.id = 'edit-' + s; b.addEventListener('click', () => { P.looks.edit = s; showEdited(); app.autosave(); }); edSeg.append(b); return [b, s]; });
  const edName = el('span', 'k-editname'), edWhy = el('p', 'k-status');
  editing.append(edSeg, edName, edWhy);
  const lookPages = { a: [], b: [] };           // per-look pages, in Looks and in Light
  const showEdited = () => {
    for (const [b, s] of edBtns) b.setAttribute('aria-pressed', String(P.looks.edit === s));
    for (const s of ['a', 'b']) for (const pg of lookPages[s]) pg.hidden = P.looks.edit !== s;
  };
  const lookPage = (parent, slot) => { const pg = el('div', 'k-page'); parent.append(pg); lookPages[slot].push(pg); return pg; };

  // ══ LOOKS ══════════════════════════════════════════════════════════════════
  const presetOptions = () => [...LOOK_ORDER.map(k => [LOOKS[k].name, k]), ...Object.keys(app.userLooks).map(k => ['★ ' + k, 'user:' + k])];
  const pick = { a: P.looks.a, b: P.looks.b };
  const lk = kit.folder(fam.looks, 'Looks A and B', { open: true, note: 'A and B are two complete looks. The bar auditions A, the mix or B and holds the mix fader.' });
  const selA = kit.select(lk, pick, 'a', { label: 'Look A', options: presetOptions, tip: 'Load a preset into look A (replaces A’s current values).', onChange: v => app.loadLook('a', v) });
  const selB = kit.select(lk, pick, 'b', { label: 'Look B', options: presetOptions, tip: 'Load a preset into look B.', onChange: v => app.loadLook('b', v) });
  kit.select(lk, P.looks, 'drive', { label: 'Mix moves by', tip: 'Hand: the fader in the bar. LFO: a 16 s cycle. A voice: that voice’s floor-lift level.',
    options: [['hand (the fader)', 'hand'], ['slow LFO · 16 s', 'lfo'], ...VOICE_NAMES.map((n, i) => ['voice · ' + n, 'v' + i])] });
  kit.status(lk, () => {
    const m = app.effectiveMorph();
    return P.looks.preview === 'mix' ? `Showing the mix: ${pctOf(1 - m)} A · ${pctOf(m)} B` : `Auditioning ${P.looks.preview.toUpperCase()} alone (not saved)`;
  });
  kit.text(lk, app.ui, 'saveName', { label: 'Save edited look as', tip: 'A name for the look you are editing (A or B, above).' });
  kit.button(lk, 'Save the edited look', () => { app.saveUserLook(); selA.rebuild(); selB.rebuild(); }, { tip: 'Stores the look you are editing in this browser; it appears in both preset lists with a ★.' });

  const lookColours = [];
  [app.lookA, app.lookB].forEach((look, ti) => {
    const slot = ti ? 'b' : 'a', pg = lookPage(fam.looks, slot), L = LOOKS.av2p;
    const col = kit.folder(pg, 'Colours', { open: true, note: 'Each voice’s colour when it lights a tile, then the surfaces and the sky.' });
    VOICE_NAMES.forEach((n, i) => kit.color(col, look, 'v' + i, { label: n, tip: `Colour of the ${n} voice`, def: L['v' + i] }));
    kit.color(col, look, 'rim', { label: 'rim at rest', tip: 'Rim colour before a voice lights the tile.', def: L.rim });
    kit.color(col, look, 'face', { label: 'face', tip: 'Top surface (not emission).', def: L.face });
    kit.color(col, look, 'side', { label: 'side', tip: 'Column sides (not emission).', def: L.side });
    kit.color(col, look, 'skyTop', { label: 'sky', def: L.skyTop });
    kit.color(col, look, 'horizon', { label: 'horizon / fog', def: L.horizon });
    lookColours.push({ pg, look, slot });
  });

  // ══ MOTION ═════════════════════════════════════════════════════════════════
  const mv = kit.folder(fam.motion, 'Floor movement', { open: true, onReset: () => app.resetGroup('movement') });
  const M = P.movement, DM = D.movement, ML = P.map.lift;
  const cLift = kit.slider(mv, M, 'lift', { label: 'Maximum lift', min: 0, max: 12, step: 0.05, unit: 'u', def: DM.lift, tip: 'Extra height at full activation (× Movement in the bar).' });
  kit.slider(mv, ML, 'rise', { label: 'Rise time', min: 0, max: 2000, step: 1, unit: 'ms', def: D.map.lift.rise, tip: 'Time to reach 90 % of a step up.' });
  kit.slider(mv, ML, 'fall', { label: 'Fall time · sub', min: 10, max: 8000, log: true, unit: 'ms', def: D.map.lift.fall, tip: 'Time to decay by 90 %, for the lowest voice.' });
  kit.slider(mv, ML, 'fallHigh', { label: 'Fall time · air', min: 10, max: 8000, log: true, unit: 'ms', def: D.map.lift.fallHigh, tip: 'For the highest voice; voices in between ease between the two.' });
  kit.segmented(mv, M, 'ripple', { label: 'Ripple', options: [['Instant', 'instant'], ['Outward', 'outward']], tip: 'Instant: every tile reads the present. Outward: the music reaches outer tiles later.' });
  const cTravel = kit.slider(mv, M, 'travel', { label: 'Ripple travel', min: 1, max: 200, log: true, unit: 'u/s', def: DM.travel, tip: 'Speed of the outward ripple.' });
  kit.readout(mv, 'Edge arrives after', () => {
    if (M.ripple !== 'outward') return 'instant';
    const t = app.field.layout.radius / M.travel, valid = (HIST - 1) / app.timeline.rowHz;
    return `${t.toFixed(2)} s${t > valid ? ` · beyond the ${valid.toFixed(2)} s of history: outer tiles hold the oldest row` : ` (history reaches back ${valid.toFixed(2)} s)`}`;
  }, { tip: 'Spatial delay by design, separate from analysis latency. History length depends on the source: 512 rows at the analysis rate.' });
  const mp = kit.sub(mv, 'Precision');
  kit.slider(mp, M, 'curve', { label: 'Response curve', min: 0.3, max: 4, step: 0.05, def: DM.curve, tip: '1 linear; above 1 holds back then snaps up.' });
  kit.slider(mp, M, 'floor', { label: 'Activation floor', min: 0, max: 0.95, step: 0.01, unit: '%', def: DM.floor, tip: 'Below this level a tile rests. Kept below the ceiling.' });
  kit.slider(mp, M, 'ceil', { label: 'Activation ceiling', min: 0.02, max: 1, step: 0.01, unit: '%', def: DM.ceil, tip: 'At or above this level a tile is fully active.' });
  kit.slider(mp, M, 'swell', { label: 'Sub swell', min: 0, max: 4, step: 0.01, unit: 'u', def: DM.swell, tip: 'The sub voice lifts the floor in broad, slow folds.' });

  const pl = kit.folder(fam.motion, 'Plume', { onReset: () => app.resetGroup('plume'), note: 'One authored gesture per hit on one voice: emerge, rise, curl, disperse, rest. Strength changes only the rise and the particle count.' });
  const Pl = P.plume, DPl = D.plume;
  kit.toggle(pl, Pl, 'on', { label: 'On' });
  const plCtrls = [];
  plCtrls.push(kit.select(pl, Pl, 'voice', { label: 'Launched by', options: VOICES, def: DPl.voice }));
  plCtrls.push(kit.slider(pl, Pl, 'area', { label: 'Launch area', min: 0, max: 90, step: 1, unit: 'u', def: DPl.area, tip: 'Radius around the centre a plume may start in (0 = anywhere). While the pointer touches the floor, plumes start under it.' }));
  plCtrls.push(kit.slider(pl, Pl, 'length', { label: 'Gesture length', min: 0.4, max: 5, step: 0.05, unit: 's', def: DPl.length }));
  plCtrls.push(kit.slider(pl, Pl, 'height', { label: 'Rise', min: 0, max: 30, step: 0.1, unit: 'u', def: DPl.height }));
  plCtrls.push(kit.slider(pl, Pl, 'curl', { label: 'Curl', min: 0, max: 4, step: 0.05, unit: 'turns', def: DPl.curl }));
  plCtrls.push(kit.slider(pl, Pl, 'spread', { label: 'Spread', min: 0, max: 12, step: 0.1, unit: 'u', def: DPl.spread }));
  plCtrls.push(kit.slider(pl, Pl, 'drift', { label: 'Drift', min: 0, max: 10, step: 0.1, unit: 'u', def: DPl.drift }));
  const plp = kit.sub(pl, 'Budget and trail');
  plCtrls.push(kit.slider(plp, Pl, 'perHit', { label: 'Particles per plume', min: 10, max: 400, step: 1, def: DPl.perHit, tip: '× Activity in the bar.' }));
  plCtrls.push(kit.slider(plp, Pl, 'maxConcurrent', { label: 'At most at once', min: 1, max: 12, step: 1, def: DPl.maxConcurrent, tip: 'A hit beyond this is dropped (counted below), so fast hits never pile up.' }));
  plCtrls.push(kit.slider(plp, Pl, 'size', { label: 'Particle size', min: 0.05, max: 2, step: 0.01, unit: 'u', def: DPl.size }));
  plCtrls.push(kit.slider(plp, Pl, 'trail', { label: 'Trail ghosts', min: 0, max: 6, step: 1, def: DPl.trail }));
  plCtrls.push(kit.slider(plp, Pl, 'trailGap', { label: 'Trail spacing', min: 5, max: 200, step: 1, unit: 'ms', def: DPl.trailGap }));
  kit.readout(pl, 'Plumes · dropped', () => `${app.sparks.stats.plumes} · ${app.sparks.stats.plumesDropped}`, { tip: 'Dropped: hits that arrived while the maximum number of plumes was alive.' });

  const pc = kit.folder(fam.motion, 'Pointer', { onReset: () => app.resetGroup('pointer'), note: 'Move the pointer over the floor: tiles near it lift, light and tint.' });
  const Pt = P.pointer, DP = D.pointer;
  kit.toggle(pc, Pt, 'on', { label: 'On' });
  const ptr = [];
  ptr.push(kit.slider(pc, Pt, 'radius', { label: 'Radius', min: 1, max: 40, step: 0.1, unit: 'u', def: DP.radius }));
  ptr.push(kit.slider(pc, Pt, 'lift', { label: 'Lift', min: -3, max: 8, step: 0.05, unit: 'u', def: DP.lift, tip: 'Negative presses tiles down; they never go through the floor.' }));
  const pp = kit.sub(pc, 'Precision');
  ptr.push(kit.select(pp, Pt, 'mode', { label: 'Driven by', options: [['pointer', 'pointer'], ['orbit path', 'orbit']] }));
  ptr.push(kit.slider(pp, Pt, 'glow', { label: 'Glow', min: 0, max: 1, step: 0.01, def: DP.glow }));
  ptr.push(kit.slider(pp, Pt, 'tint', { label: 'Tint', min: 0, max: 2, step: 0.01, def: DP.tint }));
  ptr.push(kit.color(pp, Pt, 'color', { label: 'Tint colour', def: DP.color }));
  const cOrbit = kit.slider(pp, Pt, 'speed', { label: 'Orbit speed', min: 0, max: 2, step: 0.01, def: DP.speed });

  // ══ ACTIVITY ═══════════════════════════════════════════════════════════════
  const floor = kit.folder(fam.activity, 'Field', { open: true, onReset: () => app.resetGroup('floor') });
  const F = P.floor, DF = D.floor;
  const rebuildOnCommit = (v, commit) => { if (commit) app.rebuild(); };
  kit.slider(floor, F, 'active', { label: 'Active tiles', min: 0, max: 1, step: 0.01, unit: '%', def: DF.active, tip: 'Share of tiles eligible to respond; the rest stay pure grid.', onChange: rebuildOnCommit });
  kit.slider(floor, F, 'variation', { label: 'Activation variation', min: 0, max: 1, step: 0.01, def: DF.variation, tip: 'Low: a voice’s tiles respond together. High: activation spreads through them as the voice gets louder.' });
  kit.slider(floor, F, 'rings', { label: 'Field radius', min: 6, max: 96, step: 1, unit: 'rings', def: DF.rings, tip: 'Hex rings from the centre. Rebuilds the tiles when you let go.', onChange: rebuildOnCommit });
  kit.readout(floor, 'Tiles', () => app.stats.tiles.toLocaleString());
  kit.slider(floor, F, 'gap', { label: 'Tile spacing', min: 0, max: 0.6, step: 0.005, unit: '%', def: DF.gap, tip: 'Empty margin around each tile, as a share of the cell.' });
  kit.slider(floor, F, 'rest', { label: 'Resting height', min: 0.02, max: 2, step: 0.01, unit: 'u', def: DF.rest });
  const fp = kit.sub(floor, 'Voice layout');
  kit.select(fp, F, 'pattern', { label: 'Voice layout', def: DF.pattern, options: [['rings', 'rings'], ['sectors', 'sectors'], ['spiral', 'spiral'], ['scatter', 'scatter']], onChange: () => app.rebuild() });
  kit.slider(fp, F, 'ringWidth', { label: 'Band width', min: 0.5, max: 12, step: 0.1, unit: 'tiles', def: DF.ringWidth, onChange: rebuildOnCommit });
  kit.select(fp, F, 'order', { label: 'Centre', def: DF.order, options: [['low voices in', 'low-in'], ['high voices in', 'high-in']], onChange: () => app.rebuild() });
  kit.slider(fp, F, 'scatter', { label: 'Scatter', min: 0, max: 1, step: 0.01, unit: '%', def: DF.scatter, tip: 'Share of tiles given a random voice.', onChange: rebuildOnCommit });
  kit.slider(fp, F, 'seed', { label: 'Seed', min: 1, max: 999, step: 1, def: DF.seed, tip: 'Same seed, same layout and sparks.', onChange: rebuildOnCommit });
  kit.slider(fp, F, 'jitter', { label: 'Height jitter', min: 0, max: 2, step: 0.01, unit: 'u', def: DF.jitter });

  const sk = kit.folder(fam.activity, 'Sparks', { open: true, onReset: () => app.resetGroup('sparks') });
  const S = P.sparks, DS = D.sparks;
  const sparkCtrls = [];
  sparkCtrls.push(kit.toggle(sk, S, 'on', { label: 'On' }));
  sparkCtrls.push(kit.slider(sk, S, 'perHit', { label: 'Particles per hit', min: 0, max: 400, step: 1, def: DS.perHit, tip: 'A finite budget per hit event (scaled by its strength, × Activity in the bar), spread over the ripple.' }));
  sparkCtrls.push(kit.slider(sk, S, 'continuous', { label: 'Continuous', min: 0, max: 400, step: 1, unit: '/s', def: DS.continuous, tip: 'Particles per second per voice at full level.' }));
  sparkCtrls.push(kit.slider(sk, S, 'speed', { label: 'Launch speed', min: 0, max: 20, step: 0.1, unit: 'u/s', def: DS.speed }));
  sparkCtrls.push(kit.slider(sk, S, 'life', { label: 'Lifetime', min: 0.05, max: 6, step: 0.01, unit: 's', def: DS.life }));
  const sp = kit.sub(sk, 'Precision');
  sparkCtrls.push(kit.select(sp, S, 'from', { label: 'From voices', def: DS.from, options: [['presence · brilliance · air', 'highs'], ['mid and up', 'mids+highs'], ['all voices', 'all']] }));
  sparkCtrls.push(kit.slider(sp, S, 'cone', { label: 'Cone spread', min: 0, max: 90, step: 1, unit: '°', def: DS.cone, tip: 'Half-angle around straight up.' }));
  sparkCtrls.push(kit.slider(sp, S, 'gravity', { label: 'Gravity', min: -20, max: 10, step: 0.1, unit: 'u/s²', def: DS.gravity }));
  sparkCtrls.push(kit.slider(sp, S, 'turbulence', { label: 'Turbulence', min: 0, max: 6, step: 0.05, def: DS.turbulence }));
  sparkCtrls.push(kit.slider(sp, S, 'turbScale', { label: 'Turbulence scale', min: 0.1, max: 6, step: 0.05, def: DS.turbScale, tip: 'Spatial frequency of the turbulence: higher is finer.' }));
  sparkCtrls.push(kit.slider(sp, S, 'size', { label: 'Size', min: 0.02, max: 2, step: 0.01, unit: 'u', def: DS.size }));
  sparkCtrls.push(kit.slider(sp, S, 'bright', { label: 'Brightness', min: 0, max: 5, step: 0.01, def: DS.bright }));
  kit.readout(sk, 'Alive · dropped', () => `${app.stats.sparks.toLocaleString()} · ${app.stats.dropped.toLocaleString()} (capacity 8,192)`, { tip: 'Dropped: still-living particles overwritten because the buffer was full (oldest first).' });

  // ══ LIGHT ══════════════════════════════════════════════════════════════════
  const lightPages = [];
  [app.lookA, app.lookB].forEach((look, ti) => {
    const slot = ti ? 'b' : 'a', pg = lookPage(fam.light, slot), L = LOOKS.av2p;
    const Sl = (f, key, label, min, max, o = {}) => kit.slider(f, look, key, { label, min, max, step: o.step ?? 0.01, unit: o.unit ?? '', tip: o.tip, def: L[key], log: o.log });
    const em = kit.folder(pg, 'Emission', { open: true, note: 'The light the tiles give off (× Light in the bar).' });
    Sl(em, 'restRim', 'Rim brightness', 0, 4, { tip: 'Steady emission of every rim, at rest.' });
    Sl(em, 'rimResponse', 'Rim response', 0, 4, { tip: 'Extra rim emission as a tile’s voice lights it (in the voice colour).' });
    Sl(em, 'fill', 'Interior brightness', 0, 4, { tip: 'Emission across the top face of a lit tile. Keep low for dark interiors.' });
    Sl(em, 'hitAccent', 'Hit accent', 0, 5, { tip: 'Brief coloured boost on a hit (not white).' });
    const pr = kit.sub(em, 'Precision');
    Sl(pr, 'rimWidth', 'Rim width', 0.02, 0.5, { step: 0.005, unit: 'tile', tip: 'Rim band width in tile radii (world space). Distant rims fade by pixel coverage instead of widening.' });
    Sl(pr, 'rimBreath', 'Rim breath', 0, 4, { tip: 'Whole-floor rim pulse from the Rim breath mapping (Music response).' });
    Sl(pr, 'innerSpill', 'Inner spill', 0, 1, { tip: 'Light leaking inward from the rim, × rim brightness.' });
    Sl(pr, 'spillFalloff', 'Spill falloff', 1, 16, { step: 0.1, tip: 'Higher keeps spill (and edge fill) closer to the rim.' });
    Sl(pr, 'fillCore', 'Interior: edge → solid', 0, 1, { tip: '0 fills from the rim inward; 1 fills the whole face.' });
    Sl(pr, 'sideGlow', 'Side glow', 0, 4, { tip: 'Voice colour glowing down the column sides.' });
    Sl(pr, 'sideFalloff', 'Side falloff', 0.5, 12, { step: 0.1, tip: 'At full activation: higher keeps side glow near the top edge.' });
    Sl(pr, 'topLine', 'Side top line', 0, 3, { tip: 'Bright line along each column’s top edge.' });
    Sl(pr, 'edgeLines', 'Corner lines', 0, 2, { tip: 'Vertical lines at the prism corners.' });
    Sl(pr, 'hitWhiten', 'Hit whitening', 0, 3, { tip: 'Separate move toward white on hits. 0 keeps hits coloured.' });
    Sl(pr, 'sparkCore', 'Spark white core', 0, 2, { tip: 'White centre of each spark, separate from its coloured body.' });
    const gl = kit.folder(pg, 'Glow', { open: true, note: 'Bloom: a halo added after rendering. It does not light neighbouring tiles.' });
    Sl(gl, 'bloom', 'Glow amount', 0, 3, { tip: 'Bloom strength. Does not change the source brightness.' });
    Sl(gl, 'bloomRadius', 'Glow spread', 0, 1, { tip: 'UnrealBloomPass radius: how the blurred levels are weighted. Not a world distance.' });
    Sl(gl, 'bloomThreshold', 'Glow cutoff', 0, 3, { tip: 'Linear luminance a pixel needs before it glows. Saturated blue reads darker than yellow at equal RGB.' });
    Sl(gl, 'bloomSky', 'Glow source: emission → scene', 0, 1, { tip: '0: only emitted light can glow (sky and fog never do). 1: the whole scene above the cutoff glows (Study 01).' });
    const at = kit.folder(pg, 'Atmosphere and exposure');
    Sl(at, 'fog', 'Fog', 0, 0.04, { step: 0.0005, tip: 'Haze toward the horizon, starting 24 units from the viewer.' });
    Sl(at, 'horizonGlow', 'Horizon seam', 0, 2, { tip: 'Bright band where floor meets sky.' });
    Sl(at, 'grain', 'Stone grain', 0, 1, { tip: 'Noise in the face colour.' });
    Sl(at, 'exposure', 'Exposure', 0.2, 2.5, { tip: 'Before tone mapping.' });
    lightPages.push({ pg, look, slot, em, gl, at });
  });
  const out = kit.folder(fam.light, 'Output', { note: 'Shared by both looks.' });
  kit.slider(out, P.macros, 'glow', { label: 'Glow ×', min: 0, max: 3, step: 0.01, unit: '×', def: 1, tip: 'Scales glow amount (bloom strength) of whichever look is showing. Nothing else.' });
  kit.select(out, P.render, 'toneMapping', { label: 'Tone mapping', options: [['Neutral', 'neutral'], ['ACES', 'aces'], ['AgX', 'agx'], ['none', 'none']], tip: 'Applied once, at output.' });

  // ══ MUSIC RESPONSE ═════════════════════════════════════════════════════════
  const mu = kit.folder(fam.music, 'Mappings', { open: true, note: 'One mapping at a time: a musical source → a visual destination. The meters under the floor follow the mapping you choose: measured, processed, output. Frequency bands are ranges, not instruments.' });
  kit.select(mu, P.inspect, 'dest', { label: 'Mapping', options: DEST, onChange: () => showMapping() });
  const mapBodies = {};
  const mapRow = (dest, title, source) => {
    const b = el('div', 'k-map'); mu.append(b); mapBodies[dest] = b;
    b.append(el('p', 'k-maptitle', title));
    const m = P.map[dest], dm = D.map[dest];
    if (source) kit.select(b, m, 'source', { label: 'Source', def: dm.source, options: [...VOICES, ['global (whole spectrum)', 8]] });
    if ('sensitivity' in m) kit.slider(b, m, 'sensitivity', { label: 'Sensitivity', min: 0.1, max: 8, log: true, unit: '×', def: dm.sensitivity, tip: 'Multiplies the normalised level before the curve. Higher reaches full output sooner.' });
    if ('curve' in m) kit.slider(b, m, 'curve', { label: 'Response curve', min: 0.3, max: 4, step: 0.05, def: dm.curve });
    if ('rise' in m) kit.slider(b, m, 'rise', { label: 'Rise time', min: 0, max: 4000, step: 1, unit: 'ms', def: dm.rise, tip: 'Time to 90 % of a step.' });
    if ('hold' in m) kit.slider(b, m, 'hold', { label: 'Hold', min: 0, max: 1000, step: 1, unit: 'ms', def: dm.hold });
    if ('fall' in m) kit.slider(b, m, 'fall', { label: dest === 'lift' ? 'Fall time · sub' : 'Fall time', min: 10, max: 12000, log: true, unit: 'ms', def: dm.fall, tip: 'Time to decay by 90 %.' });
    if ('fallHigh' in m) kit.slider(b, m, 'fallHigh', { label: 'Fall time · air', min: 10, max: 12000, log: true, unit: 'ms', def: dm.fallHigh });
    kit.slider(b, m, 'amount', { label: 'Output amount', min: 0, max: 2, step: 0.01, unit: '×', def: dm.amount });
    if (dest === 'hits') kit.slider(b, P.music, 'hitSensitivity', { label: 'Hit sensitivity', min: 0, max: 10, step: 0.1, def: D.music.hitSensitivity, onChange: () => app.redetect(),
      tip: 'How easily the detector fires (0–10). The same control as in Analysis below.' });
  };
  mapRow('lift', 'Each tile’s own voice → Floor lift', false);
  mapRow('rim', 'Source → Rim breath (whole floor)', true);
  mapRow('hits', 'Hit events → Accent + flash', false);
  mapRow('colour', 'Source → Colour drift (slow)', true);
  // Harmony → Shimmer (experimental): its own body, because its source is evidence, not a level.
  const hb = el('div', 'k-map'); mu.append(hb); mapBodies.shimmer = hb;
  hb.append(el('p', 'k-maptitle', 'Harmony → Shimmer · experimental'),
    el('p', 'k-note', 'A fifth between two detected notes, held long enough, makes the rims twinkle. The score is a heuristic, not a probability; it is not chord recognition. Tracks and the test pattern only.'));
  const Hm = P.harmony, DHm = D.harmony, reH = () => app.timeline.refreshHarmony();
  const hCtrls = [];
  kit.toggle(hb, Hm, 'on', { label: 'On' });
  hCtrls.push(kit.slider(hb, Hm, 'amount', { label: 'Shimmer amount', min: 0, max: 4, step: 0.01, unit: '×', def: DHm.amount }));
  hCtrls.push(kit.slider(hb, Hm, 'tolerance', { label: 'Fifth tolerance', min: 1, max: 100, step: 1, unit: '¢', def: DHm.tolerance, onChange: reH, tip: 'Cents either side of a fifth (701 ± 1: just 3:2 and equal-tempered both fit).' }));
  hCtrls.push(kit.slider(hb, Hm, 'activate', { label: 'Confident above', min: 0.05, max: 1, step: 0.01, def: DHm.activate, onChange: reH }));
  hCtrls.push(kit.slider(hb, Hm, 'letGo', { label: 'Let go below', min: 0, max: 0.99, step: 0.01, def: DHm.letGo, onChange: () => { app.validate(); reH(); }, tip: 'Kept below “confident above” (hysteresis).' }));
  hCtrls.push(kit.slider(hb, Hm, 'persist', { label: 'Must hold', min: 0, max: 2000, step: 1, unit: 'ms', def: DHm.persist, onChange: reH, tip: 'How long the score must stay confident before the shimmer starts. Adds this much delay.' }));
  hCtrls.push(kit.slider(hb, Hm, 'bridge', { label: 'Bridge gaps', min: 0, max: 2000, step: 1, unit: 'ms', def: DHm.bridge, onChange: reH, tip: 'A drop below “let go” shorter than this is ignored, so a drum hit that masks the notes does not cut the shimmer.' }));
  hCtrls.push(kit.slider(hb, Hm, 'rise', { label: 'Rise time', min: 0, max: 5000, step: 1, unit: 'ms', def: DHm.rise, onChange: reH, tip: 'Time to 90 %.' }));
  hCtrls.push(kit.slider(hb, Hm, 'release', { label: 'Release time', min: 0, max: 10000, step: 1, unit: 'ms', def: DHm.release, onChange: reH, tip: 'Time to decay by 90 %.' }));
  hCtrls.push(kit.slider(hb, Hm, 'tuning', { label: 'Tuning (A4)', min: 400, max: 480, step: 0.1, unit: 'Hz', def: DHm.tuning, tip: 'For note names and chroma only.' }));
  const harmNow = () => {
    const tl = app.timeline, H = tl.harm, f = tl.f && tl.f.harmony, i = tl.harmIdx;
    if (!H || !f || i < 0) return null;
    const Mx = f.maxNotes, n = f.nNotes[i], nf = Array.from(f.notesF.subarray(i * Mx, i * Mx + Mx)), ns = Array.from(f.notesS.subarray(i * Mx, i * Mx + Mx));
    return { n, nf, ns, raw: H.raw[i], conf: H.conf[i], state: H.state[i], best: fifthScore(nf, ns, Hm.tolerance) };
  };
  kit.readout(hb, 'Notes', () => { const x = harmNow(); if (!x) return 'unavailable on this source'; return x.n ? x.nf.slice(0, x.n).map(f => noteName(f, Hm.tuning)).join(' · ') : 'none'; });
  kit.readout(hb, 'Fifth', () => { const x = harmNow(); if (!x) return '—'; return x.best.score > 0 ? `${noteName(x.best.a, Hm.tuning)} → ${noteName(x.best.b, Hm.tuning)} · ${x.best.cents.toFixed(0)} ¢` : 'none in tolerance'; });
  kit.readout(hb, 'Score · confidence', () => { const x = harmNow(); if (!x) return '—'; return `${x.raw.toFixed(2)} · ${x.conf.toFixed(2)} · ${['no evidence', 'uncertain', 'confident'][x.state]}`; },
    { tip: 'Score: this frame’s best fifth. Confidence: after “must hold”, hysteresis, rise and release — what drives the shimmer.' });
  const showMapping = () => { for (const [d, b] of Object.entries(mapBodies)) b.hidden = d !== P.inspect.dest; };
  showMapping();

  const an = kit.folder(fam.music, 'Analysis', { onReset: () => app.resetGroup('music'), note: 'How sound becomes levels and hits, before any mapping.' });
  const Mu = P.music, DMu = D.music;
  kit.readout(an, 'Path', () => app.timeline.mode === 'precise'
    ? `precise · ${app.timeline.f.meta.bandWin}/${app.timeline.f.meta.bandHop} and ${app.timeline.f.meta.fastWin}/${app.timeline.f.meta.fastHop} @ ${(app.timeline.f.meta.sampleRate / 1000).toFixed(1)} kHz`
    : 'Live · basic analysis (analyser snapshot per 60 Hz update)');
  kit.readout(an, 'History', () => { const hz = app.timeline.rowHz; return `${HIST} rows at ${hz.toFixed(2)} rows/s · reaches back ${((HIST - 1) / hz).toFixed(2)} s`; },
    { tip: 'What the floor can remember. A track is stored one row per analysis hop, so the length depends on its sample rate; live input stores 60 rows a second.' });
  kit.readout(an, 'Output latency', () => app.sources.ctx ? `${(app.sources.outputLatency * 1000).toFixed(0)} ms (compensated) · sync offset ${Mu.syncOffset} ms` : '—',
    { tip: 'Device output latency is removed from musical time; the sync offset is added on top.' });
  kit.readout(an, 'Hits detected', () => app.timeline.mode === 'precise' && app.timeline.ev ? `${app.timeline.ev.time.length} in this source · ${app.timeline.stats.events} played` : `${app.timeline.stats.events} played`);
  kit.segmented(an, Mu, 'normalize', { label: 'Normalisation', options: [['Preserve dynamics', 'preserve'], ['Adaptive', 'adaptive']],
    tip: 'Preserve: a fixed reference; quiet passages stay quiet. Adaptive: each voice’s reference follows its recent peaks, ±12 dB, slowly.' });
  kit.slider(an, Mu, 'gain', { label: 'Input gain', min: -24, max: 24, step: 0.5, unit: 'dB', def: DMu.gain });
  kit.slider(an, Mu, 'noiseFloor', { label: 'Noise floor', min: -110, max: -20, step: 0.5, unit: 'dB', def: DMu.noiseFloor, tip: 'The gate closes below this (dB re a full-scale sine).' });
  kit.slider(an, Mu, 'gateHyst', { label: 'Gate opens above floor by', min: 0, max: 24, step: 0.5, unit: 'dB', def: DMu.gateHyst });
  kit.slider(an, Mu, 'gateOpen', { label: 'Gate open time', min: 1, max: 1000, log: true, unit: 'ms', def: DMu.gateOpen });
  kit.slider(an, Mu, 'gateClose', { label: 'Gate close time', min: 1, max: 3000, log: true, unit: 'ms', def: DMu.gateClose });
  kit.slider(an, Mu, 'reference', { label: 'Reference (full scale)', min: -60, max: 6, step: 0.5, unit: 'dB', def: DMu.reference, tip: 'The level that reads as 100 %. Kept 6 dB above the floor.' });
  kit.slider(an, Mu, 'tilt', { label: 'Tilt above 500 Hz', min: -6, max: 9, step: 0.1, unit: 'dB/oct', def: DMu.tilt, tip: 'Music usually falls with frequency; this lifts upper voices without making them equal to the bass.' });
  kit.slider(an, Mu, 'curve', { label: 'Transfer curve', min: 0.3, max: 3, step: 0.05, def: DMu.curve, tip: 'dB-normalised level → output.' });
  const cAdapt = kit.slider(an, Mu, 'adapt', { label: 'Adaptation amount', min: 0, max: 1, step: 0.01, unit: '%', def: DMu.adapt });
  const redetect = () => app.redetect();
  kit.slider(an, Mu, 'hitSensitivity', { label: 'Hit sensitivity', min: 0, max: 10, step: 0.1, def: DMu.hitSensitivity, onChange: redetect,
    tip: 'Higher triggers more easily: threshold = median + k·MAD of the last 0.5 s of novelty, k = 1 + (10 − sensitivity)·0.6.' });
  kit.slider(an, Mu, 'cooldownLow', { label: 'Re-arm · sub … mid', min: 10, max: 500, log: true, unit: 'ms', def: DMu.cooldownLow, onChange: redetect });
  kit.slider(an, Mu, 'cooldownHigh', { label: 'Re-arm · upper mid … air', min: 10, max: 500, log: true, unit: 'ms', def: DMu.cooldownHigh, onChange: redetect });
  kit.slider(an, Mu, 'syncOffset', { label: 'Visual sync offset', min: -200, max: 300, step: 1, unit: 'ms', def: DMu.syncOffset, tip: 'Delays the visuals relative to the heard audio (positive = later). For your output device.' });

  // ══ INSPECT ════════════════════════════════════════════════════════════════
  const ins = kit.folder(fam.inspect, 'Meters and solo', { open: true, note: 'The meters under the floor show one mapping as measured → processed → output. None of this is saved in a scene.' });
  kit.readout(ins, 'Meters follow', () => matchMedia('(max-width: 640px)').matches ? 'hidden on a screen this narrow (they need about 420 px)'
    : `${DEST_NAME[P.inspect.dest].replace(' (experimental)', '')} (choose in Music response)`);
  kit.select(ins, P.inspect, 'voice', { label: 'Meter voice', options: VOICES, tip: 'Which voice the meters follow (Floor lift and Hits are per voice).' });
  kit.select(ins, P.solo, 'dest', { label: 'Solo response', def: 'none', tip: 'Shows only this destination’s visual contribution; the music keeps playing.',
    options: [['none', 'none'], ['Floor lift', 'lift'], ['Rim breath', 'rim'], ['Hits', 'hits'], ['Colour drift', 'colour'], ['Shimmer (harmony)', 'shimmer'], ['Sparks', 'sparks']] });
  kit.select(ins, P.diag, 'view', { label: 'Render view', tip: 'Take the picture apart.', def: 'normal',
    options: [['composite', 'normal'], ['no glow', 'nobloom'], ['glow only', 'bloom'], ['emission only', 'emission'], ['surfaces only', 'surface']] });
  const man = kit.folder(fam.inspect, 'Manual test', { note: 'Injected after the detector, to check a visual response without relying on the audio.' });
  kit.toggle(man, P.manual, 'on', { label: 'Hold a level', tip: 'Replaces one voice’s level after interpretation.' });
  kit.select(man, P.manual, 'voice', { label: 'Voice', options: VOICES });
  kit.slider(man, P.manual, 'level', { label: 'Level', min: 0, max: 1, step: 0.01, unit: '%' });
  kit.button(man, 'Fire one hit on this voice', () => app.fireHit(), { tip: 'One manual hit: one flash, one spark budget.' });
  kit.button(man, 'Hold full harmony confidence (toggle)', () => { P.manual.shimmer = !P.manual.shimmer; }, { tip: 'Forces shimmer confidence to 1 after the detector, to check the shimmer itself.' });
  const vw = kit.folder(fam.inspect, 'View and performance');
  kit.toggle(vw, P.camera, 'drift', { label: 'Camera drift' });
  kit.slider(vw, P.camera, 'driftSpeed', { label: 'Drift speed', min: -3, max: 3, step: 0.01, def: D.camera.driftSpeed });
  kit.slider(vw, P.camera, 'fov', { label: 'Lens (field of view)', min: 20, max: 100, step: 1, unit: '°', def: D.camera.fov });
  kit.slider(vw, P.render, 'scale', { label: 'Render scale', min: 0.4, max: 1.5, step: 0.05, unit: '×', def: 1, tip: 'Pixel ratio × this. Lower for speed; audio timing is unaffected.', onChange: () => app.resize() });
  kit.readout(vw, 'Frame rate', () => `${app.stats.fps.toFixed(0)} fps`);
  kit.readout(vw, 'Draw calls · triangles', () => `${app.stats.calls} · ${(app.stats.tris / 1000).toFixed(0)} k`);

  // ── Why a control has no effect right now ──────────────────────────────────
  const tickInactive = () => {
    const solo = P.solo.dest, soloOther = d => (solo !== 'none' && solo !== d ? `Solo response is on (${solo})` : '');
    cLift.setInactive(soloOther('lift'));
    cTravel.setInactive(M.ripple !== 'outward' ? 'Ripple is set to Instant' : '');
    for (const c of sparkCtrls.slice(1)) c.setInactive(!S.on ? 'Sparks are off' : soloOther('sparks'));
    cAdapt.setInactive(Mu.normalize !== 'adaptive' ? 'Preserve dynamics mode' : '');
    for (const c of ptr) c.setInactive(!Pt.on ? 'Pointer is off' : solo !== 'none' ? 'Solo response hides the pointer' : '');
    cOrbit.setInactive(Pt.mode !== 'orbit' ? 'Driven by the pointer' : '');
    for (const c of plCtrls) c.setInactive(!Pl.on ? 'Plume is off' : soloOther('sparks'));
    const noHarm = app.timeline.mode !== 'precise' ? 'Live · basic analysis has no harmonic path' : '';
    for (const c of hCtrls) c.setInactive(!Hm.on ? 'Shimmer is off' : noHarm || soloOther('shimmer'));
  };
  const tickEditing = () => {
    const slot = P.looks.edit, look = slot === 'b' ? app.lookB : app.lookA, m = app.effectiveMorph(), share = slot === 'a' ? 1 - m : m;
    edName.textContent = `Look ${slot.toUpperCase()} · ${look.name || 'unnamed'}`;
    const why = share > 0.001 ? '' : P.looks.preview !== 'mix'
      ? `Not visible now: the bar is auditioning ${P.looks.preview.toUpperCase()}. Edits still apply.`
      : `Not visible now: the mix is at ${pctOf(m)} B. Audition ${slot.toUpperCase()} in the bar to see edits.`;
    edWhy.textContent = why; edWhy.hidden = !why;
  };

  const setFamily = key => {
    for (const [k] of FAMILIES) { fam[k].hidden = k !== key; famBtns[k].setAttribute('aria-selected', String(k === key)); famBtns[k].tabIndex = k === key ? 0 : -1; }
    question.textContent = FAMILIES.find(f => f[0] === key)[2];
    editing.hidden = key !== 'looks' && key !== 'light';
  };
  setFamily(app.ui.family); showEdited(); tickEditing();

  return {
    kit, setFamily,
    refresh() { pick.a = P.looks.a; pick.b = P.looks.b; kit.refresh(); showMapping(); showEdited(); tickEditing(); },
    refreshMorph() {},
    tick() { kit.tick(); tickInactive(); tickEditing(); },
  };
}

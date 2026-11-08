// ─────────────────────────────────────────────────────────────────────────────
//  Controls (Tweakpane). Folders follow VFX Graph's contexts so the vocabulary
//  carries over: Spawn → Initialize → Update → Output, plus the two systems that
//  sit beside the floor (Affector, Sparks) and the analysis (Signal).
//
//  Output is two looks, A and B, each fully editable in its own tab. What you see
//  is mix(A, B, morph); morph can be a hand fader, a slow LFO, or a voice.
// ─────────────────────────────────────────────────────────────────────────────
import { Pane } from 'tweakpane';
import { P, VOICE_NAMES } from '../params.js';
import { LOOKS, LOOK_ORDER } from '../looks.js';

export function buildPanel(container, app) {
  const pane = new Pane({ container, title: 'Living Particles · controls' });
  const voiceOpts = Object.fromEntries(VOICE_NAMES.map((n, i) => [n, i]));

  // ── Looks (Output, A/B) ────────────────────────────────────────────────────
  const fl = pane.addFolder({ title: 'Looks · A / B', expanded: true });
  const presetOptions = () => {
    const o = {};
    for (const k of LOOK_ORDER) o[LOOKS[k].name] = k;
    for (const k of Object.keys(app.userLooks)) o['★ ' + k] = 'user:' + k;
    return o;
  };
  const pick = { a: P.looks.a, b: P.looks.b };
  let selA = fl.addBinding(pick, 'a', { label: 'look A', options: presetOptions() });
  let selB = fl.addBinding(pick, 'b', { label: 'look B', options: presetOptions() });
  const wireSel = () => {
    selA.on('change', e => app.loadLook('a', e.value));
    selB.on('change', e => app.loadLook('b', e.value));
  };
  wireSel();
  const morph = fl.addBinding(P.looks, 'morph', { label: 'morph A→B', min: 0, max: 1, step: 0.001 });
  fl.addBinding(P.looks, 'drive', {
    label: 'morph by',
    options: { 'hand (fader)': 'hand', 'slow LFO (16 s)': 'lfo', ...Object.fromEntries(VOICE_NAMES.map((n, i) => ['voice · ' + n, 'v' + i])) },
  });
  fl.addBinding(app.ui, 'saveName', { label: 'save edited as' });
  fl.addButton({ title: 'Save the tab you are editing as a look' }).on('click', () => {
    app.saveUserLook();
    const opts = presetOptions();
    // Tweakpane lists are fixed at creation: rebuild the two selects with the new entry.
    selA.dispose(); selB.dispose();
    selA = fl.addBinding(pick, 'a', { label: 'look A', options: opts, index: 0 });
    selB = fl.addBinding(pick, 'b', { label: 'look B', options: opts, index: 1 });
    wireSel();
  });

  const tabs = fl.addTab({ pages: [{ title: 'Edit A' }, { title: 'Edit B' }] });
  tabs.on('select', e => { P.looks.edit = e.index === 0 ? 'a' : 'b'; });
  [app.lookA, app.lookB].forEach((look, ti) => {
    const pg = tabs.pages[ti];
    const voices = pg.addFolder({ title: 'Voice colours', expanded: false });
    VOICE_NAMES.forEach((n, i) => voices.addBinding(look, 'v' + i, { label: n }));
    const floor = pg.addFolder({ title: 'Floor · rim and face', expanded: false });
    floor.addBinding(look, 'rim', { label: 'rim' });
    floor.addBinding(look, 'rimWidth', { label: 'rim width', min: 0.02, max: 0.5, step: 0.005 });
    floor.addBinding(look, 'rimGlow', { label: 'rim glow', min: 0, max: 4, step: 0.01 });
    floor.addBinding(look, 'rimPulse', { label: 'rim breath', min: 0, max: 3, step: 0.01 });
    floor.addBinding(look, 'face', { label: 'face' });
    floor.addBinding(look, 'grain', { label: 'stone grain', min: 0, max: 1, step: 0.01 });
    const cols = pg.addFolder({ title: 'Columns · fill and sides', expanded: false });
    cols.addBinding(look, 'fillGlow', { label: 'fill glow', min: 0, max: 4, step: 0.01 });
    cols.addBinding(look, 'fillCore', { label: 'fill: edge → solid', min: 0, max: 1, step: 0.01 });
    cols.addBinding(look, 'side', { label: 'side' });
    cols.addBinding(look, 'sideGlow', { label: 'side glow', min: 0, max: 4, step: 0.01 });
    cols.addBinding(look, 'edgeLines', { label: 'edge lines', min: 0, max: 2, step: 0.01 });
    cols.addBinding(look, 'flash', { label: 'onset flash', min: 0, max: 5, step: 0.01 });
    const sky = pg.addFolder({ title: 'Sky and distance', expanded: false });
    sky.addBinding(look, 'skyTop', { label: 'sky top' });
    sky.addBinding(look, 'horizon', { label: 'horizon / fog' });
    sky.addBinding(look, 'horizonGlow', { label: 'horizon seam', min: 0, max: 2, step: 0.01 });
    sky.addBinding(look, 'fog', { label: 'fog', min: 0, max: 0.04, step: 0.0005 });
    const post = pg.addFolder({ title: 'Bloom and exposure', expanded: false });
    post.addBinding(look, 'bloom', { label: 'bloom', min: 0, max: 3, step: 0.01 });
    post.addBinding(look, 'bloomRadius', { label: 'bloom radius', min: 0, max: 1, step: 0.01 });
    post.addBinding(look, 'bloomThreshold', { label: 'bloom threshold', min: 0, max: 1.5, step: 0.01 });
    post.addBinding(look, 'exposure', { label: 'exposure', min: 0.2, max: 2.5, step: 0.01 });
  });

  // ── Spawn ──────────────────────────────────────────────────────────────────
  const fs = pane.addFolder({ title: 'Spawn · what exists', expanded: false });
  const rebuild = e => app.rebuild(e);
  fs.addBinding(P.spawn, 'rings', { label: 'capacity (rings)', min: 6, max: 96, step: 1 }).on('change', rebuild);
  fs.addBinding(app.stats, 'tiles', { label: 'tiles', readonly: true, format: v => v.toFixed(0) });
  fs.addBinding(P.spawn, 'pattern', { label: 'voice layout', options: { rings: 'rings', sectors: 'sectors', spiral: 'spiral', scatter: 'scatter' } }).on('change', rebuild);
  fs.addBinding(P.spawn, 'ringWidth', { label: 'band width (tiles)', min: 0.5, max: 12, step: 0.1 }).on('change', rebuild);
  fs.addBinding(P.spawn, 'order', { label: 'centre', options: { 'low voices in': 'low-in', 'high voices in': 'high-in' } }).on('change', rebuild);
  fs.addBinding(P.spawn, 'scatter', { label: 'scatter', min: 0, max: 1, step: 0.01 }).on('change', rebuild);
  fs.addBinding(P.spawn, 'density', { label: 'density', min: 0, max: 1, step: 0.01 }).on('change', rebuild);
  fs.addBinding(P.spawn, 'seed', { label: 'seed', min: 1, max: 999, step: 1 }).on('change', rebuild);

  // ── Initialize ─────────────────────────────────────────────────────────────
  const fi = pane.addFolder({ title: 'Initialize · what each tile is born with', expanded: false });
  fi.addBinding(P.init, 'spread', { label: 'threshold spread', min: 0, max: 1, step: 0.01 });
  fi.addBinding(P.init, 'gap', { label: 'gap', min: 0, max: 0.6, step: 0.005 });
  fi.addBinding(P.init, 'base', { label: 'rest height', min: 0.02, max: 2, step: 0.01 });
  fi.addBinding(P.init, 'jitter', { label: 'height jitter', min: 0, max: 2, step: 0.01 });

  // ── Update ─────────────────────────────────────────────────────────────────
  const fu = pane.addFolder({ title: 'Update · how the floor answers', expanded: false });
  fu.addBinding(P.update, 'travel', { label: 'travel (units/s)', min: 0, max: 120, step: 0.5 });
  fu.addBinding(P.update, 'extrude', { label: 'extrude', min: 0, max: 12, step: 0.05 });
  fu.addBinding(P.update, 'shape', { label: 'height curve', min: 0.3, max: 4, step: 0.05 });
  fu.addBinding(P.update, 'floor', { label: 'presence floor', min: 0, max: 0.9, step: 0.01 });
  fu.addBinding(P.update, 'ceil', { label: 'presence ceiling', min: 0.1, max: 1, step: 0.01 });
  fu.addBinding(P.update, 'pulseVoice', { label: 'grid breathes with', options: voiceOpts });
  fu.addBinding(P.update, 'swell', { label: 'sub swell', min: 0, max: 4, step: 0.01 });

  // ── Affector ───────────────────────────────────────────────────────────────
  const fa = pane.addFolder({ title: 'Affector · touch the floor', expanded: false });
  fa.addBinding(P.affector, 'on', { label: 'on' });
  fa.addBinding(P.affector, 'mode', { label: 'driven by', options: { pointer: 'pointer', 'orbit path': 'orbit' } });
  fa.addBinding(P.affector, 'radius', { label: 'radius', min: 1, max: 40, step: 0.1 });
  fa.addBinding(P.affector, 'lift', { label: 'lift', min: -3, max: 8, step: 0.05 });
  fa.addBinding(P.affector, 'glow', { label: 'glow', min: 0, max: 1, step: 0.01 });
  fa.addBinding(P.affector, 'tint', { label: 'tint', min: 0, max: 2, step: 0.01 });
  fa.addBinding(P.affector, 'color', { label: 'tint colour' });
  fa.addBinding(P.affector, 'speed', { label: 'orbit speed', min: 0, max: 2, step: 0.01 });

  // ── Sparks ─────────────────────────────────────────────────────────────────
  const fk = pane.addFolder({ title: 'Sparks · second system', expanded: false });
  fk.addBinding(P.sparks, 'on', { label: 'on' });
  fk.addBinding(P.sparks, 'from', { label: 'spawn from', options: { 'presence · brilliance · air': 'highs', 'mid and up': 'mids+highs', 'all voices': 'all' } });
  fk.addBinding(P.sparks, 'burst', { label: 'burst on hits', min: 0, max: 1, step: 0.01 });
  fk.addBinding(P.sparks, 'shimmer', { label: 'shimmer (/s)', min: 0, max: 400, step: 1 });
  fk.addBinding(P.sparks, 'speed', { label: 'speed', min: 0, max: 20, step: 0.1 });
  fk.addBinding(P.sparks, 'life', { label: 'lifetime (s)', min: 0.1, max: 5, step: 0.05 });
  fk.addBinding(P.sparks, 'gravity', { label: 'gravity', min: -20, max: 10, step: 0.1 });
  fk.addBinding(P.sparks, 'turbulence', { label: 'turbulence', min: 0, max: 6, step: 0.05 });
  fk.addBinding(P.sparks, 'size', { label: 'size', min: 0.02, max: 2, step: 0.01 });
  fk.addBinding(P.sparks, 'bright', { label: 'brightness', min: 0, max: 5, step: 0.01 });
  fk.addBinding(app.stats, 'sparks', { label: 'alive', readonly: true, format: v => v.toFixed(0) });

  // ── Signal ─────────────────────────────────────────────────────────────────
  const fv = pane.addFolder({ title: 'Signal · voice analysis', expanded: false });
  fv.addBinding(P.voices, 'attack', { label: 'attack (s)', min: 0.002, max: 0.2, step: 0.001 });
  fv.addBinding(P.voices, 'releaseLow', { label: 'release, sub (s)', min: 0.02, max: 2, step: 0.01 });
  fv.addBinding(P.voices, 'releaseHigh', { label: 'release, air (s)', min: 0.02, max: 2, step: 0.01 });
  fv.addBinding(P.voices, 'onset', { label: 'onset threshold', min: 1, max: 5, step: 0.05 });

  // ── Camera, render, scenes ────────────────────────────────────────────────
  const fc = pane.addFolder({ title: 'Camera · render · scenes', expanded: false });
  fc.addBinding(P.camera, 'drift', { label: 'drift' });
  fc.addBinding(P.camera, 'driftSpeed', { label: 'drift speed', min: -3, max: 3, step: 0.01 });
  fc.addBinding(P.camera, 'fov', { label: 'lens (fov)', min: 20, max: 100, step: 1 });
  fc.addBinding(P.render, 'toneMapping', { label: 'tone mapping', options: { ACES: 'aces', AgX: 'agx', Neutral: 'neutral', none: 'none' } });
  fc.addBinding(P.render, 'scale', { label: 'render scale', min: 0.4, max: 1.5, step: 0.05 }).on('change', () => app.resize());
  fc.addBinding(app.stats, 'fps', { label: 'fps', readonly: true, format: v => v.toFixed(0) });
  fc.addBinding(app.stats, 'calls', { label: 'draw calls', readonly: true, format: v => v.toFixed(0) });
  fc.addBinding(app.stats, 'tris', { label: 'triangles', readonly: true, format: v => (v / 1000).toFixed(0) + ' k' });
  fc.addButton({ title: 'Export scene (JSON)' }).on('click', () => app.exportScene());
  fc.addButton({ title: 'Import scene (JSON)' }).on('click', () => app.importScene());
  fc.addButton({ title: 'Reset to defaults' }).on('click', () => app.resetScene());

  return {
    pane,
    refreshMorph() { morph.refresh(); },
    refresh() {
      pick.a = P.looks.a; pick.b = P.looks.b;
      pane.refresh();
    },
  };
}

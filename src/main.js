// ─────────────────────────────────────────────────────────────────────────────
//  Living Particles · Study 01 · Hex Field — v0.3
//
//  SOURCE    pattern / track (precise, analysed ahead) · mic / stress (live, basic)
//  TIMELINE  musical time → feature frames → gate + level → per-destination envelopes
//            → history rows (9 × 512); hit events → flashes and finite spark budgets
//  FIELD     ~7.5k instanced hex prisms read the history at their own ripple delay
//  LOOK      two editable looks, previewed alone or mixed by a fader, an LFO or a voice
//  UI        one bar (source, transport, scene, look mix, three macros); the editor shows one
//            family at a time; Music is a drawer; meters appear with the families that need them
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { P, VERSION, NB, VOICE_NAMES, FFT_SIZE, LOW_FFT_SIZE } from './params.js';
import { LOOKS, cloneLook, mixLooks, sanitizeLook, lookToPalette, applyPalette } from './looks.js';
import { FixedClock, SIM_DT } from './clock.js';
import { Sources } from './audio.js';
import { response, historySeconds, histAt } from './response.js';
import { Timeline } from './timeline.js';
import { ANALYSIS_VERSION } from './analysis/features.js';
import { renderPattern } from './analysis/pattern.js';
import { HexField } from './world/hexfield.js';
import { Sparks } from './world/sparks.js';
import { Stage, BOOKMARKS } from './world/stage.js';
import { Meters } from './ui/meters.js';
import { Library, fmt } from './ui/library.js';
import { buildPanel, FAMILIES } from './ui/panel.js';
import { buildBar } from './ui/bar.js';
import { SAVED_GROUPS, migrate, assignGroup, validate, header, compatibility } from './scene.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const clone = o => JSON.parse(JSON.stringify(o));
const DEFAULTS = clone(P);

// ── State ───────────────────────────────────────────────────────────────────
let panel = null, bar = null;
const state = { running: true, voiceMorph: 0, visualTime: 0, analysis: 'idle', progress: 0, lastT: 0 };
const savedUi = store.get('lp.ui', {});
const app = {
  lookA: cloneLook(LOOKS[P.looks.a]), lookB: cloneLook(LOOKS[P.looks.b]),
  mixed: {},
  userLooks: Object.fromEntries(Object.entries(store.get('lp.looks', {})).map(([k, l]) => [k, sanitizeLook(l, LOOKS.av2)])),
  scenes: store.get('lp.scenes', {}),              // one scene per track, keyed by track name
  userScenes: store.get('lp.userScenes', {}),      // named scenes
  stats: { tiles: 0, sparks: 0, dropped: 0, fps: 0, calls: 0, tris: 0, frameMs: 0 },
  // Interface state: a per-browser convenience, never part of a scene.
  ui: { saveName: 'my look', hidden: false, library: false,
        mode: savedUi.mode === 'edit' ? 'edit' : 'perform',
        family: FAMILIES.some(f => f[0] === savedUi.family) ? savedUi.family : 'looks' },
  defaults: DEFAULTS,
  lastSaved: null,
};

// ── World ───────────────────────────────────────────────────────────────────
let stage;
try { stage = new Stage($('stage')); }
catch (e) {
  $('glError').hidden = false;
  $('glError').textContent = 'WebGL 2 is not available in this browser, so the field cannot be drawn.';
  throw e;
}
const field = new HexField(response.tex);
field.build(P.floor);
stage.scene.add(field.mesh);
const sparks = new Sparks();
sparks.reseed(P.floor.seed);
sparks.uniforms.uRamp.value = field.ramp.texture;        // one ramp texture, shared
stage.scene.add(sparks.points);
let diagBefore = 0;
stage.emissionHook = on => { const u = field.uniforms.uDiag; if (on) { diagBefore = u.value; u.value = 1; } else u.value = diagBefore; };
app.stats.tiles = field.layout.count;

const delayOf = i => { const tr = field.uniforms.uTravel.value; return tr > 0 ? field.layout.d[i] / tr : 0; };

// ── Sources, analysis, timeline ─────────────────────────────────────────────
const sources = new Sources();
const clock = new FixedClock();
const meters = new Meters($('meters'));
const timeline = new Timeline({
  onEvent: ev => sparks.burst(ev, field, stage.affector, delayOf),
  onReset: () => { sparks.clear(); sparks.reseed(P.floor.seed); },
});

const worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
const featureCache = new Map();          // key → { features, events } (bounded)
let pending = null;                      // { key, resolve, reject }
worker.onmessage = e => {
  const m = e.data;
  if (m.type === 'progress' && pending?.key === m.key) { state.progress = m.p; updateStatus(); }
  else if (m.type === 'result' && pending?.key === m.key) {
    featureCache.set(m.key, { features: m.features, events: m.events });
    while (featureCache.size > 6) featureCache.delete(featureCache.keys().next().value);
    const p = pending; pending = null; p.resolve(featureCache.get(m.key));
  } else if (m.type === 'events') {
    const c = featureCache.get(m.key); if (c) c.events = m.events;
    if (m.key === current.key) timeline.setEvents(m.events);
  } else if (m.type === 'error' && pending?.key === m.key) { const p = pending; pending = null; p.reject(new Error(m.message)); }
};

// Identity of decoded audio: rate, length, channels and a hash of strided samples. A file
// name alone is not enough. Analysis settings are part of the key.
function audioKey(buffer) {
  let h = 2166136261 >>> 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c), step = Math.max(1, Math.floor(d.length / 4096));
    for (let i = 0; i < d.length; i += step) { h ^= Math.round(d[i] * 1e6) & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; }
  }
  return `${ANALYSIS_VERSION}:${buffer.sampleRate}:${buffer.length}:${buffer.numberOfChannels}:${h.toString(16)}`;
}
const detectOpts = () => timeline.detectOpts();

function analyse(buffer) {
  const key = audioKey(buffer);
  if (featureCache.has(key)) return Promise.resolve({ key, ...featureCache.get(key) });
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  return new Promise((resolve, reject) => {
    pending = { key, resolve: r => resolve({ key, ...r }), reject };
    state.analysis = 'analysing'; state.progress = 0; updateStatus();
    worker.postMessage({ type: 'analyze', key, sampleRate: buffer.sampleRate, channels, detect: detectOpts() }, channels.map(c => c.buffer));
  });
}
let redetectTimer = 0;
app.redetect = () => {
  timeline.refreshLiveDetect();
  if (!current.key) return;
  clearTimeout(redetectTimer);
  redetectTimer = setTimeout(() => worker.postMessage({ type: 'detect', key: current.key, detect: detectOpts() }), 250);
};

const current = { key: null, buffer: null, analysis: null };
let patternBuffer = null;

async function startBuffered(mode, id, name, buffer) {
  await sources.useBuffer(mode, id, name, buffer);
  sources.setLoop($('loopChk').checked);
  current.key = null; current.buffer = buffer;
  // until the precise analysis is ready, the live analyser follows the audio ("basic")
  timeline.setLive(sources.sampleRate, FFT_SIZE, LOW_FFT_SIZE);
  if (state.running) startPlayback();
  setSourceButtons();
  try {
    const r = await analyse(buffer);
    if (current.buffer !== buffer) return;                 // the source changed meanwhile
    current.key = r.key;
    timeline.setPrecise(r.features, r.events, buffer.duration, sources.loop);
    state.analysis = 'precise';
  } catch (e) { console.error('[analysis]', e); state.analysis = 'failed'; }
  updateStatus(); setSourceButtons();
}

// Sound needs a user gesture. Until then buffered sources run on a silent clock with the
// same timeline; the first click or key makes them audible from the same position.
function startPlayback() {
  if (sources.ctx && sources.ctx.state === 'running') sources.play();
  else { sources.silent = true; sources.silentAt = performance.now() / 1000; sources.playing = true; }
}
const origHeard = sources.heardTime.bind(sources);
sources.heardTime = () => {
  if (sources.silent && sources.virtual === null) return sources.base + (sources.playing ? performance.now() / 1000 - sources.silentAt : 0);
  return origHeard();
};
const origPause = sources.pause.bind(sources);
sources.pause = () => {
  if (sources.silent) { sources.base = sources.heardTime(); sources.playing = false; return; }
  origPause();
};
function unlockAudio() {
  const ctx = sources.ensureContext();
  ctx.resume().then(() => {
    if (sources.silent) {
      const t = sources.heardTime(), was = sources.playing;
      sources.silent = false; sources.playing = false; sources.base = t;
      if (was) sources.play();
      setSourceButtons();
    }
  });
}
addEventListener('pointerdown', unlockAudio, { once: false, passive: true });
addEventListener('keydown', unlockAudio, { passive: true });

async function usePattern() {
  const ctx = sources.ensureContext();
  if (!patternBuffer || patternBuffer.sampleRate !== ctx.sampleRate) {
    const pcm = renderPattern(ctx.sampleRate);
    patternBuffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
    patternBuffer.copyToChannel(pcm, 0);
  }
  await startBuffered('pattern', 'pattern', 'Test pattern', patternBuffer);
}

// ── Looks ───────────────────────────────────────────────────────────────────
function lookFromKey(key) { return key?.startsWith('user:') ? app.userLooks[key.slice(5)] : LOOKS[key]; }
app.loadLook = (slot, key) => {
  const src = lookFromKey(key); if (!src) return;
  Object.assign(slot === 'a' ? app.lookA : app.lookB, cloneLook(src));
  P.looks[slot] = key;
  panel?.refresh(); autosave();
};
app.saveUserLook = () => {
  const name = (app.ui.saveName || 'my look').trim().slice(0, 40) || 'my look';
  const src = P.looks.edit === 'b' ? app.lookB : app.lookA;
  app.userLooks[name] = { ...cloneLook(src), name };
  store.set('lp.looks', app.userLooks);
  P.looks[P.looks.edit] = 'user:' + name;
};
// The edited look's ramps as a palette file (the reusable asset), and back.
app.exportPalette = () => {
  const look = P.looks.edit === 'b' ? app.lookB : app.lookA, pal = lookToPalette(look);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(pal, null, 2)], { type: 'application/json' })); a.download = `palette_${pal.id}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
app.applyPalette = obj => { const r = applyPalette(P.looks.edit === 'b' ? app.lookB : app.lookA, obj); if (r.ok) { panel?.refresh(); autosave(); } return r; };
app.importPalette = done => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    let r;
    try { r = app.applyPalette(JSON.parse(await inp.files[0].text())); } catch (e) { r = { ok: false, message: 'That file could not be read as JSON.' }; }
    done?.(r);
  };
  inp.click();
};
app.effectiveMorph = () => (P.looks.preview === 'a' ? 0 : P.looks.preview === 'b' ? 1 : P.looks.morph);
function updateMorph(dt) {
  const d = P.looks.drive;
  if (d === 'hand') return;
  let target = 0;
  if (d === 'lfo') target = 0.5 - 0.5 * Math.cos((2 * Math.PI * state.visualTime) / 16);
  else if (d[0] === 'v') target = response.lift[+d.slice(1)] || 0;
  state.voiceMorph += (target - state.voiceMorph) * (1 - Math.exp(-dt / (d === 'lfo' ? 0.05 : 0.8)));
  P.looks.morph = Math.min(1, Math.max(0, state.voiceMorph));
}

// ── Scenes ──────────────────────────────────────────────────────────────────
//  A scene is every saved control, both looks, the mix state and the camera. Where they come from:
//    built in   authored starting points (BUILTIN below)
//    saved      named scenes in this browser                 (lp.userScenes)
//    track      one scene per track, recalled with the track (lp.scenes, as in v0.2)
//    file       an imported JSON
//  The bar shows which scene is loaded, whether anything changed since, Revert and Save.
function snapshot() {
  const s = header();
  for (const g of SAVED_GROUPS()) s[g] = clone(P[g]);
  s.view = { pos: stage.camera.position.toArray(), target: stage.controls.target.toArray() };
  const { preview, ...looks } = P.looks;                 // preview is an audition, never saved
  s.looks = { ...looks, lookA: cloneLook(app.lookA), lookB: cloneLook(app.lookB) };
  return s;
}
function applyScene(input, { fly = true } = {}) {
  const ok = compatibility(input);
  if (!ok.ok) { app.sceneError = ok.message; console.warn('[scene]', ok.message); return false; }
  const s = migrate(input);
  if (!s) return false;
  app.sceneError = '';
  const floorBefore = JSON.stringify(P.floor);
  for (const g of SAVED_GROUPS()) assignGroup(P[g], s[g]);
  if (s.looks) {
    for (const k of ['a', 'b', 'morph', 'drive', 'edit']) if (typeof s.looks[k] === typeof P.looks[k]) P.looks[k] = s.looks[k];
    Object.assign(app.lookA, sanitizeLook(s.looks.lookA, app.lookA));
    Object.assign(app.lookB, sanitizeLook(s.looks.lookB, app.lookB));
    state.voiceMorph = P.looks.morph;
  }
  P.looks.preview = 'mix';
  validate();
  if (JSON.stringify(P.floor) !== floorBefore) app.rebuild();
  if (s.view?.pos && s.view?.target && [...s.view.pos, ...s.view.target].every(Number.isFinite)) {
    const to = { pos: new THREE.Vector3(...s.view.pos), target: new THREE.Vector3(...s.view.target) };
    if (fly) stage.flight = { from: { pos: stage.camera.position.clone(), target: stage.controls.target.clone() }, to, t: 0 };
    else { stage.camera.position.copy(to.pos); stage.controls.target.copy(to.target); stage.controls.update(); }
  }
  stage.resize(innerWidth, innerHeight);
  app.redetect();
  panel?.refresh(); bar?.refresh();
  return true;
}
for (const bag of [app.scenes, app.userScenes]) for (const [name, sc] of Object.entries(bag)) { const m = migrate(sc); if (m) bag[name] = m; else delete bag[name]; }
let saveTimer = 0;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('lp.current', snapshot()), 400); }
app.autosave = autosave;
app.validate = () => { validate(); };

app.rebuild = () => { field.build(P.floor); app.stats.tiles = field.layout.count; sparks.clear(); autosave(); };
app.resize = () => { stage.resize(innerWidth, innerHeight); meters.resize(); };

// Built-in scenes: authored starting points. Each returns a complete scene.
const standView = () => ({ pos: [...BOOKMARKS.stand.pos], target: [...BOOKMARKS.stand.target] });
const BUILTIN = {
  default: { label: 'Default · AV2 Precision', make() {
    const d = clone(DEFAULTS);
    return { ...header(), ...d, view: standView(), looks: { ...d.looks, lookA: LOOKS[d.looks.a], lookB: LOOKS[d.looks.b] } };
  } },
  // The Plume phrase (v0.2 spec §7): weight from the low end, a clear plume on bass hits, sparse
  // high sparks as counterpoint, slow colour change, dark regions.
  plume: { label: 'Plume phrase · Nocturne', make() {
    const d = clone(DEFAULTS);
    Object.assign(d.floor, { active: 0.45, variation: 0.85, scatter: 0.1 });
    Object.assign(d.movement, { lift: 1.3, swell: 0.9, travel: 30 });
    Object.assign(d.map.rim, { source: 0, fall: 900 });
    Object.assign(d.map.colour, { source: 8, amount: 0.35, rise: 3000, fall: 6000 });
    Object.assign(d.sparks, { perHit: 10, from: 'highs', continuous: 0, life: 0.9, size: 0.22 });
    Object.assign(d.plume, { on: true, voice: 1 });
    const lookA = { ...LOOKS.nocturne, restRim: 0.35, rimBreath: 0.9, fill: 0.5, bloom: 0.55, bloomThreshold: 0.7, bloomSky: 0, hitWhiten: 0.2, name: 'Nocturne · plume' };
    return { ...header(), ...d, view: standView(), looks: { ...d.looks, a: 'nocturne', b: 'av2p', morph: 0, lookA, lookB: LOOKS.av2p } };
  } },
  // v0.3 · P2: each new look in A with the look it answers in B, on the default scene's motion, so
  // A / Mix / B in the bar is the comparison.
  mineral: { label: 'Mineral Night  (B: Nocturne)', make() {
    const d = clone(DEFAULTS);
    return { ...header(), ...d, view: standView(), looks: { ...d.looks, a: 'mineral', b: 'nocturne', morph: 0, lookA: LOOKS.mineral, lookB: LOOKS.nocturne } };
  } },
  daylight: { label: 'Daylight Precision  (B: AV2 Precision)', make() {
    const d = clone(DEFAULTS);
    return { ...header(), ...d, view: standView(), looks: { ...d.looks, a: 'daylight', b: 'av2p', morph: 0, lookA: LOOKS.daylight, lookB: LOOKS.av2p } };
  } },
};
app.builtinScenes = BUILTIN;

// Which scene is loaded, and what it looked like when loaded or last saved (for "edited" and Revert).
// The camera is saved with a scene but moving it does not count as an edit.
const sceneKey = s => { const { saved, version, schema, migratedFrom, view, ...rest } = s; return JSON.stringify(rest); };
const scene = { ref: 'builtin:default', label: BUILTIN.default.label, base: null, baseKey: '', modified: false };
function setBase(ref, label) {
  scene.ref = ref; scene.label = label; scene.base = snapshot(); scene.baseKey = sceneKey(scene.base); scene.modified = false;
  store.set('lp.sceneRef', { ref, label });
}
function resolveScene(ref) {
  const [kind, ...rest] = String(ref).split(':'), key = rest.join(':');
  if (kind === 'builtin' && BUILTIN[key]) return { data: BUILTIN[key].make(), label: BUILTIN[key].label };
  if (kind === 'user' && app.userScenes[key]) return { data: app.userScenes[key], label: key };
  if (kind === 'track' && app.scenes[key]) return { data: app.scenes[key], label: `${key} (track)` };
  return null;
}
app.loadSceneRef = (ref, opts) => {
  const r = resolveScene(ref);
  if (!r || !applyScene(r.data, opts)) return false;
  setBase(ref, r.label); autosave();
  return true;
};
app.revertScene = () => { if (scene.base && applyScene(scene.base)) { scene.modified = false; autosave(); } };
app.sceneList = () => {
  const groups = [
    { label: 'Built in', items: Object.entries(BUILTIN).map(([k, b]) => ({ ref: 'builtin:' + k, label: b.label })) },
    { label: 'Saved', items: Object.keys(app.userScenes).sort().map(k => ({ ref: 'user:' + k, label: k })) },
    { label: 'Saved with a track', items: Object.keys(app.scenes).sort().map(k => ({ ref: 'track:' + k, label: k })) },
  ];
  if (!resolveScene(scene.ref)) groups.push({ label: 'Loaded', items: [{ ref: scene.ref, label: scene.label }] });
  return groups;
};
const activeTrackName = () => (sources.mode === 'track' && library.active ? library.active.name : '');
app.sceneState = () => {
  const trackName = activeTrackName(), kind = scene.ref.split(':')[0];
  return { ref: scene.ref, label: scene.label, modified: scene.modified, trackName,
           suggestedName: kind === 'user' ? scene.ref.slice(5) : trackName || `${scene.label.split(' · ')[0]} · mine` };
};
const STORAGE_FAIL = 'Could not save: this browser’s storage is unavailable or full.';
app.saveNamedScene = raw => {
  const name = String(raw || '').trim().slice(0, 60);
  if (!name) return { ok: false, message: 'Give the scene a name first.' };
  app.userScenes[name] = snapshot();
  if (!store.set('lp.userScenes', app.userScenes)) return { ok: false, message: STORAGE_FAIL };
  setBase('user:' + name, name);
  return { ok: true, name };
};
app.deleteNamedScene = () => {
  if (!scene.ref.startsWith('user:')) return { ok: false, message: 'Only named scenes can be deleted here.' };
  const name = scene.ref.slice(5);
  delete app.userScenes[name]; store.set('lp.userScenes', app.userScenes);
  setBase('session', `${name} (deleted, still loaded)`);
  return { ok: true, name };
};
app.saveTrackScene = () => {
  const t = sources.mode === 'track' ? library.active : null;
  if (!t) return { ok: false, message: 'Play a track from Music first; then its scene can be saved with it.' };
  app.scenes[t.name] = snapshot(); app.lastSaved = app.scenes[t.name];
  if (!store.set('lp.scenes', app.scenes)) return { ok: false, message: STORAGE_FAIL };
  library.render(); setBase('track:' + t.name, `${t.name} (track)`);
  return { ok: true, name: t.name };
};
app.exportScene = () => {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const base = scene.ref.startsWith('user:') ? scene.ref.slice(5) : library.active ? library.active.name : 'scene';
  a.href = URL.createObjectURL(blob); a.download = `living-particles_${base.replace(/[^\w.-]+/g, '_')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
// Apply an imported scene object. Returns { ok, message }.
app.applyImported = (obj, name = 'imported scene') => {
  if (!applyScene(obj)) return { ok: false, message: app.sceneError || 'That file is not a scene this build can read.' };
  setBase('file:' + name, `${name} (file)`); autosave();
  return { ok: true, message: '' };
};
app.importScene = done => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    let r;
    try { r = app.applyImported(JSON.parse(await inp.files[0].text()), inp.files[0].name.replace(/\.json$/i, '')); }
    catch (e) { console.error('[scene] import failed', e); r = { ok: false, message: 'That file could not be read as JSON.' }; }
    done?.(r);
  };
  inp.click();
};
app.resetScene = () => {
  store.del('lp.current');
  applyScene(BUILTIN.default.make(), { fly: false });
  stage.goTo('stand');
  setBase('builtin:default', BUILTIN.default.label);
};
app.resetGroup = g => {
  const floorBefore = JSON.stringify(P.floor);
  assignGroup(P[g], clone(DEFAULTS[g]));
  validate();
  if (g === 'floor' && JSON.stringify(P.floor) !== floorBefore) app.rebuild();
  if (g === 'music') app.redetect();
  panel?.refresh(); bar?.refresh(); autosave();
};
app.restoreSaved = () => { if (app.lastSaved) applyScene(app.lastSaved); };
app.loadPlumeScene = () => app.loadSceneRef('builtin:plume');
app.snapshot = snapshot;

// ── Library + transport ─────────────────────────────────────────────────────
const library = new Library({
  list: $('tracks'), empty: $('emptyNote'), sources,
  hasScene: name => !!app.scenes[name],
  onSelect: async t => {
    if ($('recallChk').checked && app.scenes[t.name] && applyScene(app.scenes[t.name])) { app.lastSaved = app.scenes[t.name]; setBase('track:' + t.name, `${t.name} (track)`); }
    state.running = true; clock.reset();
    await startBuffered('track', t.id, t.name, t.buffer);
  },
});
library.onRemovedActive = () => { usePattern(); };
sources.onEnded = () => {
  const n = sources.mode === 'track' && library.tracks.length > 1 ? library.next() : null;
  if (n) library.select(n.id); else { state.running = false; setSourceButtons(); }
};

function sourceLabel() {
  const precise = timeline.mode === 'precise';
  const how = sources.buffered ? (precise ? 'precise' : state.analysis === 'analysing' ? `basic · analysing ${Math.round(state.progress * 100)} %` : 'basic') : 'Live · basic analysis';
  if (sources.mode === 'track' && library.active) return `${library.active.name} · ${how}`;
  if (sources.mode === 'pattern') return `Test pattern · ${how}`;
  if (sources.mode === 'mic') return 'Microphone · Live · basic analysis';
  return 'Stress test · synthetic spectrum (visual only)';
}
function updateStatus() {
  const precise = timeline.mode === 'precise';
  bar?.setSource(sourceLabel() + (sources.silent && sources.buffered ? ' · click anywhere for sound' : ''),
    !sources.buffered ? 'live' : precise ? 'precise' : state.analysis === 'analysing' ? 'analysing' : 'basic');
}
function setSourceButtons() {
  document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === sources.mode)));
  document.querySelector('[data-source="track"]').disabled = !library.active;
  bar?.setPlaying(state.running);
  updateStatus();
}
const sourceNote = text => { $('sourceNote').textContent = text; };

document.querySelectorAll('[data-source]').forEach(btn => btn.addEventListener('click', async () => {
  const s = btn.dataset.source;
  sourceNote(s === 'mic' ? 'Waiting for microphone permission…' : '');
  try {
    state.running = true; clock.reset();
    if (s === 'pattern') await usePattern();
    else if (s === 'stress') { sources.useStress(); current.buffer = null; current.key = null; timeline.setLive(48000, FFT_SIZE, null); }
    else if (s === 'mic') { await sources.useMic(); current.buffer = null; current.key = null; timeline.setLive(sources.sampleRate, FFT_SIZE, LOW_FFT_SIZE); }
    else if (s === 'track' && library.active) await library.select(library.active.id);
    sourceNote('');
  } catch (e) {
    console.warn('[source]', e);
    sourceNote(s === 'mic' ? 'Microphone not available (permission denied, or no input device). The previous source keeps playing.' : 'Could not switch source.');
    return;
  }
  setSourceButtons();
}));

function togglePlay() {
  state.running = !state.running; clock.reset();
  if (sources.buffered) { state.running ? startPlayback() : sources.pause(); }
  setSourceButtons();
}
app.togglePlay = togglePlay;
app.restart = () => {
  if (sources.silent) { sources.base = 0; sources.silentAt = performance.now() / 1000; sources.liveTime = 0; }
  else sources.restart();
  clock.reset();
  if (timeline.mode === 'precise') timeline.reset(0); else timeline.setLive(timeline.live.sr, timeline.live.hi.size, timeline.live.lo?.size || null);
};
app.setLoop = on => { sources.setLoop(on); timeline.setLoop(on); };
app.fireHit = () => timeline.fireManual(P.manual.voice);
$('rememberChk').addEventListener('change', e => { library.remember = e.target.checked; });

$('fileInput').addEventListener('change', async e => {
  const first = await library.add(e.target.files);
  e.target.value = '';
  if (first) library.select(first.id);
});
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropveil').hidden = false; });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropveil').hidden = true; });
addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropveil').hidden = true;
  const first = await library.add(e.dataTransfer.files);
  if (first) library.select(first.id);
});

// ── Interface: bar, editor, Music drawer, meters, keys ──────────────────────
//  Perform (default): the bar and the camera chips. Edit: the editor too, one family at a time;
//  the meters appear with the Music response and Inspect families. H hides everything.
app.timeline = timeline; app.sources = sources; app.response = response; app.sparks = sparks; app.field = field;
bar = buildBar($('bar'), app);
panel = buildPanel($('pane'), app);

const sheets = () => matchMedia('(max-width: 900px)').matches;       // the editor and Music share the bottom of a narrow screen
const METER_FAMILIES = ['music', 'inspect'];
function layout() {
  const edit = app.ui.mode === 'edit';
  document.body.classList.toggle('mode-edit', edit); document.body.classList.toggle('mode-perform', !edit);
  document.body.classList.toggle('clean', app.ui.hidden);
  document.body.classList.toggle('sheet-open', edit || app.ui.library);
  $('paneWrap').hidden = !edit;
  $('library').hidden = !app.ui.library;
  $('voices').hidden = !(edit && METER_FAMILIES.includes(app.ui.family));
  $('showBtn').hidden = !app.ui.hidden;
  bar.setLibraryOpen(app.ui.library); bar.refresh();
  if (!$('voices').hidden) meters.resize();
  store.set('lp.ui', { mode: app.ui.mode, family: app.ui.family });
}
app.setMode = mode => {
  app.ui.mode = mode === 'edit' ? 'edit' : 'perform';
  if (app.ui.mode === 'edit' && sheets()) app.ui.library = false;
  layout();
  if (app.ui.mode === 'edit') panel.refresh();
};
app.setFamily = key => { if (!FAMILIES.some(f => f[0] === key)) return; app.ui.family = key; panel.setFamily(key); layout(); };
app.toggleLibrary = on => {
  app.ui.library = on ?? !app.ui.library;
  if (app.ui.library && sheets()) app.ui.mode = 'perform';
  layout();
  if (app.ui.library) $('library').querySelector('[aria-pressed="true"]')?.focus();
};
app.setHidden = on => { app.ui.hidden = !!on; layout(); if (on) $('showBtn').focus(); };
$('libClose').addEventListener('click', () => { app.toggleLibrary(false); $('sourceBtn').focus(); });
$('showBtn').addEventListener('click', () => app.setHidden(false));
new ResizeObserver(() => document.documentElement.style.setProperty('--bar-h', `${$('bar').offsetHeight}px`)).observe($('bar'));

function goTo(name) {
  stage.goTo(name);
  document.querySelectorAll('[data-cam]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === name)));
}
document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.cam)));
stage.controls.addEventListener('start', () => document.querySelectorAll('[data-cam]').forEach(b => b.setAttribute('aria-pressed', 'false')));
stage.controls.addEventListener('end', autosave);

// Keys never fire while typing in a field. On a focused button, Space and Enter belong to the button.
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') {                                    // close the innermost thing that is open
    if (bar.closePopover()) return;
    if (app.ui.hidden) return app.setHidden(false);
    if (e.target.closest?.('input, textarea, select')) return e.target.blur();
    if (app.ui.library) { app.toggleLibrary(false); $('sourceBtn').focus(); return; }
    if (app.ui.mode === 'edit') { app.setMode('perform'); $('editBtn').focus(); }
    return;
  }
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if ((k === ' ' || k === 'enter') && e.target.closest?.('button, summary, a')) return;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'h') app.setHidden(!app.ui.hidden);
  else if (k === 'l') app.toggleLibrary();
  else if (k === 'e' || k === 'p') app.setMode(app.ui.mode === 'edit' ? 'perform' : 'edit');
  else if (k === 'r') app.restart();
  else if (k === '1') goTo('stand');
  else if (k === '2') goTo('survey');
  else if (k === '3') goTo('low');
});

// ── Loop ────────────────────────────────────────────────────────────────────
const renderer = stage.renderer;
renderer.info.autoReset = false;
let last = null, frameNo = 0, fpsT = 0, fpsN = 0;
const accentHex = new THREE.Color();
const frameTimes = new Float32Array(240); let ftI = 0;

// Advance the music to display time `now` (ms). Returns the timing the shaders need.
function advance(dt) {
  field.syncParams(stage.affector);
  if (timeline.mode === 'precise') {
    const t = Math.max(0, sources.heardTime() - P.music.syncOffset / 1000);
    timeline.advancePrecise(t);
    state.visualTime = t;
    return { rowHz: timeline.rowHz, rowShift: Math.max(0, (timeline.latest - t) * timeline.rowHz) };
  }
  if (state.running) {
    const n = clock.advance(dt);
    for (let i = 0; i < n; i++) {
      sources.liveTime += SIM_DT;
      const db = sources.readDb();
      if (db && timeline.live) timeline.stepLive(db, sources.liveTime, SIM_DT);
    }
  }
  state.visualTime = sources.liveTime;
  return { rowHz: 60, rowShift: 0 };
}

function frame(now) {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  const dt = last == null ? 0 : Math.max(0, (now - last) / 1000); last = now;
  const timing = advance(dt);
  if (!state.skipDraw) {
    draw(dt, timing);
    fpsT += dt; fpsN++;
    frameTimes[ftI++ % frameTimes.length] = performance.now() - t0;
    if (fpsT >= 0.5) { app.stats.fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  }
  frameNo++;
  uiTick();
}
// The interface refreshes a few times a second, not every frame (and also while drawing is skipped by the tools).
function uiTick() {
  if (frameNo % 6 === 0) {
    const pos = sources.position(), dur = sources.duration;
    bar.setTime(sources.buffered ? `${fmt(pos)} / ${fmt(dur)}` : sources.mode === 'mic' ? 'live' : `${fmt(pos)} · stress`, dur ? pos / dur : 0);
    bar.tick();
    if (app.ui.mode === 'edit') panel.tick();
  }
  if (frameNo % 30 === 0) {
    sparks.countAlive(state.visualTime);
    app.stats.sparks = sparks.stats.alive; app.stats.dropped = sparks.stats.dropped;
    if (app.mixed.rim) { accentHex.copy(app.mixed.rim).convertLinearToSRGB(); document.documentElement.style.setProperty('--accent', '#' + accentHex.getHexString()); }
    scene.modified = sceneKey(snapshot()) !== scene.baseKey;
    updateStatus();
  }
}

function draw(dt, timing) {
  updateMorph(dt);
  mixLooks(app.lookA, app.lookB, app.effectiveMorph(), app.mixed);
  stage.update(dt, app.mixed, state.visualTime);
  field.sync(app.mixed, state.visualTime, stage.affector, timing, response.lift[P.light.source] ?? 1);
  sparks.sync(app.mixed, state.visualTime, stage.pixelScale);
  renderer.info.reset();
  stage.render();
  app.stats.calls = renderer.info.render.calls; app.stats.tris = renderer.info.render.triangles;
  if (!$('voices').hidden) { meters.setPalette(app.mixed); meters.draw(app, timeline); }
}

// ── Boot ────────────────────────────────────────────────────────────────────
//  Last session's controls come back as they were. If they came from a scene that still exists,
//  that scene is the base again, so "edited" and Revert mean the same as before the reload.
const saved = store.get('lp.current', null), savedRef = store.get('lp.sceneRef', null);
if (savedRef && resolveScene(savedRef.ref) && applyScene(resolveScene(savedRef.ref).data, { fly: false })) setBase(savedRef.ref, resolveScene(savedRef.ref).label);
else setBase('builtin:default', BUILTIN.default.label);
if (saved && applyScene(saved, { fly: false })) {
  scene.modified = sceneKey(snapshot()) !== scene.baseKey;
  if (scene.modified && !savedRef) setBase('session', 'Last session');
}
app.resize();
addEventListener('resize', () => { app.resize(); layout(); });
library.init().then(setSourceButtons);
usePattern();
setSourceButtons();
layout();
requestAnimationFrame(frame);

// Hooks for the headless checks in tools/.
window.__lp = {
  state, P, app, response, timeline, field, sparks, stage, sources, library, worker, histAt, scene,
  draw(dt = 1 / 60) { draw(dt, advance(0)); },
  advance, restart: () => app.restart(),
  goTo(name) { stage.goTo(name, true); },
  applyScene, snapshot, analyse, usePattern, startBuffered,
  ready: () => timeline.mode === 'precise',
  frameTimes: () => Array.from(frameTimes),
  voices: VOICE_NAMES, NB, VERSION,
  historySeconds: () => historySeconds(timeline.rowHz),
};

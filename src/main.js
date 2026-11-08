// ─────────────────────────────────────────────────────────────────────────────
//  Living Particles · Study 01 · Hex Field
//
//  SIGNAL   source → two FFTs → 8 voices (level, onset) → 8 × 512 history texture
//  FIELD    ~8k instanced hex prisms read the history at their own delay
//  SPARKS   a second system with lifetimes, spawned where tiles flash
//  LOOK     two editable looks, mixed by a fader, an LFO or a voice
//
//  The simulation (analysis, history, spark spawning) steps at a fixed 60 Hz;
//  drawing happens once per display frame.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { P, VERSION, BINS, LOW_FFT_SIZE, NB, VOICE_NAMES } from './params.js';
import { LOOKS, cloneLook, mixLooks, sanitizeLook } from './looks.js';
import { FixedClock, SIM_DT } from './clock.js';
import { Sources } from './audio.js';
import { bands, cookBands, depositBands, clearBands, applyManual, fireManualHit } from './bands.js';
import { SAVED_GROUPS, migrate, assignGroup, validate, header } from './scene.js';
import { HexField } from './world/hexfield.js';
import { Sparks } from './world/sparks.js';
import { Stage } from './world/stage.js';
import { Meters } from './ui/meters.js';
import { Library, fmt } from './ui/library.js';
import { buildPanel } from './ui/panel.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const DEFAULTS = JSON.parse(JSON.stringify(P));

// ── State ───────────────────────────────────────────────────────────────────
let panel = null;           // built after the world exists
const state = { running: true, simTime: 0, voiceMorph: 0 };
const app = {
  lookA: cloneLook(LOOKS[P.looks.a]), lookB: cloneLook(LOOKS[P.looks.b]),
  mixed: {},
  userLooks: store.get('lp.looks', {}),
  scenes: store.get('lp.scenes', {}),
  stats: { tiles: 0, sparks: 0, fps: 0, calls: 0, tris: 0 },
  ui: { saveName: 'my look' },
};

// ── World ───────────────────────────────────────────────────────────────────
let stage;
try { stage = new Stage($('stage')); }
catch (e) {
  $('glError').hidden = false;
  $('glError').textContent = 'WebGL 2 is not available in this browser, so the field cannot be drawn.';
  throw e;
}
const field = new HexField(bands.tex);
field.build(P.spawn);
stage.scene.add(field.mesh);
const sparks = new Sparks();
stage.scene.add(sparks.points);
app.stats.tiles = field.layout.count;

const sources = new Sources();
const clock = new FixedClock();
const bins = new Float32Array(BINS), lowBins = new Float32Array(LOW_FFT_SIZE / 2);
const meters = new Meters($('meters'));

function simStep() {
  sources.read(bins);
  const hasLow = sources.readLow(lowBins);
  cookBands(bins, sources.mode === 'test' ? 46.875 : sources.binHz, hasLow ? lowBins : null, sources.lowBinHz);
  applyManual();
  depositBands();
  sources.advance(SIM_DT);
  state.simTime += SIM_DT;
  sparks.step(field, state.simTime, SIM_DT);
}

// ── Looks ───────────────────────────────────────────────────────────────────
function lookFromKey(key) {
  if (key?.startsWith('user:')) return app.userLooks[key.slice(5)];
  return LOOKS[key];
}
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
function updateMorph(dt) {
  const d = P.looks.drive;
  if (d === 'hand') return;
  let target = 0;
  if (d === 'lfo') target = 0.5 - 0.5 * Math.cos((2 * Math.PI * state.simTime) / 16);
  else if (d[0] === 'v') target = bands.level[+d.slice(1)] || 0;
  state.voiceMorph += (target - state.voiceMorph) * (1 - Math.exp(-dt / (d === 'lfo' ? 0.05 : 0.8)));
  P.looks.morph = Math.min(1, Math.max(0, state.voiceMorph));
}

// ── Scenes ──────────────────────────────────────────────────────────────────
function snapshot() {
  const s = header();
  for (const g of SAVED_GROUPS()) s[g] = JSON.parse(JSON.stringify(P[g]));
  s.view = { pos: stage.camera.position.toArray(), target: stage.controls.target.toArray() };
  const { preview, ...looks } = P.looks;                 // preview is an audition, never saved
  s.looks = { ...looks, lookA: cloneLook(app.lookA), lookB: cloneLook(app.lookB) };
  return s;
}
function applyScene(input, { fly = true } = {}) {
  const s = migrate(input);
  if (!s) return false;
  const spawnBefore = JSON.stringify(P.spawn);
  for (const g of SAVED_GROUPS()) assignGroup(P[g], s[g]);
  if (s.looks) {
    for (const k of ['a', 'b', 'morph', 'drive', 'edit']) if (typeof s.looks[k] === typeof P.looks[k]) P.looks[k] = s.looks[k];
    Object.assign(app.lookA, sanitizeLook(s.looks.lookA, app.lookA));
    Object.assign(app.lookB, sanitizeLook(s.looks.lookB, app.lookB));
    state.voiceMorph = P.looks.morph;
  }
  validate();
  if (JSON.stringify(P.spawn) !== spawnBefore) app.rebuild();
  if (s.view?.pos && s.view?.target && [...s.view.pos, ...s.view.target].every(Number.isFinite)) {
    const to = { pos: new THREE.Vector3(...s.view.pos), target: new THREE.Vector3(...s.view.target) };
    if (fly) stage.flight = { from: { pos: stage.camera.position.clone(), target: stage.controls.target.clone() }, to, t: 0 };
    else { stage.camera.position.copy(to.pos); stage.controls.target.copy(to.target); stage.controls.update(); }
  }
  stage.resize(innerWidth, innerHeight);
  panel?.refresh();
  return true;
}
// Saved per-track scenes are migrated once at load; re-saving writes the new schema.
for (const [name, sc] of Object.entries(app.scenes)) { const m = migrate(sc); if (m) app.scenes[name] = m; else delete app.scenes[name]; }
let saveTimer = 0;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('lp.current', snapshot()), 400); }

app.rebuild = () => { field.build(P.spawn); app.stats.tiles = field.layout.count; sparks.clear(); autosave(); };
app.resize = () => { stage.resize(innerWidth, innerHeight); meters.resize(); };
app.exportScene = () => {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const base = library.active ? library.active.name : 'scene';
  a.href = URL.createObjectURL(blob); a.download = `living-particles_${base.replace(/[^\w.-]+/g, '_')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
app.importScene = () => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => { try { applyScene(JSON.parse(await inp.files[0].text())); autosave(); } catch (e) { console.error('[scene] import failed', e); } };
  inp.click();
};
app.resetScene = () => {
  store.del('lp.current');
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  applyScene({ ...d, looks: { ...d.looks, lookA: LOOKS[d.looks.a], lookB: LOOKS[d.looks.b] } }, { fly: false });
  stage.goTo('stand');
};

// ── Library + transport ─────────────────────────────────────────────────────
const library = new Library({
  list: $('tracks'), empty: $('emptyNote'), sources,
  hasScene: name => !!app.scenes[name],
  onSelect: async t => {
    await sources.useTrack(t.id, t.name, t.buffer);
    sources.setLoop($('loopChk').checked);
    if ($('recallChk').checked && app.scenes[t.name]) applyScene(app.scenes[t.name]);
    state.running = true; clock.reset();
    sources.play();
    setSourceButtons();
  },
});
library.onRemovedActive = () => { sources.useTest(); setSourceButtons(); };
sources.onEnded = () => {
  const n = library.tracks.length > 1 ? library.next() : null;
  if (n) library.select(n.id); else { state.running = false; setSourceButtons(); }
};

function setSourceButtons() {
  document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === sources.mode)));
  document.querySelector('[data-source="track"]').disabled = !library.active;
  $('saveSceneBtn').disabled = !(sources.mode === 'track' && library.active);
  $('playBtn').textContent = state.running ? 'Pause' : 'Play';
  const np = $('nowPlaying');
  if (sources.mode === 'track' && library.active) np.textContent = library.active.name + (sources.ctx?.state === 'suspended' ? ' · press Play to hear it' : '');
  else if (sources.mode === 'mic') np.textContent = 'Microphone · live';
  else np.textContent = 'Test signal · eight voices in polyrhythm';
}

document.querySelectorAll('[data-source]').forEach(btn => btn.addEventListener('click', async () => {
  const s = btn.dataset.source;
  try {
    if (s === 'test') sources.useTest();
    else if (s === 'mic') await sources.useMic();
    else if (s === 'track' && library.active) await library.select(library.active.id);
    state.running = true; clock.reset();
  } catch (e) {
    console.warn('[source]', e);
    $('nowPlaying').textContent = s === 'mic' ? 'Microphone not available (permission denied?)' : 'Could not switch source';
    return;
  }
  setSourceButtons();
}));

function togglePlay() {
  state.running = !state.running; clock.reset();
  if (sources.mode === 'track') { state.running ? sources.play() : sources.pause(); }
  sources.ctx?.resume?.();
  setSourceButtons();
}
$('playBtn').addEventListener('click', togglePlay);
$('restartBtn').addEventListener('click', () => app.restart());
$('loopChk').addEventListener('change', e => sources.setLoop(e.target.checked));
$('rememberChk').addEventListener('change', e => { library.remember = e.target.checked; });
$('saveSceneBtn').addEventListener('click', () => {
  const t = library.active; if (!t) return;
  app.scenes[t.name] = snapshot(); store.set('lp.scenes', app.scenes);
  library.render();
  $('saveSceneBtn').textContent = 'Saved ✓';
  setTimeout(() => { $('saveSceneBtn').textContent = 'Save scene to this track'; }, 1400);
});
app.restart = () => { sources.seekStart(); clearBands(); sparks.clear(); sparks.reseed(P.spawn.seed); state.simTime = 0; clock.reset(); };
app.fireHit = () => fireManualHit(P.manual.voice);

// Files: the drop zone, the whole window, and the file picker.
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

// ── Panels, camera, keys ────────────────────────────────────────────────────
panel = buildPanel($('pane'), app);
panel.pane.on('change', () => autosave());

const narrow = () => matchMedia('(max-width: 640px)').matches;
const setOpen = (btn, el, open) => { el.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
const toggle = (btn, el) => {
  const open = el.hidden;
  if (open && narrow()) {                         // phones: one sheet at a time
    setOpen($('libBtn'), $('library'), false); setOpen($('paneBtn'), $('paneWrap'), false);
  }
  setOpen(btn, el, open);
};
if (matchMedia('(max-width: 1100px)').matches) setOpen($('libBtn'), $('library'), false);
if (narrow()) setOpen($('paneBtn'), $('paneWrap'), false);
$('libBtn').addEventListener('click', () => toggle($('libBtn'), $('library')));
$('paneBtn').addEventListener('click', () => toggle($('paneBtn'), $('paneWrap')));
$('hideBtn').addEventListener('click', () => document.body.classList.toggle('perform'));
function goTo(name) {
  stage.goTo(name);
  document.querySelectorAll('[data-cam]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cam === name)));
}
document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.cam)));
stage.controls.addEventListener('start', () => document.querySelectorAll('[data-cam]').forEach(b => b.setAttribute('aria-pressed', 'false')));
stage.controls.addEventListener('end', autosave);

addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'h' || (k === 'escape' && document.body.classList.contains('perform'))) document.body.classList.toggle('perform');
  else if (k === 'l') toggle($('libBtn'), $('library'));
  else if (k === 'p') toggle($('paneBtn'), $('paneWrap'));
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

function frame(now) {
  requestAnimationFrame(frame);
  const dt = last == null ? 0 : Math.max(0, (now - last) / 1000); last = now;
  if (state.running) { const n = clock.advance(dt); for (let i = 0; i < n; i++) simStep(); }
  if (state.skipDraw) return;          // headless timing checks only
  draw(dt);
  frameNo++;
  fpsT += dt; fpsN++;
  if (fpsT >= 0.5) { app.stats.fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  if (frameNo % 6 === 0) {
    const pos = sources.position(), dur = sources.duration;
    $('progBar').style.width = dur ? `${(100 * pos / dur).toFixed(2)}%` : '0%';
    $('timeLine').textContent = sources.mode === 'track' ? `${fmt(pos)} / ${fmt(dur)}` : sources.mode === 'test' ? `${fmt(pos)} · built-in` : 'live';
    if (P.looks.drive !== 'hand') panel.refreshMorph();
  }
  if (frameNo % 30 === 0) {
    sparks.countAlive(state.simTime);
    app.stats.sparks = sparks.alive;
    accentHex.copy(app.mixed.rim).convertLinearToSRGB();
    document.documentElement.style.setProperty('--accent', '#' + accentHex.getHexString());
  }
}

function draw(dt) {
  updateMorph(dt);
  mixLooks(app.lookA, app.lookB, P.looks.morph, app.mixed);
  stage.update(dt, app.mixed, state.simTime);
  field.sync(app.mixed, state.simTime, stage.affector);
  sparks.sync(app.mixed, state.simTime, stage.pixelScale);
  renderer.info.reset();
  stage.render();
  app.stats.calls = renderer.info.render.calls; app.stats.tris = renderer.info.render.triangles;
  meters.setPalette(app.mixed);
  meters.draw();
}

// ── Boot ────────────────────────────────────────────────────────────────────
const saved = store.get('lp.current', null);
if (saved) applyScene(saved, { fly: false });
app.resize();
addEventListener('resize', app.resize);
library.init().then(setSourceButtons);
setSourceButtons();
requestAnimationFrame(frame);

// Hooks for the headless checks in tools/.
window.__lp = {
  state, P, app, bands, field, sparks, stage, sources, library,
  stepSim(n) { for (let i = 0; i < n; i++) simStep(); },
  draw(dt = 1 / 60) { draw(dt); },
  restart: () => app.restart(),
  goTo(name) { stage.goTo(name, true); },
  applyScene, snapshot,
  voices: VOICE_NAMES, NB,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Living Particles · Study 01 · Hex Field — precision pass
//
//  SOURCE    pattern / track (precise, analysed ahead) · mic / stress (live, basic)
//  TIMELINE  musical time → feature frames → gate + level → per-destination envelopes
//            → history rows (9 × 512); hit events → flashes and finite spark budgets
//  FIELD     ~7.5k instanced hex prisms read the history at their own ripple delay
//  LOOK      two editable looks, previewed alone or mixed by a fader, an LFO or a voice
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { P, VERSION, NB, VOICE_NAMES, FFT_SIZE, LOW_FFT_SIZE } from './params.js';
import { LOOKS, cloneLook, mixLooks, sanitizeLook } from './looks.js';
import { FixedClock, SIM_DT } from './clock.js';
import { Sources } from './audio.js';
import { response, historySeconds, histAt } from './response.js';
import { Timeline } from './timeline.js';
import { ANALYSIS_VERSION } from './analysis/features.js';
import { renderPattern } from './analysis/pattern.js';
import { HexField } from './world/hexfield.js';
import { Sparks } from './world/sparks.js';
import { Stage } from './world/stage.js';
import { Meters } from './ui/meters.js';
import { Library, fmt } from './ui/library.js';
import { buildPanel } from './ui/panel.js';
import { buildStrip } from './ui/strip.js';
import { SAVED_GROUPS, migrate, assignGroup, validate, header } from './scene.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const DEFAULTS = JSON.parse(JSON.stringify(P));

// ── State ───────────────────────────────────────────────────────────────────
let panel = null, strip = null;
const state = { running: true, voiceMorph: 0, visualTime: 0, analysis: 'idle', progress: 0, lastT: 0 };
const app = {
  lookA: cloneLook(LOOKS[P.looks.a]), lookB: cloneLook(LOOKS[P.looks.b]),
  mixed: {},
  userLooks: Object.fromEntries(Object.entries(store.get('lp.looks', {})).map(([k, l]) => [k, sanitizeLook(l, LOOKS.av2)])),
  scenes: store.get('lp.scenes', {}),
  stats: { tiles: 0, sparks: 0, dropped: 0, fps: 0, calls: 0, tris: 0, frameMs: 0 },
  ui: { saveName: 'my look' },
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
  panel?.refresh(); strip?.refresh();
  return true;
}
for (const [name, sc] of Object.entries(app.scenes)) { const m = migrate(sc); if (m) app.scenes[name] = m; else delete app.scenes[name]; }
let saveTimer = 0;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('lp.current', snapshot()), 400); }
app.autosave = autosave;
app.validate = () => { validate(); };

app.rebuild = () => { field.build(P.floor); app.stats.tiles = field.layout.count; sparks.clear(); autosave(); };
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
  inp.onchange = async () => {
    try { if (applyScene(JSON.parse(await inp.files[0].text()))) autosave(); }
    catch (e) { console.error('[scene] import failed', e); }
  };
  inp.click();
};
app.resetScene = () => {
  store.del('lp.current');
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  applyScene({ ...header(), ...d, looks: { ...d.looks, lookA: LOOKS[d.looks.a], lookB: LOOKS[d.looks.b] } }, { fly: false });
  stage.goTo('stand');
};
app.resetGroup = g => {
  const floorBefore = JSON.stringify(P.floor);
  assignGroup(P[g], JSON.parse(JSON.stringify(DEFAULTS[g])));
  validate();
  if (g === 'floor' && JSON.stringify(P.floor) !== floorBefore) app.rebuild();
  if (g === 'music') app.redetect();
  panel?.refresh(); strip?.refresh(); autosave();
};
app.restoreSaved = () => { if (app.lastSaved) applyScene(app.lastSaved); };
app.snapshot = snapshot;

// ── Library + transport ─────────────────────────────────────────────────────
const library = new Library({
  list: $('tracks'), empty: $('emptyNote'), sources,
  hasScene: name => !!app.scenes[name],
  onSelect: async t => {
    if ($('recallChk').checked && app.scenes[t.name]) { applyScene(app.scenes[t.name]); app.lastSaved = app.scenes[t.name]; }
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
  const np = $('nowPlaying');
  np.textContent = sourceLabel() + (sources.silent && sources.buffered ? ' · click anywhere for sound' : '');
}
function setSourceButtons() {
  document.querySelectorAll('[data-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.source === sources.mode)));
  document.querySelector('[data-source="track"]').disabled = !library.active;
  $('saveSceneBtn').disabled = !(sources.mode === 'track' && library.active);
  $('playBtn').textContent = state.running ? 'Pause' : 'Play';
  strip?.setPlaying(state.running);
  updateStatus();
}

document.querySelectorAll('[data-source]').forEach(btn => btn.addEventListener('click', async () => {
  const s = btn.dataset.source;
  try {
    state.running = true; clock.reset();
    if (s === 'pattern') await usePattern();
    else if (s === 'stress') { sources.useStress(); current.buffer = null; current.key = null; timeline.setLive(48000, FFT_SIZE, null); }
    else if (s === 'mic') { await sources.useMic(); current.buffer = null; current.key = null; timeline.setLive(sources.sampleRate, FFT_SIZE, LOW_FFT_SIZE); }
    else if (s === 'track' && library.active) await library.select(library.active.id);
  } catch (e) {
    console.warn('[source]', e);
    $('nowPlaying').textContent = s === 'mic' ? 'Microphone not available (permission denied?)' : 'Could not switch source';
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
app.fireHit = () => timeline.fireManual(P.manual.voice);
$('playBtn').addEventListener('click', togglePlay);
$('restartBtn').addEventListener('click', () => app.restart());
$('loopChk').addEventListener('change', e => { sources.setLoop(e.target.checked); timeline.setLoop(e.target.checked); });
$('rememberChk').addEventListener('change', e => { library.remember = e.target.checked; });
$('saveSceneBtn').addEventListener('click', () => {
  const t = library.active; if (!t) return;
  app.scenes[t.name] = snapshot(); app.lastSaved = app.scenes[t.name]; store.set('lp.scenes', app.scenes);
  library.render();
  $('saveSceneBtn').textContent = 'Saved ✓';
  setTimeout(() => { $('saveSceneBtn').textContent = 'Save scene to this track'; }, 1400);
});

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
app.timeline = timeline; app.sources = sources; app.response = response; app.sparks = sparks; app.field = field;
panel = buildPanel($('pane'), app);
strip = buildStrip($('strip'), app);

const narrow = () => matchMedia('(max-width: 640px)').matches;
const setOpen = (btn, el, open) => { el.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
const toggle = (btn, el) => {
  const open = el.hidden;
  if (open && narrow()) { setOpen($('libBtn'), $('library'), false); setOpen($('paneBtn'), $('paneWrap'), false); }
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
  if (e.target.closest?.('input, textarea, select, [contenteditable], .tp-rotv')) return;
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
  if (state.skipDraw) return;
  draw(dt, timing);
  frameNo++;
  fpsT += dt; fpsN++;
  frameTimes[ftI++ % frameTimes.length] = performance.now() - t0;
  if (fpsT >= 0.5) { app.stats.fps = fpsN / fpsT; fpsT = 0; fpsN = 0; }
  if (frameNo % 6 === 0) {
    const pos = sources.position(), dur = sources.duration;
    $('progBar').style.width = dur ? `${(100 * pos / dur).toFixed(2)}%` : '0%';
    $('timeLine').textContent = sources.buffered ? `${fmt(pos)} / ${fmt(dur)}` : sources.mode === 'mic' ? 'live' : `${fmt(pos)} · stress test`;
    if (P.looks.drive !== 'hand') panel.refreshMorph();
    panel.tick(); strip.tick();
  }
  if (frameNo % 30 === 0) {
    sparks.countAlive(state.visualTime);
    app.stats.sparks = sparks.stats.alive; app.stats.dropped = sparks.stats.dropped;
    accentHex.copy(app.mixed.rim).convertLinearToSRGB();
    document.documentElement.style.setProperty('--accent', '#' + accentHex.getHexString());
    updateStatus();
  }
}

function draw(dt, timing) {
  updateMorph(dt);
  mixLooks(app.lookA, app.lookB, app.effectiveMorph(), app.mixed);
  stage.update(dt, app.mixed, state.visualTime);
  field.sync(app.mixed, state.visualTime, stage.affector, timing);
  sparks.sync(app.mixed, state.visualTime, stage.pixelScale);
  renderer.info.reset();
  stage.render();
  app.stats.calls = renderer.info.render.calls; app.stats.tris = renderer.info.render.triangles;
  meters.setPalette(app.mixed);
  meters.draw(app, timeline);
}

// ── Boot ────────────────────────────────────────────────────────────────────
const saved = store.get('lp.current', null);
if (saved) applyScene(saved, { fly: false });
app.resize();
addEventListener('resize', app.resize);
library.init().then(setSourceButtons);
usePattern();
setSourceButtons();
requestAnimationFrame(frame);

// Hooks for the headless checks in tools/.
window.__lp = {
  state, P, app, response, timeline, field, sparks, stage, sources, library, worker, histAt,
  draw(dt = 1 / 60) { draw(dt, advance(0)); },
  advance, restart: () => app.restart(),
  goTo(name) { stage.goTo(name, true); },
  applyScene, snapshot, analyse, usePattern, startBuffered,
  ready: () => timeline.mode === 'precise',
  frameTimes: () => Array.from(frameTimes),
  voices: VOICE_NAMES, NB, VERSION,
  historySeconds: () => historySeconds(timeline.rowHz),
};

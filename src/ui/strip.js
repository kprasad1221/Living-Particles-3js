// ─────────────────────────────────────────────────────────────────────────────
//  Performance strip: what you reach for while the music plays. Each control is
//  scoped to exactly one thing (shown in its tooltip):
//    Movement     × maximum lift                 Glow         × glow amount (bloom strength)
//    Sparks       × particles per hit and /s     Sensitivity  the inspected mapping's sensitivity
// ─────────────────────────────────────────────────────────────────────────────
import { P } from '../params.js';
import { formatValue, parseValue } from './kit.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const DEST_NAMES = { lift: 'Floor lift', rim: 'Rim breath', hits: 'Hits', colour: 'Colour drift' };

export function buildStrip(container, app) {
  container.textContent = '';
  const play = h('button', 's-btn', 'Pause'); play.type = 'button'; play.title = 'Play / pause (Space)';
  const restart = h('button', 's-btn', '⟲'); restart.type = 'button'; restart.title = 'Restart (R)'; restart.setAttribute('aria-label', 'Restart');
  play.addEventListener('click', () => app.togglePlay());
  restart.addEventListener('click', () => app.restart());
  const scene = h('span', 's-scene'); scene.title = 'Current source';
  const seg = h('div', 's-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Preview');
  const segBtns = [['A', 'a'], ['Mix', 'mix'], ['B', 'b']].map(([l, v]) => {
    const b = h('button', null, l); b.type = 'button'; b.title = v === 'mix' ? 'Show the A/B mix' : `Audition look ${l} alone (not saved)`;
    b.addEventListener('click', () => { P.looks.preview = v; refresh(); app.autosave(); }); seg.append(b); return [b, v];
  });
  const sliders = [];
  const knob = (label, get, set, o) => {
    const w = h('label', 's-knob'); w.title = o.tip;
    const l = h('span', 's-label', label), r = h('input'), v = h('input', 's-val');
    r.type = 'range'; r.min = o.min; r.max = o.max; r.step = o.step; r.setAttribute('aria-label', label);
    v.type = 'text'; v.setAttribute('aria-label', `${label} value`);
    r.addEventListener('input', () => { set(+r.value); upd(); });
    r.addEventListener('change', () => app.autosave());
    v.addEventListener('change', () => {
      const x = o.parse ? o.parse(v.value) : parseValue(v.value, o.unit);
      if (Number.isFinite(x)) set(Math.min(o.max, Math.max(o.min, x))); upd(); app.autosave();
    });
    const upd = () => { r.value = get(); if (document.activeElement !== v) v.value = o.fmt ? o.fmt() : formatValue(get(), o.unit, 2); if (o.label) l.textContent = o.label(); };
    w.append(l, r, v); sliders.push(upd); upd();
    return w;
  };
  const mix = knob('A → B', () => P.looks.morph, x => { P.looks.morph = x; P.looks.preview = 'mix'; }, { min: 0, max: 1, step: 0.001, unit: '%', tip: 'Mix between look A and look B.' });
  const mov = knob('Movement', () => P.macros.movement, x => { P.macros.movement = x; }, { min: 0, max: 2, step: 0.01, unit: '×', tip: 'Scales maximum lift only.' });
  const spk = knob('Sparks', () => P.macros.sparks, x => { P.macros.sparks = x; }, { min: 0, max: 3, step: 0.01, unit: '×', tip: 'Scales particles per hit and continuous emission only.' });
  const glw = knob('Glow', () => P.macros.glow, x => { P.macros.glow = x; }, { min: 0, max: 3, step: 0.01, unit: '×', tip: 'Scales glow amount (bloom strength) only.' });
  // Sensitivity of the inspected mapping, on one 0–1 knob: mappings are log 0.1×–8×, hits are 0–10.
  const isHits = () => P.inspect.dest === 'hits';
  const toN = v => (isHits() ? v / 10 : Math.log(v / 0.1) / Math.log(80));
  const fromN = n => (isHits() ? n * 10 : 0.1 * Math.pow(80, n));
  const sensVal = () => (isHits() ? P.music.hitSensitivity : P.map[P.inspect.dest].sensitivity);
  const sens = knob('Sensitivity', () => toN(sensVal()), n => {
    if (isHits()) { P.music.hitSensitivity = +fromN(n).toFixed(2); app.redetect(); }
    else P.map[P.inspect.dest].sensitivity = +fromN(n).toFixed(3);
  }, { min: 0, max: 1, step: 0.001, tip: 'Sensitivity of the mapping inspected in Music response (hits: the detector’s 0–10).',
    label: () => `Sens · ${DEST_NAMES[P.inspect.dest]}`,
    fmt: () => (isHits() ? sensVal().toFixed(1) : `${sensVal().toFixed(2)}×`),
    parse: t => { const x = parseFloat(t); return Number.isFinite(x) ? toN(Math.max(isHits() ? 0 : 0.1, x)) : NaN; } });
  const group = h('div', 's-group'); group.append(play, restart, scene);
  const group2 = h('div', 's-group'); group2.append(seg, mix);
  const group3 = h('div', 's-group'); group3.append(mov, spk, glw, sens);
  container.append(group, group2, group3);

  const refresh = () => { for (const [b, v] of segBtns) b.setAttribute('aria-pressed', String(P.looks.preview === v)); for (const u of sliders) u(); };
  refresh();
  return {
    refresh,
    setPlaying(on) { play.textContent = on ? 'Pause' : 'Play'; },
    tick() {
      const s = app.sources;
      scene.textContent = s.mode === 'track' ? (s.trackName || 'Track') : s.mode === 'pattern' ? 'Test pattern' : s.mode === 'mic' ? 'Microphone' : 'Stress test';
      refresh();
    },
  };
}

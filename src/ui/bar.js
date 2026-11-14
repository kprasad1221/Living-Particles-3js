// ─────────────────────────────────────────────────────────────────────────────
//  The bar: the one place for what you reach for while the music plays.
//
//    Source      what is playing and how it is analysed (opens Music) · play · restart · loop · time
//    Scene       which scene · changed since it was loaded? · revert · save
//    Look        audition A, the mix, or B · the mix fader
//    Macros      three, each scaling exactly one thing (its tooltip says which, and what it leaves alone):
//                  Movement   × maximum lift
//                  Activity   × particle budgets (sparks per hit, continuous sparks, plume particles)
//                  Light      × the light the tiles give off (emission); glow is separate, in Edit › Light
//    View        Edit (the editor, one family at a time) · Hide (everything, for watching)
//
//  There is one transport and one A / Mix / B. The editor and the Music drawer do not repeat them.
// ─────────────────────────────────────────────────────────────────────────────
import { P } from '../params.js';
import { formatValue, parseValue } from './kit.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (cls, text, title, label) => { const b = h('button', cls, text); b.type = 'button'; if (title) b.title = title; if (label) b.setAttribute('aria-label', label); return b; };

export function buildBar(container, app) {
  container.textContent = '';

  // ── Source and transport ───────────────────────────────────────────────────
  const source = btn('b-source', null, 'Choose what plays: test pattern, a track, the microphone (L)');
  source.id = 'sourceBtn'; source.setAttribute('aria-expanded', 'false'); source.setAttribute('aria-controls', 'library');
  const dot = h('span', 'b-dot'), now = h('span', 'b-now', 'Test pattern'); now.id = 'nowPlaying';
  source.append(dot, now, h('span', 'b-caret', '▾'));
  source.addEventListener('click', () => app.toggleLibrary());
  const play = btn('b-btn b-play', 'Pause', 'Play / pause (Space)'); play.id = 'playBtn';
  const restart = btn('b-btn b-icon', '⟲', 'Restart from the top (R)', 'Restart'); restart.id = 'restartBtn';
  play.addEventListener('click', () => app.togglePlay());
  restart.addEventListener('click', () => app.restart());
  const loopL = h('label', 'b-check'); loopL.title = 'Loop the source';
  const loop = h('input'); loop.type = 'checkbox'; loop.id = 'loopChk'; loop.checked = true;
  loop.addEventListener('change', () => app.setLoop(loop.checked));
  loopL.append(loop, h('span', null, 'Loop'));
  const time = h('span', 'b-time', '—'); time.id = 'timeLine';
  const gSource = h('div', 'b-group b-g-source'); gSource.append(source, play, restart, loopL, time);

  // ── Scene ──────────────────────────────────────────────────────────────────
  const sceneSel = h('select', 'b-select'); sceneSel.id = 'sceneSel'; sceneSel.setAttribute('aria-label', 'Scene');
  sceneSel.title = 'Scene: every control, both looks and the camera';
  // Revert lights up (with a dot) once anything differs from the scene as loaded or last saved.
  const revert = btn('b-btn b-revert', 'Revert', 'Nothing has changed since this scene was loaded or saved'); revert.id = 'revertBtn';
  const save = btn('b-btn', 'Save…', 'Save this scene, export or import a file'); save.id = 'saveBtn'; save.setAttribute('aria-expanded', 'false'); save.setAttribute('aria-controls', 'savePop');
  revert.addEventListener('click', () => { app.revertScene(); refresh(); });
  sceneSel.addEventListener('change', () => { app.loadSceneRef(sceneSel.value); sceneSel.blur(); refresh(); });
  const gScene = h('div', 'b-group b-g-scene'); gScene.append(sceneSel, revert, save);

  // Save popover
  const pop = h('div', 'b-pop'); pop.id = 'savePop'; pop.hidden = true; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Save scene');
  const nameRow = h('label', 'b-poprow'); const nameIn = h('input', 'b-text'); nameIn.type = 'text'; nameIn.id = 'sceneName'; nameIn.maxLength = 60; nameIn.spellcheck = false;
  nameRow.append(h('span', null, 'Name'), nameIn);
  const saveNamed = btn('b-btn wide primary', 'Save as a named scene', 'Stored in this browser; appears under Saved in the scene list'); saveNamed.id = 'saveNamedBtn';
  const saveTrack = btn('b-btn wide', 'Save with this track', 'Stored with the playing track; recalled when that track starts (Music › Recall)'); saveTrack.id = 'saveSceneBtn';
  const del = btn('b-btn wide', 'Delete this saved scene', 'Removes the named scene from this browser'); del.id = 'deleteSceneBtn';
  const files = h('div', 'b-poprow2');
  const exp = btn('b-btn', 'Export JSON', 'Download this scene as a file'), imp = btn('b-btn', 'Import JSON', 'Checked on import: unknown keys ignored, numbers must be finite, ranges enforced');
  exp.id = 'exportBtn'; imp.id = 'importBtn';
  files.append(exp, imp);
  const resetAll = btn('b-btn wide', 'Reset everything to defaults', 'Tracks, saved looks and saved scenes are kept'); resetAll.id = 'resetAllBtn';
  const status = h('p', 'b-status'); status.id = 'sceneStatus'; status.setAttribute('role', 'status');
  pop.append(nameRow, saveNamed, saveTrack, del, files, resetAll, status);
  const openPop = on => {
    pop.hidden = !on; save.setAttribute('aria-expanded', String(on));
    if (on) { const s = app.sceneState(); nameIn.value = s.suggestedName; refresh(); nameIn.focus(); nameIn.select(); }
  };
  save.addEventListener('click', () => openPop(pop.hidden));
  const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };
  const doSaveNamed = () => { const r = app.saveNamedScene(nameIn.value); say(r.ok ? `Saved “${r.name}” ✓` : r.message, !r.ok); refresh(); };
  saveNamed.addEventListener('click', doSaveNamed);
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSaveNamed(); } });
  saveTrack.addEventListener('click', () => { const r = app.saveTrackScene(); say(r.ok ? `Saved with “${r.name}” ✓` : r.message, !r.ok); refresh(); });
  del.addEventListener('click', () => { const r = app.deleteNamedScene(); say(r.ok ? `Deleted “${r.name}”` : r.message, !r.ok); refresh(); });
  exp.addEventListener('click', () => { app.exportScene(); say('Exported'); });
  imp.addEventListener('click', () => app.importScene(r => { say(r.ok ? 'Imported ✓' : r.message, !r.ok); refresh(); }));
  resetAll.addEventListener('click', () => { app.resetScene(); say('Back to defaults'); refresh(); });

  // ── Look mix ───────────────────────────────────────────────────────────────
  const seg = h('div', 'b-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Preview');
  const segBtns = [['A', 'a'], ['Mix', 'mix'], ['B', 'b']].map(([l, v]) => {
    const b = btn(null, l, v === 'mix' ? 'Show the A/B mix' : `Audition look ${l} alone (not saved)`);
    b.addEventListener('click', () => { P.looks.preview = v; refresh(); app.autosave(); }); seg.append(b); return [b, v];
  });
  const sliders = [];
  const knob = (id, label, get, set, o) => {
    const w = h('label', 's-knob'); w.title = o.tip;
    const l = h('span', 's-label', label), r = h('input'), v = h('input', 's-val');
    r.type = 'range'; r.min = o.min; r.max = o.max; r.step = o.step; r.id = id; r.setAttribute('aria-label', label);
    v.type = 'text'; v.setAttribute('aria-label', `${label} value`); v.inputMode = 'decimal'; v.spellcheck = false;
    r.addEventListener('input', () => { set(+r.value); upd(); });
    r.addEventListener('change', () => app.autosave());
    r.addEventListener('dblclick', () => { set(o.def); upd(); app.autosave(); });
    v.addEventListener('change', () => { const x = parseValue(v.value, o.unit); if (Number.isFinite(x)) set(Math.min(o.max, Math.max(o.min, x))); upd(); app.autosave(); });
    v.addEventListener('keydown', e => { if (e.key === 'Enter') v.blur(); });
    const upd = () => { r.value = get(); if (document.activeElement !== v) v.value = formatValue(get(), o.unit, 2); };
    w.append(l, r, v); sliders.push(upd); upd();
    return w;
  };
  const mix = knob('mixKnob', 'A → B', () => P.looks.morph, x => { P.looks.morph = x; P.looks.preview = 'mix'; },
    { min: 0, max: 1, step: 0.001, unit: '%', def: 0, tip: 'Mix between look A and look B. Double-click to reset.' });
  const gLook = h('div', 'b-group b-g-look'); gLook.append(seg, mix);

  // ── Macros ─────────────────────────────────────────────────────────────────
  const gMacro = h('div', 'b-group b-g-macros');
  gMacro.append(
    knob('macroMovement', 'Movement', () => P.macros.movement, x => { P.macros.movement = x; },
      { min: 0, max: 2, step: 0.01, unit: '×', def: 1, tip: 'Movement: × maximum lift only. Leaves the analysis, timing and ripple alone. Double-click to reset.' }),
    knob('macroActivity', 'Activity', () => P.macros.sparks, x => { P.macros.sparks = x; },
      { min: 0, max: 3, step: 0.01, unit: '×', def: 1, tip: 'Activity: × particle budgets only (sparks per hit, continuous sparks, plume particles). Does not change what the music measures or how many tiles answer.' }),
    knob('macroLight', 'Light', () => P.macros.light, x => { P.macros.light = x; },
      { min: 0, max: 2, step: 0.01, unit: '×', def: 1, tip: 'Light: × the light the tiles give off (emission) only. Glow (bloom) is a separate control in Edit › Light.' }),
  );

  // ── View ───────────────────────────────────────────────────────────────────
  const edit = btn('b-btn', 'Edit', 'Open the editor, one family at a time (E)'); edit.id = 'editBtn'; edit.setAttribute('aria-pressed', 'false'); edit.setAttribute('aria-controls', 'paneWrap');
  const hide = btn('b-btn', 'Hide', 'Hide every control and watch (H). H or Esc brings them back.'); hide.id = 'hideBtn';
  edit.addEventListener('click', () => app.setMode(app.ui.mode === 'edit' ? 'perform' : 'edit'));
  hide.addEventListener('click', () => app.setHidden(true));
  const gView = h('div', 'b-group b-g-view'); gView.append(edit, hide);

  const prog = h('div', 'b-progress'); prog.setAttribute('aria-hidden', 'true'); const progBar = h('div'); progBar.id = 'progBar'; prog.append(progBar);
  // On a phone the groups dissolve into rows (see styles.css): this zero-height item starts the knob row.
  const brk = h('span', 'b-break'); brk.setAttribute('aria-hidden', 'true');
  container.append(gSource, gScene, gLook, gMacro, gView, brk, prog, pop);

  // Close the popover on an outside press or Escape.
  addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== save) openPop(false); });
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); openPop(false); save.focus(); } });

  let listKey = '';
  const fillScenes = () => {
    const list = app.sceneList(), key = JSON.stringify(list);
    if (key !== listKey) {
      listKey = key; sceneSel.textContent = '';
      for (const g of list) {
        if (!g.items.length) continue;
        const og = document.createElement('optgroup'); og.label = g.label;
        for (const it of g.items) { const o = h('option', null, it.label); o.value = it.ref; og.append(o); }
        sceneSel.append(og);
      }
    }
    const s = app.sceneState();
    if (document.activeElement !== sceneSel) sceneSel.value = s.ref;
    if (sceneSel.selectedIndex < 0) sceneSel.value = '';
    revert.disabled = !s.modified; revert.classList.toggle('on', s.modified);
    revert.title = s.modified ? 'Edited. Put every control back to the scene as loaded or last saved.' : 'Nothing has changed since this scene was loaded or saved';
    saveTrack.disabled = !s.trackName; saveTrack.textContent = s.trackName ? `Save with the track “${s.trackName}”` : 'Save with this track (no track playing)';
    del.hidden = !s.ref.startsWith('user:');
  };
  const refresh = () => {
    for (const [b, v] of segBtns) b.setAttribute('aria-pressed', String(P.looks.preview === v));
    for (const u of sliders) u();
    fillScenes();
    edit.setAttribute('aria-pressed', String(app.ui.mode === 'edit'));
    loop.checked = app.sources.loop;
  };
  refresh();
  return {
    refresh,
    setPlaying(on) { play.textContent = on ? 'Pause' : 'Play'; play.setAttribute('aria-pressed', String(on)); },
    setLibraryOpen(on) { source.setAttribute('aria-expanded', String(on)); },
    setSource(text, state) { now.textContent = text; source.dataset.state = state; },
    setTime(text, frac) { time.textContent = text; progBar.style.width = `${(100 * frac).toFixed(2)}%`; },
    say, closePopover() { if (pop.hidden) return false; openPop(false); return true; },
    tick: refresh,
  };
}

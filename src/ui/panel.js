// ─────────────────────────────────────────────────────────────────────────────
//  The editor: grouped by what you change, not by engine stage.
//
//    Looks · A / B       which looks, what you are previewing, how they mix
//    Light               the look being edited: primary controls, colours, precision
//    Floor               field size, spacing, resting height, active tiles
//    Movement            lift, rise and fall, ripple
//    Sparks              particles per hit, continuous, launch, lifetime
//    Music response      one mapping at a time (source → destination) + the analysis itself
//    Pointer and camera
//    Scenes and performance
//
//  Double-click any label (or press ↺) to reset that control. Group "reset" buttons reset
//  only their group; tracks and saved looks are never touched. VFX Graph / TouchDesigner
//  equivalents live in the README, not in the labels.
// ─────────────────────────────────────────────────────────────────────────────
import { P, VOICE_NAMES, HIST } from '../params.js';
import { LOOKS, LOOK_ORDER } from '../looks.js';
import { Kit } from './kit.js';

const VOICES = VOICE_NAMES.map((n, i) => [n, i]);
const DEST = [['Floor lift', 'lift'], ['Rim breath', 'rim'], ['Hits (accent + flash)', 'hits'], ['Colour drift', 'colour']];
const pctOf = x => `${Math.round(x * 100)} %`;

export function buildPanel(container, app) {
  container.textContent = '';
  const D = app.defaults;
  const kit = new Kit((key, commit) => { app.validate(); if (commit) app.autosave(); });
  const root = document.createElement('div'); root.className = 'k-root'; container.append(root);
  const head = document.createElement('div'); head.className = 'k-head';
  head.innerHTML = '<span>Editor</span><span class="k-hint">double-click a label to reset it</span>';
  root.append(head);

  // ── Looks ──────────────────────────────────────────────────────────────────
  const looks = kit.folder(root, 'Looks · A / B', { open: true });
  const presetOptions = () => [...LOOK_ORDER.map(k => [LOOKS[k].name, k]), ...Object.keys(app.userLooks).map(k => ['★ ' + k, 'user:' + k])];
  const pick = { a: P.looks.a, b: P.looks.b };
  const selA = kit.select(looks, pick, 'a', { label: 'Look A', options: presetOptions, tip: 'Load a preset into look A (replaces A’s current values).', onChange: v => app.loadLook('a', v) });
  const selB = kit.select(looks, pick, 'b', { label: 'Look B', options: presetOptions, tip: 'Load a preset into look B.', onChange: v => app.loadLook('b', v) });
  kit.segmented(looks, P.looks, 'preview', { label: 'Preview', options: [['A', 'a'], ['Mix', 'mix'], ['B', 'b']],
    tip: 'Audition one look alone. Mix restores the fader and its driver. Not saved.' });
  const morph = kit.slider(looks, P.looks, 'morph', { label: 'Mix A → B', min: 0, max: 1, step: 0.001, unit: '%', tip: 'How much of look B is visible when previewing Mix.', def: 0 });
  kit.select(looks, P.looks, 'drive', { label: 'Mix moves by', tip: 'Hand: the fader. LFO: a 16 s cycle. A voice: that voice’s floor-lift level.',
    options: [['hand (fader)', 'hand'], ['slow LFO · 16 s', 'lfo'], ...VOICE_NAMES.map((n, i) => ['voice · ' + n, 'v' + i])] });
  kit.status(looks, () => {
    const m = app.effectiveMorph();
    return P.looks.preview === 'mix' ? `Showing the mix: ${pctOf(1 - m)} A · ${pctOf(m)} B` : `Previewing ${P.looks.preview.toUpperCase()} alone (not saved)`;
  });
  kit.text(looks, app.ui, 'saveName', { label: 'Save edited look as', tip: 'A name for the look in the tab you are editing.' });
  kit.button(looks, 'Save the edited look', () => { app.saveUserLook(); selA.rebuild(); selB.rebuild(); }, { tip: 'Stores the look you are editing (A or B tab) in this browser.' });

  // ── Light (the edited look) ────────────────────────────────────────────────
  const light = kit.folder(root, 'Light', { open: true, note: 'Edits the look in the selected tab. Emission is the light the tiles give off; glow is the bloom added after.' });
  const tabs = kit.tabs(light, ['Edit A', 'Edit B'], i => { P.looks.edit = i ? 'b' : 'a'; }, P.looks.edit === 'b' ? 1 : 0);
  [app.lookA, app.lookB].forEach((look, ti) => {
    const pg = tabs.pages[ti], slot = ti ? 'b' : 'a';
    kit.status(pg, () => {
      const m = app.effectiveMorph(), share = slot === 'a' ? 1 - m : m;
      if (share > 0.001) return '';
      return P.looks.preview !== 'mix' ? `Look ${slot.toUpperCase()} is not visible: previewing ${P.looks.preview.toUpperCase()}. Edits here still apply.`
        : `Look ${slot.toUpperCase()} contributes 0 % at the current mix. Use Preview ${slot.toUpperCase()} to see edits.`;
    });
    const L = LOOKS.av2p;
    const S = (f, key, label, min, max, o = {}) => kit.slider(f, look, key, { label, min, max, step: o.step ?? 0.01, unit: o.unit ?? '', tip: o.tip, def: L[key], log: o.log });
    S(pg, 'restRim', 'Rim brightness', 0, 4, { tip: 'Steady emission of every rim, at rest.' });
    S(pg, 'rimResponse', 'Rim response', 0, 4, { tip: 'Extra rim emission as a tile’s voice lights it (in the voice colour).' });
    S(pg, 'fill', 'Interior brightness', 0, 4, { tip: 'Emission across the top face of a lit tile. Keep low for dark interiors.' });
    S(pg, 'hitAccent', 'Hit accent', 0, 5, { tip: 'Brief coloured boost on a hit (not white).' });
    S(pg, 'bloom', 'Glow amount', 0, 3, { tip: 'Bloom strength. Does not change the source brightness.' });
    S(pg, 'bloomRadius', 'Glow spread', 0, 1, { tip: 'UnrealBloomPass radius: how the blurred levels are weighted. Not a world distance.' });
    const col = kit.sub(pg, 'Colours');
    VOICE_NAMES.forEach((n, i) => kit.color(col, look, 'v' + i, { label: n, tip: `Colour of the ${n} voice`, def: L['v' + i] }));
    kit.color(col, look, 'rim', { label: 'rim at rest', tip: 'Rim colour before a voice lights the tile.', def: L.rim });
    kit.color(col, look, 'face', { label: 'face', tip: 'Top surface (not emission).', def: L.face });
    kit.color(col, look, 'side', { label: 'side', tip: 'Column sides (not emission).', def: L.side });
    kit.color(col, look, 'skyTop', { label: 'sky', def: L.skyTop });
    kit.color(col, look, 'horizon', { label: 'horizon / fog', def: L.horizon });
    const pr = kit.sub(pg, 'Precision');
    S(pr, 'rimWidth', 'Rim width', 0.02, 0.5, { step: 0.005, unit: 'tile', tip: 'Rim band width in tile radii (world space). Distant rims fade by pixel coverage instead of widening.' });
    S(pr, 'rimBreath', 'Rim breath', 0, 4, { tip: 'Whole-floor rim pulse from the Rim breath mapping.' });
    S(pr, 'innerSpill', 'Inner spill', 0, 1, { tip: 'Light leaking inward from the rim, × rim brightness.' });
    S(pr, 'spillFalloff', 'Spill falloff', 1, 16, { step: 0.1, tip: 'Higher keeps spill (and edge fill) closer to the rim.' });
    S(pr, 'fillCore', 'Interior: edge → solid', 0, 1, { tip: '0 fills from the rim inward; 1 fills the whole face.' });
    S(pr, 'sideGlow', 'Side glow', 0, 4, { tip: 'Voice colour glowing down the column sides.' });
    S(pr, 'sideFalloff', 'Side falloff', 0.5, 12, { step: 0.1, tip: 'At full activation: higher keeps side glow near the top edge.' });
    S(pr, 'topLine', 'Side top line', 0, 3, { tip: 'Bright line along each column’s top edge.' });
    S(pr, 'edgeLines', 'Corner lines', 0, 2, { tip: 'Vertical lines at the prism corners.' });
    S(pr, 'hitWhiten', 'Hit whitening', 0, 3, { tip: 'Separate move toward white on hits. 0 keeps hits coloured.' });
    S(pr, 'sparkCore', 'Spark white core', 0, 2, { tip: 'White centre of each spark, separate from its coloured body.' });
    S(pr, 'bloomThreshold', 'Glow cutoff', 0, 3, { tip: 'Linear luminance a pixel needs before it glows. Saturated blue reads darker than yellow at equal RGB.' });
    S(pr, 'bloomSky', 'Glow source: emission → scene', 0, 1, { tip: '0: only emitted light can glow (sky and fog never do). 1: the whole scene above the cutoff glows (Study 01).' });
    S(pr, 'exposure', 'Exposure', 0.2, 2.5, { tip: 'Before tone mapping.' });
    S(pr, 'fog', 'Fog', 0, 0.04, { step: 0.0005, tip: 'Haze toward the horizon, starting 24 units from the viewer.' });
    S(pr, 'horizonGlow', 'Horizon seam', 0, 2, { tip: 'Bright band where floor meets sky.' });
    S(pr, 'grain', 'Stone grain', 0, 1, { tip: 'Noise in the face colour.' });
  });
  const out = kit.sub(light, 'Output and diagnostics');
  kit.select(out, P.render, 'toneMapping', { label: 'Tone mapping', options: [['Neutral', 'neutral'], ['ACES', 'aces'], ['AgX', 'agx'], ['none', 'none']], tip: 'Applied once, at output.' });
  kit.select(out, P.diag, 'view', { label: 'Diagnostic view', tip: 'Not saved.', def: 'normal',
    options: [['composite', 'normal'], ['no glow', 'nobloom'], ['glow only', 'bloom'], ['emission only', 'emission'], ['surfaces only', 'surface']] });

  // ── Floor ──────────────────────────────────────────────────────────────────
  const floor = kit.folder(root, 'Floor', { onReset: () => app.resetGroup('floor') });
  const F = P.floor, DF = D.floor;
  const rebuildOnCommit = (v, commit) => { if (commit) app.rebuild(); };
  kit.slider(floor, F, 'rings', { label: 'Field radius', min: 6, max: 96, step: 1, unit: 'rings', def: DF.rings, tip: 'Hex rings from the centre. Rebuilds the tiles when you let go.', onChange: rebuildOnCommit });
  kit.readout(floor, 'Tiles', () => app.stats.tiles.toLocaleString());
  kit.slider(floor, F, 'gap', { label: 'Tile spacing', min: 0, max: 0.6, step: 0.005, unit: '%', def: DF.gap, tip: 'Empty margin around each tile, as a share of the cell.' });
  kit.slider(floor, F, 'rest', { label: 'Resting height', min: 0.02, max: 2, step: 0.01, unit: 'u', def: DF.rest });
  kit.slider(floor, F, 'active', { label: 'Active tiles', min: 0, max: 1, step: 0.01, unit: '%', def: DF.active, tip: 'Share of tiles eligible to respond; the rest stay pure grid.', onChange: rebuildOnCommit });
  const fp = kit.sub(floor, 'Precision');
  kit.select(fp, F, 'pattern', { label: 'Voice layout', def: DF.pattern, options: [['rings', 'rings'], ['sectors', 'sectors'], ['spiral', 'spiral'], ['scatter', 'scatter']], onChange: () => app.rebuild() });
  kit.slider(fp, F, 'ringWidth', { label: 'Band width', min: 0.5, max: 12, step: 0.1, unit: 'tiles', def: DF.ringWidth, onChange: rebuildOnCommit });
  kit.select(fp, F, 'order', { label: 'Centre', def: DF.order, options: [['low voices in', 'low-in'], ['high voices in', 'high-in']], onChange: () => app.rebuild() });
  kit.slider(fp, F, 'scatter', { label: 'Scatter', min: 0, max: 1, step: 0.01, unit: '%', def: DF.scatter, tip: 'Share of tiles given a random voice.', onChange: rebuildOnCommit });
  kit.slider(fp, F, 'seed', { label: 'Seed', min: 1, max: 999, step: 1, def: DF.seed, tip: 'Same seed, same layout and sparks.', onChange: rebuildOnCommit });
  kit.slider(fp, F, 'variation', { label: 'Activation variation', min: 0, max: 1, step: 0.01, def: DF.variation, tip: 'Low: a voice’s tiles respond together. High: activation spreads through them as the voice gets louder.' });
  kit.slider(fp, F, 'jitter', { label: 'Height jitter', min: 0, max: 2, step: 0.01, unit: 'u', def: DF.jitter });

  // ── Movement ───────────────────────────────────────────────────────────────
  const mv = kit.folder(root, 'Movement', { onReset: () => app.resetGroup('movement') });
  const M = P.movement, DM = D.movement, ML = P.map.lift;
  const cLift = kit.slider(mv, M, 'lift', { label: 'Maximum lift', min: 0, max: 12, step: 0.05, unit: 'u', def: DM.lift, tip: 'Extra height at full activation (× Movement in the strip).' });
  kit.slider(mv, ML, 'rise', { label: 'Rise time', min: 0, max: 2000, step: 1, unit: 'ms', def: D.map.lift.rise, tip: 'Time to reach 90 % of a step up.' });
  kit.slider(mv, ML, 'fall', { label: 'Fall time · sub', min: 10, max: 8000, log: true, unit: 'ms', def: D.map.lift.fall, tip: 'Time to decay by 90 %, for the lowest voice.' });
  kit.slider(mv, ML, 'fallHigh', { label: 'Fall time · air', min: 10, max: 8000, log: true, unit: 'ms', def: D.map.lift.fallHigh, tip: 'For the highest voice; voices in between ease between the two.' });
  kit.segmented(mv, M, 'ripple', { label: 'Ripple', options: [['Instant', 'instant'], ['Outward', 'outward']], tip: 'Instant: every tile reads the present. Outward: the music reaches outer tiles later.' });
  const cTravel = kit.slider(mv, M, 'travel', { label: 'Ripple travel', min: 1, max: 200, log: true, unit: 'u/s', def: DM.travel, tip: 'Speed of the outward ripple.' });
  kit.readout(mv, 'Edge arrives after', () => {
    const r = app.field.layout.radius, hs = HIST / app.timeline.rowHz;
    if (M.ripple !== 'outward') return 'instant';
    const t = r / M.travel;
    return `${t.toFixed(2)} s${t > hs ? ` · beyond the ${hs.toFixed(1)} s history: outer tiles hold the oldest row` : ` (history ${hs.toFixed(1)} s)`}`;
  }, { tip: 'Spatial delay by design, separate from analysis latency.' });
  const mp = kit.sub(mv, 'Precision');
  kit.slider(mp, M, 'curve', { label: 'Response curve', min: 0.3, max: 4, step: 0.05, def: DM.curve, tip: '1 linear; above 1 holds back then snaps up.' });
  kit.slider(mp, M, 'floor', { label: 'Activation floor', min: 0, max: 0.95, step: 0.01, unit: '%', def: DM.floor, tip: 'Below this level a tile rests. Kept below the ceiling.' });
  kit.slider(mp, M, 'ceil', { label: 'Activation ceiling', min: 0.02, max: 1, step: 0.01, unit: '%', def: DM.ceil, tip: 'At or above this level a tile is fully active.' });
  kit.slider(mp, M, 'swell', { label: 'Sub swell', min: 0, max: 4, step: 0.01, unit: 'u', def: DM.swell, tip: 'The sub voice lifts the floor in broad, slow folds.' });

  // ── Sparks ─────────────────────────────────────────────────────────────────
  const sk = kit.folder(root, 'Sparks', { onReset: () => app.resetGroup('sparks') });
  const S = P.sparks, DS = D.sparks;
  const sparkCtrls = [];
  sparkCtrls.push(kit.toggle(sk, S, 'on', { label: 'On' }));
  sparkCtrls.push(kit.slider(sk, S, 'perHit', { label: 'Particles per hit', min: 0, max: 400, step: 1, def: DS.perHit, tip: 'A finite budget per hit event (scaled by its strength), spread over the ripple.' }));
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

  // ── Music response ─────────────────────────────────────────────────────────
  const mu = kit.folder(root, 'Music response', { note: 'One mapping at a time: a musical source → a visual destination. The meters under the floor show the inspected mapping: measured, processed, output. Frequency bands are ranges, not instruments.' });
  kit.select(mu, P.inspect, 'dest', { label: 'Inspect mapping', options: DEST, onChange: () => showMapping() });
  kit.select(mu, P.inspect, 'voice', { label: 'Meter voice', options: VOICES, tip: 'Which voice the meters follow (Floor lift and Hits are per voice).' });
  kit.select(mu, P.solo, 'dest', { label: 'Solo response', def: 'none', tip: 'Shows only this destination’s visual contribution; the music keeps playing. Not saved.',
    options: [['none', 'none'], ['Floor lift', 'lift'], ['Rim breath', 'rim'], ['Hits', 'hits'], ['Colour drift', 'colour'], ['Sparks', 'sparks']] });
  const mapBodies = {};
  const mapRow = (dest, title, source) => {
    const b = document.createElement('div'); b.className = 'k-map'; mu.append(b); mapBodies[dest] = b;
    const h = document.createElement('p'); h.className = 'k-maptitle'; h.textContent = title; b.append(h);
    const m = P.map[dest], dm = D.map[dest];
    if (source) kit.select(b, m, 'source', { label: 'Source', def: dm.source, options: [...VOICES, ['global (whole spectrum)', 8]] });
    if ('sensitivity' in m) kit.slider(b, m, 'sensitivity', { label: 'Sensitivity', min: 0.1, max: 8, log: true, unit: '×', def: dm.sensitivity, tip: 'Multiplies the normalised level before the curve. Higher reaches full output sooner.' });
    if ('curve' in m) kit.slider(b, m, 'curve', { label: 'Response curve', min: 0.3, max: 4, step: 0.05, def: dm.curve });
    if ('rise' in m) kit.slider(b, m, 'rise', { label: 'Rise time', min: 0, max: 4000, step: 1, unit: 'ms', def: dm.rise, tip: 'Time to 90 % of a step.' });
    if ('hold' in m) kit.slider(b, m, 'hold', { label: 'Hold', min: 0, max: 1000, step: 1, unit: 'ms', def: dm.hold });
    if ('fall' in m) kit.slider(b, m, 'fall', { label: dest === 'lift' ? 'Fall time · sub' : 'Fall time', min: 10, max: 12000, log: true, unit: 'ms', def: dm.fall, tip: 'Time to decay by 90 %.' });
    if ('fallHigh' in m) kit.slider(b, m, 'fallHigh', { label: 'Fall time · air', min: 10, max: 12000, log: true, unit: 'ms', def: dm.fallHigh });
    kit.slider(b, m, 'amount', { label: 'Output amount', min: 0, max: 2, step: 0.01, unit: '×', def: dm.amount });
    if (dest === 'hits') kit.button(b, 'Fire one manual hit (after the detector)', () => { P.manual.voice = P.inspect.voice; app.fireHit(); }, { tip: 'Manual test on the meter voice: checks the visual response without audio.' });
  };
  mapRow('lift', 'Each tile’s own voice → Floor lift', false);
  mapRow('rim', 'Source → Rim breath (whole floor)', true);
  mapRow('hits', 'Hit events → Accent + flash', false);
  mapRow('colour', 'Source → Colour drift (slow)', true);
  const showMapping = () => { for (const [d, b] of Object.entries(mapBodies)) b.hidden = d !== P.inspect.dest; };
  showMapping();
  const man = kit.sub(mu, 'Manual test');
  kit.toggle(man, P.manual, 'on', { label: 'Hold a level', tip: 'Replaces one voice’s level after interpretation. Not saved.' });
  kit.select(man, P.manual, 'voice', { label: 'Voice', options: VOICES });
  kit.slider(man, P.manual, 'level', { label: 'Level', min: 0, max: 1, step: 0.01, unit: '%' });
  kit.button(man, 'Fire one hit on this voice', () => app.fireHit());

  const an = kit.sub(mu, 'Analysis', { onReset: () => app.resetGroup('music') });
  const Mu = P.music, DMu = D.music;
  kit.readout(an, 'Path', () => app.timeline.mode === 'precise'
    ? `precise · ${app.timeline.f.meta.bandWin}/${app.timeline.f.meta.bandHop} and ${app.timeline.f.meta.fastWin}/${app.timeline.f.meta.fastHop} @ ${(app.timeline.f.meta.sampleRate / 1000).toFixed(1)} kHz`
    : 'Live · basic analysis (analyser snapshot per 60 Hz update)');
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

  // ── Pointer and camera ─────────────────────────────────────────────────────
  const pc = kit.folder(root, 'Pointer and camera', { onReset: () => app.resetGroup('pointer') });
  const Pt = P.pointer, DP = D.pointer;
  kit.toggle(pc, Pt, 'on', { label: 'Pointer' });
  const ptr = [];
  ptr.push(kit.slider(pc, Pt, 'radius', { label: 'Pointer radius', min: 1, max: 40, step: 0.1, unit: 'u', def: DP.radius }));
  ptr.push(kit.slider(pc, Pt, 'lift', { label: 'Pointer lift', min: -3, max: 8, step: 0.05, unit: 'u', def: DP.lift, tip: 'Negative presses tiles down; they never go through the floor.' }));
  kit.toggle(pc, P.camera, 'drift', { label: 'Camera drift' });
  const pp = kit.sub(pc, 'Precision');
  ptr.push(kit.select(pp, Pt, 'mode', { label: 'Driven by', options: [['pointer', 'pointer'], ['orbit path', 'orbit']] }));
  ptr.push(kit.slider(pp, Pt, 'glow', { label: 'Pointer glow', min: 0, max: 1, step: 0.01, def: DP.glow }));
  ptr.push(kit.slider(pp, Pt, 'tint', { label: 'Pointer tint', min: 0, max: 2, step: 0.01, def: DP.tint }));
  ptr.push(kit.color(pp, Pt, 'color', { label: 'Tint colour', def: DP.color }));
  const cOrbit = kit.slider(pp, Pt, 'speed', { label: 'Orbit speed', min: 0, max: 2, step: 0.01, def: DP.speed });
  kit.slider(pp, P.camera, 'driftSpeed', { label: 'Drift speed', min: -3, max: 3, step: 0.01, def: D.camera.driftSpeed });
  kit.slider(pp, P.camera, 'fov', { label: 'Lens (field of view)', min: 20, max: 100, step: 1, unit: '°', def: D.camera.fov });

  // ── Scenes and performance ─────────────────────────────────────────────────
  const sc = kit.folder(root, 'Scenes and performance');
  kit.button(sc, 'Restore last saved scene', () => app.restoreSaved(), { tip: 'The scene last saved to (or recalled from) a track.' });
  kit.button(sc, 'Export scene (JSON)', () => app.exportScene());
  kit.button(sc, 'Import scene (JSON)', () => app.importScene(), { tip: 'Checked on import: unknown keys ignored, numbers must be finite, ranges enforced.' });
  kit.button(sc, 'Reset everything to defaults', () => app.resetScene(), { tip: 'Tracks, saved looks and track scenes are kept.' });
  kit.slider(sc, P.render, 'scale', { label: 'Render scale', min: 0.4, max: 1.5, step: 0.05, unit: '×', def: 1, tip: 'Pixel ratio × this. Lower for speed; audio timing is unaffected.', onChange: () => app.resize() });
  kit.readout(sc, 'Frame rate', () => `${app.stats.fps.toFixed(0)} fps`);
  kit.readout(sc, 'Draw calls · triangles', () => `${app.stats.calls} · ${(app.stats.tris / 1000).toFixed(0)} k`);

  // ── Why a control has no effect right now ──────────────────────────────────
  const tickInactive = () => {
    const solo = P.solo.dest, soloOther = d => (solo !== 'none' && solo !== d ? `Solo response is on (${solo})` : '');
    cLift.setInactive(soloOther('lift'));
    cTravel.setInactive(M.ripple !== 'outward' ? 'Ripple is set to Instant' : '');
    for (const c of sparkCtrls.slice(1)) c.setInactive(!S.on ? 'Sparks are off' : soloOther('sparks'));
    cAdapt.setInactive(Mu.normalize !== 'adaptive' ? 'Preserve dynamics mode' : '');
    for (const c of ptr) c.setInactive(!Pt.on ? 'Pointer is off' : solo !== 'none' ? 'Solo response hides the pointer' : '');
    cOrbit.setInactive(Pt.mode !== 'orbit' ? 'Driven by the pointer' : '');
    morph.setInactive(P.looks.preview !== 'mix' ? `Previewing ${P.looks.preview.toUpperCase()}` : P.looks.drive !== 'hand' ? `Moved by ${P.looks.drive === 'lfo' ? 'the LFO' : 'a voice'}` : '');
  };

  return {
    kit,
    refresh() { pick.a = P.looks.a; pick.b = P.looks.b; kit.refresh(); showMapping(); },
    refreshMorph() { morph.refresh(); },
    tick() { kit.tick(); tickInactive(); },
  };
}

// History-channel regression (v0.3 · P0).
//   node tools/history.test.mjs        → prints PASS/FAIL per check, writes tools/captures/history.json
//
// The history texture is how every tile hears the music: 9 columns (8 voices + global) by
// HIST rows, newest row first, one RGBA texel per column:
//
//     r  lift      each voice's floor-lift envelope      (global column: the global level's)
//     g  hit       each voice's hit envelope              (global column: harmony shimmer)
//     b  rim       the rim-breath envelope for that column as a source
//     a  colour    the colour-drift envelope for that column as a source
//
// At 28e8c16 the b and a writes sat behind a line comment, so rim breath and colour drift
// were silent while their envelopes and meters moved. Two runs of that code agree with each
// other perfectly, which is why "same output twice" checks never saw it. These checks assert
// what each channel means instead: every channel is driven to a different, known value, so a
// missing write, a swapped pair or a stale row cannot produce the expected numbers.
//
// The real src/response.js runs here with the real three.js DataTexture; nothing is stubbed.
import { register } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./three-resolve.mjs', import.meta.url);
const { response, stepResponse, clearResponse, histAt, historySeconds } = await import('../src/response.js');
const { P, NB, HIST, GLOBAL } = await import('../src/params.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const COLS = NB + 1, R = 0, G = 1, B = 2, A = 3;
const results = {};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const texel = (row, col, ch) => response.hist[(row * COLS + col) * 4 + ch];
function check(name, fn) {
  try { const detail = fn() || {}; results[name] = { pass: true, ...detail }; }
  catch (e) { results[name] = { pass: false, error: String(e.message || e) }; }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Every destination gets its own gain, and every envelope is instant, so one update leaves
// each channel holding a different number that can be worked out by hand:
//   lift = level · 1      rim = level · 0.5      colour = level · 0.25      hit = the event's strength
const saved = JSON.stringify(P.map);
const FAST = 1e-3;      // ms: a fall this short completes within one update
function instantMapping() {
  Object.assign(P.map.lift, { sensitivity: 1, curve: 1, rise: 0, fall: FAST, fallHigh: FAST });
  Object.assign(P.map.rim, { sensitivity: 0.5, curve: 1, rise: 0, fall: FAST });
  Object.assign(P.map.colour, { sensitivity: 0.25, curve: 1, rise: 0, fall: FAST });
  Object.assign(P.map.hits, { rise: 0, hold: 1000, fall: FAST });
}
const levelsAt = scale => Float32Array.from({ length: NB }, (_, k) => scale * (k + 1) / 10);   // 0.1 … 0.8, × scale
const noHits = new Float32Array(NB);
const DT = 0.01, SHIMMER = 0.37, GLOBAL_LEVEL = 0.9;

instantMapping();

// 1 · One update: each channel of the newest row holds its own destination.
check('channels_hold_their_own_destination', () => {
  clearResponse();
  const hits = new Float32Array(NB); hits[2] = 0.6; hits[5] = 1;
  stepResponse(levelsAt(1), GLOBAL_LEVEL, hits, DT, SHIMMER);
  const seen = [];
  for (let k = 0; k < NB; k++) {
    const lv = (k + 1) / 10, row = [texel(0, k, R), texel(0, k, G), texel(0, k, B), texel(0, k, A)];
    seen.push(row.map(v => +v.toFixed(4)));
    expect(near(row[R], lv), `voice ${k}: r (lift) is ${row[R]}, expected ${lv}`);
    expect(near(row[G], hits[k]), `voice ${k}: g (hit) is ${row[G]}, expected ${hits[k]}`);
    expect(near(row[B], lv * 0.5), `voice ${k}: b (rim) is ${row[B]}, expected ${lv * 0.5}`);
    expect(near(row[A], lv * 0.25), `voice ${k}: a (colour) is ${row[A]}, expected ${lv * 0.25}`);
  }
  return { voice1_rgba: seen[1], voice5_rgba: seen[5] };
});

// 2 · The global column: level in r, rim in b, colour in a, and harmony shimmer (not a hit) in g.
check('global_column_and_shimmer_slot', () => {
  clearResponse();
  const hits = new Float32Array(NB).fill(1);                       // every voice hits: none may leak into the global column
  stepResponse(levelsAt(1), GLOBAL_LEVEL, hits, DT, SHIMMER);
  const row = [R, G, B, A].map(c => texel(0, GLOBAL, c));
  expect(near(row[R], GLOBAL_LEVEL), `global r (lift) is ${row[R]}, expected ${GLOBAL_LEVEL}`);
  expect(near(row[G], SHIMMER), `global g (shimmer) is ${row[G]}, expected ${SHIMMER}`);
  expect(near(row[B], GLOBAL_LEVEL * 0.5), `global b (rim) is ${row[B]}, expected ${GLOBAL_LEVEL * 0.5}`);
  expect(near(row[A], GLOBAL_LEVEL * 0.25), `global a (colour) is ${row[A]}, expected ${GLOBAL_LEVEL * 0.25}`);
  stepResponse(levelsAt(1), GLOBAL_LEVEL, noHits, DT, 0);         // shimmer gone: the slot follows it, voices keep their hits
  expect(near(texel(0, GLOBAL, G), 0), 'global g did not return to 0 with shimmer 0');
  expect(near(texel(0, 3, G), 1), 'voice 3 hit envelope should still be held');
  return { global_rgba: row.map(v => +v.toFixed(4)) };
});

// 3 · Older rows: three updates at three levels sit in rows 2, 1, 0; all four channels travel together;
//     the CPU read used for spark origins interpolates between rows in every channel.
check('older_rows_keep_every_channel', () => {
  clearResponse();
  const scales = [1.0, 0.5, 0.25];
  for (const s of scales) stepResponse(levelsAt(s), GLOBAL_LEVEL * s, noHits, DT, SHIMMER * s);
  expect(response.rows === 3, `rows is ${response.rows}, expected 3`);
  for (let i = 0; i < 3; i++) {
    const s = scales[2 - i], k = 6, lv = s * (k + 1) / 10;           // row 0 is the newest (0.25)
    expect(near(texel(i, k, R), lv), `row ${i} r is ${texel(i, k, R)}, expected ${lv}`);
    expect(near(texel(i, k, B), lv * 0.5), `row ${i} b (rim) is ${texel(i, k, B)}, expected ${lv * 0.5}`);
    expect(near(texel(i, k, A), lv * 0.25), `row ${i} a (colour) is ${texel(i, k, A)}, expected ${lv * 0.25}`);
    expect(near(texel(i, GLOBAL, G), SHIMMER * s), `row ${i} global g (shimmer) is ${texel(i, GLOBAL, G)}, expected ${SHIMMER * s}`);
  }
  for (const c of [R, G, B, A]) for (let k = 0; k < COLS; k++) expect(texel(3, k, c) === 0, `row 3 should be untouched (col ${k}, channel ${c})`);
  const k = 6, mid = histAt(k, 0.5, B), want = 0.5 * (0.25 + 0.5) * (k + 1) / 10 * 0.5;
  expect(near(mid, want), `histAt between rows 0 and 1 (rim) is ${mid}, expected ${want}`);
  expect(near(histAt(k, 0.5, A), want * 0.5), 'histAt between rows 0 and 1 (colour) is wrong');
  return { rows: response.rows, rim_rows_0_1_2: [0, 1, 2].map(i => +texel(i, 6, B).toFixed(4)) };
});

// 4 · A destination is independent of the others: changing only the rim mapping moves only b.
check('destinations_are_independent', () => {
  clearResponse();
  stepResponse(levelsAt(1), GLOBAL_LEVEL, noHits, DT, 0);
  const before = [R, G, B, A].map(c => texel(0, 4, c));
  P.map.rim.sensitivity = 1;                                       // was 0.5
  clearResponse();
  stepResponse(levelsAt(1), GLOBAL_LEVEL, noHits, DT, 0);
  const after = [R, G, B, A].map(c => texel(0, 4, c));
  P.map.rim.sensitivity = 0.5;
  expect(near(after[R], before[R]) && near(after[G], before[G]) && near(after[A], before[A]), 'changing rim sensitivity moved another channel');
  expect(near(after[B], 2 * before[B]) && before[B] > 0, `b should double (${before[B]} → ${after[B]})`);
  return { before: before.map(v => +v.toFixed(4)), after: after.map(v => +v.toFixed(4)) };
});

// 5 · Slow envelopes are stored as envelopes: rim and colour keep their own timing in the rows.
check('rim_and_colour_keep_their_own_timing', () => {
  Object.assign(P.map.rim, { sensitivity: 1, rise: 100, fall: 100 });
  Object.assign(P.map.colour, { sensitivity: 1, rise: 1000, fall: 1000 });
  clearResponse();
  const one = new Float32Array(NB).fill(1);
  for (let i = 0; i < 10; i++) stepResponse(one, 1, noHits, DT, 0);   // 100 ms of a full-scale step
  const rim = texel(0, 1, B), col = texel(0, 1, A), lift = texel(0, 1, R);
  instantMapping();
  expect(near(lift, 1), `lift should be instant (${lift})`);
  expect(near(rim, 0.9, 1e-3), `rim after its own t90 (100 ms) is ${rim}, expected 0.9`);
  expect(near(col, 1 - Math.pow(10, -0.1), 1e-3), `colour after 100 ms of a 1000 ms t90 is ${col}, expected ${1 - Math.pow(10, -0.1)}`);
  expect(texel(9, 1, B) < texel(0, 1, B) && texel(9, 1, B) > 0, 'the rim rise should be visible across rows');
  return { lift: +lift.toFixed(4), rim: +rim.toFixed(4), colour: +col.toFixed(4) };
});

// 6 · Capacity: the buffer holds HIST rows, the oldest is the row written HIST − 1 updates ago, nothing wraps.
check('capacity_and_oldest_row', () => {
  clearResponse();
  const extra = 5, total = HIST + extra;
  for (let i = 0; i < total; i++) { const lv = new Float32Array(NB).fill((i + 1) / total); stepResponse(lv, 0, noHits, DT, 0); }
  expect(response.rows === HIST, `rows is ${response.rows}, expected ${HIST}`);
  const newest = texel(0, 0, B), oldest = texel(HIST - 1, 0, B);
  expect(near(newest, 0.5), `newest rim is ${newest}, expected 0.5`);
  expect(near(oldest, 0.5 * (extra + 1) / total), `oldest rim is ${oldest}, expected ${0.5 * (extra + 1) / total}`);
  expect(response.hist.length === HIST * COLS * 4, 'history length changed');
  return { rows: response.rows, capacity_s_at_60: +historySeconds(60).toFixed(3), oldest_valid_age_s_at_60: +((HIST - 1) / 60).toFixed(3) };
});

// 7 · Reset: a seek or a source change leaves no old music in any channel, and marks the texture for upload.
check('reset_clears_every_channel', () => {
  const hits = new Float32Array(NB).fill(1);
  for (let i = 0; i < 20; i++) stepResponse(levelsAt(1), GLOBAL_LEVEL, hits, DT, SHIMMER);
  const v0 = response.tex.version;
  clearResponse();
  let sum = 0; for (let i = 0; i < response.hist.length; i++) sum += Math.abs(response.hist[i]);
  expect(sum === 0, `history still holds ${sum} after a reset`);
  expect(response.rows === 0 && response.shimmer === 0, 'rows / shimmer not reset');
  for (const a of [response.lift, response.rim, response.colour, response.hit, response.hitTarget, response.hitHold]) expect(a.every(v => v === 0), 'an envelope survived the reset');
  expect(response.tex.version > v0, 'the texture was not marked for upload after the reset');
  stepResponse(levelsAt(1), GLOBAL_LEVEL, noHits, DT, 0);
  expect(response.rows === 1 && near(texel(0, 2, B), 0.15) && texel(1, 2, B) === 0, 'the first row after a reset is wrong');
  return { rowsAfterReset: 0, firstRowRim: +texel(0, 2, B).toFixed(4) };
});

// 8 · A fall time of 0 ms means instant. At 28e8c16 the sub → air easing computed 0 · (x / 0)^k = NaN for
//     every voice above the sub, and NaN then stayed in the envelope and the history (reachable from an
//     imported scene: validation accepts 0).
check('zero_fall_time_is_instant', () => {
  const out = {};
  for (const [fall, fallHigh] of [[0, 199], [797, 0], [0, 0]]) {
    Object.assign(P.map.lift, { rise: 0, fall, fallHigh });
    clearResponse();
    stepResponse(levelsAt(1), GLOBAL_LEVEL, noHits, DT, 0);
    stepResponse(levelsAt(0.5), GLOBAL_LEVEL, noHits, DT, 0);        // falling: this is where the fall time is used
    for (let i = 0; i < 2 * COLS * 4; i++) expect(Number.isFinite(response.hist[i]), `fall ${fall} / ${fallHigh}: history holds ${response.hist[i]}`);
    if (fall === 0) expect(near(response.lift[0], 0.05), `fall 0: sub should drop at once (${response.lift[0]})`);
    if (fallHigh === 0) expect(near(response.lift[NB - 1], 0.4), `fallHigh 0: air should drop at once (${response.lift[NB - 1]})`);
    out[`${fall}/${fallHigh}`] = Array.from(response.lift).map(v => +v.toFixed(3));
  }
  instantMapping();
  return out;
});

// 9 · What is asserted above is what the GPU samples: the texture wraps this very array, one texel per column.
check('texture_is_the_asserted_array', () => {
  const img = response.tex.image;
  expect(img.data === response.hist, 'the DataTexture does not wrap response.hist');
  expect(img.width === COLS && img.height === HIST, `texture is ${img.width} × ${img.height}, expected ${COLS} × ${HIST}`);
  return { width: img.width, height: img.height };
});

Object.assign(P.map, JSON.parse(saved));
mkdirSync(join(HERE, 'captures'), { recursive: true });
writeFileSync(join(HERE, 'captures', 'history.json'), JSON.stringify(results, null, 2));
let failed = 0;
for (const [k, v] of Object.entries(results)) { if (!v.pass) failed++; console.log(v.pass ? 'PASS' : 'FAIL', k, JSON.stringify(v)); }
console.log(`${Object.keys(results).length - failed} of ${Object.keys(results).length} history checks pass`);
process.exit(failed ? 1 : 0);

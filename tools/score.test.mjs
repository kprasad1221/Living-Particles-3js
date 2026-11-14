// The authored score (v0.3 · P3), without a browser.
//   node tools/score.test.mjs        → PASS/FAIL per check, writes tools/captures/score.json
//
// src/shared/score.js is meant to travel to other sketches, so these checks pin down what it promises:
// one call makes one answer, the same time gives the same gestures however you got there, nothing
// pending survives a reset, a suspended tab does not produce a storm, the free clock bends without
// jumping, the loop clock repeats exactly, and the music only weighs on a gesture within its bound.
// The last checks cover this world's own drawing of it (src/world/gestures.js) and show that a
// different world can draw the same score with routes of its own.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Score, SCORE_DEFAULTS, MAX_INSTANCES, envelope, lifeOf, periodOf, commonPeriod, foundationCycles, weighted, sanitizeScore } from '../src/shared/score.js';
import { ROUTES, routeOf, pathPoint, nearest, touch, gestureLift, callHead } from '../src/world/gestures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = {};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
function check(name, fn) {
  try { results[name] = { pass: true, ...(fn() || {}) }; }
  catch (e) { results[name] = { pass: false, error: String(e.message || e) }; }
}
const params = (over = {}) => { const p = JSON.parse(JSON.stringify(SCORE_DEFAULTS)); p.on = true; return Object.assign(p, over); };
const HOP = 512 / 44100;                                   // the app's analysis step for a 44.1 kHz track
// Run a score from 0 to `end` in steps of dt; returns the score and everything that started.
function run(p, end, dt = HOP, energy = () => 0.5, from = 0) {
  const s = new Score(p), started = [];
  for (let t = from; t <= end + 1e-9; t += dt) s.advance(t, energy(t), g => started.push({ ...g, announcedAt: t }));
  return { s, started };
}
const key = g => `${g.id}|${g.kind}|${g.route}|${g.start.toFixed(6)}`;

// 1 · One call, one answer: every reply names the call it answers, starts exactly `delay` after it and carries its strength.
check('one_call_one_answer', () => {
  const p = params(), END = 31, { started } = run(p, END);
  const calls = started.filter(g => g.kind === 'call'), replies = started.filter(g => g.kind === 'reply');
  // one every 2 s: 2, 4, … 30. The call at t = 0 falls on the first step, which fills in without announcing.
  expect(calls.length === 15, `expected 15 calls announced in ${END} s, got ${calls.length}`);
  expect(new Set(calls.map(g => g.id)).size === calls.length, 'a call id repeats');
  for (const c of calls) {
    const mine = replies.filter(r => r.parent === c.id);
    if (c.start + p.reply.delay > END) continue;           // its answer is due after the run ends
    expect(mine.length === 1, `call ${c.id} has ${mine.length} replies`);
    expect(near(mine[0].start, c.start + p.reply.delay), `reply to ${c.id} starts at ${mine[0].start}, expected ${c.start + p.reply.delay}`);
    expect(near(mine[0].strength, c.strength * p.reply.gain), 'a reply does not carry its call’s strength');
  }
  for (const r of replies) expect(calls.some(c => c.id === r.parent) || r.parent === 'c0', `reply ${r.id} answers ${r.parent}, which never started`);
  for (const g of started) expect(g.announcedAt >= g.start && g.announcedAt - g.start <= HOP + 1e-9, `${g.id} was announced ${g.announcedAt - g.start} s after its start`);
  return { calls: calls.length, replies: replies.length, firstCall: calls[0].id, firstReplyParent: replies[0].parent };
});

// 2 · The same time gives the same gestures at any step size, and after a seek straight to that time.
check('same_time_same_gestures', () => {
  const p = params(), T = 17.3;
  const a = run(p, T, HOP).s.instances.map(key), b = run(p, T, 1 / 30).s.instances.map(key), c = run(p, T, 1 / 240).s.instances.map(key);
  const seek = new Score(p); seek.advance(T, 0.5);
  const d = seek.instances.map(key);
  expect(a.length > 0, 'nothing alive at the test time');
  expect(a.join() === b.join() && a.join() === c.join(), `step size changed the gestures:\n ${a}\n ${b}\n ${c}`);
  expect(a.join() === d.join(), `a seek gave different gestures:\n ${a}\n ${d}`);
  return { at: T, alive: a };
});

// 3 · Reset (seek, restart, source change): nothing pending survives, and nothing from the past is announced again.
check('reset_drops_what_was_pending', () => {
  const p = params({ mode: 'free' }), s = new Score(p), announced = [];
  for (let t = 0; t <= 2.2; t += HOP) s.advance(t, 0.5, g => announced.push(g.id));       // call 1 has started; its reply is due at 2.5
  expect(s.instances.some(g => g.kind === 'reply' && g.start > 2.2), 'the test needs a pending reply');
  s.reset();
  expect(s.instances.length === 0, `${s.instances.length} instances survived the reset`);
  const after = [];
  for (let t = 40; t <= 40.6; t += HOP) s.advance(t, 0.5, g => after.push(g));
  expect(!after.some(g => g.kind === 'reply' && g.parent && announced.includes(g.parent)), 'a reply to a call from before the reset appeared');
  // loop clock: the first step after a reset fills in what the clock says is alive, without announcing it
  const q = params(), l = new Score(q), loud = [];
  l.advance(9.3, 0.5, g => loud.push(g.id));
  expect(l.instances.length > 0 && loud.length === 0, `the first step after a reset announced ${loud}`);
  return { survivedReset: 0, filledInSilently: l.instances.map(g => g.id) };
});

// 4 · A long gap (a suspended tab) makes only what can still be alive: no backlog, no burst of announcements.
check('no_storm_after_a_long_gap', () => {
  const out = {};
  for (const mode of ['loop', 'free']) {
    const s = new Score(params({ mode })), announced = [];
    for (let t = 0; t <= 10; t += HOP) s.advance(t, 0.5);
    const before = s.stats.calls;
    s.advance(70, 0.5, g => announced.push(g.id));                                           // one step, a minute later
    expect(s.instances.length <= MAX_INSTANCES, `${s.instances.length} instances after the gap`);
    expect(s.stats.calls - before <= 2, `${mode}: ${s.stats.calls - before} calls were created for a 60 s gap (30 fit in it)`);
    expect(announced.length <= 2, `${mode}: ${announced.length} gestures announced at once`);
    out[mode] = { created: s.stats.calls - before, announced: announced.length };
  }
  return out;
});

// 5 · Free clock: the music bends the pace within its bound; the phase never jumps or runs backwards.
check('free_clock_bends_without_jumping', () => {
  const p = params({ mode: 'free', rateDepth: 0.4 }), s = new Score(p), base = 1 / periodOf(p);
  let last = null, maxStep = 0, minRate = Infinity, maxRate = 0;
  for (let t = 0; t <= 40; t += HOP) {
    s.advance(t, Math.floor(t / 3) % 2 ? 1 : 0);                                              // the level slams between 0 and 1 every 3 s
    if (last !== null) { const d = s.phase - last; expect(d >= 0, 'the phase ran backwards'); maxStep = Math.max(maxStep, d); }
    last = s.phase; minRate = Math.min(minRate, s.rate); maxRate = Math.max(maxRate, s.rate);
  }
  expect(maxStep <= base * 1.4 * HOP * 1.0001, `largest phase step ${maxStep} is more than the fastest allowed pace allows (${base * 1.4 * HOP})`);
  expect(minRate >= base * 0.6 - 1e-9 && maxRate <= base * 1.4 + 1e-9, `rate left its bound: ${minRate} … ${maxRate} around ${base}`);
  expect(maxRate > base * 1.2 && minRate < base * 0.8, 'the level never moved the pace: the test would prove nothing');
  return { tempoHz: base, slowest: +minRate.toFixed(4), fastest: +maxRate.toFixed(4), largestPhaseStep: +maxStep.toFixed(6) };
});

// 6 · Loop clock: after commonPeriod seconds everything is exactly where it was (what a seamless capture needs).
check('loop_repeats_exactly', () => {
  const p = params(), C = commonPeriod(p);
  expect(near(C, 24), `default score should repeat every 24 s (4 calls per swell × 3 routes × 2 s), got ${C}`);
  const shape = t => { const s = new Score(p); s.advance(t, 0.5); return s.instances.map(g => `${g.kind}|${g.route}|${(g.start - t).toFixed(6)}`).join() + '|' + s.foundationShape(t).toFixed(9); };
  for (const t of [3.21, 11.9, 17.3, 23.99]) expect(shape(t) === shape(t + C), `the score at ${t} s and at ${t + C} s differ`);
  expect(shape(3.21) !== shape(3.21 + periodOf(p)), 'one call period later should be a different route');
  return { call_s: periodOf(p), swell_s: periodOf(p) * foundationCycles(p), repeats_s: C };
});

// 7 · A gesture has a shape and returns to rest; calls and replies overlap; most of the time a place on the route is at rest.
check('shape_overlap_and_rest', () => {
  const p = params(), c = p.call;
  expect(envelope(-0.1, c.rise, c.crest, c.release) === 0 && envelope(0, c.rise, c.crest, c.release) === 0, 'not at rest before the front arrives');
  expect(near(envelope(c.rise + c.crest / 2, c.rise, c.crest, c.release), 1), 'no crest');
  expect(envelope(c.rise + c.crest + c.release, c.rise, c.crest, c.release) === 0 && envelope(99, c.rise, c.crest, c.release) === 0, 'does not return to rest');
  let prev = 0, rising = true;
  for (let tau = 0; tau <= 1; tau += 0.001) { const e = envelope(tau, c.rise, c.crest, c.release); if (e < prev - 1e-9) rising = false; else expect(rising || e <= prev + 1e-9, 'the envelope rises twice'); prev = e; }
  // one place at the start of the route, sampled over a whole repeat
  let rest = 0, both = 0, n = 0;
  const s = new Score(p);
  for (let t = 0; t < commonPeriod(p); t += HOP) {
    s.advance(t, 0.5); n++;
    const lit = s.instances.filter(g => g.kind === 'call' && envelope(t - g.start, g.rise, g.crest, g.release) > 0).length;
    if (!lit) rest++;
    if (s.alive(t, 'call').length && s.alive(t, 'reply').length) both++;
  }
  expect(rest / n > 0.5, `a place on the route is at rest only ${(100 * rest / n).toFixed(0)} % of the time`);
  expect(both / n > 0.2, `a call and a reply are alive together only ${(100 * both / n).toFixed(0)} % of the time`);
  return { restShareAtOnePlace: +(rest / n).toFixed(3), callAndReplyTogether: +(both / n).toFixed(3) };
});

// 8 · The music weighs on a gesture within its bound and never becomes it.
check('music_weighs_within_bounds', () => {
  const p = params();
  expect(near(weighted(2, 0.5, 0), 1) && near(weighted(2, 0.5, 1), 2) && near(weighted(2, 0, 0.1), 2) && near(weighted(2, 1, 0), 0), 'weighted() is not amount × (1 − share + share × level)');
  expect(weighted(1, 0.5, 7) === 1 && weighted(1, 0.5, -3) === 0.5, 'a level outside 0…1 escaped the bound');
  const quiet = run(p, 9, HOP, () => 0).started.filter(g => g.kind === 'call'), loud = run(p, 9, HOP, () => 1).started.filter(g => g.kind === 'call');
  expect(quiet.every(g => near(g.strength, 0.5)) && loud.every(g => near(g.strength, 1)), 'call strength is not bounded by strength × (1 − audio) … strength');
  expect(quiet.map(g => g.start).join() === loud.map(g => g.start).join(), 'the level moved when calls start (loop clock)');
  const s = new Score(p);
  for (let t = 0; t < 16; t += 0.05) { const f = s.foundation(t, 1), q = s.foundation(t, 0); expect(f <= p.foundation.amount + 1e-9 && q <= f + 1e-9 && q >= f * 0.5 - 1e-9, 'the foundation left its bound'); }
  expect(new Score(params({ on: false })).foundation(3, 1) === 0, 'an off score still swells');
  return { callStrengthQuiet: quiet[0].strength, callStrengthLoud: loud[0].strength };
});

// 9 · Tap: moving the origin moves every call with it; tempo and beats set the spacing. Nothing is measured.
check('tempo_and_origin_set_the_grid', () => {
  const p = params({ bpm: 96, callBeats: 2, origin: 0.37 }), { started } = run(p, 12);
  const calls = started.filter(g => g.kind === 'call');
  expect(near(periodOf(p), 1.25), `2 beats at 96 bpm is 1.25 s, got ${periodOf(p)}`);
  for (const c of calls) { const k = (c.start - 0.37) / 1.25; expect(near(k, Math.round(k), 1e-6), `call at ${c.start} is off the grid`); }
  return { period_s: periodOf(p), firstCalls: calls.slice(0, 3).map(c => +c.start.toFixed(3)) };
});

// 10 · Settings from a file are repaired, not trusted.
check('settings_are_repaired', () => {
  const p = sanitizeScore({ on: true, mode: 'sideways', bpm: 'fast', origin: NaN, callBeats: -4, foundationBeats: 1e9, routes: 99, source: 2.6, rateDepth: 5,
    call: { travel: -1, rise: NaN, crest: -2, release: 0, strength: 99, audio: 9 }, reply: { on: true, delay: -3, travel: 1e9, rise: 0.2, crest: 0, release: 0.3, gain: -1 },
    foundation: { rise: 0, crest: -1, release: NaN, amount: 50, audio: -1 } });
  expect(p.mode === 'loop' && p.bpm === 120 && p.origin === 0 && p.callBeats === 0.5 && p.routes === 8 && p.source === 3 && p.rateDepth === 0.5, 'top-level values not repaired');
  expect(p.call.travel === 0.01 && p.call.rise === SCORE_DEFAULTS.call.rise && p.call.crest === 0 && p.call.strength === 2 && p.call.audio === 1, 'call values not repaired');
  expect(p.reply.delay === 0 && p.reply.travel === 8 && p.reply.gain === 0 && p.foundation.amount === 2 && p.foundation.audio === 0, 'reply or foundation values not repaired');
  const s = new Score(p); for (let t = 0; t < 5; t += HOP) s.advance(t, 0.5);
  expect(s.instances.every(g => Number.isFinite(g.start) && Number.isFinite(g.strength)), 'a repaired score produced a number that is not finite');
  return { period_s: periodOf(p) };
});

// 11 · The shared modules stand alone: no three.js, no app state, nothing imported from outside src/shared.
check('shared_modules_stand_alone', () => {
  const dir = join(HERE, '..', 'src', 'shared'), files = readdirSync(dir).filter(f => f.endsWith('.js')), found = {};
  for (const f of files) {
    const imports = [...readFileSync(join(dir, f), 'utf8').matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    found[f] = imports;
    for (const i of imports) expect(i.startsWith('./'), `${f} imports ${i}`);
  }
  expect(files.includes('score.js') && files.includes('palette.js'), 'a shared module is missing');
  return { imports: found };
});

// 12 · Another world can draw the same score with routes of its own: here two straight ribbons, nothing hexagonal.
check('another_world_can_draw_it', () => {
  const ribbons = [{ from: [-10, 0], to: [10, 0] }, { from: [0, -6], to: [0, 6] }];              // that world's routes
  const p = params({ routes: 2 }), s = new Score(p);
  const frontOf = (g, t) => { let best = -1, at = 0; for (let u = 0; u <= 1.0001; u += 0.02) { const e = envelope(t - (g.start + u * g.travel), g.rise, g.crest, g.release); if (e >= best) { best = e; at = u; } } return at; };
  const seen = [];
  for (let t = 0; t <= 4.6; t += HOP) s.advance(t, 0.5);
  const call = s.instances.find(g => g.kind === 'call' && g.id === 'c2'); expect(call, 'call c2 should be alive at 4.6 s');
  const u1 = frontOf(call, call.start + 0.2), u2 = frontOf(call, call.start + 0.5), r = ribbons[call.route];
  expect(u2 > u1 && u1 > 0, `the front does not travel (${u1} → ${u2})`);
  for (const u of [u1, u2]) seen.push([r.from[0] + (r.to[0] - r.from[0]) * u, r.from[1] + (r.to[1] - r.from[1]) * u].map(v => +v.toFixed(2)));
  expect(call.route === 0 && new Set(run(p, 9).started.filter(g => g.kind === 'call').map(g => g.route)).size === 2, 'calls do not step through that world’s two routes');
  return { ribbon: call.route, frontAt: seen };
});

// 13 · This world's drawing: routes, the nearest place on them, the travelling front, a reply that leaves from where its call arrived.
check('hex_world_routes', () => {
  const G = { reach: 1, callWidth: 2.4, callLift: 2.2, callGlow: 1, replyLength: 16, replyWidth: 1.8, replyLift: 3, replyGlow: 0.9 };
  const out = {};
  ROUTES.forEach((route, i) => {
    const call = { kind: 'call', route: i, start: 10, travel: 0.7, rise: 0.12, crest: 0.1, release: 0.5, strength: 1 };
    const reply = { ...call, kind: 'reply', start: 10.5, travel: 0.8, rise: 0.15, crest: 0.05, release: 0.8, strength: 0.8 };
    const c = routeOf(call, G), r = routeOf(reply, G);
    for (const u of [0, 0.3, 0.77, 1]) { const q = pathPoint(c, u), n = nearest(c, q.x, q.z); expect(near(n.u, u, 1e-6) && n.dist < 1e-6, `route ${i}: nearest() puts u ${u} at ${n.u}, ${n.dist} away`); }
    const beyond = pathPoint({ ...c, sweep: c.sweep * 1.2 }, 1), nb = nearest(c, beyond.x, beyond.z);
    expect(nb.u === 1 && nb.dist > 0.5, `route ${i}: a place past the end should belong to the end (u ${nb.u})`);
    const end = pathPoint(c, 1);
    expect(near(r.ax, end.x) && near(r.az, end.z), `route ${i}: the reply does not leave from where the call arrived`);
    expect(near(Math.hypot(r.bx - r.ax, r.bz - r.az), G.replyLength, 1e-9), 'reply length is wrong');
    expect(r.bz < r.az, `route ${i}: the reply should climb away from the Stand camera (toward −z)`);
    // the front: early on only the start is lit; at arrival the end is rising and the start is fading
    const a = pathPoint(c, 0), z = pathPoint(c, 1), w = G.callWidth;
    expect(touch(call, c, w, a.x, a.z, 10.15) > 0.9 && touch(call, c, w, z.x, z.z, 10.15) === 0, `route ${i}: the call does not start at its start`);
    expect(touch(call, c, w, z.x, z.z, 10.85) > 0.9 && touch(call, c, w, a.x, a.z, 10.85) === 0, `route ${i}: the start has not come to rest while the end is lit`);
    expect(touch(call, c, w, a.x + 40, a.z + 40, 10.15) < 1e-6, 'a far tile is touched');
    const h0 = callHead([call], G, 10.0001), h1 = callHead([call], G, 10.7);
    expect(Math.hypot(h0.x - a.x, h0.z - a.z) < 0.1 && Math.hypot(h1.x - z.x, h1.z - z.z) < 1e-6, `route ${i}: the light’s head is not on the front`);
    expect(callHead([call], G, 9.9) === null && callHead([call], G, 11.5).strength === 0, 'the head should be dark before a call and after it has faded');
    expect(near(gestureLift([call], G, a.x, a.z, 10.15), touch(call, c, w, a.x, a.z, 10.15) * G.callLift), 'gestureLift disagrees with touch × lift');
    out[i] = { start: [a.x, a.z].map(v => +v.toFixed(1)), end: [z.x, z.z].map(v => +v.toFixed(1)), replyEnds: [r.bx, r.bz].map(v => +v.toFixed(1)) };
  });
  return out;
});

mkdirSync(join(HERE, 'captures'), { recursive: true });
writeFileSync(join(HERE, 'captures', 'score.json'), JSON.stringify(results, null, 2));
let failed = 0;
for (const [k, v] of Object.entries(results)) { if (!v.pass) failed++; console.log(v.pass ? 'PASS' : 'FAIL', k, JSON.stringify(v)); }
console.log(`${Object.keys(results).length - failed} of ${Object.keys(results).length} score checks pass`);
process.exit(failed ? 1 : 0);

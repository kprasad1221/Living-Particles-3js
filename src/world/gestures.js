// ─────────────────────────────────────────────────────────────────────────────
//  GESTURES — how the hex field draws the score's calls and replies.
//
//  The score (src/shared/score.js) says when a gesture starts and how its envelope runs. This file is
//  the hex field's own part: where a gesture goes on the floor and how wide it is. Another world
//  would keep the score and replace this file with its own routes (inlay curves, branches, ribbons).
//
//  A route is a path with a start and an end. A gesture's front travels it once; a tile takes the
//  gesture's local envelope at the place on the route nearest to it, scaled by how far it is from
//  the route (a soft band `width` wide). So a tile lights as the front passes and fades on its own.
//
//    arc   around a centre, from angle a0 over `sweep` degrees (negative = the other way)
//    ray   straight from A to B
//  Either kind can be a call or a reply; here calls are arcs and replies are rays.
//
//  Angles are atan2(z, x) in degrees: 0° is +x (screen right from the Stand camera), 90° is +z
//  (toward the Stand camera). The same maths runs in the vertex shader (hexfield.js) and here on the
//  CPU (so sparks and plumes start on the surface the shader draws); keep the two in step.
// ─────────────────────────────────────────────────────────────────────────────
import { envelope, MAX_INSTANCES } from '../shared/score.js';

const RAD = Math.PI / 180, TAU = Math.PI * 2;

// The routes, authored for this floor and its Stand camera (at z = +24, looking toward −z):
// calls cross the middle ground from side to side; each reply leaves from where its call arrived
// and climbs away from the viewer, so a call and its answer never share a direction.
// The calls step through these in order (score.routes = how many are used).
export const ROUTES = [
  { call: { kind: 'arc', cx: 0, cz: -4, r: 13, a0: 160, sweep: -140 }, reply: -70 },    // across the front, left to right · reply climbs on the right
  { call: { kind: 'arc', cx: 0, cz: -4, r: 13, a0: -20, sweep: -140 }, reply: -110 },   // around the far side, right to left · reply climbs on the left
  { call: { kind: 'arc', cx: 0, cz: -4, r: 6, a0: 180, sweep: -180 }, reply: -90 },     // a small arc close to the centre · reply straight up the middle
];
export const ROUTE_NAMES = ['front arc', 'far arc', 'small centre arc'];

// Point at fraction u along a route.
export function pathPoint(g, u) {
  if (g.kind === 'ray') return { x: g.ax + (g.bx - g.ax) * u, z: g.az + (g.bz - g.az) * u };
  const a = (g.a0 + g.sweep * u) * RAD;
  return { x: g.cx + g.r * Math.cos(a), z: g.cz + g.r * Math.sin(a) };
}

// The geometry of one score instance in this world. `G` is P.gesture; G.reach scales every route about the centre.
export function routeOf(inst, G) {
  const route = ROUTES[inst.route % ROUTES.length], s = G.reach, k = route.call;
  const c = k.kind === 'ray' ? { kind: 'ray', ax: k.ax * s, az: k.az * s, bx: k.bx * s, bz: k.bz * s }
                             : { kind: 'arc', cx: k.cx * s, cz: k.cz * s, r: k.r * s, a0: k.a0, sweep: k.sweep };
  if (inst.kind === 'call') return c;
  // A reply is a straight run from where its call arrived, on that route's own heading.
  const end = pathPoint(c, 1), h = route.reply * RAD, len = G.replyLength;
  return { kind: 'ray', ax: end.x, az: end.z, bx: end.x + Math.cos(h) * len, bz: end.z + Math.sin(h) * len };
}

// Nearest place on a route to (x, z): { u, dist }.
export function nearest(g, x, z) {
  if (g.kind === 'ray') {
    const abx = g.bx - g.ax, abz = g.bz - g.az, u = Math.min(1, Math.max(0, ((x - g.ax) * abx + (z - g.az) * abz) / Math.max(abx * abx + abz * abz, 1e-4)));
    return { u, dist: Math.hypot(x - (g.ax + abx * u), z - (g.az + abz * u)) };
  }
  const span = Math.abs(g.sweep) * RAD, dir = Math.sign(g.sweep) || 1;
  let da = (((Math.atan2(z - g.cz, x - g.cx) - g.a0 * RAD) * dir) % TAU + TAU) % TAU;       // 0…2π along the sweep
  const u = da <= span ? da / Math.max(span, 1e-4) : (da - span < TAU - da ? 1 : 0);        // past the ends: the nearer end
  const p = pathPoint(g, u);
  return { u, dist: Math.hypot(x - p.x, z - p.z) };
}

// What one instance does to a tile at (x, z) at time t: 0…1 before strength.
export function touch(inst, geom, width, x, z, t) {
  const n = nearest(geom, x, z);
  const band = Math.exp(-(n.dist * n.dist) / Math.max(width * width, 1e-4));
  return band * envelope(t - (inst.start + n.u * inst.travel), inst.rise, inst.crest, inst.release);
}

// Extra height at (x, z) from every live gesture (the CPU twin of the shader loop).
export function gestureLift(instances, G, x, z, t) {
  let lift = 0;
  for (const inst of instances) {
    const call = inst.kind === 'call';
    lift += touch(inst, routeOf(inst, G), call ? G.callWidth : G.replyWidth, x, z, t) * inst.strength * (call ? G.callLift : G.replyLift);
  }
  return lift;
}

// The front of the newest call that has started: where it is and how strong (for a light that rides it).
export function callHead(instances, G, t) {
  let best = null;
  for (const inst of instances) if (inst.kind === 'call' && inst.start <= t && (!best || inst.start > best.start)) best = inst;
  if (!best) return null;
  const u = Math.min(1, Math.max(0, (t - best.start) / Math.max(best.travel, 1e-4))), p = pathPoint(routeOf(best, G), u);
  const after = t - (best.start + best.travel);          // once it has arrived, it fades with the call's own crest and release
  return { x: p.x, z: p.z, strength: best.strength * (after <= 0 ? Math.min(1, (t - best.start) / Math.max(best.rise, 1e-4)) : envelope(after + best.rise, best.rise, best.crest, best.release)) };
}

// Fill the shader's uniform arrays (four vec4 per instance; kind 0 = empty slot).
export function packInstances(instances, G, uA, uB, uT, uC) {
  for (let i = 0; i < MAX_INSTANCES; i++) {
    const inst = instances[i];
    if (!inst) { uB[i].set(0, 0, 0, 1); continue; }
    const g = routeOf(inst, G), call = inst.kind === 'call';
    if (g.kind === 'ray') { uA[i].set(g.ax, g.az, g.bx, g.bz); uB[i].set(0, 0, 1, call ? G.callWidth : G.replyWidth); }
    else { uA[i].set(g.cx, g.cz, g.r, 0); uB[i].set(g.a0 * RAD, g.sweep * RAD, 2, call ? G.callWidth : G.replyWidth); }
    uT[i].set(inst.start, inst.travel, inst.rise, inst.crest);
    uC[i].set(inst.release, inst.strength * (call ? G.callLift : G.replyLift), Math.min(1, inst.strength * (call ? G.callGlow : G.replyGlow)), call ? 1 : 0);
  }
}
